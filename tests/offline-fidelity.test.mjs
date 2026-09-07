/**
 * End-to-end proof that an exported bundle runs the same way offline.
 *
 * Stands up an origin site (HTML + CSS + JS + images + a webfont + a nested
 * CSS url(), across two sitemap-listed pages), exports it through the real
 * StaticSnap server, unzips the delivered bundle, then **kills the origin**
 * and serves the bundle. Every page and asset must still resolve, with no
 * surviving reference to the origin.
 *
 * Run: `npm run build && node ./tests/offline-fidelity.test.mjs`
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const serverEntry = path.join(repoRoot, "dist", "server", "server.js");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const WOFF = Buffer.from("d09GRgABAAAAAAAQAAoAAAAAAAAAAAAAAAAAAAAAAAAA", "base64");
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- origin site ---------------- */
let originPort = 0;
const origin = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const html = (title, other) => `<!doctype html><html><head>
<title>${title}</title><link rel="stylesheet" href="/assets/site.css">
<script src="/assets/app.js" defer></script></head>
<body><h1>${title}</h1>
<img src="/assets/hero.png" srcset="${GIF} 1x, /assets/hero.png 2x" alt="hero">
<img src="${GIF}" alt="placeholder">
<p style="background:url('/assets/inline.png')">styled</p>
<a href="${other}">go</a></body></html>`;
  if (url === "/") return void res.writeHead(200, { "Content-Type": "text/html" }).end(html("Home", "/about/"));
  if (url === "/about/") return void res.writeHead(200, { "Content-Type": "text/html" }).end(html("About", "/"));
  if (url === "/assets/site.css")
    return void res.writeHead(200, { "Content-Type": "text/css" }).end(
      `@font-face{font-family:X;src:url('/assets/font.woff')}body{background:url('/assets/bg.png');font-family:X}`,
    );
  if (url === "/assets/app.js") return void res.writeHead(200, { "Content-Type": "application/javascript" }).end("window.OK=1;");
  if (url === "/assets/font.woff") return void res.writeHead(200, { "Content-Type": "font/woff" }).end(WOFF);
  if (url.startsWith("/assets/") && url.endsWith(".png"))
    return void res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
  if (url === "/sitemap.xml")
    return void res.writeHead(200, { "Content-Type": "application/xml" }).end(
      `<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:${originPort}/</loc></url><url><loc>http://127.0.0.1:${originPort}/about/</loc></url></urlset>`,
    );
  res.writeHead(404).end("nope");
});

