/**
 * Checks for the live-terminal log renderer in `public/index.html`.
 *
 * Runs the *actual shipped* `appendLog` / `scrollTerminalToEnd` source, sliced
 * out of the dashboard and evaluated against a minimal DOM stub, so the test
 * cannot drift from the code it covers.
 *
 * Regression cover for the production wordpress.com run:
 *   - log lines were rendered 20-50x each, because every state frame re-sent
 *     the newest entry and the client had no way to tell it apart;
 *   - EventSource reconnects replay the job's whole history, duplicating again;
 *   - the terminal did not follow the newest line.
 *
 * Run: `node ./tests/terminal.test.mjs`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = readFileSync(
  path.join(here, "..", "public", "index.html"),
  "utf8",
);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---- slice the real implementation out of the dashboard ---- */
const start = dashboard.indexOf("  var LEVEL_STYLE = {");
const end = dashboard.indexOf("  /* ---------- state updates ---------- */");
check("located appendLog source in public/index.html", start > 0 && end > start);
if (start < 0 || end < 0) process.exit(1);
const source = dashboard.slice(start, end);
check(
  "shipped appendLog dedupes on seq",
  source.includes("entry.seq <= state.lastSeq"),
);
check(
  "shipped appendLog pins the terminal",
  source.includes("scrollTerminalToEnd()"),
);
check(
  "autoscroll assigns scrollHeight to scrollTop",
  source.includes("termBody.scrollTop = termBody.scrollHeight"),
);

/* ---- minimal DOM stub: only what appendLog touches ---- */
const LINE_HEIGHT = 20;
const termLines = {
  children: [],
  appendChild(node) {
    this.children.push(node);
  },
};
const termBody = {
  scrollTop: 0,
  clientHeight: 288,
  get scrollHeight() {
    return termLines.children.length * LINE_HEIGHT;
  },
};
const termEmpty = { style: {} };
const termCount = { textContent: "" };
const autoScroll = { checked: true };
const state = { lineCount: 0, lastSeq: 0 };
const frameQueue = [];
const requestAnimationFrame = (fn) => frameQueue.push(fn);
const flushFrames = () => {
  while (frameQueue.length > 0) frameQueue.shift()();
};
const document = { createElement: () => ({ className: "", innerHTML: "" }) };
const escapeHtml = (value) => String(value);
const toast = () => {};

const appendLog = new Function(
  "termLines", "termBody", "termEmpty", "termCount", "autoScroll", "state",
  "requestAnimationFrame", "document", "escapeHtml", "toast",
  `${source}; return appendLog;`,
)(
  termLines, termBody, termEmpty, termCount, autoScroll, state,
  requestAnimationFrame, document, escapeHtml, toast,
);

/* ---- replay a realistic stream ---- */
const LOGS = [
  "StaticSnap export started",
  "Scope=deep webp=on external=keep-remote",
  "Sitemap discovery: 2 page(s) queued",
  "Harvesting 2 page(s)…",
  "Asset engine: downloading 131 file(s)…",
  "Assets: 129 file(s) | 4.1 MB | 2 failed",
].map((message, i) => ({ seq: i + 1, ts: new Date().toISOString(), level: "INFO", message }));

// Every log frame, interleaved with the state frames that used to carry a
// duplicate of the newest entry (log: null now, so they render nothing).
for (const entry of LOGS) {
  appendLog(entry);
  for (let i = 0; i < 40; i += 1) appendLog(null);
}
flushFrames();

check(
  "each log line renders exactly once",
  termLines.children.length === LOGS.length,
  `rendered ${termLines.children.length}, expected ${LOGS.length}`,
);
check("line counter matches", state.lineCount === LOGS.length, String(state.lineCount));
check(
  "terminal is pinned to the newest line",
  termBody.scrollTop === termBody.scrollHeight,
  `scrollTop=${termBody.scrollTop} scrollHeight=${termBody.scrollHeight}`,
);

/* ---- EventSource reconnect: the server replays the whole history ---- */
const beforeReplay = termLines.children.length;
for (const entry of LOGS) appendLog(entry);
flushFrames();
check(
  "reconnect replay adds no duplicates",
  termLines.children.length === beforeReplay,
  `grew to ${termLines.children.length}`,
);

/* ---- a genuinely new entry after the replay still renders ---- */
appendLog({ seq: LOGS.length + 1, ts: new Date().toISOString(), level: "SUCCESS", message: "Archive ready" });
flushFrames();
check("new entries after a replay still render", termLines.children.length === beforeReplay + 1);
check(
  "terminal re-pins after the new line",
  termBody.scrollTop === termBody.scrollHeight,
  `scrollTop=${termBody.scrollTop} scrollHeight=${termBody.scrollHeight}`,
);

/* ---- client-side entries carry no seq and must always render ---- */
appendLog({ ts: new Date().toISOString(), level: "ERROR", message: "SSE connection lost." });
flushFrames();
check("seq-less local entries always render", termLines.children.length === beforeReplay + 2);

/* ---- autoscroll is batched, not one forced layout per line ---- */
{
  const seen = frameQueue.length;
  for (let i = 0; i < 50; i += 1) {
    appendLog({ seq: 1000 + i, ts: new Date().toISOString(), level: "INFO", message: `burst ${i}` });
  }
  check(
    "a 50-line burst schedules a single scroll frame",
    frameQueue.length - seen === 1,
    `scheduled ${frameQueue.length - seen}`,
  );
  flushFrames();
  check("burst ends pinned to the bottom", termBody.scrollTop === termBody.scrollHeight);
}

/* ---- respecting the autoscroll toggle ---- */
{
  autoScroll.checked = false;
  const pinned = termBody.scrollTop;
  appendLog({ seq: 2000, ts: new Date().toISOString(), level: "INFO", message: "while unpinned" });
  flushFrames();
  check("no autoscroll when the toggle is off", termBody.scrollTop === pinned);
  autoScroll.checked = true;
}

if (failures > 0) {
  console.error(`\nterminal: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("\nterminal: ALL CHECKS PASSED");
