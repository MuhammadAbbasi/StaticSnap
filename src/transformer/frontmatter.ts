import matter from "gray-matter";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WpPost } from "../types/index.js";

/**
 * Frontmatter module for MDX output.
 *
 * Formats migrated posts with YAML frontmatter (`title`, `slug`, `date`,
 * `description`, `tags`, `categories`, `featuredImage`) via `gray-matter`
 * and writes the result to disk with an `.mdx` extension.
 */

/** Canonical frontmatter written into every migrated `.mdx` file. */
export interface MdxFrontmatter {
  title: string;
  slug: string;
  date: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  categories?: string[] | undefined;
  featuredImage?: string | undefined;
}

/**
 * Flexible input accepted when building frontmatter. Covers the full
 * {@link WpPost} shape plus common aliases (`excerpt` → `description`,
 * `image` → `featuredImage`) so callers can pass WP API payloads directly.
 */
export interface FrontmatterInput {
  title: string;
  slug: string;
  date: string | Date;
  description?: string | undefined;
  excerpt?: string | undefined;
  tags?: string[] | undefined;
  categories?: string[] | undefined;
  featuredImage?: string | null | undefined;
  image?: string | null | undefined;
}

export type PostFrontmatter = MdxFrontmatter;
export type PostMetadata = FrontmatterInput;

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return undefined;
}

function toDateString(value: string | Date): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return value;
}

/**
 * Build canonical MDX frontmatter from a post-like input.
 *
 * - `description` falls back to `excerpt` (HTML stripped) when absent.
 * - `featuredImage` falls back to `image` when absent; empty values omitted.
 * - Empty `tags` / `categories` / `description` / `featuredImage` are omitted
 *   so the emitted YAML stays clean (exactOptionalPropertyTypes-safe).
 */
export function buildFrontmatter(input: FrontmatterInput): MdxFrontmatter {
  const rawDescription =
    input.description?.trim() || input.excerpt?.trim() || undefined;
  // Excerpts are often HTML fragments; store plain text in `description`.
  const description =
    rawDescription !== undefined && /<[^>]+>/.test(rawDescription)
      ? rawDescription
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim() || undefined
      : rawDescription;

  const featuredImage =
    input.featuredImage?.trim() || input.image?.trim() || undefined;

  const frontmatter: MdxFrontmatter = {
    title: input.title,
    slug: input.slug,
    date: toDateString(input.date),
  };

  if (description !== undefined && description.length > 0) {
    frontmatter.description = description;
  }
  const tags = toStringArray(input.tags);
  if (tags !== undefined) {
    frontmatter.tags = tags;
  }
  const categories = toStringArray(input.categories);
  if (categories !== undefined) {
    frontmatter.categories = categories;
  }
  if (featuredImage !== undefined && featuredImage.length > 0) {
    frontmatter.featuredImage = featuredImage;
  }

  return frontmatter;
}

/** Alias for {@link buildFrontmatter}. */
export const createFrontmatter = buildFrontmatter;

/** Alias for {@link buildFrontmatter}. */
export const getFrontmatter = buildFrontmatter;

/** Alias for {@link buildFrontmatter}. */
export const toFrontmatter = buildFrontmatter;

/**
 * Build frontmatter directly from a validated {@link WpPost}.
 */
export function buildFrontmatterFromPost(post: WpPost): MdxFrontmatter {
  return buildFrontmatter({
    title: post.title,
    slug: post.slug,
    date: post.date,
    excerpt: post.excerpt,
    tags: post.tags,
    categories: post.categories,
    featuredImage: post.featuredImage,
  });
}

/** Alias for {@link buildFrontmatterFromPost}. */
export const frontmatterFromPost = buildFrontmatterFromPost;

/**
 * Format an MDX document (frontmatter + body) using `gray-matter`.
 *
 * @param body Markdown/MDX body content (without frontmatter).
 * @param data Frontmatter input or already-built canonical frontmatter.
 * @returns Full `.mdx` file contents with YAML frontmatter.
 */
