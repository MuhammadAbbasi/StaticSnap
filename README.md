# StaticSnap

<p align="center">
  <img src="public/media/brand-banner.jpg" alt="StaticSnap" width="100%" />
</p>

Turn any front-end-heavy website into a self-contained static bundle you can host anywhere.

Paste a URL, pick a scope, watch the crawl stream live, download a `.zip`. Unzip it on any static host — S3, Netlify, nginx, GitHub Pages — and it serves the same pages with no origin server, no database, and no runtime.

Because it works on the **rendered output**, the source stack is irrelevant: WordPress, Node, Angular, Rails, Squarespace, a hand-written site — all export the same way. That makes it a practical migration path off a CMS for portfolios, brochure sites, and brand pages.

**What it cannot do:** anything that needs a backend at request time. Forms still POST to the original endpoint (or nothing), search stops working, logins and carts don't exist, and content that only appears after client-side data fetching won't be captured. This is a tool for sites whose value is in what the visitor sees.

---

## What it does

| Stage | Behaviour |
|---|---|
| **Discovery** | Verifies the target, then finds pages via `sitemap.xml`, `wp-sitemap.xml`, `sitemap_index.xml`, `page-sitemap.xml` and any `Sitemap:` line in `robots.txt`. Recurses one level into sitemap indexes. Capped at 120 pages. |
| **Harvesting** | Fetches each page concurrently with a full desktop-Chrome header profile (so CDNs and WAFs don't return 403), transparently decoding gzip/deflate/br. |
| **Asset engine** | Downloads images, CSS, JS, fonts, video/audio, favicons, manifests and OG images — including nested `url()` references inside stylesheets. Optionally converts JPEG/PNG to WebP. |
| **Link transformation** | Rewrites `src`, `href`, `srcset`, `data-src`, `poster`, `content` and CSS `url()` to relative offline paths. Inline `data:` URIs are left byte-for-byte intact. |
| **Archive** | Streams the tree into a `.zip` with a `staticsnap-manifest.json` recording source URLs, files, byte counts and failure tallies. |
| **Secret Scan** *(Pro — subscribed)* | Heuristic scan of the harvested HTML + JS/CSS for accidentally published credentials (AWS, Google, Stripe, GitHub, OpenAI/Anthropic, Slack, JWTs, hardcoded passwords, credentials-in-URL, exposed `.env`/`.pem`). Redacted report in the dashboard's **Secret Scan** tab; never stored in the `.zip`. |
| **Screenshots** *(optional)* | Renders every harvested page in headless Chromium at the selected device widths (Desktop 1280px, Tablet 768px, Mobile 390px) and packs the PNGs — in individual per-viewport folders — into a **separate** screenshots `.zip`. Runs after the site bundle, which stays downloadable meanwhile; a capture failure only warns, never fails the export. |

Live telemetry streams over SSE: staged progress, per-asset operations, and a terminal with `INFO`/`SUCCESS`/`WARN`/`ERROR` lines. Every job also writes a durable log file that outlives both the artifacts and a server restart.

## Scopes

- **Landing page** — one page plus its assets.
- **Deep crawl** — every page in the sitemap (up to 120), plus assets.

External/CDN assets stay remote by default; enable *Download external CDN assets* to inline them.

Tick any of the Desktop / Tablet / Mobile screenshot boxes to also capture every harvested page at those widths. Captures run in the background once the site bundle is ready and download from their own button as `<domain>-screenshots.zip` (`desktop/`, `tablet/`, `mobile/` folders plus a `screenshots-manifest.json`). Requires the server to have Playwright's Chromium (`npx playwright install chromium`, already wired into the `Dockerfile`); without it the export still succeeds and the screenshots phase just warns.

Tick **Scan for leaked API keys & passwords** (Pro) to also run the secret-exposure analysis. Findings appear in the dashboard's **Secret Scan** tab (`Export` | `Secret Scan`) as a redacted report (severity, file, line, `AKIA***…` excerpt, fix recommendation) with a severity filter and JSON download. Requires a subscribed deployment — see Configuration below — otherwise job creation is refused with an upgrade notice.

---

## Run it your way

Two options — same image, same dashboard. Pick the one that fits:

| | **A. Local Docker** (free, private) | **B. Hosted service** (zero setup, partially paid) |
|---|---|---|
| Address | `http://localhost:3000` on your machine | `https://staticscan.muhammadabbasi.com` |
| Start | `docker compose up --build` | Open the URL — no install |
| Cost | Free forever, your hardware | Free tier for exports; **Pro** (secret scan) is paid |
| Pro unlock | `STATICSNAP_PRO_ENABLED=1` in your `.env` | Subscription on the hosted service |

### A. Running locally

```bash
cp .env.example .env   # optional — defaults work out of the box
docker compose up --build
# dashboard → http://localhost:3000
```

No Docker? The classic path still works: `npm ci && npm run build && npm run serve`.

To crawl a site on your own machine (`localhost`, `127.0.0.1`, a LAN address), you must opt out of the SSRF guard:

```bash
STATICSNAP_ALLOW_PRIVATE=1 npm run serve
```

**Never set that in a public deployment** — see Security below.

### B. Using the hosted service

Open **https://staticscan.muhammadabbasi.com** and export — landing + deep crawls and screenshots are free within the usual rate/size limits. The **Secret Scan** tab is a Pro feature: requesting it without a subscription is refused with an upgrade notice (`402 + upgradeRequired`).

### Operating the hosted service (for the domain owner)

The hosted service is this same repo on a VPS, with Caddy terminating TLS:

1. **DNS** — add an `A` (and optionally `AAAA`) record: `staticscan.muhammadabbasi.com → <server IP>`.
2. **Firewall** — open ports `80` and `443`.
3. **Configure** — `cp .env.example .env`, then set:
   ```ini
   DOMAIN=staticscan.muhammadabbasi.com
   STATICSNAP_DEPLOYMENT=cloud
   STATICSNAP_PUBLIC_URL=https://staticscan.muhammadabbasi.com
   STATICSNAP_BEHIND_PROXY=1
   # leave STATICSNAP_PRO_ENABLED / STATICSNAP_SECRET_SCAN_ENABLED OFF
   # so the secret scan stays a paid Pro feature (402 paywall active)
   ```
4. **Launch** — `docker compose --profile prod up -d --build`. Caddy fetches a Let's Encrypt certificate automatically on first request.
5. **Verify** — `curl https://staticscan.muhammadabbasi.com/api/health` should report `"deployment":"cloud"`.

`STATICSNAP_BEHIND_PROXY=1` (implied by `cloud`) makes per-IP rate limiting see real visitor IPs from `X-Forwarded-For` instead of throttling the whole service as one address. Job logs persist in the `staticsnap-logs` volume across container recreations.

Serverless platforms are a poor fit either way: a deep crawl runs for minutes, holds an SSE connection open, and writes hundreds of megabytes to temp disk — use a small VPS.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `STATICSNAP_LOG_DIR` | `<tmpdir>/staticsnap-logs` | Durable per-job logs |
| `STATICSNAP_MAX_CONCURRENT_JOBS` | `3` | Simultaneous crawls |
| `STATICSNAP_RATE_MAX` | `5` | Job submissions per IP per window |
| `STATICSNAP_RATE_WINDOW_MS` | `60000` | Rate-limit window |
| `STATICSNAP_ACCESS_TOKEN` | unset | When set, `POST /api/jobs` requires this token |
| `STATICSNAP_MAX_JOB_BYTES` | `2 GiB` | Per-export size ceiling |
| `STATICSNAP_MAX_TOTAL_BYTES` | `10 GiB` | Refuse new jobs beyond this much retained disk |
| `STATICSNAP_ALLOW_PRIVATE` | unset | **Dev only.** Permits crawling private/loopback addresses |
| `STATICSNAP_SCREENSHOT_TIMEOUT_MS` | `30000` | Per-page navigation + capture budget for screenshots |
| `STATICSNAP_SCREENSHOT_CONCURRENCY` | `2` | Concurrent screenshot pages |
| `STATICSNAP_MAX_SCREENSHOTS` | `360` | Cap on captures per job (pages × viewports) |
| `STATICSNAP_PRO_ENABLED` | unset | **Subscribed tier.** `1` unlocks all Pro features (currently: secret scan) |
| `STATICSNAP_SECRET_SCAN_ENABLED` | unset | Unlocks only the secret-exposure scan (`1` to enable) |
| `STATICSNAP_DEPLOYMENT` | `selfhost` | `cloud` marks the hosted service (implies proxy trust, shown in dashboard footer) |
| `STATICSNAP_PUBLIC_URL` | unset | e.g. `https://staticscan.muhammadabbasi.com` — shown in the dashboard footer + `/api/health` |
| `STATICSNAP_BEHIND_PROXY` | unset | `1` trusts `X-Forwarded-For` for rate limiting (required behind Caddy/nginx) |

### Access control

Leave `STATICSNAP_ACCESS_TOKEN` unset and the exporter is open to anyone — fine for local use and internal networks. Set it and job creation requires the token, supplied as `X-StaticSnap-Token` or `Authorization: Bearer`; the dashboard prompts once and remembers it. Comparison is constant-time.

Only job creation is gated. Every other route is addressed by an unguessable job id that you can only obtain by creating a job, and gating the SSE route would break `EventSource`, which cannot send custom headers.

For a public deployment that must stay anonymous, put a CAPTCHA (Cloudflare Turnstile, hCaptcha) or your edge's bot protection in front of `POST /api/jobs` instead — the token gate is the self-contained option, not the only one.

### Disk

Bundles and their zips live in the OS temp directory and are deleted 15 minutes after their job finishes. Three ceilings keep the volume from filling:

- **Per export** — a crawl exceeding `STATICSNAP_MAX_JOB_BYTES` fails with a message telling the user to narrow the scope.
- **Total retained** — new jobs are refused with `503` while outstanding bundles exceed `STATICSNAP_MAX_TOTAL_BYTES`.
- **Orphans** — a crash or redeploy strands bundles whose 15-minute reaper never fires, so startup removes any `staticsnap-*` directory older than an hour.

Peak usage is roughly *(site size × 2)* per concurrent job. Give the host a few GB of writable temp space and set `STATICSNAP_MAX_CONCURRENT_JOBS` to match.

---

## Security

The server fetches URLs supplied by anonymous visitors, which is a server-side request forgery primitive unless constrained. Every outbound request — the submitted URL, **every redirect hop**, and every asset — passes through one guard that rejects:

- loopback, RFC1918, link-local, CGNAT, multicast and reserved ranges, in IPv4 and IPv6 (including IPv4-mapped forms)
- cloud instance metadata (`169.254.169.254`)
- hostnames that *resolve* into those ranges (DNS rebinding)
- `localhost`, `*.local`, `*.internal`, `*.home.arpa`
- non-HTTP schemes and URLs carrying credentials

Job creation can be gated behind an access token, submissions are rate-limited per IP, concurrent crawls are capped, and disk use is bounded per-job and in total.

Still worth adding for a sensitive network: an egress allowlist, so the crawler can only reach hosts you approve.

**Legal note:** exporting a site you don't own may infringe copyright or breach terms of service. Respect `robots.txt` and get permission.

---

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/jobs` | `{ url, scope: "landing" \| "deep", convertWebp?, downloadExternal?, secretScan?, screenshotViewports?: ("desktop" \| "tablet" \| "mobile")[] }` → `{ jobId }` (`screenshots: true` is shorthand for desktop-only; `secretScan: true` needs Pro or the call is refused with `402` + `upgradeRequired`) |
| `GET /api/stream/:jobId` | SSE telemetry — stage, progress, metrics, log entries, screenshots + secret-scan state |
| `GET /api/jobs/:jobId` | Full job state (polling fallback) |
| `GET /api/jobs/:jobId/log` | Durable plain-text job log |
| `GET /api/jobs/:jobId/secrets` | Redacted secret-exposure report (404 if not requested, 409 while running/failed, 402 if not Pro) |
| `GET /api/download/:jobId` | The `.zip` bundle (live as soon as packed, even while screenshots render) |
| `GET /api/download/:jobId/screenshots` | The separate screenshots `.zip` (404 if not requested, 409 while rendering) |
| `GET /api/health` | Liveness + `{ pro, deployment, publicUrl, features: { secretScan } }` so the dashboard can render the locked Pro tab and hosted/self-hosted footer |

---

## Tests

```bash
npm run build
npm test              # unit + fidelity + e2e
```

- `tests/ssrf.test.mjs` — address classification and live API rejection
- `tests/limits.test.mjs` — access token, disk ceilings, orphan sweep
- `tests/srcset.test.mjs` — `srcset`/data-URI parsing
- `tests/terminal.test.mjs` — dashboard log rendering (runs the shipped source)
- `tests/offline-fidelity.test.mjs` — exports a site, **kills the origin**, then serves the unzipped bundle and asserts every page and reference still resolves
- `tests/screenshots.test.mjs` — screenshot viewport helpers plus the screenshots API surface (no browser required)
- `tests/secrets.test.mjs` — secret-pattern detection, placeholder rejection, and the no-raw-secret-leak guarantee (redacted excerpts only)
- `tests/deployment.test.mjs` — health deployment contract + reverse-proxy trust
- `tests/e2e.mjs` — the bundled `wp-to-astro` CLI, including an `astro build` of its output

---

## Also in this repo

`wp-to-astro` (`npm start`) converts a WordPress WXR XML export into an Astro 5 + MDX project — a code-first migration path, where StaticSnap is the freeze-it-as-is path.
