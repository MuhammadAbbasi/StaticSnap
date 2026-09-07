/**
 * Secret-exposure scanner unit tests (Pro feature).
 *
 * Verifies high-signal patterns fire, placeholders do not, and — critically —
 * that no raw secret value ever leaves the scanner (redacted excerpts only).
 *
 * Run: `node ./tests/secrets.test.mjs` (also wired into `npm run test:unit`).
 */
import { scanTextForSecrets, redactSecret, sensitivePathFinding, summarize, mergeFindings } from "../dist/server/secrets.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GOOGLE_KEY = "AIzaSyB4mym7J2K8xQ0vT1uW3yZ5aB6cD7eF8gH0ijK";
const STRIPE_LIVE = "sk_live_SyntheticTestKey01";
const GITHUB_PAT = "ghp_abcdefghij1234567890abcdefghij12345678";
const OPENAI_KEY = "sk-proj-abcdefghij1234567890abcdefghij1234567890ab";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummySignature1234567890ab";

check("aws access key detected", scanTextForSecrets(`key=${AWS_KEY}`, "assets/app.js").some((f) => f.type.includes("AWS")));
check("google api key detected", scanTextForSecrets(`api:"${GOOGLE_KEY}"`, "index.html").some((f) => f.type.includes("Google")));
check("stripe live key is high", scanTextForSecrets(STRIPE_LIVE, "a.js")[0]?.severity === "high");
check("github token detected", scanTextForSecrets(GITHUB_PAT, "a.js").length === 1);
check("openai key detected", scanTextForSecrets(OPENAI_KEY, "a.js").length >= 1);
check("jwt detected as medium", scanTextForSecrets(`token=${JWT}`, "a.js").some((f) => f.severity === "medium"));
check("password assignment detected", scanTextForSecrets(`db_password = "s3cr3tP@ssw0rd!"`, "a.js").some((f) => f.type.includes("password")));
// Placeholder values must not alarm the site owner.
check("placeholder api key ignored", scanTextForSecrets(`api_key = "example"`, "a.js").length === 0);
check("changeme ignored", scanTextForSecrets(`password: "changeme"`, "a.js").length === 0);
check("clean file has no findings", scanTextForSecrets("<h1>Hello</h1><p>No secrets here.</p>", "index.html").length === 0);

// Redaction: the raw credential must not appear anywhere in the output.
const rawFindings = scanTextForSecrets(`const k="${STRIPE_LIVE}"; // ${AWS_KEY}`, "assets/app.js");
const blob = JSON.stringify(rawFindings);
check("raw stripe key never returned", !blob.includes(STRIPE_LIVE));
check("raw aws key never returned", !blob.includes(AWS_KEY));
check("redacted excerpt keeps shape only", rawFindings.every((f) => f.redacted.includes("***")));
check("redactSecret masks short values", redactSecret("abcdefg") === "ab***");
check("redactSecret keeps head/tail", redactSecret("abcdefghij123456") === "abcd***56");

// Sensitive paths.
check(".env path flagged high", sensitivePathFinding(".env")?.severity === "high");
check("pem path flagged", sensitivePathFinding("certs/server.pem") !== null);
check("normal js path not flagged", sensitivePathFinding("assets/app.js") === null);

// Summary + merge caps.
const s = summarize(
  [{ severity: "high" }, { severity: "medium" }, { severity: "low" }],
  4,
  100,
);
check("summary counts severities", s.high === 1 && s.medium === 1 && s.low === 1 && s.filesScanned === 4);
const merged = mergeFindings([[{
  id: "abc123",
  type: "t",
  severity: "high",
  file: "a.js",
  line: 1,
  redacted: "x***y",
  recommendation: "r",
}], [{
  id: "abc123",
  type: "t",
  severity: "high",
  file: "a.js",
  line: 1,
  redacted: "x***y",
  recommendation: "r",
}]]);
check("merge dedups by id", merged.findings.length === 1);

if (failures > 0) {
  console.error(`\nsecrets: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("\nsecrets: ALL CHECKS PASSED");
