/**
 * End-to-end integration test for the wp-to-astro pipeline.
 *
 * Spins up a tiny local HTTP server serving a 1x1 PNG, rewrites the
 * `__MEDIA_BASE_URL__` placeholder in the sample WXR fixture, runs the built
 * CLI (`node ./dist/cli.js --source <xml> --out <dir>`) and asserts:
 *   - published posts + page are converted to `.mdx` (draft/attachment ignored)
 *   - media images are downloaded into `src/assets/images`
 *   - `_thumbnail_id` postmeta resolves to a local featured image, and a
 *     dangling id degrades to no `featuredImage` at all
 *   - `redirects.json` maps original permalinks to `/blog/<slug>/`
 *   - the generated project actually installs and builds: `npm install` and
 *     `npx astro build` must both exit 0, and emit the expected routes
 *     (including the redirect page produced from `redirects.json`)
 *
 * Run: `npm run build && npm run test:e2e`
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixturePath = path.join(here, "fixtures", "sample-export.xml");
const cliPath = path.join(repoRoot, "dist", "cli.js");

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";
const npxCmd = isWindows ? "npx.cmd" : "npx";

/**
 * Run a command to completion and capture its output.
 *
 * Always resolves (never rejects) so a failure is asserted on rather than
 * crashing the suite. Uses async spawn, not spawnSync, so this process's
 * event loop stays alive to serve image downloads to the CLI subprocess.
 */
