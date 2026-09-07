import { createHash } from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import sharp from "sharp";
import { fetchWithTimeout } from "../fetcher.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "svg", "gif"]);

const RASTER_OPTIMIZABLE = new Set(["jpg", "jpeg", "png"]);

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Decode a minimal subset of HTML entities found in WordPress content.
 * Primarily `&amp;` which appears in escaped image URLs.
 */
function decodeHtmlEntities(url: string): string {
  return url
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Strip trailing punctuation that is commonly captured alongside a URL
 * in prose or HTML (e.g. `...photo.jpg).` or `...photo.jpg,`).
 */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}'"]+$/g, "");
}

/**
 * Collect all unique image URLs matching common raster/vector extensions.
 *
 * Handles `src="..."`, `srcset="..."` (multiple candidates with `300w`/`2x`
 * descriptors are each captured), and bare URLs in post content. Query
 * strings (e.g. WordPress `?w=1024` / `?resize=...`) are preserved so the
 * remote binary can be downloaded; HTML entities such as `&amp;` are
 * decoded. Results are de-duplicated while preserving first-seen order.
 *
 * @param rawHtml Raw post HTML / content to scan.
 * @returns Unique image URLs in order of first appearance.
 */
export function extractImageUrls(rawHtml: string): string[] {
  if (!rawHtml || rawHtml.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const results: string[] = [];

  // Matches absolute http(s) URLs ending in a known image extension with an
  // optional query string. Fragment identifiers are intentionally excluded
  // (they are never sent to the server). Stops at whitespace/quotes/brackets.
  const absoluteSource =
    "https?:\\/\\/[^\\s\"'<>()`\\\\]+?\\.(?:jpg|jpeg|png|webp|svg|gif)(?:\\?[^\\s\"'<>()`]*)?";
  const absolutePattern = new RegExp(absoluteSource, "gi");

  const pushCandidate = (raw: string): void => {
    let cleaned = decodeHtmlEntities(raw.trim());
    cleaned = stripTrailingPunctuation(cleaned);
    if (cleaned.length === 0) {
      return;
    }
    // Normalize protocol-relative URLs to https so they are downloadable.
    if (cleaned.startsWith("//")) {
      cleaned = `https:${cleaned}`;
    }
    // Validate extension after stripping query string.
    const withoutQuery = cleaned.split("?")[0] ?? cleaned;
    const ext = (withoutQuery.split(".").pop() ?? "").toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return;
    }
    // Basic URL validation — skip malformed candidates.
    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
    } catch {
      return;
    }
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      results.push(cleaned);
    }
  };

  const absoluteMatches: Array<{ text: string; index: number }> = [];
  for (const match of rawHtml.matchAll(absolutePattern)) {
    const candidate = match[0];
    const idx = match.index ?? 0;
    if (candidate !== undefined) {
      absoluteMatches.push({ text: candidate, index: idx });
      pushCandidate(candidate);
    }
  }

  // Protocol-relative fallback (//example.com/...jpg) common in WP content.
  // Normalize matches to https. Skip candidates already covered by an
  // absolute http(s) match (avoid double-counting "https://..." as "//...").
  const simpleProtocolRelative = new RegExp(
    "\\/\\/[^\\s\"'<>()`\\\\]+\\.(?:jpg|jpeg|png|webp|svg|gif)(?:\\?[^\\s\"'<>()`]*)?",
    "gi",
  );
  const absoluteSpans: Array<[number, number]> = absoluteMatches.map((m) => [
    m.index,
    m.index + m.text.length,
  ]);
  for (const match of rawHtml.matchAll(simpleProtocolRelative)) {
    const idx = match.index ?? 0;
    const end = idx + match[0].length;
    const insideAbsolute = absoluteSpans.some(([s, e]) => idx >= s && end <= e);
    if (insideAbsolute) {
      continue;
    }
    // Require that the "//" is not part of some other token (e.g. path
    // without host). A valid protocol-relative URL has "//host/...".
    const preceding = idx > 0 ? rawHtml[idx - 1] : " ";
    if (
      preceding !== undefined &&
      /[a-zA-Z0-9:]/.test(preceding) &&
      !/\s/.test(preceding) &&
      preceding !== '"' &&
      preceding !== "'" &&
      preceding !== "(" &&
      preceding !== ">" &&
      preceding !== "="
    ) {
      continue;
    }
    pushCandidate(match[0]);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "");
  if (trimmed.length === 0) {
    return "image";
  }
  // Guard against overly long names on Windows / ext4.
  if (trimmed.length > 180) {
    const ext = path.extname(trimmed);
    const base = path.basename(trimmed, ext).slice(0, 180 - ext.length);
    return `${base}${ext}`;
  }
  return trimmed;
}