export function formatMdxDocument(
  body: string,
  data: FrontmatterInput | MdxFrontmatter,
): string {
  const frontmatter =
    "excerpt" in data || "featuredImage" in data || "image" in data
      ? buildFrontmatter(data as FrontmatterInput)
      : (data as MdxFrontmatter);
  const normalizedBody = body.trim().length === 0 ? "" : `${body.trim()}\n`;
  return matter.stringify(
    normalizedBody,
    frontmatter as unknown as Record<string, unknown>,
  );
}

/** Alias for {@link formatMdxDocument}. */
export const stringifyMdx = formatMdxDocument;

/** Alias for {@link formatMdxDocument}. */
export const createMdxDocument = formatMdxDocument;

/** Alias for {@link formatMdxDocument}. */
export const createMdxContent = formatMdxDocument;

/**
 * Format a full MDX document from a post + already-converted MDX body.
 */
export function formatPostMdx(post: WpPost, mdxBody: string): string {
  return formatMdxDocument(mdxBody, buildFrontmatterFromPost(post));
}

/** Alias for {@link formatPostMdx}. */
export const createPostMdx = formatPostMdx;

/**
 * Ensure a file path ends with an `.mdx` extension.
 *
 * - `post` → `post.mdx`
 * - `post.md` → `post.mdx`
 * - `post.mdx` → unchanged
 */
export function ensureMdxExtension(filePath: string): string {
  if (filePath.endsWith(".mdx")) {
    return filePath;
  }
  const ext = path.extname(filePath);
  if (ext.length === 0) {
    return `${filePath}.mdx`;
  }
  return `${filePath.slice(0, -ext.length)}.mdx`;
}

/**
 * Write an MDX document to disk, creating parent directories as needed.
 *
 * The output path is coerced to an `.mdx` extension.
 *
 * @param outputPath Destination file path (extension coerced to `.mdx`)
 *   or a directory (when `fileName` is provided separately).
 * @param body Markdown/MDX body content (without frontmatter).
 * @param data Frontmatter input.
 * @param fileName Optional file name (e.g. `${slug}.mdx`) joined onto
 *   `outputPath` when it points at a directory.
 * @returns Absolute-or-as-given path of the written `.mdx` file.
 */
export async function writeMdxFile(
  outputPath: string,
  body: string,
  data: FrontmatterInput | MdxFrontmatter,
  fileName?: string,
): Promise<string> {
  if (!outputPath || outputPath.trim().length === 0) {
    throw new Error("writeMdxFile: outputPath must be a non-empty string");
  }
  const target =
    fileName !== undefined && fileName.trim().length > 0
      ? path.join(outputPath, ensureMdxExtension(fileName.trim()))
      : ensureMdxExtension(outputPath);
  const content = formatMdxDocument(body, data);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

/**
 * Write a migrated {@link WpPost} (plus converted MDX body) to disk.
 *
 * @param outputDir Target directory for the `.mdx` file.
 * @param post Source WordPress post (provides slug + frontmatter fields).
 * @param mdxBody Converted MDX body content (without frontmatter).
 * @param fileNameOverride Optional explicit file name; defaults to
 *   `${post.slug}.mdx`.
 * @returns Path of the written `.mdx` file.
 */
export async function writePostMdx(
  outputDir: string,
  post: WpPost,
  mdxBody: string,
  fileNameOverride?: string,
): Promise<string> {
  if (!outputDir || outputDir.trim().length === 0) {
    throw new Error("writePostMdx: outputDir must be a non-empty string");
  }
  const fileName = ensureMdxExtension(
    fileNameOverride?.trim() || `${post.slug}.mdx`,
  );
  return writeMdxFile(
    path.join(outputDir, fileName),
    mdxBody,
    buildFrontmatterFromPost(post),
  );
}

/** Alias for {@link writeMdxFile}. */
export const writeMdxDocument = writeMdxFile;

/** Alias for {@link writeMdxFile}. */
export const createMdxFile = writeMdxFile;

/** Alias for {@link writePostMdx}. */
export const writePostMdxFile = writePostMdx;

export default formatMdxDocument;
