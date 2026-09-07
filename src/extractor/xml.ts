import { XMLParser } from "fast-xml-parser";
import fs from "fs-extra";
import { WpPostSchema, type WpPost } from "../types/index.js";

/**
 * WordPress WXR XML extractor.
 *
 * Parses a WordPress eXtended RSS (WXR) export with `fast-xml-parser` and
 * returns only published `post` / `page` items as validated {@link WpPost}
 * records plus permalink metadata needed for `redirects.json`.
 */

export const WXR_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
} as const;

/** A validated post plus permalink metadata retained for redirects. */
export interface ExtractedPost extends WpPost {
  /** Original WordPress permalink (`<link>`), may be empty when absent. */
  link: string;
  /** Original `wp:post_type` value (`post` or `page`). */
  postType: string;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // fast-xml-parser represents text nodes as `#text` and (optionally)
    // CDATA under `__cdata` / `#cdata`. Prefer the textual payload.
    for (const key of ["#text", "__cdata", "#cdata", "value", "_"]) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        return candidate;
      }
      if (typeof candidate === "number") {
        return String(candidate);
      }
    }
    // Nested single-key wrappers (e.g. { title: { "#text": ... } } handled
    // by recursing into the only plausible string leaf.
    for (const candidate of Object.values(record)) {
      if (typeof candidate === "string") {
        return candidate;
      }
    }
  }
  return "";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

interface RawCategory {
  "@_domain"?: unknown;
  "@_nicename"?: unknown;
  "#text"?: unknown;
}

function extractCategoriesAndTags(
  rawCategory: unknown,
): { categories: string[]; tags: string[] } {
  const categories: string[] = [];
  const tags: string[] = [];

  for (const entry of toArray<unknown>(rawCategory as never)) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text.length > 0) {
        categories.push(text);
      }
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const record = entry as RawCategory & Record<string, unknown>;
      const domain = asString(record["@_domain"]).toLowerCase().trim();
      const text =
        asString(record["#text"]).trim() ||
        asString(record["__cdata"]).trim() ||
        asString(record["#cdata"]).trim();
      if (text.length === 0) {
        continue;
      }
      if (domain === "post_tag") {
        tags.push(text);
      } else {
        // `category`, empty/missing domain, and custom taxonomies are
        // treated as categories so no taxonomy data is silently dropped.
        categories.push(text);
      }
    }
  }

  // De-duplicate while preserving first-seen order.
  const dedupe = (items: string[]): string[] => [...new Set(items)];
  return { categories: dedupe(categories), tags: dedupe(tags) };
}

interface RawPostMeta {
  "wp:meta_key"?: unknown;
  "wp:meta_value"?: unknown;
}

/**
 * Collect an item's `<wp:postmeta>` entries into a key -> value map.
 *
 * A single meta entry is parsed as an object rather than an array, so the
 * input is normalized with {@link toArray} first.
 */
function extractPostMeta(rawMeta: unknown): Map<string, string> {
  const meta = new Map<string, string>();
  for (const entry of toArray<unknown>(rawMeta as never)) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as RawPostMeta & Record<string, unknown>;
    const key = asString(record["wp:meta_key"]).trim();
    if (key.length === 0) {
      continue;
    }
    meta.set(key, asString(record["wp:meta_value"]).trim());
  }
  return meta;
}

/**
 * Index every `attachment` item by `wp:post_id` -> media URL.
 *
 * Attachments carry `wp:status` of `inherit` (never `publish`), so they are
 * indexed from the raw item list before the publish filter is applied.
 * `wp:attachment_url` is authoritative; `guid` is the fallback because older
 * exports omit the former.
 */
function indexAttachments(
  items: Array<Record<string, unknown>>,
): Map<string, string> {
  const attachments = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (asString(item["wp:post_type"]).trim().toLowerCase() !== "attachment") {
      continue;
    }
    const id = asString(item["wp:post_id"]).trim();
    if (id.length === 0) {
      continue;
    }
    const url =
      asString(item["wp:attachment_url"]).trim() ||
      asString(item["guid"]).trim();
    if (url.length > 0) {
      attachments.set(id, url);
    }
  }
  return attachments;
}