function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(decodeHtmlEntities(url));
    let base = path.posix.basename(parsed.pathname);
    try {
      base = decodeURIComponent(base);
    } catch {
      // Keep raw basename if it is not valid percent-encoding.
    }
    base = base.trim();
    if (!base || base === "/" || base === ".") {
      const hash = createHash("md5").update(url).digest("hex").slice(0, 8);
      return `image-${hash}.bin`;
    }
    const sanitized = sanitizeFileName(base);
    // If the URL path had no extension but the URL hints at an image type
    // via query or extension check, keep sanitized name as-is; the caller
    // resolves the final extension.
    if (!path.extname(sanitized)) {
      const withoutQuery = url.split("?")[0] ?? url;
      const hintedExt = (withoutQuery.split(".").pop() ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]/)[0];
      if (hintedExt !== undefined && IMAGE_EXTENSIONS.has(hintedExt)) {
        return `${sanitized}.${hintedExt}`;
      }
      return sanitized;
    }
    return sanitized;
  } catch {
    const hash = createHash("md5").update(url).digest("hex").slice(0, 8);
    return `image-${hash}.bin`;
  }
}

async function fetchWithTimeoutAndRetry(url: string): Promise<Buffer> {
  const decodedUrl = decodeHtmlEntities(url);
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Shared browser-profiled transport (desktop-Chrome headers,
      // keep-alive sockets, redirect + cookie handling). The Accept override
      // below keeps the image-first preference browsers send for subresources.
      const response = await fetchWithTimeout(
        decodedUrl,
        {
          headers: {
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
        },
        DOWNLOAD_TIMEOUT_MS,
      );

      if (!response.ok) {
        throw new Error(
          `Failed to download ${url}: ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        throw new Error(`Downloaded empty file for ${url}`);
      }
      return buffer;
    } catch (error: unknown) {
      lastError = error;
      const isTimeout =
        error instanceof Error && error.message.includes("timed out");
      const reason = isTimeout
        ? `timed out after ${DOWNLOAD_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      if (attempt < MAX_RETRIES) {
        console.warn(
          `Warning: download attempt ${attempt + 1} for ${url} failed (${reason}). Retrying...`,
        );
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      } else {
        console.warn(
          `Warning: download for ${url} failed after ${MAX_RETRIES + 1} attempts (${reason}).`,
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to download ${url} after ${MAX_RETRIES + 1} attempts`);
}

/**
 * Download a remote image, optionally optimize raster images to WebP, and
 * persist the result under `targetDir`.
 *
 * - Retries transient failures up to 2 times with a per-attempt timeout.
 * - When `optimize` is true and the source is JPG/JPEG/PNG, the buffer is
 *   converted to `.webp` at 80% quality via `sharp`. SVG/GIF/WebP sources
 *   are kept untouched. A failed `sharp` conversion falls back to the
 *   original bytes with a warning.
 * - Filename collisions are avoided deterministically: if the target name
 *   already exists, a short md5 hash of the source URL is appended
 *   (`name-<hash>.ext`), so distinct URLs sharing a basename never clobber
 *   each other while repeat downloads of the same URL stay idempotent.
 *
 * @param url Remote image URL.
 * @param targetDir Local directory to save the image into (created if needed).
 * @param optimize Whether to convert JPG/PNG sources to WebP.
 * @returns Relative Astro asset path, e.g. `../../assets/images/photo.webp`.
 */
export async function downloadAndOptimizeImage(
  url: string,
  targetDir: string,
  optimize: boolean,
): Promise<string> {
  if (!url || url.trim().length === 0) {
    throw new Error("downloadAndOptimizeImage: url must be a non-empty string");
  }
  if (!targetDir || targetDir.trim().length === 0) {
    throw new Error(
      "downloadAndOptimizeImage: targetDir must be a non-empty string",
    );
  }

  // Validate URL early for a clear error message.
  try {
    const parsed = new URL(decodeHtmlEntities(url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Unsupported")) {
      throw error;
    }
    throw new Error(
      `downloadAndOptimizeImage: invalid URL "${url}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await fs.ensureDir(targetDir);

  const originalFileName = fileNameFromUrl(url);
  const originalExt = path
    .extname(originalFileName)
    .replace(/^\./, "")
    .toLowerCase();

  const shouldOptimize = optimize && RASTER_OPTIMIZABLE.has(originalExt);

  const buffer = await fetchWithTimeoutAndRetry(url);

  let finalBuffer: Buffer = buffer;
  let finalFileName: string = originalFileName;

  if (shouldOptimize) {
    const baseName = path.basename(
      originalFileName,
      path.extname(originalFileName),
    );
    const webpName = `${baseName}.webp`;
    try {
      finalBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();
      finalFileName = webpName;
    } catch (error: unknown) {
      console.warn(
        `Warning: sharp optimization failed for ${url}: ${error instanceof Error ? error.message : String(error)}. Saving original file.`,
      );
      finalBuffer = buffer;
      finalFileName = originalFileName;
    }
  } else {
    // SVGs (and GIF/WebP) are intentionally kept untouched.
    finalBuffer = buffer;
    finalFileName = originalFileName;
  }

  finalFileName = sanitizeFileName(finalFileName);
  let finalPath = path.join(targetDir, finalFileName);

  if (await fs.pathExists(finalPath)) {
    const urlHash = createHash("md5").update(url).digest("hex").slice(0, 8);
    const parsed = path.parse(finalFileName);
    const hashedBase = parsed.name.endsWith(`-${urlHash}`)
      ? parsed.name
      : `${parsed.name}-${urlHash}`;
    const hashedName = sanitizeFileName(`${hashedBase}${parsed.ext}`);
    const hashedPath = path.join(targetDir, hashedName);

    if (hashedName !== finalFileName) {
      if (!(await fs.pathExists(hashedPath))) {
        finalFileName = hashedName;
        finalPath = hashedPath;
      } else {
        // Extremely rare: hashed name also taken (pre-existing unrelated
        // file). Append a counter to guarantee uniqueness.
        let counter = 1;
        let candidate = hashedName;
        let candidatePath = hashedPath;
        while (await fs.pathExists(candidatePath)) {
          // If the existing hashed file is exactly ours (idempotent retry),
          // reuse it instead of growing the counter forever. We cannot verify
          // content cheaply here without reading; since the name embeds the
          // URL hash deterministically, a match means the same URL — reuse on
          // the first collision probe, otherwise disambiguate.
          if (counter === 1 && candidate === hashedName) {
            break;
          }
          candidate = sanitizeFileName(
            `${hashedBase}-${counter}${parsed.ext}`,
          );
          candidatePath = path.join(targetDir, candidate);
          counter += 1;
          if (counter > 100) {
            break;
          }
        }
        finalFileName = candidate;
        finalPath = candidatePath;
      }
    }
    // Else: file already carries our URL hash — idempotent re-download,
    // overwrite/reuse the same path.
  }

  await fs.writeFile(finalPath, finalBuffer);

  // Astro content (e.g. src/content/posts/*.md) references shared assets via
  // a relative path to src/assets/images. The on-disk location is controlled
  // by `targetDir`; the returned string is the portable reference to embed.
  return `../../assets/images/${finalFileName}`;
}
