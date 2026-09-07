/**
 * Screenshots option checks (no browser required).
 *
 * Covers the pure helpers in `src/server/screenshots.ts` (viewport
 * definitions, option normalization, PNG filename mapping and target
 * expansion) plus the live API surface: job creation accepts
 * `screenshotViewports`, job detail exposes the screenshots state without
 * leaking server paths, and the separate screenshots download endpoint
 * answers 404/409 correctly while captures are disabled or pending.
 *
 * The real Chromium rendering path is exercised only when the browser is
 * installed; here the missing browser must surface as a clean launch error
 * (the crawler turns that into a WARN, never a failed export).
 *
 * Run: `npm run build && node ./tests/screenshots.test.mjs`
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const serverEntry = path.join(repoRoot, "dist", "server", "server.js");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const {
  SCREENSHOT_VIEWPORTS,
  SCREENSHOT_VIEWPORT_ORDER,
  normalizeScreenshotViewports,
  resolveScreenshotViewports,
  screenshotFilename,
  buildScreenshotTargets,
  captureScreenshots,
} = await import("../dist/server/screenshots.js");

/* ---- viewport definitions ---- */
check("three viewports in canonical order", JSON.stringify(SCREENSHOT_VIEWPORT_ORDER) === JSON.stringify(["desktop", "tablet", "mobile"]));
check("desktop is 1280x800", SCREENSHOT_VIEWPORTS.desktop?.width === 1280 && SCREENSHOT_VIEWPORTS.desktop?.height === 800);
check("tablet is 768x1024", SCREENSHOT_VIEWPORTS.tablet?.width === 768 && SCREENSHOT_VIEWPORTS.tablet?.height === 1024);
check("mobile is 390x844", SCREENSHOT_VIEWPORTS.mobile?.width === 390 && SCREENSHOT_VIEWPORTS.mobile?.height === 844);

/* ---- option normalization ---- */
check("dedupes + orders viewports", JSON.stringify(normalizeScreenshotViewports(["mobile", "desktop", "mobile"])) === JSON.stringify(["desktop", "mobile"]));
check("drops unknown values", JSON.stringify(normalizeScreenshotViewports(["desktop", "watch", 42, null])) === JSON.stringify(["desktop"]));
check("non-array disables", normalizeScreenshotViewports(undefined).length === 0 && normalizeScreenshotViewports("desktop").length === 0);
check("explicit list wins", JSON.stringify(resolveScreenshotViewports({ screenshotViewports: ["mobile"], screenshots: true })) === JSON.stringify(["mobile"]));
check("boolean shortcut means desktop-only", JSON.stringify(resolveScreenshotViewports({ screenshots: true })) === JSON.stringify(["desktop"]));
check("nothing selected disables", resolveScreenshotViewports({}).length === 0 && resolveScreenshotViewports({ screenshots: false }).length === 0);

/* ---- filename mapping ---- */
check("root maps to home.png", screenshotFilename("https://ex.com/", new Set()) === "home.png");
check("trailing slash dropped", screenshotFilename("https://ex.com/about/", new Set()) === "about.png");
check("nested path joined", screenshotFilename("https://ex.com/about/team/", new Set()) === "about-team.png");
{
  const used = new Set(["about.png"]);
  const name = screenshotFilename("https://ex.com/about/", used);
  check("collision gets a hash suffix", /^about-[a-f0-9]{6}\.png$/.test(name), name);
}
check("query strings ignored", screenshotFilename("https://ex.com/a/?x=1", new Set()) === "a.png");

/* ---- target expansion ---- */
{
  const pages = [{ url: "https://ex.com/" }, { url: "https://ex.com/about/" }, { url: "" }];
  const { targets, truncated } = buildScreenshotTargets(pages, ["desktop", "mobile"]);
  check("pages x viewports expand", targets.length === 4, JSON.stringify(targets.length));
  check("nothing truncated", truncated === 0);
  check(
    "individual viewport folders",
    targets.every((t) => t.file === `${t.viewport}/${t.file.split("/").pop()}`) &&
      targets.filter((t) => t.viewport === "desktop").length === 2 &&
      targets.filter((t) => t.viewport === "mobile").length === 2,
    JSON.stringify(targets),
  );
}
{
  // 200 pages x 2 viewports = 400 > default 360 cap.
  const pages = Array.from({ length: 200 }, (_, i) => ({ url: `https://ex.com/p${i}/` }));
  const { targets, truncated } = buildScreenshotTargets(pages, ["desktop", "tablet"]);
  check("capture cap truncates deterministically", targets.length === 360 && truncated === 40, `${targets.length}/${truncated}`);
}

