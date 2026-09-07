import path from "node:path";
import { createHash } from "node:crypto";
import fs from "fs-extra";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import sharp from "sharp";
import { jobManager, formatBytes } from "./jobManager.js";
import { createZip } from "./zipper.js";
import { fetchWithTimeout, type BrowserResponse } from "../fetcher.js";
import { BlockedTargetError } from "../net-guard.js";

const PAGE_CONCURRENCY = 5;
const ASSET_CONCURRENCY = 8;
const MAX_DEEP_PAGES = 120;

/**
 * Byte ceiling for a single export.
 *
 * A media-heavy site can otherwise fill the working volume on its own, taking
 * the whole service down. Hitting the cap fails this one job with a message
 * that says why, instead of an out-of-disk error somewhere unrelated.
 */
const MAX_JOB_BYTES = Number(
  process.env.STATICSNAP_MAX_JOB_BYTES ?? 2 * 1024 * 1024 * 1024,
);

/**
 * Budget for the initial reachability probe.
 *
 * The probe is the single point of failure for a whole export, and it lands
 * on a cold origin: a WordPress/LiteSpeed homepage that answers in ~2s warm
 * routinely takes 10-20s on the first uncached hit. It gets its own, longer
 * budget and is retried, so one slow cold start cannot kill the job.
 */
const PROBE_TIMEOUT_MS = Number(process.env.STATICSNAP_PROBE_TIMEOUT_MS ?? 45_000);
const PROBE_ATTEMPTS = Number(process.env.STATICSNAP_PROBE_ATTEMPTS ?? 3);
const PROBE_BACKOFF_MS = 2_000;

const RASTER_EXTS = new Set(["jpg", "jpeg", "png"]);
const SKIP_SCHEMES = new Set(["data:", "blob:", "javascript:", "mailto:", "tel:"]);

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Values that must never be normalized, queued for download, or rewritten.
 *
 * Inline `data:` payloads are already self-contained and stay verbatim in the
 * output; the rest are not fetchable resources at all. This is the single
 * guard every extraction and rewrite path funnels through.
 */
export function isSkippable(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.startsWith("#")) return true;
  for (const scheme of SKIP_SCHEMES) {
    if (v.startsWith(scheme)) return true;
  }
  return false;
}

function resolveUrl(raw: string, base: string): URL | null {
  try {
    const cleaned = raw.trim();
    if (cleaned.length === 0) return null;
    return new URL(cleaned, base);
  } catch {
    return null;
  }
}

function stripFragment(href: string): string {
  const idx = href.indexOf("#");
  return idx >= 0 ? href.slice(0, idx) : href;
}

function safeBasename(p: string): string {
  let base = p.split("/").pop() ?? "";
  try {
    base = decodeURIComponent(base);
  } catch {
    // keep raw
  }
  base = base.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  return base.length > 0 ? base : "index.html";
}

/** Map a page URL to a relative html file path inside the bundle. */
export function urlToPageFile(pageUrl: URL): string {
  let pathname = pageUrl.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // keep raw pathname
  }
  const clean = pathname.replace(/^\/+/, "");
  if (clean === "" || clean.endsWith("/")) {
    return path.posix.join(clean, "index.html");
  }
  const last = clean.split("/").pop() ?? "";
  if (!last.includes(".")) {
    return `${clean}/index.html`;
  }
  // Keep explicit filenames (about.html, feed.xml …) but sanitize segments.
  const parts = clean.split("/").map((seg) => {
    const s = seg.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return s.length > 0 ? s : "_";
  });
  return parts.join("/");
}

/** Map an asset URL to a relative file path inside the bundle. */
export function assetUrlToFile(assetUrl: URL, baseHost: string): string {
  const sameHost = assetUrl.hostname.toLowerCase() === baseHost.toLowerCase();
  let pathname = assetUrl.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // keep raw
  }
  let rel = pathname.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) {
    const hash = createHash("md5").update(assetUrl.toString()).digest("hex").slice(0, 8);
    rel = `${rel}asset-${hash}.bin`;
  }
  const sanitized = rel
    .split("/")
    .map((seg) => {
      const s = seg.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
      return s.length > 0 ? s : "_";
    })
    .join("/");
  if (sameHost) return sanitized;
  return path.posix.join("_external", assetUrl.hostname.toLowerCase(), sanitized);
}

function withHashSuffix(relPath: string, hash: string): string {
  const parsed = path.posix.parse(relPath);
  const name = `${parsed.name}-${hash}${parsed.ext}`;
  return parsed.dir ? path.posix.join(parsed.dir, name) : name;
}

/**
 * Split a `srcset` into its candidates.
 *
 * A naive `split(",")` tears data URIs in half, because the mediatype and the
 * payload are themselves comma-separated:
 *
 *   data:image/gif;base64,R0lGODlhAQABAIAAAA...  1x
 *   -> ["data:image/gif;base64", "R0lGODlhAQABAIAAAA... 1x"]
 *
 * The second fragment then looks like a relative path and resolves against the
 * page URL (https://host/it/R0lGODlh...), producing a spurious 404 per
 * placeholder GIF and corrupting the attribute when the srcset is reassembled.
 *
 * A data URI cannot contain unescaped whitespace in a srcset, so the URL of a
 * `data:` candidate runs to the next whitespace and its commas are kept.
 */
