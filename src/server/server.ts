import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { jobManager, LOG_DIR, sweepOrphanedBundles } from "./jobManager.js";
import { runStaticSnapJob } from "./crawler.js";
import { resolveScreenshotViewports } from "./screenshots.js";
import { isProEnabled, isSecretScanAvailable, SECRET_SCAN_UPGRADE_MESSAGE } from "./entitlements.js";
import { assertPublicUrl, BlockedTargetError } from "../net-guard.js";

/**
 * Abuse limits for a publicly reachable deployment.
 *
 * A crawl is expensive: up to 120 pages plus every asset, written to disk and
 * zipped. Without a ceiling one visitor can exhaust the box's disk, sockets
 * and CPU. Both are env-tunable so a private deployment can loosen them.
 */
const MAX_CONCURRENT_JOBS = Number(process.env.STATICSNAP_MAX_CONCURRENT_JOBS ?? 3);
const RATE_LIMIT_WINDOW_MS = Number(process.env.STATICSNAP_RATE_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.STATICSNAP_RATE_MAX ?? 5);

/**
 * Optional shared access token.
 *
 * Unset (the default) leaves the exporter open, which is what local testing
 * wants. Set it and job creation requires the token, turning a public URL into
 * a private tool without any external service. Only `POST /api/jobs` is gated:
 * every other route is addressed by a 96-bit job id that can only be obtained
 * by creating a job, and gating the SSE route would break `EventSource`, which
 * cannot send custom headers.
 */
const ACCESS_TOKEN = process.env.STATICSNAP_ACCESS_TOKEN ?? "";

