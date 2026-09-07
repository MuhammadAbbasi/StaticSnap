import http, { STATUS_CODES } from "node:http";
import https from "node:https";
import {
  brotliDecompress,
  gunzip,
  inflate,
  inflateRaw,
} from "node:zlib";
import { promisify } from "node:util";
import { assertPublicUrl } from "./net-guard.js";

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const brotliDecompressAsync = promisify(brotliDecompress);

/**
 * Shared browser-realistic HTTP fetcher (StaticSnap + wp-to-astro).
 *
 * The transport is `node:http` / `node:https` — not the global `fetch`
 * (undici) — for three deliberate reasons, all verified against the wire
 * with an `/headers` echo endpoint:
 *
 * 1. Exact wire profile. Undici reserves the right to normalize what it
 *    sends (observed on Node 20: a caller-supplied
 *    `Sec-Fetch-Mode: navigate` arrives as `cors`, and forbidden-header
 *    filtering varies by version). `node:http` transmits {@link BROWSER_HEADERS}
 *    byte-for-byte, so the profile below is what LiteSpeed / ModSecurity
 *    actually sees, on every Node version.
 * 2. Keep-alive socket management. LiteSpeed aggressively RSTs connections
 *    with poor keep-alive behaviour. The module-level agents reuse sockets
 *    (`keep-alive`) with an idle reap timeout comfortably under typical
 *    LiteSpeed `KeepAliveTimeout` values, instead of churning a fresh
 *    TCP+TLS handshake per asset.
 * 3. One audited path for redirect following (with chain-cookie forwarding),
 *    uniform timeouts, and transparent `gzip` / `deflate` / `br` decoding.
 *
 * Every outbound crawl/download request in this repo must go through
 * {@link fetchWithTimeout} so the full desktop-Chrome profile below is what
 * remote hosts actually see.
 */

/** Complete desktop-Chrome header profile sent on every request. */
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua":
    '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

/** Default per-request time budget (matches the historical crawler value). */
export const FETCH_TIMEOUT_MS = 20_000;

/** Max redirect hops followed per request (browsers allow ~20; 10 is plenty). */
const MAX_REDIRECTS = 10;

/** Hard cap on a single response body — protects against zip-bombs / HLS. */
const MAX_BODY_BYTES = 100 * 1024 * 1024;

/**
 * Shared keep-alive agents. `timeout` reaps idle sockets after 30s so we
 * never write onto a connection LiteSpeed already closed server-side
 * (the classic RST-on-reuse failure). `maxSockets` bounds fan-out under
 * the crawler's `p-limit` concurrency.
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 4000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30_000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 4000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30_000,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Minimal header view — the only surface callers need (`res.headers.get`). */
export interface BrowserHeaderView {
  get(name: string): string | null;
}

/**
 * Minimal `fetch()`-Response-compatible result.
 *
 * Only the subset the codebase uses: `status`, `statusText`, `ok`, `url`
 * (final URL after redirects), `headers.get()`, `text()`, `arrayBuffer()`.
 */
export class BrowserResponse {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: BrowserHeaderView;
  private readonly body: Buffer;

  constructor(
    status: number,
    url: string,
    headers: Map<string, string>,
    body: Buffer,
  ) {
    this.status = status;
    this.statusText = STATUS_CODES[status] ?? "";
    this.url = url;
    const snapshot = new Map(headers);
    this.headers = {
      get: (name: string): string | null =>
        snapshot.get(name.toLowerCase()) ?? null,
    };
    this.body = body;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    return this.body.toString("utf8");
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.buffer.slice(
      this.body.byteOffset,
      this.body.byteOffset + this.body.byteLength,
    ) as ArrayBuffer;
  }

  /** Direct buffer access for download paths that want to skip a copy. */
  buffer(): Buffer {
    return this.body;
  }
}

function normalizeHeaders(
  headers: RequestInit["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers as Array<[string, string]>) {
      out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, string>,
  )) {
    out[key] = value;
  }
  return out;
}

function parseCookies(
  setCookie: string | string[] | undefined,
  jar: Map<string, string>,
): void {
  if (!setCookie) return;
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of values) {
    const pair = header.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair);
    }
  }
}

