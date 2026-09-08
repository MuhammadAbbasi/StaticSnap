# StaticSnap — Project Overview

StaticSnap is an **instant web-to-static replatformer**: paste a public URL, watch the crawl stream live in the dashboard, and download a self-contained static `.zip` that can be hosted anywhere (S3, Netlify, nginx, GitHub Pages) with no origin server, database, or runtime.

Because it works on the **rendered HTTP output**, the source stack is irrelevant — WordPress, Node, Rails, Squarespace, hand-written HTML all export the same way. The repo also contains **`wp-to-astro`** (`npm start`), a code-first migration path that converts a WordPress WXR export into an Astro 5 + MDX project.

> See `README.md` for the short operator guide, `docs/project-scope.md` for requirements, and `docs/future-roadmap-and-monetization.md` for the tier plan.

---

## 1. The two migration paths

| Path | Entry | Output | When to use it |
|---|---|---|---|
| **StaticSnap (freeze-it-as-is)** | Dashboard at `http://localhost:3000` → Start Scan & Export | `<domain>-static.zip` (relative HTML/CSS/JS + `staticsnap-manifest.json`) | Portfolios, brochure sites, brand pages whose value is what the visitor sees |
| **wp-to-astro (code-first)** | `npm start` with a WordPress WXR XML file | Astro 5 + Tailwind + MDX project, verified with `astro build` | You want to keep editing content as code |

What StaticSnap **cannot** do (by design): anything needing a backend at request time — form processing, search indexes, logins, carts — and content that only appears after client-side data fetching (no headless rendering in the crawl path; screenshots use Chromium only for captures).

---

## 2. Export pipeline

```
Discovery → Harvesting → Asset Engine → Link Transformation → Secret Scan (Pro) → Archive → Screenshots (optional)
```

| Stage | What happens | Code |
|---|---|---|
| **Discovery** | Reachability probe (45 s budget, 3 attempts), then page list from `sitemap.xml`, `wp-sitemap.xml`, `sitemap_index.xml`, `page-sitemap.xml` + `Sitemap:` lines in `robots.txt`, one level of index recursion. Cap **120 pages**. No sitemap → landing page only. | `src/server/crawler.ts` |
| **Harvesting** | Concurrent fetch (5 pages) with a desktop-Chrome header profile, gzip/deflate/br decoding, redirect + cookie handling. | `src/fetcher.ts` |
| **Asset engine** | Concurrent download (8 assets) of images, CSS/JS, fonts, video/audio, favicons, manifests, OG images, including nested `url()` in stylesheets. Optional JPEG/PNG→WebP (sharp q80). External CDN hosts stay remote unless *Download external CDN assets* is on. | `src/server/crawler.ts` |
| **Link transformation** | Rewrites `src/href/srcset/data-src/poster/content` + CSS `url()` to relative offline paths; drops `<base>`; preserves `data:` URIs byte-for-byte (descriptor-aware `srcset` parser). Injects a provenance comment. | `src/server/crawler.ts` |
| **Secret Scan (Pro)** | Heuristic scan of the final on-disk HTML + JS/JSON/CSS for leaked credentials. Redacted report only — see §4. | `src/server/secrets.ts`, `src/server/entitlements.ts` |
| **Archive** | Streams the tree to `<domain>-static.zip` + `staticsnap-manifest.json` (counts only for secrets — never excerpts). | `src/server/zipper.ts` |
| **Screenshots** | Optional headless-Chromium captures (Desktop 1280 / Tablet 768 / Mobile 390) into a **separate** screenshots zip; runs after the site bundle is downloadable; failures only warn. | `src/server/screenshots.ts` (Playwright, lazy import) |

Live telemetry (stage, progress, metrics, terminal lines) streams over SSE; every job also writes a durable log file that survives restarts and artifact GC.

---

## 3. Dashboard

Single page (`public/index.html`, Tailwind via CDN, no build step).

**Configuration (left):** target URL · crawl scope (Landing / Deep) · WebP + external-assets toggles · screenshot viewports (Beta) · **secret-exposure scan (Pro)** checkbox · Start button · job meta.

**Results (right) — two tabs:**

- **Export** — pipeline stepper (7 stages), progress bar, pages/assets/operation metrics, live terminal, bundle download panel, failure panel.
- **Secret Scan (Pro)** — summary cards (files / high / medium / low), severity filter, finding cards (severity badge, type, `file:line`, redacted `AKIA***…` excerpt, fix recommendation), JSON download. States: **locked** (server not Pro, with the exact env var to set), idle, running, clean, failed, filter-empty.

The tab badge shows the finding count; the health check (`GET /api/health` → `{ pro, features.secretScan }`) drives the locked state, and requesting a scan on a non-Pro server is refused with an upgrade toast that jumps to the locked tab.

---

