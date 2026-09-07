import { createHash } from "node:crypto";

/**
 * Secret-exposure scanner (Pro / subscribed feature).
 *
 * Scans already-harvested page HTML plus downloaded text assets (JS, JSON,
 * CSS…) for accidentally published credentials: API keys, tokens, passwords,
 * private keys, JWTs and credentials embedded in URLs.
 *
 * Safety rules (load-bearing — do not weaken):
 * - Only scans content the crawler already fetched for the export. No extra
 *   outbound requests, so no new SSRF surface.
 * - NEVER returns a full secret to callers. Every finding carries a redacted
 *   excerpt (`redacted`) plus a hash fingerprint for dedup. The raw match is
 *   dropped before leaving this module.
 * - Callers must log counts/types only — never `redacted` at INFO, never the
 *   raw text. The dashboard shows redacted excerpts with a warning banner.
 */

export type SecretSeverity = "high" | "medium" | "low";
export type SecretStatus = "disabled" | "pending" | "running" | "completed" | "failed";

export interface SecretFinding {
  /** Stable dedup id: sha256(type + file + redacted-hash), 12 hex chars. */
  id: string;
  type: string;
  severity: SecretSeverity;
  /** Relative posix path inside the bundle (`index.html`, `assets/app.js`). */
  file: string;
  /** 1-based line number within the scanned text, when determinable. */
  line: number | null;
  /** Redacted excerpt — safe to render, store and transmit. */
  redacted: string;
  recommendation: string;
}

export interface SecretSummary {
  filesScanned: number;
  bytesScanned: number;
  findings: number;
  high: number;
  medium: number;
  low: number;
}

export interface SecretScanResult {
  summary: SecretSummary;
  findings: SecretFinding[];
  truncated: number;
}

export const MAX_SECRET_FINDINGS = 200;
const MAX_PER_FILE = 25;
/** Per-file scan cap — larger files are scanned up to this prefix only. */
export const MAX_SCAN_BYTES_PER_FILE = 2 * 1024 * 1024;

interface Rule {
  type: string;
  severity: SecretSeverity;
  recommendation: string;
  pattern: RegExp;
  /** Values matching this are obvious placeholders, not real secrets. */
  benign?: RegExp;
}

const BENIGN_VALUE = /^(example|sample|test|demo|changeme|placeholder|xxx+|\*+|password123?|12345678|abcdef|your[_-]?key[_-]?here)$/i;

