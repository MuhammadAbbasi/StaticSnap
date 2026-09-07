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

Live telemetry streams over SSE: staged progress, per-asset operations, and a terminal with `INFO`/`SUCCESS`/`WARN`/`ERROR` lines. Every job also writes a durable log file that outlives both the artifacts and a server restart.

## Scopes

- **Landing page** — one page plus its assets.
- **Deep crawl** — every page in the sitemap (up to 120), plus assets.

External/CDN assets stay remote by default; enable *Download external CDN assets* to inline them.

---

## Running locally

```bash
npm ci
npm run build
npm run serve            # http://localhost:3000
```

To crawl a site on your own machine (`localhost`, `127.0.0.1`, a LAN address), you must opt out of the SSRF guard:

```bash
STATICSNAP_ALLOW_PRIVATE=1 npm run serve
```

**Never set that in a public deployment** — see Security below.

## Deploying

**Current status: run it directly with Node.** `npm ci && npm run build && npm run serve` is the supported path while the app is being tested.

A `Dockerfile` is committed and ready for when you deploy, but it has **not been built or run yet** — there was no Docker daemon available in the environment where it was written. Treat it as a starting point and verify the first build:

```bash
docker build -t staticsnap .
docker run -p 3000:3000 -e STATICSNAP_ACCESS_TOKEN=... staticsnap
```

Serverless platforms are a poor fit either way: a deep crawl runs for minutes, holds an SSE connection open, and writes hundreds of megabytes to temp disk.

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
| `POST /api/jobs` | `{ url, scope: "landing" \| "deep", convertWebp?, downloadExternal? }` → `{ jobId }` |
| `GET /api/stream/:jobId` | SSE telemetry — stage, progress, metrics, log entries |
| `GET /api/jobs/:jobId` | Full job state (polling fallback) |
| `GET /api/jobs/:jobId/log` | Durable plain-text job log |
| `GET /api/download/:jobId` | The `.zip` bundle |
| `GET /api/health` | Liveness |

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
- `tests/e2e.mjs` — the bundled `wp-to-astro` CLI, including an `astro build` of its output

---

## Also in this repo

`wp-to-astro` (`npm start`) converts a WordPress WXR XML export into an Astro 5 + MDX project — a code-first migration path, where StaticSnap is the freeze-it-as-is path.
