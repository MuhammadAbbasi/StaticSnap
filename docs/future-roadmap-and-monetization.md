# StaticSnap — Future Roadmap & Monetization Strategy

This document outlines the strategic roadmap, product tiers, monetization architecture, and technical implementation plan for evolving StaticSnap from an open-source tool into a sustainable SaaS and developer platform.

---

## 1. Product Tiers & Pricing Model

To balance wide adoption with sustainable revenue, StaticSnap will transition into a tiered SaaS offering with distinct Free, Pro, and Developer/Custom Output tiers.

### Tier Comparison Table

| Feature / Capability | Free Tier ($0) | Pro Tier ($10 / month) | Developer / Multi-Framework ($25 / month) |
|---|---|---|---|
| **Crawl Depth** | Limited (Depth: 1–2 levels, max 25–50 pages) | **Unlimited Depth** (full sitemaps) | **Unlimited Depth** (full sitemaps & custom paths) |
| **Output Formats** | Standard Static HTML/CSS/JS Bundle | Standard Static HTML/CSS/JS Bundle | **Custom Framework Outputs** (Angular, Node.js, Astro, Next.js, etc.) |
| **Concurrent Crawls** | 1 job at a time | Up to 3 parallel jobs | Up to 5 parallel jobs |
| **Crawl Speed & Concurrency** | Standard queue (5 pages / 8 assets) | Priority queue (15 pages / 20 assets) | Max speed priority queue (dedicated workers) |
| **Asset Optimization** | Basic (original formats) | Auto-WebP conversion, asset minification | Full media pipeline + responsive `srcset` generation |
| **Artifact Retention** | 15 minutes download window | 24 hours download availability | 7 days retention + direct cloud push |
| **SSPA / JavaScript Rendering** | Static HTTP fetch only | Headless browser option (Puppeteer/Playwright) | Headless browser with custom wait conditions & cookies |
| **Deployment Hooks** | Manual download only | Manual download + direct S3/Netlify links | 1-Click deploy to Cloudflare Pages, Vercel, S3, GitHub Pages |
| **Support** | Community / GitHub Issues | Email Support | Priority Developer Support |

---

## 2. Deep Dive into Tiers

### A. Free Tier ($0 / month)
The Free Tier is designed for open adoption, individual portfolios, and small site freezes:
- **Crawl Limits:** Strictly capped at a crawl depth of 1 or 2 levels, or a maximum of 25–50 pages per job.
- **Output:** Clean, self-contained static HTML/CSS/JS zip archive with relative path rewriting.
- **Guards:** Standard IP rate limiting (e.g. 5 jobs/hour), 15-minute temp disk retention, and strict SSRF protections.

### B. Pro Tier ($10 / month)
Targeted at agencies, system administrators, and webmasters looking to archive complete dynamic websites (e.g., enterprise blogs, corporate sites, documentation portals):
- **Unlimited Crawl Depth:** Remove the page count and depth ceilings, allowing full traversal of complete sitemaps (thousands of pages).
- **Headless Browser Capture:** Integrated Chromium rendering (Playwright/Puppeteer) to snapshot dynamic SPAs and client-side JavaScript content (React, Vue, Angular, hydration scripts).
- **Extended Retention:** Crawl bundles remain stored in cloud object storage (e.g., Cloudflare R2 / S3) for 24 hours with shareable download links.
- **Priority Worker Pool:** Dedicated job queue with higher concurrency limits for significantly faster harvesting.

### C. Developer / Custom Output Tier ($25 / month)
Targeted at software engineers and digital migration agencies who do not just want a static snapshot, but want to migrate an old CMS into a modern, editable codebase in their framework of choice.

#### Supported Output Formats:
1. **Angular Project:**
   - Emits a complete Angular static app or Angular Universal structure.
   - Converts HTML sections into modular standalone components (`header.component.ts`, `footer.component.ts`, `navigation.component.ts`).
   - Generates routing configuration (`app.routes.ts`) mapping the original site structure.
