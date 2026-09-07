import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF guard for user-supplied crawl targets.
 *
 * StaticSnap fetches whatever URL a visitor types. Deployed publicly that is a
 * server-side request forgery primitive: `http://169.254.169.254/` reaches
 * cloud instance metadata, `http://127.0.0.1:6379/` reaches a local Redis,
 * `http://10.0.0.5/` reaches the private network the host sits in.
 *
 * Every outbound request is checked here — not just the URL the visitor
 * submitted, but each redirect hop and every asset URL, because a public
 * hostname can resolve to a private address (DNS rebinding) or redirect into
 * one.
 *
 * Set `STATICSNAP_ALLOW_PRIVATE=1` to disable the guard for local development
 * and the test suite, which crawl `127.0.0.1`. Never set it in production.
 */

export const ALLOW_PRIVATE = process.env.STATICSNAP_ALLOW_PRIVATE === "1";

/** Thrown when a target resolves somewhere it must not be fetched from. */
export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out.push(value);
  }
  return out;
}

/** Is this IPv4 address outside the publicly routable space? */
function isPrivateIPv4(ip: string): boolean {
  const parts = ipv4ToParts(ip);
  if (!parts) return true; // unparseable — refuse rather than guess
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Is this IPv6 address outside the publicly routable space? */
function isPrivateIPv6(ip: string): boolean {
  const value = ip.toLowerCase().split("%")[0] ?? "";
  if (value === "::" || value === "::1") return true;
  // IPv4-mapped / IPv4-compatible: judge the embedded v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  const first = value.split(":")[0] ?? "";
  const head = Number.parseInt(first.padStart(4, "0").slice(0, 4), 16);
  if (Number.isNaN(head)) return true;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Does this literal IP address belong to a blocked range? */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * Validate one URL before it is fetched.
 *
 * Rejects non-HTTP schemes, credentials in the URL, and any host that resolves
 * to a non-public address. Resolution happens here so a hostname that points
 * at private space is caught even though it looks public.
 *
 * @throws {BlockedTargetError} when the URL must not be fetched.
 */
export async function assertPublicUrl(rawUrl: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new BlockedTargetError(`Not a valid URL: ${String(rawUrl)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedTargetError(`Only http:// and https:// URLs can be exported (got ${url.protocol}).`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new BlockedTargetError("URLs with embedded credentials are not accepted.");
  }
  if (ALLOW_PRIVATE) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) {
    throw new BlockedTargetError("URL has no host.");
  }
  // A bare "localhost" (and friends) never needs DNS to be obviously wrong.
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) {
    throw new BlockedTargetError(`Refusing to fetch internal hostname "${host}".`);
  }

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new BlockedTargetError(`Refusing to fetch private or reserved address ${host}.`);
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedTargetError(`Could not resolve host "${host}".`);
  }
  if (addresses.length === 0) {
    throw new BlockedTargetError(`Host "${host}" did not resolve.`);
  }
  // Every resolved address must be public: one private answer is enough for a
  // rebinding attack to land.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedTargetError(
        `Host "${host}" resolves to a private or reserved address (${address}) and cannot be exported.`,
      );
    }
  }
  return url;
}