function runCommand(command, args, options = {}) {
  const { cwd = repoRoot, timeoutMs = 120000, label = command } = options;
  // Node refuses to spawn .cmd/.bat shims without a shell on Windows
  // (CVE-2024-27980 hardening), which is how npm/npx ship there.
  const shell = isWindows && command.endsWith(".cmd");
  return new Promise((resolve) => {
    let child;
    try {
      // This suite crawls 127.0.0.1, which the SSRF guard blocks by default.
      // Opt in explicitly — never set this in production.
      child = spawn(command, args, {
        cwd,
        shell,
        env: { ...process.env, STATICSNAP_ALLOW_PRIVATE: "1" },
      });
    } catch (error) {
      resolve({ status: 1, stdout: "", stderr: `${label}: ${String(error)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        status: 1,
        stdout,
        stderr: `${stderr}
${label} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("e2e: starting local image server…");
  const server = createServer((req, res) => {
    if (
      req.url === "/uploads/test.png" ||
      req.url === "/uploads/photo.jpg" ||
      (req.url ?? "").startsWith("/uploads/")
    ) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": PNG.length,
      });
      res.end(PNG);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`e2e: image server at ${baseUrl}`);

  const workDir = mkdtempSync(path.join(tmpdir(), "wp-to-astro-e2e-"));
  const sourceXml = path.join(workDir, "export.xml");
  const outDir = path.join(workDir, "astro-site");

  try {
    if (!existsSync(fixturePath)) {
      console.error(`e2e: fixture not found: ${fixturePath}`);
      process.exit(1);
    }
    if (!existsSync(cliPath)) {
      console.error(
        `e2e: built CLI not found: ${cliPath}. Run "npm run build" first.`,
      );
      process.exit(1);
    }

    const fixture = readFileSync(fixturePath, "utf8");
    if (!fixture.includes("__MEDIA_BASE_URL__")) {
      console.error("e2e: fixture missing __MEDIA_BASE_URL__ placeholder");
      process.exit(1);
    }
    writeFileSync(sourceXml, fixture.split("__MEDIA_BASE_URL__").join(baseUrl));

    console.log(`e2e: running CLI → ${outDir}`);
    const run = await runCommand(
      process.execPath,
      [cliPath, "--source", sourceXml, "--out", outDir, "--concurrency", "3"],
      { timeoutMs: 120000, label: "CLI" },
    );
    console.log("--- CLI stdout ---");
    console.log(run.stdout ?? "");
    console.log("--- CLI stderr ---");
    console.log(run.stderr ?? "");
    check("CLI exits with status 0", run.status === 0, `status=${run.status}`);

    if (run.status !== 0) {
      failures += 1;
      console.error("e2e: CLI failed, skipping file assertions.");
    } else {
      const blogDir = path.join(outDir, "src", "content", "blog");
      const imagesDir = path.join(outDir, "src", "assets", "images");
      const redirectsPath = path.join(outDir, "redirects.json");

      check("blog dir exists", existsSync(blogDir));
      check(
        "hello-world.mdx exists",
        existsSync(path.join(blogDir, "hello-world.mdx")),
      );
      check(
        "second-post.mdx exists",
        existsSync(path.join(blogDir, "second-post.mdx")),
      );
      check("about.mdx exists", existsSync(path.join(blogDir, "about.mdx")));
      check(
        "draft is ignored",
        !existsSync(path.join(blogDir, "draft-post.mdx")),
      );
      check(
        "attachment is ignored",
        !existsSync(path.join(blogDir, "test-image.mdx")),
      );

      if (existsSync(path.join(blogDir, "hello-world.mdx"))) {
        const mdx = readFileSync(
          path.join(blogDir, "hello-world.mdx"),
          "utf8",
        );
        check("hello-world has frontmatter title", mdx.includes("Hello World"));
        check(
          "hello-world rewrites image to local asset",
          mdx.includes("../../assets/images/"),
          "expected local asset path",
        );
        check(
          "hello-world has no remote image URL left",
          !mdx.includes(baseUrl),
          "remote URL should be rewritten",
        );
        check(
          "hello-world resolves _thumbnail_id to a featured image",
          mdx.includes("featuredImage:"),
          "expected featuredImage frontmatter from _thumbnail_id postmeta",
        );
        check(
          "featured image is rewritten to a local asset",
          /featuredImage:\s*\S*assets\/images\/featured\.png/.test(mdx),
          "expected featured image downloaded and rewritten locally",
        );
      }

      if (existsSync(path.join(blogDir, "second-post.mdx"))) {
        const mdx = readFileSync(
          path.join(blogDir, "second-post.mdx"),
          "utf8",
        );
        check("second-post mentions Subheading", mdx.includes("Subheading"));
        check(
          "dangling _thumbnail_id yields no featuredImage",
          !mdx.includes("featuredImage"),
          "an unresolvable attachment id must not leak into frontmatter",
        );
      }

      check("redirects.json exists", existsSync(redirectsPath));
      if (existsSync(redirectsPath)) {
        let redirects = {};
        try {
          redirects = JSON.parse(readFileSync(redirectsPath, "utf8"));
        } catch {
          redirects = {};
        }
        check(
          "redirect maps hello-world permalink",
          redirects["https://example.com/hello-world/"] ===
            "/blog/hello-world/",
          JSON.stringify(redirects),
        );
        check(
          "redirect maps second-post permalink",
          redirects["https://example.com/second-post/"] ===
            "/blog/second-post/",
          JSON.stringify(redirects),
        );
        check(
          "draft permalink is absent",
          !("https://example.com/draft-post/" in redirects),
        );
      }

      const logPath = path.join(outDir, "migration-log.json");
      check("migration-log.json exists", existsSync(logPath));
      if (existsSync(logPath)) {
        let runLog = {};
        try {
          runLog = JSON.parse(readFileSync(logPath, "utf8"));
        } catch {
          runLog = {};
        }
        check(
          "run log records 3 posts and 0 failures",
          runLog.totals?.posts === 3 && runLog.totals?.mediaFailed === 0,
          JSON.stringify(runLog.totals),
        );
        check(
          "run log records the resolved featured image",
          (runLog.posts ?? []).some(
            (entry) =>
              entry.slug === "hello-world" &&
              typeof entry.featuredImage === "string" &&
              entry.featuredImage.includes("featured"),
          ),
          JSON.stringify(runLog.posts),
        );
      }

      check("images dir exists", existsSync(imagesDir));
      if (existsSync(imagesDir)) {
        const files = readdirSync(imagesDir);
        check(
          "at least 3 images downloaded (2 body + 1 featured)",
          files.length >= 3,
          `found: ${files.join(", ")}`,
        );
        check(
          "featured image was downloaded",
          files.some((file) => file.startsWith("featured.")),
          `found: ${files.join(", ")}`,
        );
      }

      check(
        "scaffold wrote astro.config.mjs",
        existsSync(path.join(outDir, "astro.config.mjs")),
      );
      check(
        "scaffold wrote package.json",
        existsSync(path.join(outDir, "package.json")),
      );

      // --- Build validation -------------------------------------------------
      // Asserting on the emitted .mdx only proves the migrator's output shape.
      // The generated project must also compile, so install and build it.
      console.log(
        "e2e: npm install in generated project (this takes ~1 minute)…",
      );
      const install = await runCommand(
        npmCmd,
        ["install", "--no-audit", "--no-fund"],
        { cwd: outDir, timeoutMs: 600000, label: "npm install" },
      );
      check(
        "npm install exits 0 in generated project",
        install.status === 0,
        `status=${install.status}
${install.stderr.slice(-2000)}`,
      );

      if (install.status === 0) {
        console.log("e2e: npx astro build in generated project…");
        const astroBuild = await runCommand(npxCmd, ["astro", "build"], {
          cwd: outDir,
          timeoutMs: 600000,
          label: "astro build",
        });
        check(
          "astro build exits 0 in generated project",
          astroBuild.status === 0,
          `status=${astroBuild.status}
${`${astroBuild.stdout}${astroBuild.stderr}`.slice(-3000)}`,
        );

        const distDir = path.join(outDir, "dist");
        check("astro build emitted dist/index.html", existsSync(path.join(distDir, "index.html")));
        check(
          "astro build emitted the blog route",
          existsSync(path.join(distDir, "blog", "hello-world", "index.html")),
        );
        check(
          "redirects.json produced a redirect page for the old permalink",
          existsSync(path.join(distDir, "hello-world", "index.html")),
          "expected astro.config.mjs to wire redirects.json into Astro",
        );
      }
    }
  } finally {
    server.close();
    // Keep the work dir on failure for debugging; otherwise clean up.
    if (failures === 0) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.error(`e2e: failures=${failures}, work dir kept at ${workDir}`);
    }
  }

  if (failures > 0) {
    console.error(`\ne2e: FAILED (${failures} check(s) failed)`);
    process.exit(1);
  }
  console.log("\ne2e: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error(`e2e: unexpected error: ${error?.message ?? error}`);
  process.exit(1);
});
