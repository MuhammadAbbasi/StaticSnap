# StaticSnap — Project Scope & Requirements

## 1. Executive Summary & Vision

**StaticSnap** is an instant, web-to-static replatforming engine and CMS archiver designed to turn dynamic, server-dependent websites into self-contained, lightning-fast static bundles that can run anywhere without an origin server, database, or backend runtime.

The project addresses a common and expensive problem: maintaining legacy dynamic websites (WordPress, Drupal, Joomla, Squarespace, Ghost, or custom monolithic CMSs) that rarely change but continually incur hosting costs, maintenance overhead, security patching, and vulnerability risks.

StaticSnap provides two complementary migration paths:
1. **The Visual Freeze Path (StaticSnap Web & Engine):** Crawls the rendered output of any live website, downloads all assets, rewrites links for 100% offline relative resolution, and streams a downloadable, host-ready `.zip` archive.
2. **The Code-First Modernization Path (`wp-to-astro` CLI):** Converts a WordPress WXR XML export into an Astro 5 + Tailwind CSS + MDX codebase for developers who wish to continue developing and editing content statically.

---

## 2. What I Want From This Project (Core Goals)

### A. Frictionless Web-to-Static Archiving
- **One-Click Freeze:** Paste a URL, select a crawl scope (Single Landing Page or Deep Crawl), and generate a deployable static archive.
- **Universal Compatibility:** Works independently of the origin tech stack because it operates on the rendered HTTP response rather than the underlying CMS code or database.
- **Sitemap-Driven Deep Crawling:** Automatically discovers pages via `sitemap.xml`, `wp-sitemap.xml`, `sitemap_index.xml`, `page-sitemap.xml`, and `robots.txt`, recursing through sitemap indexes up to configurable page limits.
- **Host-Agnostic Output:** The generated archive must run immediately upon unzipping on any static file server, including:
  - AWS S3 / CloudFront
  - Cloudflare Pages / Workers
  - Netlify / Vercel
  - GitHub Pages
  - Nginx / Caddy / Apache
  - Local filesystem or offline air-gapped environments

### B. Complete Offline Visual & Functional Fidelity
- **Origin-Independent Resilience:** Once downloaded, if the original origin server is terminated or erased, the static site must remain 100% visually intact and operational.
- **Deep Asset Engine:** Download and localize every required resource:
  - Stylesheets (`.css`) and inline `<style>` tags
  - Client-side scripts (`.js`) and module scripts
  - Web fonts (`.woff2`, `.woff`, `.ttf`, `.otf`, `.eot`)
  - Images (JPEG, PNG, WebP, AVIF, SVG, GIF, ICO)
  - Rich media (`<video>`, `<audio>`, poster images)
  - Favicons, manifest files (`site.webmanifest`), and OpenGraph/meta images
  - Nested CSS dependencies (stylesheets referencing background images and font files inside `url(...)` declarations)
- **Precise Link & Attribute Rewriting:**
  - Rewrite all internal page URLs to relative paths (e.g., `/about/` -> `../about/index.html`).
  - Rewrite all media attributes: `src`, `href`, `srcset`, `data-src`, `data-srcset`, `poster`, and CSS `url(...)`.
  - Intact Data URIs: Preserve inline `data:image/...` schemes byte-for-byte without corruption.
  - Leave external non-target links pointing to their canonical remote URLs.
- **Optional Asset Optimization:** Ability to automatically transcode heavy raster images (JPEG/PNG) to modern WebP to reduce bundle footprint.

### C. Real-Time Telemetry & Modern User Experience
- **Live SSE Streaming Dashboard:** A clean, modern dashboard built with Tailwind CSS, dark mode support, and zero external build tool requirements.
- **Granular Progress Telemetry:** Real-time visibility into every crawl phase:
  1. Discovery & Reachability Probe
  2. Page Harvesting
  3. Asset Ingestion
  4. Link & Asset Transformation
  5. Zip Packaging & Manifest Creation
- **Live Terminal Console:** An interactive ANSI terminal streaming colored, real-time log lines (`INFO`, `SUCCESS`, `WARN`, `ERROR`).
- **Audit & Manifest Export:** Every generated zip includes a `staticsnap-manifest.json` detailing crawl source, crawl date, page count, asset inventory, total byte size, and any failed resource URLs.
- **Durable Logging:** Retain persistent job logs on disk for debugging and auditing even across server restarts.

### D. Production-Grade Security & Guardrails
- **Comprehensive SSRF Protection (`net-guard`):** Anonymous users can submit URLs, making SSRF mitigation critical. Every request (initial URL, redirects, and every individual asset) must strictly reject:
  - Loopback addresses (`127.0.0.0/8`, `::1`)
  - RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
  - Link-local and cloud metadata addresses (`169.254.169.254`, AWS/GCP/Azure metadata services)
  - CGNAT, multicast, and reserved IP ranges
  - Hostnames resolving to private IPs (DNS rebinding prevention)
  - Non-HTTP protocols (`file://`, `gopher://`, `ftp://`)
  - User-credentialed URLs (`user:pass@host`)
