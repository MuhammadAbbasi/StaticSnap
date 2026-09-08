/**
 * Deployment-metadata tests: health advertisement + proxy trust.
 *
 * The same image serves local Docker runs and the hosted service at
 * staticscan.muhammadabbasi.com. These tests pin the contract the dashboard
 * and Caddy rely on: `deployment`, `publicUrl`, feature flags, and correct
 * client-IP handling behind a reverse proxy.
 *
 * Run: `node ./tests/deployment.test.mjs`
 */
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
delete process.env.STATICSNAP_DEPLOYMENT;
delete process.env.STATICSNAP_PUBLIC_URL;
delete process.env.STATICSNAP_BEHIND_PROXY;

const { createApp, deploymentMode, publicUrl } = await import("../dist/server/server.js");

// --- pure helpers -------------------------------------------------------
assert.equal(deploymentMode(), "selfhost", "default deployment is selfhost");
assert.equal(publicUrl(), null, "no public URL by default");

process.env.STATICSNAP_DEPLOYMENT = "cloud";
assert.equal(deploymentMode(), "cloud", "cloud deployment recognized");
process.env.STATICSNAP_DEPLOYMENT = "bogus";
assert.equal(deploymentMode(), "selfhost", "unknown deployment falls back to selfhost");
delete process.env.STATICSNAP_DEPLOYMENT;

process.env.STATICSNAP_PUBLIC_URL = "https://staticscan.muhammadabbasi.com/";
assert.equal(
  publicUrl(),
  "https://staticscan.muhammadabbasi.com",
  "public URL is normalized (trailing slash stripped)",
);
process.env.STATICSNAP_PUBLIC_URL = "not-a-url";
assert.equal(publicUrl(), null, "garbage public URL is rejected");
delete process.env.STATICSNAP_PUBLIC_URL;
console.log("  PASS  deploymentMode()/publicUrl() helpers");

// --- health contract ----------------------------------------------------
async function listen(app) {
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  return srv;
}

{
  const app = createApp();
  const srv = await listen(app);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.service, "staticsnap");
    assert.equal(health.deployment, "selfhost");
    assert.equal(health.publicUrl, null);
    assert.equal(typeof health.features.secretScan, "boolean");
    console.log("  PASS  health advertises deployment + publicUrl + features");
  } finally {
    srv.close();
  }
}

// --- trust proxy: X-Forwarded-For counts as the client IP ----------------
// Behind Caddy every request arrives from the proxy address; without trust
// proxy the per-IP rate limiter would throttle the whole service as one IP.
{
  process.env.STATICSNAP_BEHIND_PROXY = "1";
  const app = createApp();
  assert.equal(app.get("trust proxy"), 1, "proxy trust enabled via env flag");
  delete process.env.STATICSNAP_BEHIND_PROXY;
  const plain = createApp();
  assert.notEqual(plain.get("trust proxy"), 1, "proxy trust off by default");
  console.log("  PASS  trust proxy follows STATICSNAP_BEHIND_PROXY");
}

console.log("\ndeployment: ALL CHECKS PASSED");