/**
 * Parse raw WXR XML string into published posts/pages.
 *
 * Keeps only items where `wp:status === "publish"` and
 * `wp:post_type` is `"post"` or `"page"`. Title, slug (`wp:post_name`),
 * date (`wp:post_date`), raw content (`content:encoded`), excerpt
 * (`excerpt:encoded`), categories/tags (`<category>`) and the featured image
 * (`_thumbnail_id` postmeta resolved against the export's attachments) are
 * extracted.
 *
 * @param xml Raw WXR XML document.
 * @returns Published posts as {@link ExtractedPost} records.
 */
export function parseWxrXml(xml: string): ExtractedPost[] {
  if (!xml || xml.trim().length === 0) {
    return [];
  }

  const parser = new XMLParser({ ...WXR_PARSER_OPTIONS });
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const rss = parsed["rss"] as Record<string, unknown> | undefined;
  const channel = (rss?.["channel"] ?? parsed["channel"]) as
    | Record<string, unknown>
    | undefined;
  if (!channel || typeof channel !== "object") {
    return [];
  }

  const items = toArray<Record<string, unknown>>(
    channel["item"] as never,
  );

  // Attachments must be indexed across the whole feed before posts are
  // filtered, because `_thumbnail_id` can reference an attachment declared
  // anywhere in the document.
  const attachments = indexAttachments(items);

  const posts: ExtractedPost[] = [];
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      return;
    }

    const status = asString(item["wp:status"]).trim().toLowerCase();
    const postType = asString(item["wp:post_type"]).trim().toLowerCase();
    if (status !== "publish") {
      return;
    }
    if (postType !== "post" && postType !== "page") {
      return;
    }

    const title = asString(item["title"]).trim();
    const rawSlug = asString(item["wp:post_name"]).trim();
    const slug =
      rawSlug.length > 0
        ? slugify(rawSlug) || rawSlug
        : slugify(title) || `post-${index + 1}`;
    const date = asString(item["wp:post_date"]).trim();
    const content = asString(item["content:encoded"]);
    const excerpt = asString(item["excerpt:encoded"]);
    const link = asString(item["link"]).trim();

    const { categories, tags } = extractCategoriesAndTags(item["category"]);

    // Featured image: `_thumbnail_id` postmeta points at an attachment item's
    // `wp:post_id`. An unresolvable id (attachment excluded from the export)
    // degrades to null rather than leaving a dangling numeric id behind.
    const postMeta = extractPostMeta(item["wp:postmeta"]);
    const thumbnailId = postMeta.get("_thumbnail_id");
    const featuredImage =
      thumbnailId !== undefined && thumbnailId.length > 0
        ? (attachments.get(thumbnailId) ?? null)
        : null;

    const candidate = {
      title,
      slug,
      date,
      status: "publish",
      content,
      excerpt,
      categories,
      tags,
      featuredImage,
    };

    // Validate the WP-facing shape; throws on programmer error, never on
    // feed noise because every field above is coerced to the schema type.
    const validated: WpPost = WpPostSchema.parse(candidate);

    posts.push({ ...validated, link, postType });
  });

  return posts;
}

/** Alias for {@link parseWxrXml}. */
export const parseWordPressXml = parseWxrXml;

/** Alias for {@link parseWxrXml}. */
export const extractPosts = parseWxrXml;

/** Alias for {@link parseWxrXml}. */
export const parseWxr = parseWxrXml;

/**
 * Read a WXR export file from disk and parse its published posts/pages.
 *
 * @param filePath Path to the WordPress WXR XML export file.
 */
export async function parseWxrFile(filePath: string): Promise<ExtractedPost[]> {
  const xml = await fs.readFile(filePath, "utf8");
  return parseWxrXml(xml);
}

/** Alias for {@link parseWxrFile}. */
export const parseWordPressXmlFile = parseWxrFile;

export default parseWxrXml;