/* ---- missing browser surfaces cleanly (crawler turns this into a WARN) ---- */
{
  // Deterministic regardless of environment: no shots dir, no captures.
  let emptyDirMessage = "";
  try {
    await captureScreenshots(
      [{ url: "https://ex.com/", viewport: "desktop", file: "desktop/home.png" }],
      "   ",
    );
  } catch (error) {
    emptyDirMessage = error?.message ?? String(error);
  }
  check("empty shots dir throws", /shotsDir/.test(emptyDirMessage), emptyDirMessage.slice(0, 120));

  // Browser-dependent: only assert the missing-browser error when no browser
  // is installed (CI). Where Chromium exists, real rendering is covered by a
  // live run instead of this unit suite.
  const { homedir } = await import("node:os");
  const { readdirSync } = await import("node:fs");
  const roots = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "ms-playwright")]
      : [path.join(homedir(), ".cache", "ms-playwright")];
  const browserInstalled = roots.some((root) => {
    try {
      return readdirSync(root).some((entry) => entry.startsWith("chromium"));
    } catch {
      return false;
    }
  });
  if (browserInstalled) {
    console.log("  SKIP  unusable browser throws (Chromium installed — covered live)");
  } else {
    let message = "";
    try {
      await captureScreenshots(
        [{ url: "https://ex.com/", viewport: "desktop", file: "desktop/home.png" }],
        path.join(repoRoot, "does-not-matter"),
      );
    } catch (error) {
      message = error?.message ?? String(error);
    }
    check("unusable browser throws a Chromium error", /chromium/i.test(message), message.slice(0, 160));
  }
}

/* ---- live API surface ---- */
if (!existsSync(serverEntry)) {
  console.error("screenshots: build first");
  process.exit(1);
}
const port = 4100 + Math.floor(Math.random() * 200);
const app = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    STATICSNAP_ALLOW_PRIVATE: "1",
    STATICSNAP_RATE_MAX: "100",
  },
  stdio: "ignore",
});

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

try {
  check("server boots", await waitForHealth());

  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // Unknown viewport ids are rejected by the schema.
  {
    const res = await post({ url: "https://example.com/", scope: "landing", screenshotViewports: ["watch"] });
    check("unknown viewport is a 400", res.status === 400, `HTTP ${res.status}`);
  }

  // Legacy boolean shortcut resolves to desktop-only.
  {
    const res = await post({ url: "https://example.com/", scope: "landing", screenshots: true });
    const body = await res.json().catch(() => ({}));
    check("screenshots:true accepted", res.status === 201 && typeof body.jobId === "string", `HTTP ${res.status}`);
    if (body.jobId) {
      const detail = await fetch(`http://127.0.0.1:${port}/api/jobs/${body.jobId}`).then((r) => r.json());
      check("boolean shortcut resolves to desktop", JSON.stringify(detail.options?.screenshotViewports) === JSON.stringify(["desktop"]), JSON.stringify(detail.options));
      check("screenshots pending at creation", detail.screenshotsStatus === "pending", detail.screenshotsStatus);
      check("no screenshots URL before capture", detail.screenshotsDownloadUrl === null || detail.screenshotsDownloadUrl === undefined, String(detail.screenshotsDownloadUrl));
      check("server paths not leaked", detail.screenshotsDir === undefined && detail.screenshotZipPath === undefined && detail.zipPath === undefined, Object.keys(detail).filter((k) => /dir|path/i.test(k)).join(","));
      const shots = await fetch(`http://127.0.0.1:${port}/api/download/${body.jobId}/screenshots`);
      check("screenshots endpoint 409 while rendering", shots.status === 409, `HTTP ${shots.status}`);
    }
  }

  // Explicit multi-viewport selection is stored verbatim.
  {
    const res = await post({ url: "https://example.com/", scope: "landing", screenshotViewports: ["mobile", "desktop"] });
    const body = await res.json().catch(() => ({}));
    check("viewport list accepted", res.status === 201 && typeof body.jobId === "string", `HTTP ${res.status}`);
    if (body.jobId) {
      const detail = await fetch(`http://127.0.0.1:${port}/api/jobs/${body.jobId}`).then((r) => r.json());
      check("viewports stored in canonical order", JSON.stringify(detail.options?.screenshotViewports) === JSON.stringify(["desktop", "mobile"]), JSON.stringify(detail.options?.screenshotViewports));
    }
  }

  // Default jobs are untouched: screenshots disabled, endpoint 404s.
  {
    const res = await post({ url: "https://example.com/", scope: "landing" });
    const body = await res.json().catch(() => ({}));
    check("plain job still accepted", res.status === 201 && typeof body.jobId === "string", `HTTP ${res.status}`);
    if (body.jobId) {
      const detail = await fetch(`http://127.0.0.1:${port}/api/jobs/${body.jobId}`).then((r) => r.json());
      check("screenshots disabled by default", detail.screenshotsStatus === "disabled", detail.screenshotsStatus);
      const shots = await fetch(`http://127.0.0.1:${port}/api/download/${body.jobId}/screenshots`);
      const shotsBody = await shots.json().catch(() => ({}));
      check("screenshots endpoint 404 when not requested", shots.status === 404 && typeof shotsBody.error === "string", `HTTP ${shots.status}`);
      const main = await fetch(`http://127.0.0.1:${port}/api/download/${body.jobId}`);
      check("main bundle 409 while still building", main.status === 409, `HTTP ${main.status}`);
    }
  }
} finally {
  app.kill();
}

if (failures > 0) {
  console.error(`\nscreenshots: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("\nscreenshots: ALL CHECKS PASSED");