const RULES: Rule[] = [
  {
    type: "AWS access key ID",
    severity: "high",
    recommendation: "Rotate the key in IAM immediately and never ship access keys in frontend code.",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    type: "AWS secret access key assignment",
    severity: "high",
    recommendation: "Rotate the IAM credentials. Use short-lived roles instead of long-lived secrets.",
    pattern: /aws[_-]?secret[_-]?access[_-]?key['"]?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  {
    type: "Google API key",
    severity: "high",
    recommendation: "Restrict the key by HTTP referrer/API in Google Cloud Console, then rotate it.",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}\b/g,
  },
  {
    type: "Stripe live secret key",
    severity: "high",
    recommendation: "Roll the key in the Stripe dashboard. Publishable keys are fine in frontend; secret keys must stay server-side.",
    pattern: /\bsk_live_[0-9A-Za-z]{16,}\b/g,
  },
  {
    type: "Stripe test secret key",
    severity: "medium",
    recommendation: "Test keys are lower risk but still rotate if the repo/bundle is public.",
    pattern: /\bsk_test_[0-9A-Za-z]{16,}\b/g,
  },
  {
    type: "GitHub token",
    severity: "high",
    recommendation: "Revoke the token on GitHub immediately — it grants repo/API access.",
    pattern: /\b(?:ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|ghu_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|ghr_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  {
    type: "GitLab personal access token",
    severity: "high",
    recommendation: "Revoke the token in GitLab user settings.",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "Slack token",
    severity: "high",
    recommendation: "Revoke the Slack token and rotate via the Slack app admin panel.",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    type: "OpenAI API key",
    severity: "high",
    recommendation: "Revoke the key in the OpenAI dashboard. Call AI APIs from a backend, never the browser bundle.",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    benign: /^(sk-test|sk-example)$/i,
  },
  {
    type: "Anthropic API key",
    severity: "high",
    recommendation: "Revoke the key in the Anthropic console. Keep model keys server-side.",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "SendGrid API key",
    severity: "high",
    recommendation: "Delete the key in SendGrid and create a scoped replacement.",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "Private key block",
    severity: "high",
    recommendation: "This private key is compromised — generate a new keypair and revoke the old one everywhere.",
    pattern: /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]{0,40}?/g,
  },
  {
    type: "JSON Web Token",
    severity: "medium",
    recommendation: "JWTs can carry session power. Shorten expiry, verify it is not a long-lived credential.",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    type: "Credentials in URL",
    severity: "high",
    recommendation: "Remove user:password from URLs. Use Authorization headers or a backend proxy instead.",
    pattern: /https?:\/\/[^\s"'<>`\/:]+:[^\s"'<>`@\/]+@[^\s"'<>`]+/g,
  },
  {
    type: "Hardcoded password / secret assignment",
    severity: "medium",
    recommendation: "Move the value to a backend secret store or env var; never ship it in frontend assets.",
    pattern: /(password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?([^'"\s;,}]{8,128})['"]?/gi,
  },
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Keep the shape of a secret for triage without exposing it. */
export function redactSecret(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return `${v.slice(0, 2)}***`;
  return `${v.slice(0, 4)}***${v.slice(-2)}`;
}

function excerptAround(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 48);
  const end = Math.min(text.length, index + matchLen + 24);
  const before = scrubContext(text.slice(start, index).replace(/\s+/g, " "));
  const after = scrubContext(text.slice(index + matchLen, end).replace(/\s+/g, " "));
  const raw = text.slice(index, index + matchLen);
  // Never echo more than the redacted shape, and cap context length.
  const snippet = `${before.slice(-48)}${redactSecret(raw)}${after.slice(0, 24)}`;
  return snippet.length > 160 ? `${snippet.slice(0, 157)}…` : snippet;
}

/**
 * Scrub surrounding context so a neighboring credential is not leaked
 * verbatim inside another finding's excerpt (e.g. two keys on one line).
 * Reuses the same high-signal patterns, replacing values with their shape.
 */
function scrubContext(fragment: string): string {
  let out = fragment;
  // Private-key headers carry no secret payload — drop them from context.
  out = out.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, (m) => redactSecret(m));
  out = out.replace(/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{20,}\b/g, (m) => redactSecret(m));
  out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, (m) => redactSecret(m.slice(0, 12)));
  out = out.replace(/(password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?([^'"\s;,}]{8,128})['"]?/gi, (_m, k: string, v: string) => `${k}=${redactSecret(v)}`);
  return out;
}

function fingerprint(type: string, file: string, match: string): string {
  return createHash("sha256").update(`${type}|${file}|${match}`).digest("hex").slice(0, 12);
}

/**
 * Scan one text blob. Returns redacted findings only — the raw match never
 * leaves this function.
 */
export function scanTextForSecrets(text: string, file: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  if (!text || text.length === 0) return out;
  const head = text.length > MAX_SCAN_BYTES_PER_FILE ? text.slice(0, MAX_SCAN_BYTES_PER_FILE) : text;
  const seen = new Set<string>();

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    let perRule = 0;
    while ((m = rule.pattern.exec(head)) !== null) {
      // For assignment rules the secret is capture group 2; otherwise the
      // whole match is the credential.
      const candidate = (m[2] ?? m[1] ?? m[0] ?? "").trim();
      if (candidate.length < 4) continue;
      if (BENIGN_VALUE.test(candidate)) continue;
      if (rule.benign?.test(candidate)) continue;
      // Guard against matching labels without values (`apiKey:` with nothing).
      if (/^(password|passwd|pwd|secret)$/i.test(candidate)) continue;

      const id = fingerprint(rule.type, file, m[0]);
      if (seen.has(id)) continue;
      seen.add(id);

      out.push({
        id,
        type: rule.type,
        severity: rule.severity,
        file,
        line: lineOf(head, m.index),
        redacted: excerptAround(head, m.index, m[0].length),
        recommendation: rule.recommendation,
      });
      perRule += 1;
      if (out.length >= MAX_PER_FILE || perRule >= MAX_PER_FILE) break;
    }
    if (out.length >= MAX_PER_FILE) break;
  }
  return out;
}

/** Flag bundle paths that should never be publicly reachable. */
export function sensitivePathFinding(relPath: string): SecretFinding | null {
  const lower = relPath.toLowerCase();
  const sensitive =
    /(^|\/)\.env(\.|$|-|_)|\.pem$|\.key$|(^|\/)id_rsa$|\.p12$|\.pfx$|wp-config\.php\.bak$|\.sql$|\.dump$/.test(lower);
  if (!sensitive) return null;
  return {
    id: createHash("sha256").update(`path|${relPath}`).digest("hex").slice(0, 12),
    type: "Sensitive file exposed",
    severity: "high",
    file: relPath,
    line: null,
    redacted: `${relPath} — config/backup file reachable in the bundle`,
    recommendation: "Remove private config, keys and database dumps from the public web root.",
  };
}

export function summarize(findings: SecretFinding[], filesScanned: number, bytesScanned: number): SecretSummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    if (f.severity === "high") high += 1;
    else if (f.severity === "medium") medium += 1;
    else low += 1;
  }
  return { filesScanned, bytesScanned, findings: findings.length, high, medium, low };
}

/** Merge per-file results with global dedup + cap. */
export function mergeFindings(lists: SecretFinding[][]): { findings: SecretFinding[]; truncated: number } {
  const seen = new Map<string, SecretFinding>();
  for (const list of lists) {
    for (const f of list) {
      if (!seen.has(f.id)) seen.set(f.id, f);
      if (seen.size >= MAX_SECRET_FINDINGS) {
        return { findings: [...seen.values()], truncated: 1 };
      }
    }
  }
  return { findings: [...seen.values()], truncated: 0 };
}

export const __testables = { RULES, redactSecret, excerptAround };
