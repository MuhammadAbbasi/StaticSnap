/**
 * Unit checks for srcset parsing and the non-HTTP skip guard.
 *
 * Regression cover for the production wordpress.com run, where a naive
 * `split(",")` tore `data:image/gif;base64,R0lGODlh...` in half. The tail
 * fragment then looked like a relative path, resolved against the page URL
 * (https://wordpress.com/it/R0lGODlh...), produced a 404 warning per
 * placeholder GIF, and — worse — got rewritten into a broken local path in
 * the saved HTML.
 *
 * Run: `npm run build && node ./tests/srcset.test.mjs`
 */
import { parseSrcset, isSkippable } from "../dist/server/crawler.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/* ---- the exact production case ---- */
{
  const entries = parseSrcset(`${GIF} 1x, https://ex.com/real.png 2x`);
  check("data-URI srcset yields exactly 2 candidates", entries.length === 2, `got ${entries.length}`);
  check("data URI survives intact", entries[0]?.url === GIF, entries[0]?.url);
  check("its descriptor is kept", entries[0]?.descriptor === "1x", entries[0]?.descriptor);
  check("the real URL still parses", entries[1]?.url === "https://ex.com/real.png", entries[1]?.url);
  check("the real descriptor is kept", entries[1]?.descriptor === "2x", entries[1]?.descriptor);

  // The actual bug: a torn fragment resolving to a bogus same-host path.
  const wouldFetch = entries
    .filter((entry) => !isSkippable(entry.url))
    .map((entry) => new URL(entry.url, "https://wordpress.com/it/").toString());
  check(
    "no base64 fragment is queued as a relative path",
    !wouldFetch.some((url) => url.includes("/it/R0lGODlh")),
    wouldFetch.join(" | "),
  );
  check("only the real asset is queued", wouldFetch.length === 1, wouldFetch.join(" | "));
}

/* ---- data URIs that themselves contain commas ---- */
{
  const svg = 'data:image/svg+xml;utf8,<svg viewBox="0,0,1,1"></svg>';
  const entries = parseSrcset(`${svg} 2x, /real.png 1x`);
  check("comma-bearing SVG data URI stays whole", entries[0]?.url === svg, entries[0]?.url);
  check("candidate after it is still found", entries[1]?.url === "/real.png", entries[1]?.url);
}

/* ---- ordinary srcsets must be unaffected ---- */
{
  const entries = parseSrcset("/a.png 320w, /b.png 640w, /c.png 1280w");
  check("plain srcset yields 3 candidates", entries.length === 3, `got ${entries.length}`);
  check("plain srcset urls", entries.map((e) => e.url).join(",") === "/a.png,/b.png,/c.png");
  check("plain srcset descriptors", entries.map((e) => e.descriptor).join(",") === "320w,640w,1280w");
}
{
  const entries = parseSrcset("/a.png,/b.png");
  check("comma-separated without spaces", entries.length === 2 && entries[1]?.url === "/b.png", JSON.stringify(entries));
}
{
  const entries = parseSrcset("  /only.png   ");
  check("single candidate, no descriptor", entries.length === 1 && entries[0]?.descriptor === "", JSON.stringify(entries));
}
check("empty srcset yields nothing", parseSrcset("").length === 0);

/* ---- the skip guard ---- */
for (const value of [GIF, "blob:https://x/y", "javascript:void(0)", "#anchor", "mailto:a@b.c", "tel:+123", "   "]) {
  check(`skipped: ${value.slice(0, 28)}`, isSkippable(value) === true);
}
for (const value of ["/a.png", "https://x.com/a.png", "//cdn.x.com/a.png", "../b.png"]) {
  check(`not skipped: ${value}`, isSkippable(value) === false);
}

if (failures > 0) {
  console.error(`\nsrcset: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("\nsrcset: ALL CHECKS PASSED");
