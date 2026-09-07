import path from "node:path";
import fs from "fs-extra";
import {
  MigrationConfigSchema,
  type MigrationConfig,
} from "./types/index.js";
import { scaffoldTemplate } from "./scaffolder/template.js";
import { parseWxrFile, type ExtractedPost } from "./extractor/xml.js";
import { MediaPipeline } from "./media/pipeline.js";
import { postContentToMdx } from "./transformer/ast-to-mdx.js";
import { formatPostMdx } from "./transformer/frontmatter.js";

/**
 * Unified migration pipeline.
 *
 * Orchestrates the full WordPress → Astro conversion:
 *   a. Validate inputs and ensure the source XML exists.
 *   b. Scaffold the Astro project structure in the destination folder.
 *   c. Parse all published posts from the XML.
 *   d. Download/process media via `MediaPipeline` and rewrite links.
 *   e. Transform Gutenberg blocks to MDX and write `.mdx` files.
 *   f. Generate `redirects.json` (WP permalink → new Astro slug).
 */

export type PipelineStage =
  | "validate"
  | "scaffold"
  | "parse"
  | "media"
  | "mdx"
  | "redirects";

export interface MigrationProgress {
  onStage?: (
    stage: PipelineStage,
    status: "start" | "end",
    detail?: string,
  ) => void;
}

export interface PipelineResult {
  totalPosts: number;
  mediaDownloaded: number;
  /** Assets that could not be downloaded; details in `migration-log.json`. */
  mediaFailed: number;
  executionTimeMs: number;
  outDir: string;
  redirectsPath: string;
  /** Path of the durable run log written into the output directory. */
  logPath: string;
  posts: ExtractedPost[];
}

function emit(
  progress: MigrationProgress | undefined,
  stage: PipelineStage,
  status: "start" | "end",
  detail?: string,
): void {
  progress?.onStage?.(stage, status, detail);
}

function toSafeSlug(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Run the full migration.
 *
 * @param config Migration configuration (source XML, outDir, flags).
 * @param progress Optional stage hooks used by the CLI spinners.
 */
export async function runMigration(
  config: MigrationConfig,
  progress?: MigrationProgress,
): Promise<PipelineResult> {
  const startedAt = Date.now();

  // a. Validate inputs and ensure source XML exists.
  emit(progress, "validate", "start");
  const parsed = MigrationConfigSchema.parse(config);
  const sourcePath = path.resolve(parsed.source);
  const targetDir = path.resolve(parsed.outDir);

  if (!(await fs.pathExists(sourcePath))) {
    throw new Error(`Source XML not found: ${parsed.source}`);
  }
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`Source path is not a file: ${parsed.source}`);
  }
  emit(progress, "validate", "end", sourcePath);

  // b. Scaffold the Astro project structure in the destination folder.
  emit(progress, "scaffold", "start", targetDir);
  await scaffoldTemplate(targetDir);
  emit(progress, "scaffold", "end", targetDir);

  // c. Parse all published posts from the XML.
  emit(progress, "parse", "start", sourcePath);
  const posts = await parseWxrFile(sourcePath);
  emit(progress, "parse", "end", `${posts.length} posts`);

  // d. Initialize MediaPipeline and process all post contents.
  emit(progress, "media", "start");
  const media = new MediaPipeline({
    concurrency: parsed.concurrency,
    optimize: parsed.optimizeImages,
  });
  const outputImagesDir = path.join(targetDir, "src", "assets", "images");
  await fs.ensureDir(outputImagesDir);

  let mediaDownloaded = 0;
  for (const post of posts) {
    // Body images and the featured image are harvested in one batch so they
    // share the same concurrency limit and download cache.
    const { updatedContent, updatedFeaturedImage, downloadedCount } =
      await media.processPost(post, outputImagesDir);
    post.content = updatedContent;
    post.featuredImage = updatedFeaturedImage;
    mediaDownloaded += downloadedCount;
  }
  emit(progress, "media", "end", `${mediaDownloaded} assets`);

  // e. Transform Gutenberg blocks to MDX and write `.mdx` files.
  emit(progress, "mdx", "start");
  const blogDir = path.join(targetDir, "src", "content", "blog");
  await fs.ensureDir(blogDir);

  const usedSlugs = new Set<string>();
  const redirects: Record<string, string> = {};

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i] as ExtractedPost;
    const baseSlug = toSafeSlug(post.slug, `post-${i + 1}`);
    let slug = baseSlug;
    let counter = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
    usedSlugs.add(slug);
    post.slug = slug;

    const mdxBody = postContentToMdx(post.content);
    const document = formatPostMdx(post, mdxBody);
    const outFile = path.join(blogDir, `${slug}.mdx`);
    await fs.writeFile(outFile, document, "utf8");

    // f. Collect redirect entries alongside MDX writing.
    if (post.link.trim().length > 0) {
      redirects[post.link] = `/blog/${slug}/`;
    }
  }
  emit(progress, "mdx", "end", `${posts.length} files`);

  // f. Generate redirects.json mapping WP permalinks to new Astro slugs.
  emit(progress, "redirects", "start");
  const redirectsPath = path.join(targetDir, "redirects.json");
  await fs.writeFile(
    redirectsPath,
    JSON.stringify(redirects, null, 2) + "\n",
    "utf8",
  );

  // g. Write a durable run log. Download failures are warned about on the
  // console as they happen, but the terminal scrolls; without this a run that
  // lost 40 images looks identical to a clean one in the summary output.
  const finishedAt = Date.now();
  const logPath = path.join(targetDir, "migration-log.json");
  await fs.writeFile(
    logPath,
    JSON.stringify(
      {
        tool: "wp-to-astro",
        source: sourcePath,
        outDir: targetDir,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        options: {
          optimizeImages: parsed.optimizeImages,
          concurrency: parsed.concurrency,
        },
        totals: {
          posts: posts.length,
          mediaDownloaded,
          mediaFailed: media.failures.length,
          redirects: Object.keys(redirects).length,
        },
        posts: posts.map((post) => ({
          slug: post.slug,
          title: post.title,
          type: post.postType,
          file: `src/content/blog/${post.slug}.mdx`,
          link: post.link,
          featuredImage: post.featuredImage ?? null,
        })),
        mediaFailures: media.failures,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  emit(progress, "redirects", "end", redirectsPath);

  return {
    totalPosts: posts.length,
    mediaDownloaded,
    mediaFailed: media.failures.length,
    executionTimeMs: finishedAt - startedAt,
    outDir: targetDir,
    redirectsPath,
    logPath,
    posts,
  };
}

export default runMigration;
