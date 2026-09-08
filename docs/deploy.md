# StaticSnap — Deployment Prompt: `staticsnap.muhammadabbasi.com`

> **Purpose of this file.** A self-contained brief you can hand to an engineer or
> a coding agent to take StaticSnap from this repository to a live, TLS-secured
> service at `staticsnap.muhammadabbasi.com`. Everything below is written against
> the deployment assets that already exist in the repo — `Dockerfile`,
> `docker-compose.yml`, `Caddyfile`, `.env.example`. Nothing here needs to be
> invented; it needs to be executed and verified.

---

## 0. Resolve this before you start

**The repository currently defaults to a different hostname than this document.**

| Location | Current default |
|---|---|
| `.env.example` → `DOMAIN` | `staticscan.muhammadabbasi.com` |
| `Caddyfile` → site block | `{$DOMAIN:staticscan.muhammadabbasi.com}` |
| `docker-compose.yml` → `caddy.environment.DOMAIN` | `staticscan.muhammadabbasi.com` |

This brief targets **`staticsnap`** (matching the product name and the repo).
Pick one and make it consistent everywhere before deploying — a mismatch means
Caddy requests a certificate for a hostname that DNS does not point at, and TLS
provisioning fails with an opaque ACME error.

- **If `staticsnap` is correct:** update the three defaults above, or simply set
  `DOMAIN=staticsnap.muhammadabbasi.com` in `.env` (it overrides all three).
- **If `staticscan` is correct:** substitute it throughout this document.

Do not proceed until this is settled.

---

## 1. Task

Deploy StaticSnap as a public, TLS-secured web service at
`https://staticsnap.muhammadabbasi.com`, using the repository's Docker Compose
`prod` profile (app container + Caddy reverse proxy with automatic Let's Encrypt
certificates).

**Definition of done:** a visitor can open the URL over HTTPS, submit a public
website, watch live progress stream in the terminal panel, and download a working
`.zip` bundle — with the SSRF guard active, abuse limits enforced, and the
service surviving a host reboot.

---

## 2. Prerequisites

**Host**
- Linux VM with Docker Engine ≥ 24 and the Compose plugin.
- **4 GB RAM minimum.** Chromium (screenshots) plus concurrent crawls will OOM a
  1–2 GB box. 2 vCPU is comfortable.
- **20 GB+ free disk.** Bundles and screenshot archives are written to the
  container's `/tmp` and only reaped 15 minutes after a job finishes. Peak usage
  is roughly *(site size × 2) × concurrent jobs*.

**Network**
- `A` (and `AAAA` if the host has IPv6) record for
  `staticsnap.muhammadabbasi.com` → the host's public IP, **propagated before
  first start**. Caddy's ACME HTTP-01 challenge fails without it.
- Inbound TCP **80 and 443** open. Port 80 is required for the ACME challenge and
  the HTTP→HTTPS redirect; it cannot be skipped.

**Verify both before deploying:**

```bash
dig +short staticsnap.muhammadabbasi.com          # must return the host IP
curl -s ifconfig.me                                # run on the host; must match
```

---

## 3. Deployment steps

### 3.1 Get the code onto the host

```bash
git clone <repo-url> staticsnap && cd staticsnap
```

### 3.2 Create the environment file

```bash
cp .env.example .env
```

Then edit `.env`. The values that matter for a public deployment:

```bash
DOMAIN=staticsnap.muhammadabbasi.com
STATICSNAP_PUBLIC_URL=https://staticsnap.muhammadabbasi.com
STATICSNAP_DEPLOYMENT=cloud       # also implies BEHIND_PROXY
STATICSNAP_BEHIND_PROXY=1         # trust X-Forwarded-For from Caddy

# Leave empty for an open public service; set a value to gate job creation.
STATICSNAP_ACCESS_TOKEN=

# Tune to the host's real capacity.
STATICSNAP_MAX_CONCURRENT_JOBS=3
STATICSNAP_RATE_MAX=5
STATICSNAP_RATE_WINDOW_MS=60000
STATICSNAP_MAX_JOB_BYTES=2147483648      # 2 GiB per export
STATICSNAP_MAX_TOTAL_BYTES=10737418240   # 10 GiB retained across jobs

# MUST stay empty. Enabling it turns the service into an SSRF proxy into
# your private network.
STATICSNAP_ALLOW_PRIVATE=
```

**`STATICSNAP_BEHIND_PROXY=1` is not optional behind Caddy.** Without it Express
reads the proxy's address as the client IP, so every visitor shares a single
rate-limit bucket and the first five submissions per minute lock everyone out.
Setting `STATICSNAP_DEPLOYMENT=cloud` turns it on implicitly, but set both
explicitly so the intent survives a future change to that default.

### 3.3 Restrict the direct app port