/* ---------------- bundle host (offline) ---------------- */
function serveDir(root) {
  const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".woff": "font/woff", ".json": "application/json" };
  return createServer((req, res) => {
    let rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (rel.endsWith("/")) rel += "index.html";
    const abs = path.join(root, rel.replace(/^\/+/, ""));
    if (!abs.startsWith(root) || !existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404).end("missing");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(abs).toLowerCase()] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
  });
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`offline-fidelity: build first (missing ${serverEntry})`);
    process.exit(1);
  }

  const work = mkdtempSync(path.join(tmpdir(), "staticsnap-fidelity-"));
  const zipPath = path.join(work, "bundle.zip");
  const extractDir = path.join(work, "bundle");
  let app = null;
  let bundleHost = null;

  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  originPort = origin.address().port;
  console.log(`fidelity: origin on http://127.0.0.1:${originPort}`);

  const appPort = 3300 + Math.floor(Math.random() * 300);
  app = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      STATICSNAP_LOG_DIR: path.join(work, "logs"),
      // Crawls a local origin; the guard blocks that by default. Opt in.
      STATICSNAP_ALLOW_PRIVATE: "1",
    },
    stdio: "ignore",
  });

  try {
    // wait for readiness
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${appPort}/api/health`);
        if (r.ok) break;
      } catch {}
      await sleep(250);
    }

    const created = await fetch(`http://127.0.0.1:${appPort}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${originPort}/`, scope: "deep", convertWebp: false }),
    }).then((r) => r.json());
    check("job accepted", typeof created.jobId === "string", JSON.stringify(created));
    const jobId = created.jobId;

    let detail = null;
    for (let i = 0; i < 120; i += 1) {
      detail = await fetch(`http://127.0.0.1:${appPort}/api/jobs/${jobId}`).then((r) => r.json());
      if (detail.status === "completed" || detail.status === "failed") break;
      await sleep(250);
    }
    check("export completed", detail?.status === "completed", `${detail?.status}: ${detail?.error}`);
    check("both sitemap pages harvested", detail?.metrics?.pagesCompleted === 2, String(detail?.metrics?.pagesCompleted));
    check("no asset failures", detail?.metrics?.assetsFailed === 0, String(detail?.metrics?.assetsFailed));

    const dl = await fetch(`http://127.0.0.1:${appPort}/api/download/${jobId}`);
    check("bundle downloads", dl.ok && dl.headers.get("content-type") === "application/zip", String(dl.status));
    await pipeline(Readable.fromWeb(dl.body), createWriteStream(zipPath));
    check("zip is non-trivial", statSync(zipPath).size > 500, `${statSync(zipPath).size} bytes`);

    // Unzip with the platform's own tool so the delivered artifact is tested.
    await new Promise((resolve) => {
      const unzip = process.platform === "win32"
        ? spawn("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`], { stdio: "ignore" })
        : spawn("unzip", ["-q", "-o", zipPath, "-d", extractDir], { stdio: "ignore" });
      unzip.on("close", resolve);
      unzip.on("error", resolve);
    });
    check("zip extracts to an index.html", existsSync(path.join(extractDir, "index.html")));
    check("about page present", existsSync(path.join(extractDir, "about", "index.html")));

    /* ---- THE test: origin goes away ---- */
    await new Promise((r) => origin.close(r));
    console.log("fidelity: origin killed — bundle must now stand alone");

    const files = [];
    (function walk(dir, prefix = "") {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else files.push(rel);
      }
    })(extractDir);
    check("bundle carries css/js/img/font", ["css", "js", "png", "woff"].every((ext) => files.some((f) => f.endsWith(`.${ext}`))), files.join(", "));

    const indexHtml = readFileSync(path.join(extractDir, "index.html"), "utf8");
    // The provenance banner deliberately records the source URL; it is an HTML
    // comment, not a fetchable reference, so exclude it from this assertion.
    const withoutBanner = indexHtml.replace(/<!--\s*Mirrored by StaticSnap[^>]*-->/g, "");
    check(
      "no fetchable origin URL survives in the HTML",
      !withoutBanner.includes(`127.0.0.1:${originPort}`),
      withoutBanner.match(new RegExp(`.{0,60}127\\.0\\.0\\.1:${originPort}.{0,60}`))?.[0] ?? "",
    );
    check("inline data-URI left intact", indexHtml.includes(GIF), "placeholder GIF was corrupted");
    check("provenance banner injected", indexHtml.includes("Mirrored by StaticSnap"));
    check("manifest written", existsSync(path.join(extractDir, "staticsnap-manifest.json")));

    bundleHost = serveDir(extractDir);
    await new Promise((r) => bundleHost.listen(0, "127.0.0.1", r));
    const bundlePort = bundleHost.address().port;

    for (const route of ["/", "/about/"]) {
      const res = await fetch(`http://127.0.0.1:${bundlePort}${route}`);
      check(`offline page ${route} serves 200`, res.status === 200, String(res.status));
    }

    // Follow every local reference the page makes and require a 200.
    const body = await fetch(`http://127.0.0.1:${bundlePort}/`).then((r) => r.text());
    const refs = [...body.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((v) => !v.startsWith("data:") && !v.startsWith("#") && !v.startsWith("http"));
    check("page has local references to check", refs.length > 0, String(refs.length));
    const broken = [];
    for (const ref of refs) {
      const target = ref.startsWith("/") ? ref : `/${ref.replace(/^\.\//, "")}`;
      const res = await fetch(`http://127.0.0.1:${bundlePort}${target}`);
      if (!res.ok) broken.push(`${ref} -> ${res.status}`);
    }
    check("every local reference resolves offline", broken.length === 0, broken.join(" | "));

    const css = files.find((f) => f.endsWith(".css"));
    if (css) {
      const cssText = readFileSync(path.join(extractDir, css), "utf8");
      check("stylesheet no longer points at the origin", !cssText.includes(`127.0.0.1:${originPort}`), cssText.slice(0, 120));
    }
  } finally {
    if (bundleHost) await new Promise((r) => bundleHost.close(r));
    try { origin.close(); } catch {}
    if (app) app.kill();
    if (failures === 0) rmSync(work, { recursive: true, force: true });
    else console.error(`fidelity: work dir kept at ${work}`);
  }

  if (failures > 0) {
    console.error(`\noffline-fidelity: FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\noffline-fidelity: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error(`offline-fidelity: unexpected error: ${error?.stack ?? error}`);
  process.exit(1);
});
