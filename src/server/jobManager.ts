import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { EOL, tmpdir } from "node:os";
import path from "node:path";
import fs from "fs-extra";
import type { Response } from "express";

/** Lifecycle states for a StaticSnap export job. */
export type JobStatus = "queued" | "running" | "completed" | "failed";

/** Pipeline stages shown in the frontend stepper. */
export type StageId =
  | "discovery"
  | "harvesting"
  | "assets"
  | "rewriting"
  | "archiving";

/** Terminal log severity. */
export type LogLevel = "INFO" | "SUCCESS" | "WARN" | "ERROR";

export interface LogEntry {
  /**
   * Monotonic per-job sequence number, starting at 1.
   *
   * Lets a client drop entries it has already rendered. EventSource
   * transparently reconnects, and every reconnect replays the job's history,
   * so without an identity the terminal re-prints the whole backlog.
   */
  seq: number;
  ts: string;
  level: LogLevel;
  message: string;
}

export interface JobMetrics {
  pagesDiscovered: number;
  pagesCompleted: number;
  /** Pages that could not be harvested (403, 404, timeout, non-HTML). */
  pagesFailed: number;
  assetsDownloaded: number;
  /** Assets that could not be downloaded; the reference stays remote. */
  assetsFailed: number;
  bytesDownloaded: number;
  currentOperation: string;
}

export type CrawlScope = "landing" | "deep";

export interface JobOptions {
  url: string;
  scope: CrawlScope;
  convertWebp: boolean;
  downloadExternal: boolean;
}

export interface Job {
  id: string;
  options: JobOptions;
  /** Normalized target URL (redirect-resolved when known). */
  targetUrl: string;
  domain: string;
  status: JobStatus;
  stage: StageId;
  progress: number;
  logs: LogEntry[];
  metrics: JobMetrics;
  outDir: string;
  zipPath: string | null;
  bundleSize: number | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
  cleaned: boolean;
  /** Durable log file for this job. Survives artifact GC and restarts. */
  logPath: string;
  /** In-memory entries dropped by the MAX_LOGS cap (the file keeps all). */
  droppedLogs: number;
  /** Last issued log sequence number. */
  logSeq: number;
}

/** Shape pushed over SSE (`event: message`). */
export interface StreamPayload {
  stage: StageId;
  progress: number;
  status: JobStatus;
  log: LogEntry | null;
  metrics: JobMetrics;
  complete: boolean;
  error: string | null;
  downloadUrl: string | null;
  bundleSize: number | null;
  bundleSizeHuman: string | null;
}

export const STAGE_ORDER: StageId[] = [
  "discovery",
  "harvesting",
  "assets",
  "rewriting",
  "archiving",
];

export const STAGE_LABELS: Record<StageId, string> = {
  discovery: "Discovery",
  harvesting: "Harvesting",
  assets: "Asset Engine",
  rewriting: "Link Transformation",
  archiving: "Archive Generation",
};

/** 15 minutes — retention for /tmp site dirs + zips after completion. */
export const RETENTION_MS = 15 * 60 * 1000;

const MAX_LOGS = 2000;

/**
 * Finished job records kept in memory after their artifacts are collected.
 *
 * Records outlive their files so a late download attempt gets a useful 410
 * ("bundle expired") rather than a bare 404, but the set is bounded: without
 * this the jobs map grew for the lifetime of the process.
 */
const MAX_RETAINED_JOBS = 50;

/**
 * Where durable job logs are written.
 *
 * Deliberately outside the per-job temp directory, which cleanup() deletes 15
 * minutes after completion: the log is most useful precisely when
 * investigating a job whose artifacts are already gone.
 */