`docker-compose.yml` publishes `${APP_PORT:-3000}:3000` so the container is
reachable for debugging. On a public host that bypasses Caddy — no TLS, no
security headers. Either firewall it:

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw deny 3000/tcp
```

…or bind it to loopback only by changing the mapping to `"127.0.0.1:3000:3000"`.

### 3.4 Start the stack

```bash
docker compose --profile prod up -d --build
```

The first build compiles TypeScript and installs Playwright's Chromium — expect
several minutes. Caddy then requests a certificate on the first inbound request.

### 3.5 Watch it come up

```bash
docker compose ps                      # app must be "healthy" before caddy starts
docker compose logs -f caddy           # watch for the certificate being obtained
docker compose logs -f app
```

Caddy will log a successful ACME issuance for the domain. If it loops or reports
a challenge failure, the cause is almost always DNS or port 80 — go back to §2.

---

## 4. Verification

Run every check. Do not report success on a partial pass.

| # | Check | Command / action | Expected |
|---|---|---|---|
| 1 | TLS + redirect | `curl -sI http://staticsnap.muhammadabbasi.com` | `301`/`308` to `https://` |
| 2 | Valid certificate | `curl -sI https://staticsnap.muhammadabbasi.com` | `200`, no cert warning |
| 3 | Health | `curl -s https://staticsnap.muhammadabbasi.com/api/health` | `{"ok":true,...}` |
| 4 | Dashboard | Open the URL in a browser | Dashboard renders, "api online" indicator lit |
| 5 | Security headers | `curl -sI https://staticsnap.muhammadabbasi.com` | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` present |
| 6 | **SSRF guard live** | `POST /api/jobs` with `{"url":"http://169.254.169.254/"}` | `400` + refusal message. **A `201` here is a critical failure — stop and fix.** |
| 7 | Real export | Submit a small public site from the dashboard | Completes; live terminal streams distinct lines (no duplicates), autoscrolls |
| 8 | Download | Click the download button | `.zip` arrives; unzip and open `index.html` locally — page renders with styling |
| 9 | Rate limit | Submit 6+ jobs rapidly from one IP | A `429` appears |
| 10 | Restart survival | `sudo reboot`, wait, re-check #3 | Service back up (`restart: unless-stopped`) |

Check 6 in full:

```bash
curl -s -X POST https://staticsnap.muhammadabbasi.com/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"url":"http://169.254.169.254/latest/meta-data/","scope":"landing"}'
```

Check 7 matters most: it is the only check that exercises SSE through the proxy.
If progress never advances but the job completes when polled at
`/api/jobs/<id>`, the stream is being buffered — see §6.

---

## 5. Rollback

```bash
docker compose --profile prod down          # stop; volumes and certs are kept
docker compose --profile prod up -d         # restart the previous image
```

To roll back code, check out the last good commit and rebuild. Named volumes
(`staticsnap-logs`, `caddy-data`) persist across recreation, so certificates are
**not** re-requested on every restart — important, because Let's Encrypt rate
limits certificate issuance per domain per week. Never `docker compose down -v`
on a whim.

---

## 6. Known pitfalls, specific to this app

**Server-Sent Events must not be buffered.** The dashboard's live terminal is an
SSE stream. The app already sends `X-Accel-Buffering: no`, and Caddy does not
buffer by default, so the supplied `Caddyfile` works as-is. If you replace Caddy
with nginx you must add `proxy_buffering off;` and raise `proxy_read_timeout`
well past the longest expected crawl (600s+) — otherwise the terminal appears
frozen and long jobs are cut off mid-stream.

**Crawls are long-lived requests.** A deep crawl runs for minutes. Any proxy,
load balancer or CDN in front needs read timeouts to match. This also rules out
most serverless platforms.

**Disk is the first thing to fail.** Screenshot archives are a *second* zip per
job. Monitor free space; the app refuses new jobs with `503` past
`STATICSNAP_MAX_TOTAL_BYTES`, and sweeps orphaned bundles older than an hour at
startup, but neither helps if the volume is already full.

**Chromium is memory-hungry.** `STATICSNAP_SCREENSHOT_CONCURRENCY=2` on a 4 GB
host is about right. Raising it, or `MAX_CONCURRENT_JOBS`, without adding RAM
will get the container OOM-killed mid-export.

**Job logs outlive artifacts by design** and live in the `staticsnap-logs`
volume. They are the primary diagnostic for a failed export:

```bash
curl -s https://staticsnap.muhammadabbasi.com/api/jobs/<jobId>/log
```

**Cold origins fail slowly.** The reachability probe allows 45s with 3 retries
(`STATICSNAP_PROBE_TIMEOUT_MS`, `STATICSNAP_PROBE_ATTEMPTS`). A cold WordPress
site behind LiteSpeed can exceed even that; raise the timeout rather than
assuming the target is down.

---

## 7. After it is live

Not required to launch, but do these before advertising the URL:

1. **Abuse protection.** The service fetches arbitrary URLs for anonymous
   visitors. Rate limits are per-IP and trivially bypassed with a proxy pool. Put
   Cloudflare Turnstile (or equivalent) in front of `POST /api/jobs`, or set
   `STATICSNAP_ACCESS_TOKEN` and keep it private.
2. **Backups.** Nothing here holds user data worth backing up — bundles are
   ephemeral by design. Back up `.env` and the `caddy-data` volume only.
3. **Monitoring.** Alert on `/api/health` and on host disk usage above ~70%.
4. **Log rotation.** Job logs accumulate in the volume indefinitely; add
   age-based pruning if the service sees steady traffic.
5. **Legal posture.** The service will mirror sites visitors do not own. Publish
   terms and an abuse contact, and honour takedown requests.

---

## 8. Reporting back

State plainly: which checks in §4 passed, which failed and why, the resolved
hostname decision from §0, and any `.env` value changed from the documented
default. If check 6 (SSRF) did not return `400`, say so first — the service must
not stay public in that state.