## 4. Secret-exposure scan (subscribed feature)

**Purpose:** catch what the site owner accidentally shipped in public frontend code — API keys, tokens, passwords — before an attacker does.

**Coverage:** AWS key IDs + secret assignments, Google API keys, Stripe live/test secrets, GitHub / GitLab / Slack / OpenAI / Anthropic / SendGrid tokens, private-key blocks, JWTs, credentials embedded in URLs (`https://user:pass@…`), generic `password|secret|api_key|auth_token = value` assignments, and sensitive bundle paths (`.env`, `.pem/.key`, `id_rsa`, `.p12/.pfx`, `wp-config.php.bak`, `*.sql/*.dump`).

**Safety guarantees (tested):**

- Scans only content already harvested for the export — **zero extra network requests**, no new SSRF surface.
- **No raw secret ever leaves the scanner.** Findings carry `redacted` excerpts (`abcd***56`); even neighboring credentials inside the context window are scrubbed. `tests/secrets.test.mjs` asserts this.
- Server logs record counts and types only, never values. The downloadable site zip contains secret **counts** in the manifest, never excerpts — the full redacted report lives in memory served by `GET /api/jobs/:jobId/secrets`.
- Caps: 150 files, 2 MiB per file, 25 findings per file, 200 total (deduped by hash). Placeholders (`example`, `changeme`, `***`, …) are ignored.
- Heuristic, not an audit: verify each finding and **rotate confirmed secrets** (revoke in the provider console; move keys server-side).

**Subscription gating:** the scan is a Pro/subscribed-tier analysis. Until billing (Stripe) lands per the roadmap, unlock with `STATICSNAP_PRO_ENABLED=1` (all Pro features) or `STATICSNAP_SECRET_SCAN_ENABLED=1` (scan only). Without it: `POST /api/jobs` with `secretScan:true` → `402 { upgradeRequired: true }`; the secrets endpoint → `402`; the dashboard tab renders locked.

---

## 5. API

| Endpoint | Purpose |
|---|---|
| `POST /api/jobs` | `{ url, scope, convertWebp?, downloadExternal?, secretScan?, screenshotViewports? }` → `{ jobId }` |
| `GET /api/stream/:jobId` | SSE telemetry (stage, progress, metrics, log, screenshots + secrets state) |
| `GET /api/jobs/:jobId` | Full job state incl. `secretsUrl` (polling fallback) |
| `GET /api/jobs/:jobId/log` | Durable plain-text log |
| `GET /api/jobs/:jobId/secrets` | Redacted report `{ summary, findings[], disclaimer }` — 404 not requested, 409 running/failed, 402 not Pro |
| `GET /api/download/:jobId` | Site `.zip` (live as soon as packed) |
| `GET /api/download/:jobId/screenshots` | Screenshots `.zip` (404/409/410 semantics) |
| `GET /api/health` | `{ ok, tokenRequired, pro, deployment, publicUrl, features: { secretScan } }` |

---

## 6. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen |
| `STATICSNAP_LOG_DIR` | `<tmpdir>/staticsnap-logs` | Durable logs |
| `STATICSNAP_MAX_CONCURRENT_JOBS` | `3` | Simultaneous crawls |
| `STATICSNAP_RATE_MAX` / `STATICSNAP_RATE_WINDOW_MS` | `5` / `60000` | Per-IP submission limit |
| `STATICSNAP_ACCESS_TOKEN` | unset | Gates `POST /api/jobs` (`X-StaticSnap-Token` / `Bearer`) |
| `STATICSNAP_MAX_JOB_BYTES` | `2 GiB` | Per-export ceiling |
| `STATICSNAP_MAX_TOTAL_BYTES` | `10 GiB` | Refuse new jobs past retained total |
| `STATICSNAP_ALLOW_PRIVATE` | unset | **Dev only** — allow loopback/LAN targets |
| `STATICSNAP_PRO_ENABLED` | unset | Unlocks Pro tier (secret scan) |
| `STATICSNAP_SECRET_SCAN_ENABLED` | unset | Unlocks only the secret scan |
| `STATICSNAP_DEPLOYMENT` | `selfhost` | `cloud` marks the hosted service (implies proxy trust, footer badge) |
| `STATICSNAP_PUBLIC_URL` | unset | e.g. `https://staticscan.muhammadabbasi.com` — dashboard footer + health |
| `STATICSNAP_BEHIND_PROXY` | unset | `1` trusts `X-Forwarded-For` for rate limiting (required behind Caddy/nginx) |
| `STATICSNAP_SCREENSHOT_TIMEOUT_MS` / `STATICSNAP_SCREENSHOT_CONCURRENCY` / `STATICSNAP_MAX_SCREENSHOTS` | `30000` / `2` / `360` | Screenshot budgets |