export function parseSrcset(srcset: string): Array<{ url: string; descriptor: string }> {
  const entries: Array<{ url: string; descriptor: string }> = [];
  const isSpace = (ch: string): boolean => {
    const code = ch.charCodeAt(0);
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
  };
  /**
   * Does `rest` (from just after a comma) begin a new srcset candidate?
   *
   * Used only to decide where a `data:` URI ends. Unencoded SVG payloads
   * contain both commas *and* spaces (`<svg viewBox="0,0,1,1">`), so neither
   * separator alone terminates one; without this the payload shreds into bogus
   * candidates like `0` and `1` that resolve to real HTTP requests.
   */
  const startsCandidate = (rest: string): boolean => {
    let k = 0;
    while (k < rest.length && isSpace(rest[k]!)) k += 1;
    const tail = rest.slice(k).toLowerCase();
    if (tail.length === 0) return false;
    for (const scheme of ["http:", "https:", "data:", "blob:"]) {
      if (tail.startsWith(scheme)) return true;
    }
    if (tail.startsWith("/") || tail.startsWith("./") || tail.startsWith("../")) {
      return true;
    }
    // A bare filename candidate ("hero.png 2x") needs an extension dot.
    let end = 0;
    while (end < tail.length && !isSpace(tail[end]!) && tail[end] !== ",") end += 1;
    const token = tail.slice(0, end);
    return token.includes(".") && !token.endsWith(".");
  };

  let i = 0;

  while (i < srcset.length) {
    // Skip separators between candidates.
    while (i < srcset.length && (isSpace(srcset[i]!) || srcset[i] === ",")) i += 1;
    if (i >= srcset.length) break;

    const start = i;
    const isDataUri = srcset.slice(i, i + 5).toLowerCase() === "data:";
    if (isDataUri) {
      // Consume the whole data URI, including any commas and spaces inside it,
      // stopping only at a comma that genuinely opens the next candidate.
      while (i < srcset.length) {
        if (srcset[i] === "," && startsCandidate(srcset.slice(i + 1))) break;
        i += 1;
      }
    } else {
      while (i < srcset.length && !isSpace(srcset[i]!) && srcset[i] !== ",") {
        i += 1;
      }
    }
    let url = srcset.slice(start, i);

    // A data URI's trailing descriptor is whitespace-separated inside the span
    // we just consumed; split it back off so the URI itself stays exact.
    let dataDescriptor = "";
    if (isDataUri) {
      const lastSpace = (() => {
        for (let k = url.length - 1; k >= 0; k -= 1) {
          if (isSpace(url[k]!)) return k;
        }
        return -1;
      })();
      if (lastSpace >= 0) {
        const maybe = url.slice(lastSpace + 1).trim();
        // Only a real descriptor (`2x`, `640w`) is peeled off, never SVG markup.
        if (/^[0-9.]+[wx]$/i.test(maybe)) {
          dataDescriptor = maybe;
          url = url.slice(0, lastSpace);
        }
      }
      url = url.trim();
    }

    // The descriptor is whatever follows, up to the next candidate separator.
    while (i < srcset.length && isSpace(srcset[i]!)) i += 1;
    const descriptorStart = i;
    while (i < srcset.length && srcset[i] !== ",") i += 1;
    const descriptor = dataDescriptor || srcset.slice(descriptorStart, i).trim();

    if (url.length > 0) entries.push({ url, descriptor });
  }

  return entries;
}

const CSS_URL_RE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))\s*\)/gi;

function extractCssUrls(css: string): string[] {
  const out: string[] = [];
  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(css)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw.length > 0 && !isSkippable(raw)) out.push(raw);
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ */
/* sitemap discovery                                                   */
/* ------------------------------------------------------------------ */

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc[^>]*>([^<]+)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const v = (m[1] ?? "").trim();
    if (v.length > 0) locs.push(v);
  }
  return [...new Set(locs)];
}

function looksLikeSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml) || /<sitemap[\s>]/i.test(xml);
}

async function tryFetchText(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, undefined, 12_000);
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("text/html") && !url.toLowerCase().includes("sitemap")) {
      return null;
    }
    const text = await res.text();
    if (!text || text.length < 10) return null;
    return text;
  } catch {
    return null;
  }
}