- **Anti-Bot Navigation Headers:** Emulate real desktop Chrome browser request headers and TLS characteristics to avoid 403 Forbidden rejections from Cloudflare, AWS CloudFront, and Akamai WAFs.
- **Resource & Disk Protections:**
  - Per-export byte ceilings (e.g., 2 GiB) to prevent disk exhaustion.
  - Global disk consumption ceilings (e.g., 10 GiB) to refuse new jobs when temp storage is full.
  - Automatic orphan reaper to purge stale jobs and temporary working directories.
  - Strict IP rate limiting and optional access token authorization (`STATICSNAP_ACCESS_TOKEN`).

### E. Code-First JAMstack Migration Path (`wp-to-astro`)
- **Structured Content Conversion:** Parse WordPress WXR XML database exports into structured Astro 5 pages and MDX collections.
- **Clean Markdown Extraction:** Use Turndown with GFM tables and custom rules to convert messy WordPress HTML/Gutenberg blocks into clean markdown without losing layout structure.
- **Image Pipeline:** Extract media attachments, store them in `src/assets/images/`, and wire them to Astro's `<Image />` component with automatic WebP conversion and responsive sizing.
- **Ready to Build:** Output a fully functioning Astro project with Tailwind CSS typography, responsive layouts, syntax highlighting, and `astro build` verification.

---

## 3. Scope Boundaries

### In-Scope
- Crawling single landing pages and multi-page sitemaps (up to configured depth/page ceilings).
- Complete asset harvesting (HTML, CSS, JS, fonts, images, audio, video, manifests).
- Offline URL relative path transformation across all DOM attributes and CSS stylesheets.
- Zip compression with audit manifest and checksums.
- Real-time web UI with SSE progress tracking and live console.
- CLI interface for batch jobs and scriptable workflows.
- SSRF prevention, IP rate limits, disk space guards, and token authentication.
- WordPress XML to Astro + MDX template conversion.

### Out-of-Scope (Non-Goals)
- **Dynamic Server Runtimes:** StaticSnap freezes rendered output; it does not replicate server-side PHP/Node runtimes, databases (MySQL, Postgres), or server-side API endpoints.
- **Dynamic Authentication & Sessions:** User logins, member portals, and gated dashboard sessions cannot exist on a static freeze.
- **Server-Side E-Commerce Transactions:** Shopping carts, active checkouts, and payment gateways requiring server-side state are out of scope (can be integrated with third-party headless widgets like Snipcart or Shopify Buy Buttons).
- **Live Search Backends:** Origin database search is frozen (can be replaced by client-side static search libraries such as Pagefind or Lunr.js).
- **Dynamic Form Handling:** Forms do not have an origin PHP script to process POST requests. Forms must either post to third-party endpoints (Formspree, Basin) or external webhooks.

---

## 4. Architecture & Component Map

| Component | File Location | Responsibility |
|---|---|---|
| **Crawler Engine** | `src/server/crawler.ts` | Page discovery, HTML parsing, asset discovery, relative link rewriting, and zip building. |
| **Network Guard** | `src/net-guard.ts` | Strict SSRF defense, IP address classification, DNS resolution checks, and URL validation. |
| **Fetcher Layer** | `src/fetcher.ts` | Safe HTTP/HTTPS client with browser-like headers, decompression, timeout handling, and redirect enforcement. |
| **Job Manager** | `src/server/jobManager.ts` | Job lifecycle state, concurrency control, SSE pub/sub broadcast, and disk cleanup routines. |
| **Dashboard UI** | `public/index.html` | Real-time frontend dashboard with SSE listener, stage indicators, and virtual terminal. |
| **Archive Packer** | `src/server/zipper.ts` | Stream-based `.zip` archive creation and disk release. |
| **WXR Parser** | `src/extractor/xml.ts` | Parsing WordPress XML export dumps into typed channel/item models. |
| **MDX Transformer** | `src/transformer/ast-to-mdx.ts` | Converting HTML/Gutenberg blocks to clean MDX with frontmatter. |
| **Astro Scaffolder** | `src/scaffolder/template.ts` | Generating complete Astro project structures with layouts and Tailwind CSS. |

---

## 5. Future Roadmap & Desired Enhancements

1. **Headless Browser Capture (Puppeteer / Playwright):**
   - Add an optional rendering engine for heavy JavaScript SPAs (React, Vue, Angular) where content is injected exclusively on the client side after initial HTML load.
2. **One-Click Deploy Integrations:**
   - Direct publish hooks to push the unzipped static site directly to Cloudflare Pages, Netlify, or AWS S3 via API tokens.
3. **Form-to-Webhook Auto-Rewriter:**
   - Option to automatically rewrite existing `<form action="...">` tags to forward submissions to a configured webhook or Formspree endpoint.
4. **Client-Side Search Injection:**
   - Automatically index static pages during crawl and bundle an integrated [Pagefind](https://pagefind.app/) search bar into the exported static site.
5. **Differential Crawling / Scheduled Freezes:**
   - Incremental crawl mode to update existing archives without refetching unchanged assets.