Bundles live in the OS temp dir and are reaped 15 min after completion; startup sweeps orphaned `staticsnap-*` dirs older than an hour. In Docker, job logs persist in the `staticsnap-logs` volume.

---

## 6b. Deployment — local Docker vs hosted service

The same image serves both. The dashboard footer tells the visitor which one they are on (and links to the other).

**Option A — local Docker (free, private):** `cp .env.example .env`, then `docker compose up --build` → `http://localhost:3000`. Single container, no domain or TLS needed. Set `STATICSNAP_PRO_ENABLED=1` in `.env` to unlock the secret scan for everyone on the instance. Files: `Dockerfile` (multi-stage Debian — glibc for sharp; Playwright Chromium preinstalled; non-root `node` user; `/api/health` HEALTHCHECK), `docker-compose.yml` (app + log volume), `.env.example`.

**Option B — hosted service at staticscan.muhammadabbasi.com (zero setup, partially paid):** exports and screenshots are free within rate/size limits; the secret scan is a paid Pro feature (refused with `402 + upgradeRequired` until subscribed). Operator setup: `A/AAAA` DNS → VPS, open 80/443, `.env` with `DOMAIN`, `STATICSNAP_DEPLOYMENT=cloud`, `STATICSNAP_PUBLIC_URL=https://staticscan.muhammadabbasi.com`, `STATICSNAP_BEHIND_PROXY=1`, Pro flags **off**, then `docker compose --profile prod up -d --build`. Caddy (`Caddyfile`) reverse-proxies to `app:3000` with automatic Let's Encrypt certificates, gzip, hardened headers, and `no-store` on `/api/*`. Cloud mode implies proxy trust so per-IP rate limiting sees real visitor IPs. Use a small VPS — serverless is a poor fit (long SSE connections, hundreds of MB of temp disk).

---

## 7. Security model

- **SSRF guard** (`src/net-guard.ts`): every outbound hop (target, redirects, assets) must pass — rejects loopback/RFC1918/link-local/CGNAT/multicast/reserved (v4+v6 incl. mapped forms), metadata IP, DNS-rebinding hosts, `*.local/*.internal/*.home.arpa`, non-HTTP schemes, credentialed URLs.
- **Abuse guards:** token gate, per-IP rate limit, concurrency cap, per-job + total disk ceilings, orphan reaper.
- **Secret handling:** redacted-at-source, counts-only logging/manifest, in-memory report cleared with the job record.
- **Legal:** only export sites you own or have permission for; respect `robots.txt` and terms of service.

---

## 8. Architecture

```
public/index.html          dashboard (Export + Secret Scan tabs, SSE client)
src/server/server.ts       Express API + static frontend + Pro gating (402)
src/server/crawler.ts      pipeline: discovery → … → secrets → archive → screenshots
src/server/secrets.ts      patterns, redaction, path rules, merge/summarize
src/server/entitlements.ts Pro/subscription flags (env until billing lands)
src/server/jobManager.ts   job lifecycle, SSE pub/sub, durable logs, GC
src/server/screenshots.ts  Playwright captures, viewport specs
src/server/zipper.ts       streaming zip
src/fetcher.ts             browser-profile HTTP client (keep-alive, decode, redirects)
src/net-guard.ts           SSRF choke point
src/extractor|transformer|scaffolder|media  wp-to-astro path
Dockerfile + docker-compose.yml + Caddyfile + .env.example  local vs hosted deployment
tests/                     unit (srcset, terminal, ssrf, limits, screenshots, secrets, deployment)
                           + offline-fidelity (kill-origin proof) + e2e (astro build)
```

---

## 9. Tiers (roadmap status)

Per `docs/future-roadmap-and-monetization.md`: Free ($0, capped crawl, manual download, community support) → **Pro ($10/mo: full sitemaps, headless rendering, 24 h retention, priority queue — the secret scan ships in this tier)** → Developer ($25/mo: framework outputs, 1-click deploy, priority support). The hosted service at staticscan.muhammadabbasi.com already enforces the split (exports free, secret scan paywalled with `402 + upgradeRequired`); env flags stand in for entitlement checks until per-user billing (Supabase/Clerk + Stripe) lands.

---

## 10. Verify

```bash
npm ci && npm run build
npm run typecheck
npm test              # unit + fidelity + e2e
```

`tests/offline-fidelity.test.mjs` is the layout proof: exports a 2-page site, **kills the origin**, serves the bundle, and requires every page/reference to resolve with no surviving origin URL.

---

## 11. Limitations

Sitemap-shaped discovery (no `<a>`-graph crawl); no JS execution in the crawl (CSR SPAs incomplete); no JS-chunk/`@import` asset discovery; external CDN remote by default; forms/search/login/cart frozen by design; 120-page / 2 GiB / 60 MiB-file ceilings; screenshots need Chromium; secret scan is heuristic and Pro-gated.
