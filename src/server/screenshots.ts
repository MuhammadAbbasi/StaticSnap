import path from "node:path";
import { createHash } from "node:crypto";
import fs from "fs-extra";
import pLimit from "p-limit";
import { BROWSER_HEADERS } from "../fetcher.js";

/**
 * Headless screenshot engine for StaticSnap page captures.
 *
 * Renders already-harvested page URLs in a real Chromium (via Playwright) at
 * one viewport per selected device class and writes PNGs into individual
 * per-viewport folders (`desktop/`, `tablet/`, `mobile/`). The caller zips the
 * directory as a *separate* screenshots bundle so the main static-site export
 * stays fast and downloadable while captures continue in the background.
 *
 * Playwright is imported lazily inside {@link captureScreenshots} so the
 * server boots and serves normal exports even when the browser was never
 * downloaded (`npx playwright install chromium`). A missing browser fails
 * only the screenshots phase — never the main bundle.
 */

/** Device classes offered as dashboard screenshot options. */
export type ScreenshotViewport = "desktop" | "tablet" | "mobile";

/** Deterministic folder order (also the zip layout). */
export const SCREENSHOT_VIEWPORT_ORDER: ScreenshotViewport[] = [
  "desktop",
  "tablet",
  "mobile",
];

export interface ViewportSpec {
  width: number;
  height: number;
  label: string;
  /** Touch events enabled in the capture context. */
  hasTouch: boolean;
  /** Serve mobile markup via a phone user-agent. */
  mobileUA: boolean;
}

export const SCREENSHOT_VIEWPORTS: Record<ScreenshotViewport, ViewportSpec> = {
  desktop: { width: 1280, height: 800, label: "Desktop 1280×800", hasTouch: false, mobileUA: false },
  tablet: { width: 768, height: 1024, label: "Tablet 768×1024", hasTouch: false, mobileUA: false },
  mobile: { width: 390, height: 844, label: "Mobile 390×844", hasTouch: true, mobileUA: true },
};

/** Phone UA served to the mobile viewport so sites return mobile markup. */
export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.69 Mobile/15E148 Safari/604.1";

/** Per-page navigation + capture budget. */
export const SCREENSHOT_TIMEOUT_MS = Number(
  process.env.STATICSNAP_SCREENSHOT_TIMEOUT_MS ?? 30_000,
);

/** Concurrent pages per viewport context (browsers are heavy; keep low). */
export const SCREENSHOT_CONCURRENCY = Number(
  process.env.STATICSNAP_SCREENSHOT_CONCURRENCY ?? 2,
);

/**
 * Absolute ceiling on captures per job (pages × viewports).
 *
 * Deep crawls harvest up to 120 pages; × 3 viewports = 360 PNGs worst case.
 * Anything beyond the cap is skipped with a warning, oldest-discovered first.
 */
export const MAX_SCREENSHOTS = Number(process.env.STATICSNAP_MAX_SCREENSHOTS ?? 360);

/**
 * Keep only valid, de-duplicated viewport ids, in canonical folder order.
 *
 * Unknown values (e.g. from a hand-crafted API call) are dropped rather than
 * rejected so a typo degrades to fewer captures instead of a 400.
 */
export function normalizeScreenshotViewports(input: unknown): ScreenshotViewport[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (value === "desktop" || value === "tablet" || value === "mobile") {
      seen.add(value);
    }
  }
  return SCREENSHOT_VIEWPORT_ORDER.filter((viewport) => seen.has(viewport));
}

/**
 * Resolve the effective viewport list for a job creation request.
 *
 * Accepts the canonical `screenshotViewports` array plus the legacy `screenshots`
 * boolean shortcut (`true` with no explicit list means desktop-only). Empty
 * means screenshots are disabled for the job.
 */
export function resolveScreenshotViewports(options: {
  screenshotViewports?: unknown;
  screenshots?: unknown;
}): ScreenshotViewport[] {
  const fromList = normalizeScreenshotViewports(options.screenshotViewports);
  if (fromList.length > 0) return fromList;
  if (options.screenshots === true) return ["desktop"];
  return [];
}

/**
 * Map a page URL to a safe PNG filename (`home.png`, `about-team.png`).
 *
 * Collisions (two URLs slugifying identically) get a short md5 suffix, then a
 * counter as a last resort. `used` tracks names already claimed *within one
 * viewport folder* — folders are independent, so each viewport gets its own set.
 */
export function screenshotFilename(pageUrl: string, used: Set<string>): string {
  let slug = "page";
  try {
    const parsed = new URL(pageUrl);
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        try {
          segment = decodeURIComponent(segment);
        } catch {
          // keep raw segment
        }
        return segment
          .trim()
          .replace(/[^a-zA-Z0-9._-]+/g, "_")
          .replace(/_+/g, "_");
      })
      .filter((segment) => segment.length > 0);
    slug = parts.length === 0 ? "home" : parts.join("-");
  } catch {
    slug = "page";
  }
  if (slug.length > 120) slug = slug.slice(0, 120);

  let name = `${slug}.png`;
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const hash = createHash("md5").update(pageUrl).digest("hex").slice(0, 6);
  name = `${slug}-${hash}.png`;
  let counter = 2;
  while (used.has(name)) {
    name = `${slug}-${hash}-${counter}.png`;
    counter += 1;
  }
  used.add(name);
  return name;
}

export interface ScreenshotPage {
  url: string;
}

export interface ScreenshotTarget {
  /** Live page URL to render. */
  url: string;
  viewport: ScreenshotViewport;
  /** Relative posix path inside the shots dir, e.g. `desktop/home.png`. */
  file: string;
}

