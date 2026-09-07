/**
 * Checks for the two production guards added ahead of a public launch:
 * an optional access token in front of job creation, and disk ceilings.
 *
 * Run: `npm run build && node ./tests/limits.test.mjs`
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return res.json();
    } catch {}
    await sleep(250);
  }
  return null;
}

function startServer(env) {
  const port = 3900 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STATICSNAP_ALLOW_PRIVATE: "1", ...env },
    stdio: "ignore",
  });
  return { child, port };
}

if (!existsSync(serverEntry)) {
  console.error("limits: build first");
  process.exit(1);
}

/* ================= access token ================= */
{
  const TOKEN = "s3cret-token-value";
  const { child, port } = startServer({ STATICSNAP_ACCESS_TOKEN: TOKEN });
  try {
    const health = await waitForHealth(port);
    check("health advertises that a token is required", health?.tokenRequired === true, JSON.stringify(health));

    const body = JSON.stringify({ url: "https://example.com/", scope: "landing" });
    const post = (headers) =>
      fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });

    const noToken = await post({});
    const noTokenBody = await noToken.json().catch(() => ({}));
    check("no token is rejected with 401", noToken.status === 401, `HTTP ${noToken.status}`);
    check("401 tells the client a token is needed", noTokenBody.tokenRequired === true, JSON.stringify(noTokenBody));

    const wrong = await post({ "X-StaticSnap-Token": "wrong" });
    check("wrong token is rejected", wrong.status === 401, `HTTP ${wrong.status}`);

    const wrongLength = await post({ "X-StaticSnap-Token": `${TOKEN}extra` });
    check("token of a different length is rejected", wrongLength.status === 401, `HTTP ${wrongLength.status}`);

    const header = await post({ "X-StaticSnap-Token": TOKEN });
    check("correct token via header is accepted", header.status === 201, `HTTP ${header.status}`);

    const bearer = await post({ Authorization: `Bearer ${TOKEN}` });
    check("correct token via Authorization: Bearer is accepted", bearer.status === 201, `HTTP ${bearer.status}`);
  } finally {
    child.kill();
  }
}

/* ================= open by default ================= */
{
  const { child, port } = startServer({ STATICSNAP_ACCESS_TOKEN: "" });
  try {
    const health = await waitForHealth(port);
    check("ungated deployment reports tokenRequired=false", health?.tokenRequired === false, JSON.stringify(health));
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", scope: "landing" }),
    });
    check("no token needed when unset", res.status === 201, `HTTP ${res.status}`);
  } finally {
    child.kill();
  }
}

/* ================= disk ceiling ================= */
{
  // A 1-byte total ceiling: the first job is admitted, and once it has written
  // anything at all the next submission must be refused.
  const { child, port } = startServer({ STATICSNAP_MAX_TOTAL_BYTES: "1", STATICSNAP_RATE_MAX: "50" });
  try {
    await waitForHealth(port);
    const first = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", scope: "landing" }),
    });
    check("first job is admitted", first.status === 201, `HTTP ${first.status}`);

    let refused = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/", scope: "landing" }),
      });
      if (res.status === 503) { refused = await res.json().catch(() => ({})); break; }
    }
    check("further jobs are refused once the disk ceiling is reached", refused !== null, "never returned 503");
    check(
      "the refusal explains itself",
      typeof refused?.error === "string" && /disk/i.test(refused.error),
      JSON.stringify(refused),
    );
  } finally {
    child.kill();
  }
}

/* ================= orphan sweep ================= */
{
  // A crashed process leaves its bundle directory behind forever: the reaper
  // only runs in the process that created the job. Startup must reclaim it.
  const stale = mkdtempSync(path.join(tmpdir(), "staticsnap-stale-"));
  writeFileSync(path.join(stale, "index.html"), "x");
  const twoHoursAgo = Date.now() / 1000 - 7200;
  utimesSync(stale, twoHoursAgo, twoHoursAgo);

  const fresh = mkdtempSync(path.join(tmpdir(), "staticsnap-fresh-"));
  writeFileSync(path.join(fresh, "index.html"), "x");

  const { child, port } = startServer({});
  try {
    await waitForHealth(port);
    await sleep(500); // the sweep is fire-and-forget at boot
    check("stale orphan bundle removed at startup", !existsSync(stale));
    check("recent bundle left alone (another instance may own it)", existsSync(fresh));
  } finally {
    child.kill();
    rmSync(stale, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\nlimits: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("\nlimits: ALL CHECKS PASSED");