export const LOG_DIR =
  process.env.STATICSNAP_LOG_DIR ?? path.join(tmpdir(), "staticsnap-logs");

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const display =
    value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${display} ${units[unit]}`;
}

function domainForFilename(hostname: string): string {
  const cleaned = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "site";
}

type SseClient = Response;

class JobManager {
  private jobs = new Map<string, Job>();
  private clients = new Map<string, Set<SseClient>>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Append-only log stream per job, opened lazily on the first entry. */
  private logStreams = new Map<string, WriteStream>();

  create(rawOptions: JobOptions): Job {
    const target = new URL(rawOptions.url);
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const base = path.join(tmpdir(), `staticsnap-${id}`);
    const job: Job = {
      id,
      options: { ...rawOptions, url: target.toString() },
      targetUrl: target.toString(),
      domain: domainForFilename(target.hostname),
      status: "queued",
      stage: "discovery",
      progress: 0,
      logs: [],
      metrics: {
        pagesDiscovered: 0,
        pagesCompleted: 0,
        pagesFailed: 0,
        assetsDownloaded: 0,
        assetsFailed: 0,
        bytesDownloaded: 0,
        currentOperation: "Queued…",
      },
      outDir: path.join(base, "site"),
      zipPath: path.join(base, `${domainForFilename(target.hostname)}-static.zip`),
      bundleSize: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      cleaned: false,
      logPath: path.join(LOG_DIR, `${id}.log`),
      droppedLogs: 0,
      logSeq: 0,
    };
    this.jobs.set(id, job);
    this.clients.set(id, new Set());
    this.openLog(job);
    return job;
  }

  /**
   * Open the durable log file and write a header describing the run.
   *
   * Best-effort: if the log directory is not writable the job still runs, it
   * just loses durable logging. Never let telemetry break the export.
   */
  private openLog(job: Job): void {
    try {
      fs.ensureDirSync(LOG_DIR);
      const stream = createWriteStream(job.logPath, { flags: "a" });
      stream.on("error", () => {
        // Disk full / permissions: drop durable logging, keep the job alive.
        this.logStreams.delete(job.id);
      });
      this.logStreams.set(job.id, stream);
      stream.write(
        [
          `# StaticSnap job ${job.id}`,
          `# target : ${job.targetUrl}`,
          `# scope  : ${job.options.scope}`,
          `# options: webp=${job.options.convertWebp} external=${job.options.downloadExternal}`,
          `# started: ${new Date(job.createdAt).toISOString()}`,
          "",
        ].join(EOL),
      );
    } catch {
      // No durable log for this job; in-memory logging still works.
    }
  }

  /** Append one already-formatted entry to the job's log file. */
  private writeLogLine(id: string, entry: LogEntry): void {
    const stream = this.logStreams.get(id);
    if (!stream || stream.writableEnded) return;
    try {
      stream.write(
        `${entry.ts}  ${entry.level.padEnd(7)} ${entry.message}${EOL}`,
      );
    } catch {
      // Best-effort only.
    }
  }

  /** Flush and close the job's log stream, appending an outcome footer. */
  private closeLog(job: Job): void {
    const stream = this.logStreams.get(job.id);
    if (!stream) return;
    this.logStreams.delete(job.id);
    try {
      const elapsed =
        job.completedAt !== null ? job.completedAt - job.createdAt : 0;
      stream.end(
        [
          "",
          `# status : ${job.status}`,
          `# error  : ${job.error ?? "none"}`,
          `# pages  : ${job.metrics.pagesCompleted} ok / ${job.metrics.pagesFailed} failed`,
          `# assets : ${job.metrics.assetsDownloaded} ok / ${job.metrics.assetsFailed} failed`,
          `# bytes  : ${formatBytes(job.metrics.bytesDownloaded)}`,
          `# bundle : ${job.bundleSize !== null ? formatBytes(job.bundleSize) : "none"}`,
          `# elapsed: ${(elapsed / 1000).toFixed(1)}s`,
          `# dropped: ${job.droppedLogs} in-memory entr(ies) trimmed; this file is complete`,
          "",
        ].join(EOL),
      );
    } catch {
      // Best-effort only.
    }
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Bytes currently occupying the working volume.
   *
   * Counts jobs whose artifacts have not been reaped yet: what a running crawl
   * has downloaded so far, plus the zip written for a finished one. Used to
   * refuse new work before the disk fills rather than after.
   */
  retainedBytes(): number {
    let total = 0;
    for (const job of this.jobs.values()) {
      if (job.cleaned) continue;
      total += job.metrics.bytesDownloaded;
      if (job.bundleSize !== null) total += job.bundleSize;
    }
    return total;
  }

  /** How many jobs are queued or actively crawling right now. */
  runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "queued" || job.status === "running") count += 1;
    }
    return count;
  }

  /** Append a log line + broadcast it. */
  log(id: string, level: LogLevel, message: string): LogEntry | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.logSeq += 1;
    const entry: LogEntry = {
      seq: job.logSeq,
      ts: new Date().toISOString(),
      level,
      message,
    };
    job.logs.push(entry);
    // The file is the complete record; memory keeps only a bounded tail so a
    // long deep crawl cannot grow without limit. Count what was trimmed so
    // the truncation is visible rather than silent.
    if (job.logs.length > MAX_LOGS) {
      job.droppedLogs += job.logs.length - MAX_LOGS;
      job.logs.splice(0, job.logs.length - MAX_LOGS);
    }
    this.writeLogLine(id, entry);
    this.broadcast(id, entry);
    return entry;
  }

  setStage(id: string, stage: StageId, operation?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.stage = stage;
    if (operation !== undefined) {
      job.metrics.currentOperation = operation;
    }
    this.broadcast(id, null);
  }

  setProgress(id: string, progress: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = Math.max(0, Math.min(100, Math.round(progress)));
    this.broadcast(id, null);
  }

  patchMetrics(id: string, patch: Partial<JobMetrics>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job.metrics, patch);
    this.broadcast(id, null);
  }

  setStatus(id: string, status: JobStatus): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    this.broadcast(id, null);
  }

  markRunning(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "running";
    this.broadcast(id, null);
  }

  markComplete(id: string, bundleSize: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "completed";
    job.stage = "archiving";
    job.progress = 100;
    job.bundleSize = bundleSize;
    job.completedAt = Date.now();
    job.metrics.currentOperation = "Done — bundle ready.";
    this.broadcast(id, null);
    this.closeLog(job);
    this.scheduleCleanup(id);
  }

  markFailed(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "failed";
    job.error = error;
    job.completedAt = Date.now();
    job.metrics.currentOperation = "Failed.";
    this.broadcast(id, null);
    this.closeLog(job);
    this.scheduleCleanup(id);
  }

  /**
   * Current state, carrying no log entry.
   *
   * A state frame is broadcast on every setStage/setProgress/patchMetrics —
   * i.e. once per downloaded asset. This previously attached the *newest* log
   * entry to each of those frames, so a single line such as
   * "Asset engine: downloading 131 file(s)…" was re-sent (and re-rendered)
   * dozens of times. Log entries now travel only on their own frame.
   */
  snapshot(id: string): StreamPayload | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const done = job.status === "completed" || job.status === "failed";
    return {
      stage: job.stage,
      progress: job.progress,
      status: job.status,
      log: null,
      metrics: { ...job.metrics },
      complete: done,
      error: job.error,
      downloadUrl: job.status === "completed" ? `/api/download/${job.id}` : null,
      bundleSize: job.bundleSize,
      bundleSizeHuman:
        job.bundleSize !== null ? formatBytes(job.bundleSize) : null,
    };
  }

  /** Path of the durable log file for a job, if it still exists on disk. */
  logFile(id: string): string | null {
    return this.jobs.get(id)?.logPath ?? null;
  }

  /** Full state for the REST polling fallback. */
  detail(id: string): (Job & { bundleSizeHuman: string | null }) | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return {
      ...job,
      logs: [...job.logs],
      metrics: { ...job.metrics },
      bundleSizeHuman:
        job.bundleSize !== null ? formatBytes(job.bundleSize) : null,
    };
  }

  subscribe(id: string, res: SseClient): (() => void) | null {
    const job = this.jobs.get(id);
    const set = this.clients.get(id);
    if (!job || !set) return null;
    set.add(res);
    // Replay history so late-joining clients see the full terminal. Entries
    // carry `seq`, so a reconnecting client discards what it already has
    // instead of printing the backlog twice.
    for (const entry of job.logs) {
      this.writeEvent(res, this.payloadWithLog(job, entry));
    }
    // Always push a current-state frame (covers zero-log jobs).
    this.writeEvent(res, this.snapshot(id));
    return () => {
      set.delete(res);
    };
  }

  private payloadWithLog(job: Job, entry: LogEntry): StreamPayload {
    const done = job.status === "completed" || job.status === "failed";
    return {
      stage: job.stage,
      progress: job.progress,
      status: job.status,
      log: entry,
      metrics: { ...job.metrics },
      complete: done,
      error: job.error,
      downloadUrl: job.status === "completed" ? `/api/download/${job.id}` : null,
      bundleSize: job.bundleSize,
      bundleSizeHuman:
        job.bundleSize !== null ? formatBytes(job.bundleSize) : null,
    };
  }

  private broadcast(id: string, entry: LogEntry | null): void {
    const job = this.jobs.get(id);
    const set = this.clients.get(id);
    if (!job || !set || set.size === 0) return;
    const payload: StreamPayload =
      entry !== null ? this.payloadWithLog(job, entry) : (this.snapshot(id) as StreamPayload);
    for (const res of [...set]) {
      try {
        this.writeEvent(res, payload);
      } catch {
        set.delete(res);
      }
    }
  }

  private writeEvent(res: SseClient, payload: StreamPayload | null): void {
    if (!payload) return;
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private scheduleCleanup(id: string): void {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.cleanup(id);
    }, RETENTION_MS);
    // Don't keep the process alive just for GC.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(id, timer);
  }

  /**
   * Evict the oldest finished job records once the retention cap is passed.
   *
   * Only completed/failed jobs are candidates - a running job is never
   * dropped no matter how many have queued up behind it.
   */
  private evictOldJobs(): void {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const finished = [...this.jobs.values()]
      .filter((job) => job.status === "completed" || job.status === "failed")
      .sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));
    let excess = this.jobs.size - MAX_RETAINED_JOBS;
    for (const job of finished) {
      if (excess <= 0) break;
      this.jobs.delete(job.id);
      this.clients.delete(job.id);
      const timer = this.timers.get(job.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(job.id);
      this.logStreams.delete(job.id);
      excess -= 1;
    }
  }

  /** Delete temp site dir + zip 15 min after completion. Idempotent. */
  async cleanup(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.cleaned) return;
    job.cleaned = true;
    const targets = [job.outDir, path.dirname(job.outDir)];
    if (job.zipPath) targets.push(job.zipPath);
    for (const target of new Set(targets)) {
      try {
        await fs.remove(target);
      } catch {
        // Best-effort GC — disk cleanup must never throw.
      }
    }
    const set = this.clients.get(id);
    if (set) {
      for (const res of [...set]) {
        try {
          if (!res.writableEnded) res.end();
        } catch {
          // ignore
        }
      }
      set.clear();
    }
    // Artifacts are gone, so the in-memory log tail has no further use: the
    // durable file outlives it. Free it, but keep the (small) job record so a
    // late /api/download gets a 410 "expired" rather than a bare 404.
    job.droppedLogs += job.logs.length;
    job.logs = [];
    this.clients.delete(id);
    this.timers.delete(id);
    this.closeLog(job);
    this.evictOldJobs();
  }
}

/**
 * Delete `staticsnap-*` working directories left behind by a previous process.
 *
 * The 15-minute reaper only runs in the process that created a job, so a crash
 * or redeploy strands its bundles on the volume permanently. Called once at
 * startup; failures are ignored because this is opportunistic housekeeping.
 *
 * @param maxAgeMs Only remove directories older than this (default 1 hour), so
 *   a second instance sharing the volume cannot delete live work.
 */
export async function sweepOrphanedBundles(
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const root = tmpdir();
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.startsWith("staticsnap-")) continue;
    // Never touch the log directory, which is meant to outlive its artifacts.
    const full = path.join(root, entry);
    if (path.resolve(full) === path.resolve(LOG_DIR)) continue;
    try {
      const stat = await fs.stat(full);
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
      await fs.remove(full);
      removed += 1;
    } catch {
      // Locked or already gone — skip it.
    }
  }
  return removed;
}

export const jobManager = new JobManager();
export default jobManager;
