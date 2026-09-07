/**
 * SSRF guard checks.
 *
 * StaticSnap fetches whatever URL a visitor submits, so deployed publicly it is
 * an SSRF primitive unless internal targets are refused. These cover the guard
 * itself and the live `POST /api/jobs` rejection.
 *
 * Run: `npm run build && node ./tests/ssrf.test.mjs`
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
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The guard reads its env flag at import time, so make sure it is off here
// even if the ambient environment enables it for the other suites.
delete process.env.STATICSNAP_ALLOW_PRIVATE;
const { assertPublicUrl, isPrivateAddress, BlockedTargetError } = await import(
  "../dist/net-guard.js"
);

/* ---- address classification ---- */
const PRIVATE = [
  "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255",
  "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255",
  "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
];
for (const ip of PRIVATE) check(`blocked address: ${ip}`, isPrivateAddress(ip) === true);

const PUBLIC = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"];
for (const ip of PUBLIC) check(`allowed address: ${ip}`, isPrivateAddress(ip) === false);

/* ---- URL-level rejection ---- */
async function expectBlocked(url, label) {
  try {
    await assertPublicUrl(url);
    check(label, false, "was ALLOWED");
  } catch (error) {
    check(label, error instanceof BlockedTargetError, error?.message ?? String(error));
  }
}

await expectBlocked("http://169.254.169.254/latest/meta-data/", "cloud metadata endpoint");
await expectBlocked("http://127.0.0.1:6379/", "loopback service");
await expectBlocked("http://localhost:3000/", "localhost by name");
await expectBlocked("http://10.0.0.1/admin", "RFC1918 host");
await expectBlocked("http://[::1]:8080/", "IPv6 loopback");
await expectBlocked("file:///etc/passwd", "file:// scheme");
await expectBlocked("gopher://x/", "gopher:// scheme");
await expectBlocked("http://user:pass@example.com/", "embedded credentials");
await expectBlocked("http://router.local/", "*.local hostname");
await expectBlocked("http://db.internal/", "*.internal hostname");
await expectBlocked("not a url", "malformed URL");

/* ---- live API rejection ---- */
if (!existsSync(serverEntry)) {
  console.error("ssrf: build first");
  process.exit(1);
}
const port = 3700 + Math.floor(Math.random() * 200);
const app = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  // Deliberately NOT setting STATICSNAP_ALLOW_PRIVATE: production posture.
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STATICSNAP_ALLOW_PRIVATE: "" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {}
    await sleep(250);
  }

  for (const [url, label] of [
    ["http://169.254.169.254/latest/meta-data/", "API rejects cloud metadata"],
    ["http://127.0.0.1:22/", "API rejects loopback"],
    ["http://192.168.0.1/", "API rejects LAN address"],
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, scope: "landing" }),
    });
    const body = await res.json().catch(() => ({}));
    check(label, res.status === 400 && typeof body.error === "string", `HTTP ${res.status} ${JSON.stringify(body)}`);
  }

  /* ---- rate limiting ---- */
  let sawRateLimit = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", scope: "landing" }),
    });
    if (res.status === 429) { sawRateLimit = true; break; }
  }
  check("API rate-limits repeated submissions", sawRateLimit);
} finally {
  app.kill();
}

if (failures > 0) {
  console.error(`\nssrf: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("\nssrf: ALL CHECKS PASSED");