2. **Node.js / Express Server:**
   - Scaffolds an Express or Fastify server with clean static asset serving, compression middleware, security headers (Helmet), and optional templating (EJS/Handlebars).
3. **Astro 5 + MDX:**
   - Expands on the built-in `wp-to-astro` engine to convert crawled HTML pages into structured Astro collections, markdown frontmatter, and reusable Astro layout components.
4. **Clean Modular Vanilla JS / Modern HTML5:**
   - Sanitized, componentized HTML templates with modular ES6 JavaScript, BEM/Tailwind styling, and clean directory hierarchies.
5. **Next.js / React (Static Export):**
   - Emits an App Router project configured for `output: 'export'`, with pages organized under `/app/(site)/` and images wired to `next/image` unoptimized wrappers.

---

## 3. Technical Implementation Plan

### Milestone 1: Crawl Depth & Quota Enforcement Engine
- **Depth Tracking in Crawler (`src/server/crawler.ts`):**
  - Implement Breadth-First Search (BFS) queueing that attaches `depth: number` to each discovered URL.
  - Reject or discard links discovered at `depth > maxAllowedDepth` for Free users.
  - Add page counter check to gracefully finalize the crawl once the free page ceiling is reached, warning the user via the live terminal.
- **Plan Enforcement Middleware:**
  - Check user tier via API key or session JWT in `POST /api/jobs`.
  - Validate requested options (e.g., `scope: 'unlimited'`, `convertWebp`, `headless`) against the account's active plan.

### Milestone 2: Authentication & Billing Infrastructure
- **Authentication Service:**
  - Integrate Supabase Auth or Clerk for passwordless magic links, GitHub, and Google OAuth login.
  - Issue cryptographically signed API keys for CLI and headless integrations.
- **Stripe Billing Integration:**
  - Stripe Checkout sessions for monthly subscriptions ($10/mo Pro, $25/mo Developer).
  - Stripe Customer Portal for user self-service plan upgrades, downgrades, and invoice receipts.
  - Webhook listener (`POST /api/webhooks/stripe`) to handle `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`.

### Milestone 3: Multi-Target Code Generator Pipeline
- **Generator Interface:**
  ```typescript
  export interface ProjectGenerator {
    name: "html" | "angular" | "node" | "astro" | "nextjs";
    generate(context: CrawlContext): Promise<GeneratedProject>;
  }
  ```
- **AST / DOM Componentizer:**
  - Common component detection heuristic: identify recurring `<header>`, `<footer>`, `<nav>`, and `<aside>` elements across pages and extract them into shared framework components.
  - Asset pipeline mapping: ensure asset imports match the target framework's conventions (e.g. `src/assets/` in Angular, `public/` in Next.js).

### Milestone 4: Cloud Deployment & Form Forwarding Integrations
- **1-Click Deployment:**
  - Connect user Git accounts (GitHub/GitLab) or cloud providers (Cloudflare Pages, Vercel, Netlify, AWS S3).
  - Automatically push generated project repositories or deploy bundles directly.
- **Serverless Form Forwarder:**
  - Automatically detect `<form>` elements during transformation.
  - Offer seamless injection of endpoints (Formspree, Basin, custom webhook) so contact forms keep functioning without an origin PHP backend.

---

## 4. Projected Milestones & Timeline

```
[Phase 1: Depth Limiter & Tier Core]
 ├── Add BFS depth counter to crawler
 ├── Add page limit truncation with clean manifest notice
 └── Expose tier config in environment and config schemas

[Phase 2: Accounts & Stripe Billing]
 ├── User login & API key management
 ├── Stripe checkout integration ($10/mo and $25/mo plans)
 └── Webhook listener to toggle user tier capabilities

[Phase 3: Multi-Framework Generator Layer]
 ├── Modular output plugin architecture
 ├── Node.js / Express static server generator
 ├── Angular standalone component generator
 └── Next.js static export generator

[Phase 4: Ecosystem & Direct Integrations]
 ├── Headless browser crawling (Playwright)
 ├── Cloudflare Pages / S3 direct deployment
 └── Form webhook auto-rewriting
```