/** Constant-time token comparison; length is compared first to avoid a throw. */
function tokenMatches(supplied: string): boolean {
  const expected = Buffer.from(ACCESS_TOKEN, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function authorized(req: Request): boolean {
  if (ACCESS_TOKEN.length === 0) return true;
  const header = req.get("x-staticsnap-token") ?? "";
  const bearer = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const supplied = header.length > 0 ? header : bearer;
  return supplied.length > 0 && tokenMatches(supplied);
}

/**
 * Disk ceiling for crawl artifacts.
 *
 * Bundles land in the OS temp dir and are only reaped 15 minutes after a job
 * ends, so several large crawls can fill the volume and take the host down
 * with them. `MAX_JOB_BYTES` fails one runaway crawl; `MAX_TOTAL_BYTES` stops
 * new jobs while the outstanding ones drain.
 */
const MAX_TOTAL_BYTES = Number(
  process.env.STATICSNAP_MAX_TOTAL_BYTES ?? 10 * 1024 * 1024 * 1024,
);

/** client ip -> recent job-creation timestamps (sliding window). */
const recentRequests = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (recentRequests.get(ip) ?? []).filter(
    (at) => now - at < RATE_LIMIT_WINDOW_MS,
  );
  if (hits.length >= RATE_LIMIT_MAX) {
    recentRequests.set(ip, hits);
    return true;
  }
  hits.push(now);
  recentRequests.set(ip, hits);
  // Opportunistic sweep so the map cannot grow without bound.
  if (recentRequests.size > 5000) {
    for (const [key, times] of recentRequests) {
      if (times.every((at) => now - at >= RATE_LIMIT_WINDOW_MS)) {
        recentRequests.delete(key);
      }
    }
  }
  return false;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CreateJobSchema = z.object({
  url: z
    .string()
    .min(1, "URL is required")
    .refine((v) => /^https?:\/\/.+/i.test(v.trim()), {
      message: "URL must start with http:// or https://",
    }),
  scope: z.enum(["landing", "deep"]).default("landing"),
  convertWebp: z.boolean().optional(),
  optimizeImages: z.boolean().optional(),
  downloadExternal: z.boolean().optional(),
  screenshotViewports: z.array(z.enum(["desktop", "tablet", "mobile"])).optional(),
  screenshots: z.boolean().optional(),
  secretScan: z.boolean().optional(),
});

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "64kb" }));
  app.disable("x-powered-by");

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: "staticsnap",
      time: new Date().toISOString(),
      tokenRequired: ACCESS_TOKEN.length > 0,
      pro: isProEnabled(),
      features: { secretScan: isSecretScanAvailable() },
    });
  });

  /**
   * POST /api/jobs — validate the target, create a job, and start the
   * crawler in the background. Returns `{ jobId }`.
   */
  app.post("/api/jobs", async (req: Request, res: Response) => {
    if (!authorized(req)) {
      res
        .status(401)
        .json({ error: "An access token is required to start an export.", tokenRequired: true });
      return;
    }
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (rateLimited(clientIp)) {
      res.status(429).json({
        error: `Too many exports from this address. Try again in a minute.`,
      });
      return;
    }
    if (jobManager.runningCount() >= MAX_CONCURRENT_JOBS) {
      res.status(503).json({
        error: "The exporter is busy with other jobs right now. Please retry shortly.",
      });
      return;
    }
    if (jobManager.retainedBytes() >= MAX_TOTAL_BYTES) {
      res.status(503).json({
        error:
          "The exporter is out of working disk space. Bundles are cleared automatically — please retry in a few minutes.",
      });
      return;
    }

    const parsed = CreateJobSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request body";
      res.status(400).json({ error: message });
      return;
    }

    let target: URL;
    try {
      target = new URL(parsed.data.url.trim());
    } catch {
      res.status(400).json({ error: "Invalid URL. Must start with http:// or https://" });
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      res.status(400).json({ error: "URL must start with http:// or https://" });
      return;
    }

    // Pro-gated capability: fail fast before any crawling happens.
    const secretScan = parsed.data.secretScan ?? false;
    if (secretScan && !isSecretScanAvailable()) {
      res.status(402).json({ error: SECRET_SCAN_UPGRADE_MESSAGE, upgradeRequired: true });
      return;
    }

    // Vet the target before creating a job, so an unreachable or blocked host
    // is a clear 400 at submit time rather than a job that fails seconds later.
    try {
      await assertPublicUrl(target);
    } catch (error: unknown) {
      if (error instanceof BlockedTargetError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }

    const convertWebp = parsed.data.convertWebp ?? parsed.data.optimizeImages ?? true;
    const screenshotViewports = resolveScreenshotViewports({
      screenshotViewports: parsed.data.screenshotViewports,
      screenshots: parsed.data.screenshots,
    });
    const job = jobManager.create({
      url: target.toString(),
      scope: parsed.data.scope,
      convertWebp,
      downloadExternal: parsed.data.downloadExternal ?? false,
      screenshotViewports,
      secretScan,
    });

    jobManager.log(job.id, "INFO", `Job ${job.id} queued for ${target.toString()}`);

    // Fire-and-forget: progress flows back over SSE.
    void runStaticSnapJob(job.id).catch((error: unknown) => {
      console.error(`[job ${job.id}] unhandled:`, error);
    });

    res.status(201).json({ jobId: job.id });
  });

  /** GET /api/jobs/:jobId — polling fallback / inspector. */
  app.get("/api/jobs/:jobId", (req: Request, res: Response) => {
    const jobId = String(req.params.jobId ?? "");
    const detail = jobManager.detail(jobId);
    if (!detail) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    // Never leak absolute server paths to the client; expose a URL instead.
    const {
      outDir: _outDir,
      zipPath: _zipPath,
      logPath: _logPath,
      screenshotsDir: _screenshotsDir,
      screenshotZipPath: _screenshotZipPath,
      ...rest
    } = detail;
    void _outDir;
    void _zipPath;
    void _logPath;
    void _screenshotsDir;
    void _screenshotZipPath;
    res.json({
      ...rest,
      downloadUrl: detail.bundleSize !== null ? `/api/download/${detail.id}` : null,
      screenshotsDownloadUrl:
        detail.screenshotsStatus === "completed"
          ? `/api/download/${detail.id}/screenshots`
          : null,
      logUrl: `/api/jobs/${detail.id}/log`,
      secretsUrl: detail.secretsStatus !== "disabled" ? `/api/jobs/${detail.id}/secrets` : null,
    });
  });

  /**
   * GET /api/jobs/:jobId/log — the durable plain-text log for a job.
   *
   * Served from disk rather than memory, so it still works after the
   * in-memory tail has been trimmed or the artifacts garbage-collected.
   */
  app.get("/api/jobs/:jobId/log", async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId ?? "");
    // Reject anything that is not a plain job id before touching the path.
    if (!/^[a-f0-9]{6,32}$/i.test(jobId)) {
      res.status(400).json({ error: "Invalid job id" });
      return;
    }
    const logPath = path.join(LOG_DIR, `${jobId}.log`);
    if (!(await fs.pathExists(logPath))) {
      res.status(404).json({ error: "No log found for this job" });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const stream = fs.createReadStream(logPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read log" });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  });

  /**
   * GET /api/jobs/:jobId/secrets — redacted secret-exposure report (Pro).
   *
   * Findings are redacted at scan time (`AKIA***…`), so this payload is safe
   * to render, store and download. 404 when the scan was not requested,
   * 409 while it is still running, 402 when the deployment is not Pro.
   */
  app.get("/api/jobs/:jobId/secrets", (req: Request, res: Response) => {
    const jobId = String(req.params.jobId ?? "");
    const job = jobManager.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.secretsStatus === "disabled") {
      if (!isSecretScanAvailable()) {
        res.status(402).json({ error: SECRET_SCAN_UPGRADE_MESSAGE, upgradeRequired: true });
      } else {
        res.status(404).json({ error: "Secret scan was not requested for this job." });
      }
      return;
    }
    if (job.secretsStatus === "pending" || job.secretsStatus === "running") {
      res.status(409).json({ error: "Secret scan is still running. Try again shortly.", status: job.secretsStatus });
      return;
    }
    if (job.secretsStatus === "failed") {
      res.status(409).json({ error: job.secretsError ?? "Secret scan failed.", status: job.secretsStatus });
      return;
    }
    res.json({
      jobId: job.id,
      status: job.secretsStatus,
      summary: job.secretsSummary,
      findings: job.secretsFindings,
      disclaimer:
        "Heuristic scan of public frontend content (HTML/JS/CSS). Redacted excerpts only — verify each finding, rotate confirmed secrets, and never commit real credentials to frontend code.",
    });
  });

  /**
   * GET /api/stream/:jobId — Server-Sent Events telemetry.
   * Emits `event: message` frames with
   * `{ stage, progress, log, metrics, status, complete, … }`.
   */
  app.get("/api/stream/:jobId", (req: Request, res: Response) => {
    const jobId = String(req.params.jobId ?? "");
    const job = jobManager.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Flush headers immediately so EventSource connects without buffering.
    res.flushHeaders?.();

    const unsubscribe = jobManager.subscribe(jobId, res);
    if (!unsubscribe) {
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`: ping ${Date.now()}\n\n`);
        }
      } catch {
        // client gone — cleanup below handles it
      }
    }, 15_000);

    // Bound to a named handler and deregistered on termination so listeners
    // never accumulate across reconnects. EventSource reconnects on its own,
    // so this fires often; both 'close' events can land, hence the guard.
    let released = false;
    const cleanup = (): void => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  /**
   * GET /api/download/:jobId — stream the generated `.zip` bundle.
   *
   * Available as soon as the main bundle is packed, which can be *before* the
   * job completes when screenshots keep running in the background.
   */
  app.get("/api/download/:jobId", async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId ?? "");
    const job = jobManager.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status === "failed") {
      res.status(409).json({ error: `Bundle not ready (status: ${job.status})` });
      return;
    }
    if (job.bundleSize === null) {
      res.status(409).json({ error: `Bundle not ready (status: ${job.status})` });
      return;
    }
    if (!job.zipPath || !(await fs.pathExists(job.zipPath))) {
      res.status(410).json({ error: "Bundle expired and was garbage-collected. Please re-run the export." });
      return;
    }

    const filename = `${job.domain}-static.zip`;
    try {
      const stat = await fs.stat(job.zipPath);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Bundle-Pages", String(job.metrics.pagesCompleted));
      res.setHeader("X-Bundle-Assets", String(job.metrics.assetsDownloaded));
      const stream = fs.createReadStream(job.zipPath);
      stream.on("error", (error: Error) => {
        console.error(`[download ${jobId}] stream error:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream bundle" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to read bundle: ${message}` });
      } else {
        res.end();
      }
    }
  });

  /**
   * GET /api/download/:jobId/screenshots — stream the separate screenshots `.zip`.
   *
   * Captures run after the main bundle, so this is 404 when screenshots were
   * not requested, 409 while they are still rendering, and 410 once reaped.
   */
  app.get("/api/download/:jobId/screenshots", async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId ?? "");
    const job = jobManager.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.screenshotsStatus === "disabled") {
      res.status(404).json({ error: "Screenshots were not requested for this job." });
      return;
    }
    if (job.screenshotsStatus === "pending" || job.screenshotsStatus === "running") {
      res.status(409).json({ error: "Screenshots are still rendering. Try again shortly." });
      return;
    }
    if (job.screenshotsStatus === "failed") {
      res.status(409).json({ error: job.screenshotsError ?? "Screenshots failed." });
      return;
    }
    if (!job.screenshotZipPath || !(await fs.pathExists(job.screenshotZipPath))) {
      res.status(410).json({ error: "Screenshots expired and were garbage-collected. Please re-run the export." });
      return;
    }

    const filename = `${job.domain}-screenshots.zip`;
    try {
      const stat = await fs.stat(job.screenshotZipPath);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("X-Screenshots-Count", String(job.screenshotsDone));
      const stream = fs.createReadStream(job.screenshotZipPath);
      stream.on("error", (error: Error) => {
        console.error(`[screenshots ${jobId}] stream error:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream screenshots bundle" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to read screenshots bundle: ${message}` });
      } else {
        res.end();
      }
    }
  });

  // ---- Frontend ----------------------------------------------------
  // When built, public/ is copied to dist/ root; in dev it lives at ./public.
  const candidates = [
    path.join(__dirname, "public"),
    path.join(__dirname, "..", "public"),
    path.join(__dirname, ".."), // dist/ root (tsup publicDir output)
    path.join(__dirname, "..", "..", "public"),
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "dist"),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        app.use(express.static(dir, { maxAge: "5m", index: "index.html" }));
        break;
      }
    } catch {
      // try next candidate
    }
  }

  // SPA fallback — unknown GET routes serve the dashboard (but never shadow /api).
  // NOTE: Express 5 (path-to-regexp v8) rejects the "*" wildcard, so this is
  // a plain middleware instead of app.get("*").
  app.use((req: Request, res: Response, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    for (const dir of candidates) {
      const indexFile = path.join(dir, "index.html");
      try {
        if (fs.existsSync(indexFile)) {
          res.sendFile(indexFile);
          return;
        }
      } catch {
        // try next
      }
    }
    next();
  });

  return app;
}

export const app = createApp();

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

if (process.env.NODE_ENV !== "test") {
  // Reclaim disk from jobs whose process died before their reaper fired.
  void sweepOrphanedBundles()
    .then((removed) => {
      if (removed > 0) {
        console.log(`[startup] removed ${removed} orphaned bundle director(ies)`);
      }
    })
    .catch(() => undefined);

  app.listen(PORT, HOST, () => {
    console.log(`⚡ StaticSnap listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  });
}

export default app;