async function discoverViaSitemaps(
  jobId: string,
  target: URL,
): Promise<string[]> {
  const origin = target.origin;
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/page-sitemap.xml`,
  ];

  // robots.txt may advertise additional sitemap locations.
  try {
    const robots = await tryFetchText(`${origin}/robots.txt`);
    if (robots) {
      for (const line of robots.split(/\r?\n/)) {
        const m = /^\s*Sitemap:\s*(\S+)/i.exec(line);
        if (m?.[1]) candidates.push(m[1].trim());
      }
    }
  } catch {
    // non-fatal
  }

  // Validate XML is actually parseable (fast-xml-parser) before regex-extract.
  const parser = new XMLParser({ ignoreAttributes: false });
  const sitemapBodies: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    jobManager.log(jobId, "INFO", `Checking sitemap: ${candidate}`);
    const body = await tryFetchText(candidate);
    if (!body) continue;
    try {
      parser.parse(body);
    } catch {
      continue;
    }
    if (!/<urlset[\s>]|<sitemapindex[\s>]|<url[\s>]/i.test(body)) continue;
    jobManager.log(jobId, "SUCCESS", `Found sitemap: ${candidate}`);
    sitemapBodies.push(body);
  }

  const pageUrls = new Set<string>();
  const childSitemaps: string[] = [];

  for (const body of sitemapBodies) {
    for (const loc of extractLocs(body)) {
      if (/sitemap.*\.xml/i.test(loc)) {
        childSitemaps.push(loc);
      } else {
        pageUrls.add(stripFragment(loc));
      }
    }
    // Fallback: bodies that are pure indexes only contain child sitemaps.
    if (looksLikeSitemapIndex(body) && pageUrls.size === 0) {
      for (const loc of extractLocs(body)) childSitemaps.push(loc);
    }
  }

  // Recurse one level into sitemap indexes (cap to avoid fan-out).
  const uniqueChildren = [...new Set(childSitemaps)].slice(0, 25);
  for (const child of uniqueChildren) {
    if (pageUrls.size >= MAX_DEEP_PAGES) break;
    try {
      const childUrl = new URL(child);
      if (childUrl.hostname.toLowerCase() !== target.hostname.toLowerCase()) {
        continue;
      }
      jobManager.log(jobId, "INFO", `Parsing sitemap index child: ${child}`);
      const body = await tryFetchText(childUrl.toString());
      if (!body) continue;
      for (const loc of extractLocs(body)) {
        if (/sitemap.*\.xml/i.test(loc)) continue;
        pageUrls.add(stripFragment(loc));
        if (pageUrls.size >= MAX_DEEP_PAGES) break;
      }
    } catch {
      // ignore bad child entries
    }
  }

  // Keep only same-host http(s) URLs.
  const filtered: string[] = [];
  for (const raw of pageUrls) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (u.hostname.toLowerCase() !== target.hostname.toLowerCase()) continue;
      filtered.push(u.toString());
    } catch {
      // skip malformed
    }
    if (filtered.length >= MAX_DEEP_PAGES) break;
  }
  return [...new Set(filtered)];
}

/* ------------------------------------------------------------------ */
/* main job runner                                                     */
/* ------------------------------------------------------------------ */

interface PageRecord {
  url: string;
  finalUrl: string;
  html: string;
  file: string; // relative posix path
}

interface AssetRecord {
  url: string; // absolute, fragment-free
  file: string; // relative posix path (final, after webp remap)
  bytes: number;
  contentType: string;
}

export async function runStaticSnapJob(jobId: string): Promise<void> {
  const job = jobManager.get(jobId);
  if (!job) return;
  jobManager.markRunning(jobId);

  const startedAt = Date.now();
  try {
    await execute(jobId);
    const finished = jobManager.get(jobId);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (finished && finished.status === "completed") {
      jobManager.log(
        jobId,
        "SUCCESS",
        `Export finished in ${secs}s → ${finished.bundleSize !== null ? formatBytes(finished.bundleSize) : "zip"}`,
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    jobManager.log(jobId, "ERROR", `Export failed: ${message}`);
    jobManager.markFailed(jobId, message);
  }
}

/**
 * Fetch the target once, retrying transient failures.
 *
 * Only network-level failures and timeouts are retried; an HTTP response of
 * any status is returned immediately so the caller can classify 401/403/404
 * as a permanent, explainable failure rather than retrying pointlessly.
 */
async function probeTarget(jobId: string, url: string): Promise<BrowserResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      return await fetchWithTimeout(url, undefined, PROBE_TIMEOUT_MS);
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof BlockedTargetError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < PROBE_ATTEMPTS) {
        jobManager.log(
          jobId,
          "WARN",
          `Target did not answer (${message}) — retry ${attempt + 1}/${PROBE_ATTEMPTS}…`,
        );
        await sleep(PROBE_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function execute(jobId: string): Promise<void> {
  const job = jobManager.get(jobId);
  if (!job) throw new Error("Job not found");

  const target = new URL(job.targetUrl);
  const baseHost = target.hostname.toLowerCase();
  const outDir = job.outDir;
  await fs.ensureDir(outDir);
  await fs.emptyDir(outDir);

  /* ---- Stage 1: Discovery ---------------------------------------- */
  jobManager.setStage(jobId, "discovery", "Resolving target…");
  jobManager.setProgress(jobId, 3);
  jobManager.log(jobId, "INFO", `StaticSnap export started for ${target.toString()}`);
  jobManager.log(
    jobId,
    "INFO",
    `Scope=${job.options.scope} webp=${job.options.convertWebp ? "on" : "off"} external=${job.options.downloadExternal ? "local" : "keep-remote"}`,
  );

  // Verify the target is reachable before doing any heavy work.
  let reachableUrl = target.toString();
  try {
    const probe = await probeTarget(jobId, target.toString());
    if (probe.status === 403 || probe.status === 401) {
      throw new Error(
        `Target host refused the request (HTTP ${probe.status}). The site may block bots — try again later or check access rules.`,
      );
    }
    if (probe.status === 404) {
      throw new Error(`Target URL returned 404. Check the address and try again.`);
    }
    if (!probe.ok && probe.status >= 500) {
      throw new Error(`Target server error (HTTP ${probe.status}). Try again later.`);
    }
    // Consume body to free the socket; real fetch happens in harvesting.
    await probe.arrayBuffer().catch(() => undefined);
    if (probe.url && probe.url.length > 0) {
      try {
        const resolved = new URL(probe.url);
        if (resolved.hostname.toLowerCase() === baseHost) {
          reachableUrl = resolved.toString();
          const j = jobManager.get(jobId);
          if (j) j.targetUrl = reachableUrl;
        }
      } catch {
        // keep original
      }
    }
    jobManager.log(jobId, "SUCCESS", `Target resolved: ${reachableUrl} (HTTP ${probe.status})`);
  } catch (error: unknown) {
    if (error instanceof Error && /refused|404|server error/i.test(error.message)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|aborted|timeout/i.test(message)) {
      throw new Error(
        `Timed out reaching ${target.toString()} after ${PROBE_ATTEMPTS} attempt(s). The host may be slow to wake (cold cache) or blocking automated requests — try again in a moment.`,
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  let pageUrls: string[] = [reachableUrl];
  if (job.options.scope === "deep") {
    jobManager.log(jobId, "INFO", "Parsing sitemap.xml / sitemap indexes…");
    const discovered = await discoverViaSitemaps(jobId, new URL(reachableUrl));
    if (discovered.length > 0) {
      // Always include the landing page itself.
      const merged = [reachableUrl, ...discovered.filter((u) => u !== reachableUrl)];
      pageUrls = merged.slice(0, MAX_DEEP_PAGES);
      jobManager.log(jobId, "SUCCESS", `Sitemap discovery: ${pageUrls.length} page(s) queued`);
    } else {
      jobManager.log(
        jobId,
        "WARN",
        "No usable sitemap found (tried /sitemap.xml, /wp-sitemap.xml, robots.txt). Falling back to landing page only.",
      );
      pageUrls = [reachableUrl];
    }
  } else {
    jobManager.log(jobId, "INFO", "Landing-page scope: single page + local assets.");
  }

  jobManager.patchMetrics(jobId, {
    pagesDiscovered: pageUrls.length,
    pagesCompleted: 0,
    currentOperation: `Discovered ${pageUrls.length} page(s)`,
  });
  jobManager.setProgress(jobId, 12);

  // Pre-compute page file mapping so rewriting can resolve cross-links.
  const pageFileMap = new Map<string, string>(); // absolute url (no fragment) -> rel file
  const fileClaim = new Set<string>();
  for (const raw of pageUrls) {
    const u = new URL(raw);
    const key = stripFragment(u.toString());
    let rel = urlToPageFile(u);
    if (fileClaim.has(rel)) {
      const hash = createHash("md5").update(key).digest("hex").slice(0, 6);
      rel = withHashSuffix(rel, hash);
    }
    fileClaim.add(rel);
    pageFileMap.set(key, rel);
  }

  /* ---- Stage 2: Harvesting --------------------------------------- */
  jobManager.setStage(jobId, "harvesting", "Fetching pages…");
  jobManager.log(jobId, "INFO", `Harvesting ${pageUrls.length} page(s)…`);

  const limitPages = pLimit(PAGE_CONCURRENCY);
  const pages: PageRecord[] = [];
  const rawAssetUrls = new Set<string>();
  const cssPageUrls = new Set<string>(); // stylesheet absolute urls (also assets)
  let completed = 0;
  let pagesFailed = 0;
  let had403 = false;

  const harvestTasks = pageUrls.map((pageUrl) =>
    limitPages(async () => {
      const display = new URL(pageUrl).pathname || "/";
      jobManager.patchMetrics(jobId, { currentOperation: `Fetching: ${display}` });
      try {
        const res = await fetchWithTimeout(pageUrl);
        if (res.status === 403 || res.status === 401) {
          had403 = true;
          pagesFailed += 1;
          jobManager.log(jobId, "WARN", `Blocked (${res.status}) on ${pageUrl} — skipping page`);
          return;
        }
        if (!res.ok) {
          pagesFailed += 1;
          jobManager.log(jobId, "WARN", `Skipping ${pageUrl} (HTTP ${res.status})`);
          return;
        }
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!contentType.includes("html") && !contentType.includes("text/") && contentType.length > 0 && !contentType.includes("xml")) {
          pagesFailed += 1;
          jobManager.log(jobId, "WARN", `Skipping non-HTML ${pageUrl} (${contentType || "unknown type"})`);
          return;
        }
        const html = await res.text();
        if (!html || html.length < 50) {
          pagesFailed += 1;
          jobManager.log(jobId, "WARN", `Empty response from ${pageUrl} — skipping`);
          return;
        }
        const finalUrl = res.url && res.url.length > 0 ? stripFragment(res.url) : stripFragment(pageUrl);
        const file = pageFileMap.get(stripFragment(pageUrl)) ?? urlToPageFile(new URL(pageUrl));
        pages.push({ url: stripFragment(pageUrl), finalUrl, html, file });

        // Extract asset urls eagerly so the asset stage knows the workload.
        for (const asset of collectAssetUrls(html, finalUrl)) {
          rawAssetUrls.add(asset);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        pagesFailed += 1;
        jobManager.log(jobId, "WARN", `Fetch failed for ${pageUrl}: ${message}`);
      } finally {
        completed += 1;
        jobManager.patchMetrics(jobId, {
          pagesCompleted: completed,
          pagesFailed,
          currentOperation: `Harvested ${completed}/${pageUrls.length} pages`,
        });
        jobManager.setProgress(jobId, 12 + Math.round((completed / pageUrls.length) * 26));
      }
    }),
  );
  await Promise.all(harvestTasks);

  if (pages.length === 0) {
    if (had403) {
      throw new Error("Target host returned 403 Forbidden for all pages. The site is blocking automated export.");
    }
    throw new Error("No pages could be harvested. The target may be offline or blocking requests.");
  }
  jobManager.log(jobId, "SUCCESS", `Harvested ${pages.length}/${pageUrls.length} page(s), ${rawAssetUrls.size} raw asset reference(s)`);
  if (pagesFailed > 0) {
    // A success line quoting only the successes hides partial failure; say it
    // plainly so a half-mirrored bundle is not mistaken for a clean one.
    jobManager.log(
      jobId,
      "WARN",
      `${pagesFailed} page(s) could not be harvested and are missing from the bundle — see the WARN lines above or the job log file.`,
    );
  }
  jobManager.patchMetrics(jobId, { pagesFailed });
  jobManager.setProgress(jobId, 40);

  /* ---- Stage 3: Asset Engine ------------------------------------- */
  jobManager.setStage(jobId, "assets", "Downloading assets…");
  jobManager.log(
    jobId,
    "INFO",
    job.options.convertWebp ? "WebP conversion enabled (sharp, q80)." : "WebP conversion disabled — keeping original formats.",
  );

  // Decide which assets to download.
  const queued: string[] = [];
  let skippedExternal = 0;
  for (const raw of rawAssetUrls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const sameHost = parsed.hostname.toLowerCase() === baseHost;
    if (!sameHost && !job.options.downloadExternal) {
      skippedExternal += 1;
      continue;
    }
    queued.push(stripFragment(parsed.toString()));
  }
  if (skippedExternal > 0) {
    jobManager.log(jobId, "INFO", `Keeping ${skippedExternal} external CDN reference(s) remote (enable “Download external CDN assets” to inline them).`);
  }

  // Asset file mapping (pre-webp). Collisions get hash suffixes.
  const assetFileMap = new Map<string, string>();
  const claimedFiles = new Set<string>([...pageFileMap.values()]);
  for (const raw of queued) {
    const u = new URL(raw);
    let rel = assetUrlToFile(u, baseHost);
    if (claimedFiles.has(rel)) {
      const hash = createHash("md5").update(raw).digest("hex").slice(0, 8);
      rel = withHashSuffix(rel, hash);
    }
    claimedFiles.add(rel);
    assetFileMap.set(raw, rel);
  }

  const limitAssets = pLimit(ASSET_CONCURRENCY);
  const downloaded = new Map<string, AssetRecord>(); // url -> record (file may be webp-remapped)
  let doneAssets = 0;
  let assetsFailed = 0;
  let bytesTotal = 0;
  let budgetExceeded = false;
  const totalAssets = queued.length;

  jobManager.log(jobId, "INFO", `Asset engine: downloading ${totalAssets} file(s)…`);

  await Promise.all(
    queued.map((assetUrl) =>
      limitAssets(async () => {
        // Once the budget is blown, drain the queue without writing anything
        // more; the job fails immediately after this batch settles.
        if (budgetExceeded) {
          doneAssets += 1;
          return;
        }
        const rel = assetFileMap.get(assetUrl) ?? assetUrlToFile(new URL(assetUrl), baseHost);
        const displayPath = new URL(assetUrl).pathname || assetUrl;
        jobManager.patchMetrics(jobId, { currentOperation: `Downloading: ${displayPath}` });
        try {
          const record = await downloadOneAsset(assetUrl, path.join(outDir, rel), job.options.convertWebp);
          // WebP remap: sharp may have changed the extension.
          let finalRel = rel;
          if (record.finalExt && record.finalExt !== path.posix.extname(rel)) {
            const parsed = path.posix.parse(rel);
            finalRel = parsed.dir ? path.posix.join(parsed.dir, `${parsed.name}${record.finalExt}`) : `${parsed.name}${record.finalExt}`;
            // Move file if sharp wrote to a different name.
            const intendedAbs = path.join(outDir, finalRel);
            if (record.absPath !== intendedAbs) {
              await fs.ensureDir(path.dirname(intendedAbs));
              await fs.move(record.absPath, intendedAbs, { overwrite: true });
            }
          }
          downloaded.set(assetUrl, {
            url: assetUrl,
            file: finalRel,
            bytes: record.bytes,
            contentType: record.contentType,
          });
          bytesTotal += record.bytes;
          jobManager.patchMetrics(jobId, {
            assetsDownloaded: downloaded.size,
            bytesDownloaded: bytesTotal,
          });
          if (bytesTotal > MAX_JOB_BYTES && !budgetExceeded) {
            budgetExceeded = true;
            jobManager.log(
              jobId,
              "ERROR",
              `Export exceeded the ${formatBytes(MAX_JOB_BYTES)} size limit for a single job — stopping.`,
            );
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          assetsFailed += 1;
          jobManager.patchMetrics(jobId, { assetsFailed });
          jobManager.log(jobId, "WARN", `Asset skipped ${displayPath}: ${message}`);
        } finally {
          doneAssets += 1;
          if (totalAssets > 0) {
            jobManager.setProgress(jobId, 40 + Math.round((doneAssets / totalAssets) * 30));
          }
        }
      }),
    ),
  );

  if (budgetExceeded) {
    throw new Error(
      `This site is larger than the ${formatBytes(MAX_JOB_BYTES)} per-export limit. Try the landing-page scope, or run StaticSnap locally where the limit can be raised.`,
    );
  }

  // Parse downloaded stylesheets for nested url() assets (fonts, bg images).
  const cssRecords = [...downloaded.values()].filter((a) => a.file.toLowerCase().endsWith(".css"));
  if (cssRecords.length > 0) {
    jobManager.log(jobId, "INFO", `Resolving nested url() references in ${cssRecords.length} stylesheet(s)…`);
    for (const css of cssRecords) {
      try {
        const abs = path.join(outDir, css.file);
        const text = await fs.readFile(abs, "utf8");
        const nested = extractCssUrls(text);
        const cssUrl = new URL(css.url);
        const nestedLimit = pLimit(4);
        const rewrites = new Map<string, string>();
        await Promise.all(
          nested.map((raw) =>
            nestedLimit(async () => {
              const resolved = resolveUrl(raw, css.url);
              if (!resolved) return;
              if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
              const sameHost = resolved.hostname.toLowerCase() === baseHost;
              if (!sameHost && !job.options.downloadExternal) return;
              const key = stripFragment(resolved.toString());
              if (downloaded.has(key)) {
                rewrites.set(raw, downloaded.get(key)!.file);
                return;
              }
              try {
                let rel = assetUrlToFile(resolved, baseHost);
                if (claimedFiles.has(rel)) {
                  rel = withHashSuffix(rel, createHash("md5").update(key).digest("hex").slice(0, 8));
                }
                claimedFiles.add(rel);
                const rec = await downloadOneAsset(key, path.join(outDir, rel), false);
                downloaded.set(key, { url: key, file: rel, bytes: rec.bytes, contentType: rec.contentType });
                bytesTotal += rec.bytes;
                if (bytesTotal > MAX_JOB_BYTES) budgetExceeded = true;
                assetFileMap.set(key, rel);
                rewrites.set(raw, rel);
                jobManager.patchMetrics(jobId, {
                  assetsDownloaded: downloaded.size,
                  bytesDownloaded: bytesTotal,
                });
              } catch (error: unknown) {
                // Non-fatal, but not silent: an un-downloaded font or
                // background image leaves a broken reference in the bundle
                // and previously left no trace anywhere.
                assetsFailed += 1;
                jobManager.patchMetrics(jobId, { assetsFailed });
                jobManager.log(
                  jobId,
                  "WARN",
                  `Nested asset skipped ${key} (referenced by ${css.file}): ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }),
          ),
        );
        if (rewrites.size > 0) {
          let updated = text;
          for (const [raw, relFile] of rewrites) {
            const relFromCss = path.posix.relative(path.posix.dirname(css.file), relFile) || relFile;
            updated = updated.split(raw).join(relFromCss);
          }
          await fs.writeFile(abs, updated, "utf8");
        }
        // Track stylesheet urls for HTML rewriting convenience.
        cssPageUrls.add(css.url);
      } catch (error: unknown) {
        jobManager.log(jobId, "WARN", `Could not process stylesheet ${css.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  jobManager.log(
    jobId,
    "SUCCESS",
    `Assets: ${downloaded.size} file(s) | ${formatBytes(bytesTotal)}${assetsFailed > 0 ? ` | ${assetsFailed} failed` : ""}`,
  );
  if (assetsFailed > 0) {
    jobManager.log(
      jobId,
      "WARN",
      `${assetsFailed} asset(s) failed to download and still reference the live site — the bundle is not fully self-contained.`,
    );
  }
  jobManager.patchMetrics(jobId, {
    assetsDownloaded: downloaded.size,
    assetsFailed,
    bytesDownloaded: bytesTotal,
  });
  jobManager.setProgress(jobId, 72);

  /* ---- Stage 4: Link Transformation ------------------------------ */
  jobManager.setStage(jobId, "rewriting", "Rewriting links…");
  jobManager.log(jobId, "INFO", "Rewriting absolute URLs to relative offline paths…");

  // Build unified lookup: absolute url (no fragment/query-normalized) -> rel file.
  const lookup = new Map<string, string>();
  for (const [k, v] of pageFileMap) lookup.set(k, v);
  for (const [k, v] of assetFileMap) {
    // Prefer the webp-remapped file when the asset was converted.
    const dl = downloaded.get(k);
    lookup.set(k, dl ? dl.file : v);
  }
  // Also index finalUrls observed after redirects.
  for (const p of pages) {
    if (!lookup.has(p.finalUrl)) lookup.set(p.finalUrl, p.file);
  }

  let rewrittenPages = 0;
  for (const page of pages) {
    jobManager.patchMetrics(jobId, { currentOperation: `Rewriting: ${page.file}` });
    const rewritten = rewritePageHtml(page.html, page, lookup, baseHost, job.options.downloadExternal);
    const abs = path.join(outDir, page.file);
    await fs.ensureDir(path.dirname(abs));
    // Inject provenance banner right after <head> when present.
    const banner = `<!-- Mirrored by StaticSnap from ${escapeComment(page.url)} on ${new Date().toISOString()} -->`;
    const withBanner = rewritten.includes("<head")
      ? rewritten.replace(/<head([^>]*)>/i, `<head$1>\n${banner}`)
      : `${banner}\n${rewritten}`;
    await fs.writeFile(abs, withBanner, "utf8");
    rewrittenPages += 1;
    jobManager.setProgress(jobId, 72 + Math.round((rewrittenPages / pages.length) * 14));
  }

  // Manifest for provenance / debugging.
  await fs.writeFile(
    path.join(outDir, "staticsnap-manifest.json"),
    JSON.stringify(
      {
        generator: "StaticSnap/1.0",
        source: target.toString(),
        exportedAt: new Date().toISOString(),
        scope: job.options.scope,
        pages: pages.map((p) => ({ url: p.url, file: p.file })),
        assets: [...downloaded.values()].map((a) => ({ url: a.url, file: a.file, bytes: a.bytes })),
        bytesDownloaded: bytesTotal,
        pagesFailed,
        assetsFailed,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  jobManager.log(jobId, "SUCCESS", `Rewrote ${rewrittenPages} page(s) to relative offline paths`);
  jobManager.setProgress(jobId, 88);

  /* ---- Stage 5: Archive Generation ------------------------------- */
  jobManager.setStage(jobId, "archiving", "Building .zip bundle…");
  jobManager.patchMetrics(jobId, { currentOperation: "Archiving: compressing site…" });
  jobManager.log(jobId, "INFO", "Building self-contained .zip bundle…");

  const zipPath = jobManager.get(jobId)?.zipPath;
  if (!zipPath) throw new Error("Job zip path missing");
  await fs.ensureDir(path.dirname(zipPath));
  const { bytes } = await createZip(outDir, zipPath, (archived) => {
    jobManager.patchMetrics(jobId, { currentOperation: `Archiving: ${archived} entries…` });
  });

  jobManager.log(jobId, "SUCCESS", `Archive ready: ${formatBytes(bytes)} (${downloaded.size} assets, ${pages.length} pages)`);
  jobManager.setProgress(jobId, 100);
  jobManager.markComplete(jobId, bytes);
}

/* ------------------------------------------------------------------ */
/* asset collection + downloading                                      */
/* ------------------------------------------------------------------ */

function collectAssetUrls(html: string, pageUrl: string): string[] {
  const found = new Set<string>();
  const push = (raw: string | undefined): void => {
    if (!raw || raw.trim().length === 0) return;
    if (isSkippable(raw)) return;
    const resolved = resolveUrl(stripFragment(raw.trim()), pageUrl);
    if (!resolved) return;
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    found.add(stripFragment(resolved.toString()));
  };

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  $("img[src]").each((_, el) => push($(el).attr("src")));
  $("img[srcset]").each((_, el) => {
    for (const e of parseSrcset($(el).attr("srcset") ?? "")) push(e.url);
  });
  $("img[data-src]").each((_, el) => push($(el).attr("data-src")));
  $("source[src]").each((_, el) => push($(el).attr("src")));
  $("source[srcset]").each((_, el) => {
    for (const e of parseSrcset($(el).attr("srcset") ?? "")) push(e.url);
  });
  $("video[src]").each((_, el) => push($(el).attr("src")));
  $("video[poster]").each((_, el) => push($(el).attr("poster")));
  $("audio[src]").each((_, el) => push($(el).attr("src")));
  $("track[src]").each((_, el) => push($(el).attr("src")));
  $("embed[src]").each((_, el) => push($(el).attr("src")));
  $("input[src]").each((_, el) => push($(el).attr("src")));
  $('link[rel*="stylesheet"][href]').each((_, el) => push($(el).attr("href")));
  $('link[rel*="icon"][href]').each((_, el) => push($(el).attr("href")));
  $('link[rel*="manifest"][href]').each((_, el) => push($(el).attr("href")));
  $('link[rel*="preload"][href]').each((_, el) => push($(el).attr("href")));
  $("script[src]").each((_, el) => push($(el).attr("src")));

  // Inline <style> blocks + style="…" attributes.
  $("style").each((_, el) => {
    for (const u of extractCssUrls($(el).html() ?? "")) push(u);
  });
  $("[style]").each((_, el) => {
    for (const u of extractCssUrls($(el).attr("style") ?? "")) push(u);
  });

  // Open-graph / twitter images are real assets worth inlining.
  $('meta[property="og:image"][content], meta[name="twitter:image"][content]').each((_, el) => {
    push($(el).attr("content"));
  });

  return [...found];
}

interface DownloadResult {
  absPath: string;
  bytes: number;
  contentType: string;
  finalExt: string | null;
}

async function downloadOneAsset(
  url: string,
  absPath: string,
  convertWebp: boolean,
): Promise<DownloadResult> {
  const res = await fetchWithTimeout(url, { headers: { Accept: "*/*" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty file");
  if (buf.length > 60 * 1024 * 1024) throw new Error("file too large (>60MB), skipped");

  await fs.ensureDir(path.dirname(absPath));

  const ext = path.extname(absPath).toLowerCase().replace(".", "");
  const shouldWebp =
    convertWebp &&
    RASTER_EXTS.has(ext) &&
    (contentType.includes("jpeg") ||
      contentType.includes("jpg") ||
      contentType.includes("png") ||
      contentType === "" ||
      contentType.includes("octet-stream"));

  if (shouldWebp) {
    try {
      const webp = await sharp(buf).webp({ quality: 80 }).toBuffer();
      const parsed = path.parse(absPath);
      const webpAbs = path.join(parsed.dir, `${parsed.name}.webp`);
      await fs.writeFile(webpAbs, webp);
      return { absPath: webpAbs, bytes: webp.length, contentType: "image/webp", finalExt: ".webp" };
    } catch {
      // fall through to original bytes on sharp failure
    }
  }

  await fs.writeFile(absPath, buf);
  return { absPath, bytes: buf.length, contentType, finalExt: path.extname(absPath).toLowerCase() || null };
}

/* ------------------------------------------------------------------ */
/* HTML rewriting                                                      */
/* ------------------------------------------------------------------ */

const REWRITE_ATTRS: Array<{ selector: string; attr: string }> = [
  { selector: "a[href]", attr: "href" },
  { selector: "link[href]", attr: "href" },
  { selector: "img[src]", attr: "src" },
  { selector: "img[data-src]", attr: "data-src" },
  { selector: "source[src]", attr: "src" },
  { selector: "video[src]", attr: "src" },
  { selector: "video[poster]", attr: "poster" },
  { selector: "audio[src]", attr: "src" },
  { selector: "track[src]", attr: "src" },
  { selector: "embed[src]", attr: "src" },
  { selector: "input[src]", attr: "src" },
  { selector: "script[src]", attr: "src" },
  { selector: "form[action]", attr: "action" },
  { selector: "meta[property='og:image'][content]", attr: "content" },
  { selector: "meta[name='twitter:image'][content]", attr: "content" },
];

const SRCSET_ATTRS = new Set(["srcset", "data-srcset"]);

function rewriteUrlValue(
  raw: string,
  page: PageRecord,
  lookup: Map<string, string>,
  baseHost: string,
  downloadExternal: boolean,
): string | null {
  if (!raw || isSkippable(raw)) return null;
  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf("#");
  const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : "";
  const withoutHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  if (withoutHash.length === 0) return null; // pure fragment link — keep

  const resolved = resolveUrl(withoutHash, page.finalUrl || page.url);
  if (!resolved) return null;
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;

  const key = stripFragment(resolved.toString());
  let targetFile = lookup.get(key);

  // Same-host links that were never harvested (e.g. unqueued routes) still
  // get a deterministic offline path so navigation degrades gracefully.
  if (!targetFile) {
    const sameHost = resolved.hostname.toLowerCase() === baseHost;
    if (!sameHost) return null;
    // Only rewrite page-like links (no asset extension or .html).
    const ext = path.posix.extname(resolved.pathname).toLowerCase();
    const pageLike =
      ext === "" || ext === ".html" || ext === ".htm" || ext === "/" || resolved.pathname.endsWith("/");
    if (!pageLike) return null;
    if (!downloadExternal && !sameHost) return null;
    targetFile = urlToPageFile(resolved);
  } else if (resolved.hostname.toLowerCase() !== baseHost) {
    // External URL that was downloaded locally (downloadExternal=true).
    // lookup hit means it was downloaded — rewrite it.
  }

  // Don't rewrite same-host absolute URLs that point nowhere known AND look
  // like assets we chose not to download.
  if (!targetFile) return null;

  let rel = path.posix.relative(path.posix.dirname(page.file), targetFile);
  if (!rel || rel.length === 0) rel = path.posix.basename(targetFile);
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
  // Preserve query strings (e.g. ?v=123 cache-busters on downloaded files were
  // stripped at save time, so drop them) but keep fragments.
  return `${rel.split("?")[0]}${hash}`;
}

function rewriteSrcsetValue(
  srcset: string,
  page: PageRecord,
  lookup: Map<string, string>,
  baseHost: string,
  downloadExternal: boolean,
): string | null {
  const entries = parseSrcset(srcset);
  if (entries.length === 0) return null;
  let changed = false;
  const out = entries.map((e) => {
    // Inline data: candidates are passed through untouched — rewriting one
    // would replace a working inline image with a broken local path.
    const next = isSkippable(e.url)
      ? null
      : rewriteUrlValue(e.url, page, lookup, baseHost, downloadExternal);
    if (next && next !== e.url) {
      changed = true;
      return e.descriptor ? `${next} ${e.descriptor}` : next;
    }
    return e.descriptor ? `${e.url} ${e.descriptor}` : e.url;
  });
  return changed ? out.join(", ") : null;
}

function rewriteCssText(
  css: string,
  page: PageRecord,
  lookup: Map<string, string>,
  baseHost: string,
  downloadExternal: boolean,
): { text: string; changed: boolean } {
  let changed = false;
  const text = css.replace(
    /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))\s*\)/gi,
    (whole: string, d1: string | undefined, d2: string | undefined, d3: string | undefined) => {
      const raw = (d1 ?? d2 ?? d3 ?? "").trim();
      if (!raw || isSkippable(raw)) return whole;
      const next = rewriteUrlValue(raw, page, lookup, baseHost, downloadExternal);
      if (next && next !== raw) {
        changed = true;
        return `url("${next}")`;
      }
      return whole;
    },
  );
  return { text, changed };
}

export function rewritePageHtml(
  html: string,
  page: PageRecord,
  lookup: Map<string, string>,
  baseHost: string,
  downloadExternal: boolean,
): string {
  const $ = cheerio.load(html);

  // <base> breaks relative offline links — drop it loudly.
  $("base[href]").remove();

  for (const { selector, attr } of REWRITE_ATTRS) {
    $(selector).each((_, el) => {
      const current = $(el).attr(attr);
      if (!current) return;
      const next = rewriteUrlValue(current, page, lookup, baseHost, downloadExternal);
      if (next && next !== current) $(el).attr(attr, next);
    });
  }

  // srcset / data-srcset need descriptor-aware rewriting.
  for (const attr of SRCSET_ATTRS) {
    $(`[${attr}]`).each((_, el) => {
      const current = $(el).attr(attr);
      if (!current) return;
      const next = rewriteSrcsetValue(current, page, lookup, baseHost, downloadExternal);
      if (next) $(el).attr(attr, next);
    });
  }

  // Inline styles.
  $("style").each((_, el) => {
    const inner = $(el).html() ?? "";
    if (!inner) return;
    const { text, changed } = rewriteCssText(inner, page, lookup, baseHost, downloadExternal);
    if (changed) $(el).text(text);
  });
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (!style) return;
    const { text, changed } = rewriteCssText(style, page, lookup, baseHost, downloadExternal);
    if (changed) $(el).attr("style", text);
  });

  return $.html();
}

function escapeComment(value: string): string {
  return value.replace(/--/g, "—").replace(/</g, "&lt;");
}

/** Re-exported for tests: pause helper. */
export const __testables = { urlToPageFile, assetUrlToFile, parseSrcset, extractCssUrls };

export { sleep };