/**
 * Expand harvested pages × selected viewports into capture targets.
 *
 * One filename set per viewport folder. The list is truncated to
 * {@link MAX_SCREENSHOTS} (viewport-major order) and reports how many were
 * dropped so the caller can say so in the job log.
 */
export function buildScreenshotTargets(
  pages: ScreenshotPage[],
  viewports: ScreenshotViewport[],
): { targets: ScreenshotTarget[]; truncated: number } {
  const targets: ScreenshotTarget[] = [];
  for (const viewport of viewports) {
    const used = new Set<string>();
    for (const page of pages) {
      if (!page.url || page.url.trim().length === 0) continue;
      targets.push({
        url: page.url,
        viewport,
        file: path.posix.join(viewport, screenshotFilename(page.url, used)),
      });
    }
  }
  if (targets.length <= MAX_SCREENSHOTS) {
    return { targets, truncated: 0 };
  }
  return {
    targets: targets.slice(0, MAX_SCREENSHOTS),
    truncated: targets.length - MAX_SCREENSHOTS,
  };
}

export interface CapturedScreenshot {
  url: string;
  viewport: ScreenshotViewport;
  file: string;
  bytes: number;
}

export interface ScreenshotFailure {
  url: string;
  viewport: ScreenshotViewport;
  file: string;
  error: string;
}

export interface ScreenshotResult {
  completed: number;
  failed: number;
  files: CapturedScreenshot[];
  failures: ScreenshotFailure[];
}

/**
 * Render every target in headless Chromium and write PNGs under `shotsDir`.
 *
 * One browser, one context per viewport (contexts carry the viewport size),
 * pages captured with bounded concurrency. A single page failing (timeout,
 * navigation error, screenshot error) is recorded — never thrown — so one bad
 * page cannot sink the other captures.
 *
 * @throws when the Playwright browser is not installed or cannot launch.
 */
export async function captureScreenshots(
  targets: ScreenshotTarget[],
  shotsDir: string,
  onCapture?: (done: number, total: number, target: ScreenshotTarget) => void,
): Promise<ScreenshotResult> {
  if (!shotsDir || shotsDir.trim().length === 0) {
    throw new Error("captureScreenshots: shotsDir must be a non-empty string");
  }
  const result: ScreenshotResult = { completed: 0, failed: 0, files: [], failures: [] };
  if (targets.length === 0) return result;

  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Screenshots need Playwright's Chromium browser, which is not installed on this server (run `npx playwright install chromium`).",
    );
  }

  const userAgent = BROWSER_HEADERS["User-Agent"];
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not launch Chromium for screenshots: ${message}`);
  }

  try {
    const byViewport = new Map<ScreenshotViewport, ScreenshotTarget[]>();
    for (const target of targets) {
      const list = byViewport.get(target.viewport) ?? [];
      list.push(target);
      byViewport.set(target.viewport, list);
    }

    let done = 0;
    for (const viewport of SCREENSHOT_VIEWPORT_ORDER) {
      const list = byViewport.get(viewport);
      if (!list || list.length === 0) continue;
      const spec = SCREENSHOT_VIEWPORTS[viewport];
      const context = await browser.newContext({
        viewport: { width: spec.width, height: spec.height },
        deviceScaleFactor: 1,
        // Deliberately NOT isMobile: with mobile viewport handling, pages
        // lacking <meta name="viewport"> render at the legacy 980px layout
        // width and the full-page PNG comes out 980 wide instead of 390.
        // Width-based capture keeps every PNG exactly its viewport's width;
        // the phone UA + touch still get mobile markup and behaviour.
        isMobile: false,
        hasTouch: spec.hasTouch,
        ignoreHTTPSErrors: true,
        ...(spec.mobileUA
          ? { userAgent: MOBILE_USER_AGENT }
          : userAgent !== undefined
            ? { userAgent }
            : {}),
      });
      try {
        const limit = pLimit(
          Number.isFinite(SCREENSHOT_CONCURRENCY) && SCREENSHOT_CONCURRENCY >= 1
            ? Math.floor(SCREENSHOT_CONCURRENCY)
            : 2,
        );
        await Promise.all(
          list.map((target) =>
            limit(async () => {
              const absPath = path.join(shotsDir, ...target.file.split("/"));
              try {
                await fs.ensureDir(path.dirname(absPath));
                const page = await context.newPage();
                try {
                  // networkidle gives above-the-fold fidelity; when it times
                  // out (long-polling, slow third parties) the page is still
                  // rendered, so fall through to the screenshot regardless.
                  await page
                    .goto(target.url, {
                      waitUntil: "networkidle",
                      timeout: SCREENSHOT_TIMEOUT_MS,
                    })
                    .catch(() => undefined);
                  await page.screenshot({
                    path: absPath,
                    fullPage: true,
                    timeout: SCREENSHOT_TIMEOUT_MS,
                  });
                } finally {
                  await page.close().catch(() => undefined);
                }
                const stat = await fs.stat(absPath);
                result.files.push({
                  url: target.url,
                  viewport: target.viewport,
                  file: target.file,
                  bytes: stat.size,
                });
                result.completed += 1;
              } catch (error: unknown) {
                result.failed += 1;
                result.failures.push({
                  url: target.url,
                  viewport: target.viewport,
                  file: target.file,
                  error: error instanceof Error ? error.message : String(error),
                });
              } finally {
                done += 1;
                try {
                  onCapture?.(done, targets.length, target);
                } catch {
                  // Telemetry must never break capturing.
                }
              }
            }),
          ),
        );
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return result;
}

export default captureScreenshots;