async function decodeBody(
  body: Buffer,
  contentEncoding: string | null,
): Promise<Buffer> {
  if (!contentEncoding) return body;
  const encodings = contentEncoding
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && token !== "identity");
  let out = body;
  // Encodings are listed in the order applied; decode in reverse.
  for (let i = encodings.length - 1; i >= 0; i--) {
    const encoding = encodings[i] as string;
    try {
      if (encoding === "gzip" || encoding === "x-gzip") {
        out = await gunzipAsync(out);
      } else if (encoding === "deflate") {
        try {
          out = await inflateAsync(out);
        } catch {
          // Some servers emit raw deflate streams without the zlib wrapper.
          out = await inflateRawAsync(out);
        }
      } else if (encoding === "br") {
        out = await brotliDecompressAsync(out);
      } else {
        throw new Error(`unsupported content-encoding: ${encoding}`);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("unsupported")) {
        throw error;
      }
      throw new Error(
        `failed to decode ${encoding} body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return out;
}

interface ChainState {
  headers: Record<string, string>;
  cookies: Map<string, string>;
  redirectsLeft: number;
  deadline: number;
}

async function requestOnce(
  urlStr: string,
  state: ChainState,
): Promise<BrowserResponse> {
  // SSRF choke point. Redirects recurse through here, so every hop is checked
  // — not just the URL the caller supplied. Also covers scheme validation and
  // malformed URLs, which this function used to do inline.
  const target = await assertPublicUrl(urlStr);

  return new Promise<BrowserResponse>((resolve, reject) => {
    const remaining = state.deadline - Date.now();
    if (remaining <= 0) {
      reject(
        new Error(
          `Request to ${target.host} timed out (budget exhausted while following redirects)`,
        ),
      );
      return;
    }

    const isHttps = target.protocol === "https:";
    const cookieHeader = [...state.cookies.values()].join("; ");
    const req = (isHttps ? https : http).request(
      target,
      {
        method: "GET",
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: remaining,
        headers: {
          ...state.headers,
          ...(cookieHeader.length > 0 ? { Cookie: cookieHeader } : {}),
        },
      },
      (res) => {
        parseCookies(res.headers["set-cookie"], state.cookies);

        const status = res.statusCode ?? 0;
        const location =
          res.statusCode !== undefined &&
          REDIRECT_STATUSES.has(res.statusCode) &&
          typeof res.headers.location === "string"
            ? res.headers.location
            : null;

        if (location !== null && state.redirectsLeft > 0) {
          // Drain the redirect body so the socket is reusable, then follow.
          res.resume();
          res.on("end", () => {
            let next: string;
            try {
              next = new URL(location, target.toString()).toString();
            } catch {
              reject(
                new Error(
                  `fetchWithTimeout: invalid redirect location "${location}" from ${target.toString()}`,
                ),
              );
              return;
            }
            state.redirectsLeft -= 1;
            requestOnce(next, state).then(resolve, reject);
          });
          res.on("error", (error: Error) => reject(error));
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let overflowed = false;
        res.on("data", (chunk: Buffer) => {
          if (overflowed) return;
          received += chunk.length;
          if (received > MAX_BODY_BYTES) {
            overflowed = true;
            req.destroy();
            reject(
              new Error(
                `fetchWithTimeout: response body from ${target.toString()} exceeds ${MAX_BODY_BYTES} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (overflowed) return;
          const raw = Buffer.concat(chunks);
          const responseHeaders = new Map<string, string>();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              responseHeaders.set(key.toLowerCase(), value.join(", "));
            } else if (typeof value === "string") {
              responseHeaders.set(key.toLowerCase(), value);
            }
          }
          decodeBody(raw, responseHeaders.get("content-encoding") ?? null).then(
            (body) => {
              resolve(
                new BrowserResponse(
                  status,
                  target.toString(),
                  responseHeaders,
                  body,
                ),
              );
            },
            (error: unknown) => reject(error),
          );
        });
        res.on("error", (error: Error) => reject(error));
      },
    );

    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Request to ${target.host} timed out after socket idle timeout`,
        ),
      );
    });
    req.on("error", (error: Error) => reject(error));
    req.end();
  });
}

/**
 * GET `url` with the full desktop-Chrome profile, following redirects,
 * forwarding chain cookies, transparently decoding `gzip` / `deflate` / `br`,
 * and rejecting if the whole attempt exceeds `timeoutMs`.
 *
 * `init` keeps the `fetch()`-shaped signature so existing call sites compile
 * unchanged — only `headers` is honoured (merged *over* {@link BROWSER_HEADERS}),
 * everything else (`method`, `body`, `signal`, …) is rejected to keep the
 * transport contract explicit.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<BrowserResponse> {
  if (init?.method !== undefined && init.method.toUpperCase() !== "GET") {
    throw new Error("fetchWithTimeout: only GET requests are supported");
  }
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("fetchWithTimeout: request bodies are not supported");
  }
  const state: ChainState = {
    headers: { ...BROWSER_HEADERS, ...normalizeHeaders(init?.headers) },
    cookies: new Map<string, string>(),
    redirectsLeft: MAX_REDIRECTS,
    deadline: Date.now() + timeoutMs,
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<BrowserResponse>((resolve, reject) => {
      timer = setTimeout(() => {
        let host = url;
        try {
          host = new URL(url).host;
        } catch {
          // keep raw url in the message
        }
        reject(
          new Error(`Request to ${host} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      // The overall budget must not keep a CLI/server process alive on its own.
      if (typeof timer.unref === "function") timer.unref();
      requestOnce(url, state).then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default fetchWithTimeout;
