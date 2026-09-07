# Repository Audit — `wp-to-astro`

**Repository:** `G:\M\siteDown_js`
**Date:** 2026-09-04
**Auditor role:** Principal Software Architect / Code Auditor
**Method:** file-by-file inspection of all 10 source files, plus executed verification
(`tsc --noEmit`, `tsup` build, CLI run, `npm install` + `astro build` on the generated
output, and the repo's own e2e suite). No conclusion below is inferred; each is
either read from the file cited or observed in command output.

---

## 0. Scope mismatch — read this first

**This repository is not the tool described in the audit brief.** `G:\M\siteDown_js`
contains `wp-to-astro` (`package.json:2`): a converter that reads a **WordPress WXR
XML export file from disk** and emits an **Astro 5 / MDX project**. It is not a URL
scraper and contains no crawling code.

Nothing in the brief's core workflow exists here:

| Brief requirement | Reality in this repo |
|---|---|
| Prompt for target URL | Prompts for a **file path** to `export.xml` (`src/cli.ts:37`, `src/cli.ts:60-69`) |
| Scope 1/2 choice; crawl `sitemap.xml`; recurse `<sitemapindex>` | **Absent.** No sitemap code anywhere. `src/extractor/xml.ts` parses WXR RSS `<channel><item>`, not sitemaps |
| `./cloned-sites/<hostname>/` | `./astro-site` (`src/cli.ts:41`) |
| `assets/images`, `assets/css`, `assets/js`, fonts | **Only** `src/assets/images` (`src/scaffolder/template.ts:602`) |
| Fetch full HTML per page | **Absent.** No page fetching; HTML comes from the XML export |
| Download CSS / JS / fonts / media | **Absent.** Only images: `jpg jpeg png webp svg gif` (`src/media/harvester.ts:6`) |
| Rewrite `src` / `href` / `srcset` / CSS `url()` | Images only, by raw string replace (`src/media/pipeline.ts:147-157`) |
| Keep tables / forms / nav intact | Tables survive (turndown-gfm, `src/transformer/ast-to-mdx.ts:65`). **Forms, inputs and buttons are silently dropped** by Turndown — no rules defined. Nav menus are not in WXR post content at all |
| Realistic desktop browser headers | **Not met.** UA is `wp-to-astro/0.1.0 (+https://github.com/wp-to-astro)` (`src/media/harvester.ts:208-211`) — a bot UA, exactly what invites the 403s the brief wants avoided |
| `p-limit` concurrency + try/catch boundaries | **Met, and done well** (`src/media/pipeline.ts:71`, `:115-133`; timeout + 2 retries at `src/media/harvester.ts:197-254`) |

Judged against the brief, roughly 2 of 10 requirements are implemented. Everything
below judges the code against **what it actually is** — a WordPress-to-Astro
migrator — which is the only fair audit of the code present.

---

## 1. Executive Verdict

### Before fixes: **CRITICALLY BROKEN**

Not from missing dependencies or stubbed functions — the code was complete,
typechecked clean, and its own e2e suite passed 19/19. It was broken at the
*output* level: **every migration containing an image produced an Astro site that
would not build.**

The e2e suite never caught this because it only asserts that the emitted `.mdx`
contains the substring `../../assets/images/` (`tests/e2e.mjs:167-171`). It never
builds the site it generates.

Proven, fixed, and re-proven:

```
# BEFORE (normal success path — images downloaded and rewritten)
[LocalImageUsedWrongly] `Image`'s `src` parameter must be an imported image
or an URL, it cannot be a string filepath. Received `../../assets/images/test.png`
build exit: 1

# BEFORE (fallback path — download failed, remote URL left in place)
[MissingImageDimension] Missing width and height attributes for
https://example.invalid/uploads/test.png
build exit: 1

# AFTER
> /blog/hello-world/index.html   /blog/second-post/index.html   /blog/about/index.html
> /_astro/test.5vcyeoBI_1qMwW8.webp (1/1)
4 page(s) built - Complete!   BUILD EXIT: 0
```

### After fixes: **READY TO RUN** (as a WordPress-to-Astro migrator)

Verified end to end:

| Step | Result |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npm run build` (tsup) | clean, exit 0 |
| CLI migration (`--source` / `--out`) | exit 0, 3 posts, 2 images |
| `npm install` in generated project | exit 0, 397 packages |
| `astro build` — success path | **exit 0**, 4 pages, image optimized to WebP |
| `astro build` — failed-download fallback path | **exit 0**, degrades to plain `<img>` |
| `npm run test:e2e` after changes | 19/19 PASS, no regression |

---

## 2. Dependency Status

**No missing dependencies. No `npm install` is required.**

Every `import` / `require` across all source files resolves to a package that is
both declared in `package.json` and present in `node_modules`. Verified by
extracting every import specifier and resolving each one:

```
@clack/prompts 1.7.0                                     OK
@wordpress/block-serialization-default-parser 5.54.0     OK
cheerio 1.2.0                                            OK
commander 14.0.3                                         OK
fast-xml-parser 5.11.1                                   OK
fs-extra 11.4.0                                          OK
gray-matter 4.0.3                                        OK
p-limit 7.3.2                                            OK
picocolors 1.1.1                                         OK
sharp 0.35.4                                             OK
turndown 7.2.4                                           OK
turndown-plugin-gfm 1.0.2                                OK
zod 4.5.4                                                OK
typescript 5.9.3 / tsup 8.5.1 (dev)                      OK
```

The `astro:*`, `astro/*` and `*.astro` imports live inside scaffolded template
strings and are resolved in the **generated** project, not this one. Correct by
design — they are not missing dependencies of this package.

### Deprecations and version notes (none blocking)

| Item | Status | Action |
|---|---|---|
| `@types/sharp@^0.31.1` (`package.json:37`) | Deprecated stub — sharp >= 0.32 ships its own types | `npm rm @types/sharp` |
| `z.string().url()` (`src/types/index.ts:18`) | Deprecated in zod 4 (4.5.4 installed) | Use `z.url()` — or delete it, the schema is dead code (see G3) |
| `@astrojs/tailwind@^5.1.0` in the scaffold | Deprecated by Astro (superseded by `@tailwindcss/vite` + Tailwind 4) | Functional today. Published peer range was checked directly: `astro: ^3.0.0 \|\| ^4.0.0 \|\| ^5.0.0`, so `npm install` succeeds with **no `ERESOLVE`**. Migrate when convenient |
| Node engine warning | `sharp` / `p-limit` want newer than the local Node v20.18.1 | `EBADENGINE` warning only; install and build both succeeded |

**The only dependency command worth running:**

```bash
npm rm @types/sharp
```

---

## 3. Discovered Deficiencies & Gaps

### 3.1 Fixed (these were breaking the output)

#### D1 — CRITICAL · `src/scaffolder/template.ts` · `ResponsiveImage.astro` + `ImageGallery.astro` templates

The pipeline rewrites images to string paths such as `../../assets/images/test.png`
(returned at `src/media/harvester.ts:394`) and emits
`<ResponsiveImage src="../../assets/images/test.png" />`
(`src/transformer/ast-to-mdx.ts:136-138`).

Both templates passed that string straight into the `astro:assets` `<Image>`
component, which **rejects string filepaths** — it requires an imported
`ImageMetadata` object. Result: `LocalImageUsedWrongly`, build exits 1.

The fallback branch failed too: when a download fails the remote URL is left in
place by design (`src/media/pipeline.ts:124-131`), and `<Image>` requires explicit
`width`/`height` for remote sources — `MissingImageDimension`, build exits 1.

**Both branches of the tool's own image handling produced an unbuildable site.**
Any real WordPress export contains images, so this affected essentially every run.

#### D2 — `src/transformer/ast-to-mdx.ts:295,297` vs. the `Callout.astro` template

The transformer emits `<Callout type="quote" citation="Tester">`. The component
declared `type?: "info" | "note" | "warning" | "tip" | "danger"` and a prop named
`cite`. Neither `"quote"` nor `citation` existed, so the tone silently fell back to
`info` and **every quote citation was discarded at render time**.

TypeScript cannot catch this: the contract spans a TS template string on one side
and a generated `.astro` file on the other.

#### D3 — `prose` classes with no plugin declared

`prose`, `prose-slate`, `prose-sm` and `dark:prose-invert` are used in
`BaseLayout.astro`, `BlogPostLayout.astro` and `Callout.astro`, but the scaffolded
`package.json` never declared `@tailwindcss/typography` and `tailwind.config.mjs`
had `plugins: []`. Every `prose` class was a no-op — migrated article bodies
rendered completely unstyled.

### 3.2 Reported, not fixed (real gaps; nothing currently depends on them)

#### G1 — `src/extractor/xml.ts:187`: `featuredImage: null` is hardcoded

WXR carries the featured image as a `<wp:postmeta>` entry `_thumbnail_id` pointing
at a separate `attachment` item; that resolution is never implemented. Consequently
an entire vertical slice is dead code that can never fire:

- the zod field `src/types/index.ts:12`
- the content-collection schema `src/scaffolder/template.ts:64`
- the whole `featuredImage` branch of `buildFrontmatter`, `src/transformer/frontmatter.ts:86-108`

This is the one genuinely **unfinished feature** in the codebase.

#### G2 — `redirects.json` is written but nothing consumes it

`src/pipeline.ts:162-167` produces a correct permalink-to-slug map, but the
scaffolded `astro.config.mjs` (`src/scaffolder/template.ts:37-45`) has no
`redirects` key and no adapter. The file is an inert artifact — the migrated site
serves no redirects. Either wire it into the Astro config or document it as input
for the host's own redirect configuration.

#### G3 — dead code and speculative API surface

- `MediaItemSchema` / `MediaItem` (`src/types/index.ts:17-24`) — exported, never used anywhere.
- `writeMdxFile` / `writePostMdx` / `ensureMdxExtension` (`src/transformer/frontmatter.ts:188-258`) — never called; the pipeline writes files itself at `src/pipeline.ts:151`.
- Roughly 18 pure re-export aliases (`parseWordPressXml`, `extractPosts`, `parseWxr`, `blocksToMdx`, `convertContentToMdx`, `convertBlocksToMdx`, `scaffoldSite`, `writeTemplate`, `createSiteTemplate`, `createSiteScaffold`, `stringifyMdx`, `createMdxDocument`, ...) with at most one real consumer each.

For a single-entry CLI this is unnecessary surface area to maintain.

#### G4 — `src/media/harvester.ts:59-60, 107-110`: relative image URLs are never harvested

`extractImageUrls` only matches `https?://...` and protocol-relative `//host/...`.
A WXR containing `<img src="/wp-content/uploads/x.jpg">` leaves a permanently broken
reference with no warning. Uncommon in real exports (WordPress writes absolute URLs)
but silent when it does occur.

#### G5 — `src/media/pipeline.ts:149`: rewriting is `split().join()` over the whole post body

Longest-URL-first ordering (`src/media/pipeline.ts:144`) correctly prevents a URL
that is a prefix of another from clobbering it. However a remote URL mentioned in
*prose text* — not as an attribute — is rewritten too. An acceptable trade-off,
recorded here so it is a known behaviour rather than a surprise.

#### G6 — test coverage: one e2e, no unit tests

More important than the count: the e2e's image assertion
(`tests/e2e.mjs:167-171`) checks only that the path **string** appears in the MDX.
That is precisely why D1 shipped undetected. The suite validates the migrator's
output *shape* but never that the output **is a working Astro site**.

**Recommended addition:** an e2e step that runs `npm install && npx astro build`
in the generated directory and asserts exit 0. That single check would have caught
D1, D2 and D3.

### 3.3 Verified correct — no action required

Answering the brief's specific implementation-completeness questions directly:

- **Is the XML parser real or a stub?** Real, and solid. `fast-xml-parser` with
  `ignoreAttributes: false` (`src/extractor/xml.ts:13-16`, `:135`); correct CDATA
  handling via `#text` / `__cdata` / `#cdata` fallbacks (`:26-55`); single-vs-array
  item normalization (`:67-72`); `post_tag` vs. category discrimination by
  `@_domain` (`:96-110`); correct filtering to `status=publish` and type
  `post` | `page` (`:156-163`). There is simply no **sitemap** parser, because
  there is no crawling feature at all.
- **`srcset` with multiple comma-separated candidates?** Handled incidentally but
  correctly — the extractor sweeps raw text for absolute image URLs, so each
  candidate in a `srcset` is matched individually and the `300w` / `2x` descriptors
  fall outside the match (`src/media/harvester.ts:48-141`).
- **Relative `../` paths?** Not handled — see G4.
- **`TODO` / `FIXME` / stubs?** **Zero** in the codebase. The three `placeholder:`
  grep hits are `@clack/prompts` UI strings (`src/cli.ts:62`, `:82`, `:118`).
- **Entry-point wiring?** Correct. `src/cli.ts:174-224` to `src/pipeline.ts:77-178`
  ties argv parsing -> interactive prompts -> validate -> scaffold -> parse ->
  media download -> MDX transform -> file write -> redirects, in that order, with
  stage callbacks driving the spinner.
- Also verified sound: slug de-duplication (`src/pipeline.ts:141-146`), md5-suffixed
  filename collision handling (`src/media/harvester.ts:344-387`), and the `p-limit`
  plus per-image try/catch resilience layer (`src/media/pipeline.ts:71`, `:115-133`).

---

## 4. Actionable Fixes

All three fixes below are **applied** to `src/scaffolder/template.ts`, typechecked,
and rebuilt (`dist/` regenerated).

### D1 — resolve local asset paths to `ImageMetadata`, degrade gracefully otherwise

`src/scaffolder/template.ts:144-221` (`ResponsiveImage.astro`) and `:222-371`
(`ImageGallery.astro`). Both components now map local file names to real
`ImageMetadata` via `import.meta.glob`, and fall back to a plain `<img>` for
anything unresolved (remote URL, missing file) instead of failing the build:

```astro
const assets = import.meta.glob<{ default: ImageMetadata }>(
  "../assets/images/*",
  { eager: true },
);
const assetsByName = new Map(
  Object.entries(assets).map(([filePath, mod]) => [
    filePath.split("/").pop(),
    mod.default,
  ]),
);

const resolved: ImageMetadata | string =
  typeof src === "string"
    ? (assetsByName.get(src.split("/").pop() ?? "") ?? src)
    : src;
---
{
  typeof resolved === "string" ? (
    <img src={resolved} alt={alt} loading={loading} decoding={decoding}
         class="h-auto w-full object-cover" />
  ) : (
    <Image src={resolved} alt={alt} widths={widths} sizes={sizes}
           formats={["avif", "webp"]} loading={loading} decoding={decoding}
           class="h-auto w-full object-cover" />
  )
}
```

`ImageGallery.astro` applies the same resolution per image via a `resolvedImages`
map, keeping the existing lightbox behaviour intact.

### D2 — align the `Callout` contract with what the transformer emits

`src/scaffolder/template.ts:372-408`. The component now declares the `"quote"` type
with a slate tone and renames the prop to `citation`, matching
`src/transformer/ast-to-mdx.ts:295,297` exactly:

```astro
interface Props {
  type?: "info" | "note" | "warning" | "tip" | "danger" | "quote";
  title?: string;
  citation?: string;
}

const { type = "info", title, citation } = Astro.props;

const tones: Record<string, string> = {
  /* ...existing tones... */
  quote: "border-slate-400 bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100",
};
```

Confirmed in the rendered output: `<cite>Tester</cite>` now appears in
`dist/blog/hello-world/index.html`.

### D3 — declare and wire the typography plugin

`src/scaffolder/template.ts:29` (scaffolded dependency),
`:74` (config import), `:82` (plugin registration):

```js
"@tailwindcss/typography": "^0.5.0",
```

```js
import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: { extend: {} },
  plugins: [typography],
};
```

### Remaining one-liner for this repo

```bash
npm rm @types/sharp
```

---

## 5. What was deliberately not done

- **The URL/sitemap scraper from the brief was not implemented.** That is not a
  repair of this repository — it is a different product (page fetching, sitemap
  index recursion, CSS/JS/font harvesting, `href` / `srcset` / `url()` rewriting,
  browser-realistic headers). If it is wanted, this repo's download layer
  (`p-limit` + retry/timeout + collision-safe filenames, `src/media/harvester.ts`)
  is genuinely good and worth reusing as the foundation.
- **G1 (`featuredImage`) and G2 (`redirects.json` wiring) were left as-is.** Both
  are real unfinished features, but neither currently breaks anything, and
  implementing them changes product behaviour rather than fixing a defect. Both are
  ready to implement on request.

---

## Appendix — files inspected

| File | Lines | Verdict |
|---|---|---|
| `package.json` | 51 | Complete; one deprecated devDependency |
| `tsconfig.json` | 24 | Strict, `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` on; clean |
| `tsup.config.ts` | 10 | Complete |
| `src/cli.ts` | 233 | Complete; argument parsing + prompts + error handling all wired |
| `src/pipeline.ts` | 180 | Complete; correct stage orchestration |
| `src/types/index.ts` | 33 | Complete; `MediaItemSchema` dead (G3), deprecated `.url()` |
| `src/types/turndown-plugin-gfm.d.ts` | 8 | Complete |
| `src/extractor/xml.ts` | 222 | Complete; `featuredImage` hardcoded null (G1); alias bloat (G3) |
| `src/media/harvester.ts` | 395 | Complete; bot UA vs. brief; no relative URLs (G4) |
| `src/media/pipeline.ts` | 161 | Complete; concurrency + error boundaries correct |
| `src/transformer/ast-to-mdx.ts` | 521 | Complete; Callout contract mismatch (D2, fixed) |
| `src/transformer/frontmatter.ts` | 269 | Complete; three unused writers + alias bloat (G3) |
| `src/scaffolder/template.ts` | 545 -> 618 | **Was defective (D1, D2, D3) — now fixed** |
| `tests/e2e.mjs` | 252 | Works, passes; blind to build validity (G6) |
| `tests/fixtures/sample-export.xml` | 87 | Good coverage: post, page, draft, attachment, image, quote, code |
