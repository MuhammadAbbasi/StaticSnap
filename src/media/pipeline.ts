import pLimit, { type LimitFunction } from "p-limit";
import { downloadAndOptimizeImage, extractImageUrls } from "./harvester.js";

export interface MediaPipelineOptions {
  /** Max concurrent image downloads. Defaults to 5. */
  concurrency?: number;
  /** Convert JPG/PNG sources to WebP. Defaults to true. */
  optimize?: boolean;
}

export interface ProcessPostMediaResult {
  updatedContent: string;
  downloadedCount: number;
}

/** A download that failed, retained for the migration log. */
export interface MediaFailure {
  url: string;
  error: string;
}

/** Post-shaped input accepted by {@link MediaPipeline.processPost}. */
export interface PostMediaInput {
  content: string;
  featuredImage?: string | null | undefined;
}

export interface ProcessPostResult {
  updatedContent: string;
  /** Local asset path, or the original URL when the download failed. */
  updatedFeaturedImage: string | null;
  downloadedCount: number;
}

function encodeHtmlEntities(url: string): string {
  return url.replace(/&/g, "&amp;");
}

/**
 * Concurrent media migration pipeline with an in-memory remote→local cache.
 *
 * Wraps `p-limit` so bulk WordPress migrations never open unbounded
 * concurrent connections, and memoizes every successfully downloaded URL in
 * {@link urlMap} so repeated references (across posts or re-runs within the
 * same process) reuse the local asset instead of re-downloading.
 */
export class MediaPipeline {
  /** Remote WP URL -> local Astro asset path (e.g. `../../assets/images/x.webp`). */
  public readonly urlMap: Map<string, string> = new Map<string, string>();

  /**
   * Every download that failed, in encounter order.
   *
   * Failures are warned about on the console as they happen, but the console
   * scrolls away; the pipeline persists this list to `migration-log.json` so a
   * run that silently lost 40 images is diagnosable afterwards.
   */
  public readonly failures: MediaFailure[] = [];

  private readonly limit: LimitFunction;
  private readonly concurrency: number;
  private readonly optimize: boolean;

  constructor(optionsOrConcurrency?: number | MediaPipelineOptions);
  constructor(concurrency?: number, optimize?: boolean);
  constructor(
    optionsOrConcurrency?: number | MediaPipelineOptions,
    optimizeParam?: boolean,
  ) {
    let concurrency = 5;
    let optimize = true;

    if (typeof optionsOrConcurrency === "number") {
      if (Number.isFinite(optionsOrConcurrency) && optionsOrConcurrency >= 1) {
        concurrency = Math.floor(optionsOrConcurrency);
      }
      if (typeof optimizeParam === "boolean") {
        optimize = optimizeParam;
      }
    } else if (
      optionsOrConcurrency !== undefined &&
      optionsOrConcurrency !== null
    ) {
      const opts = optionsOrConcurrency;
      if (
        opts.concurrency !== undefined &&
        Number.isFinite(opts.concurrency) &&
        opts.concurrency >= 1
      ) {
        concurrency = Math.floor(opts.concurrency);
      }
      if (opts.optimize !== undefined) {
        optimize = opts.optimize;
      }
    }

    this.concurrency = concurrency;
    this.optimize = optimize;
    this.limit = pLimit(this.concurrency);
  }

  /** Configured concurrency limit. */
  public getConcurrency(): number {
    return this.concurrency;
  }

  /** Whether raster images are converted to WebP. */
  public getOptimize(): boolean {
    return this.optimize;
  }

  /**
   * Download every not-yet-cached URL under the shared concurrency limit.
   *
   * A single failed download never rejects: it logs a warning, leaves the
   * URL out of {@link urlMap} (so the original stays in place downstream),
   * and lets the remaining images continue.
   *
   * @returns Count of newly downloaded assets.
   */
  private async downloadAll(
    urls: string[],
    outputImagesDir: string,
  ): Promise<number> {
    const uncached = urls.filter((url) => !this.urlMap.has(url));

    const tasks = uncached.map((remoteUrl) =>
      this.limit(async (): Promise<boolean> => {
        try {
          const localPath = await downloadAndOptimizeImage(
            remoteUrl,
            outputImagesDir,
            this.optimize,
          );
          this.urlMap.set(remoteUrl, localPath);
          return true;
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.failures.push({ url: remoteUrl, error: message });
          console.warn(
            `Warning: Failed to download image ${remoteUrl}: ${message}. Leaving original URL in place.`,
          );
          return false;
        }
      }),
    );

    const outcomes = await Promise.all(tasks);
    return outcomes.filter(Boolean).length;
  }

  /**
   * Rewrite every cached remote URL in `text` to its local asset path.
   *
   * Longest URLs are rewritten first so a URL that is a prefix of another
   * (e.g. with vs. without query string) cannot partially clobber it. Only
   * URLs relevant to this text are touched; the cache itself persists across
   * posts for reuse.
   */
  private rewrite(text: string, urls: string[]): string {
    const relevant = [...this.urlMap.entries()]
      .filter(([remoteUrl]) => urls.includes(remoteUrl))
      .sort((a, b) => b[0].length - a[0].length);

    let updated = text;
    for (const [remoteUrl, localPath] of relevant) {
      if (updated.includes(remoteUrl)) {
        updated = updated.split(remoteUrl).join(localPath);
      }
      // WordPress content often stores `&amp;` HTML-escaped URLs while the
      // extractor normalizes to `&` for downloading — rewrite that form too.
      const encoded = encodeHtmlEntities(remoteUrl);
      if (encoded !== remoteUrl && updated.includes(encoded)) {
        updated = updated.split(encoded).join(localPath);
      }
    }
    return updated;
  }

  /**
   * Extract image URLs from post content, download any not yet cached, and
   * rewrite the content to reference local Astro asset paths.
   *
   * A single failed download never rejects: it logs a warning, leaves the
   * original remote URL in place, and continues migrating the remaining
   * images.
   *
   * @param content Post HTML / Markdown content containing remote image URLs.
   * @param outputImagesDir Local directory to save downloaded images into.
   * @returns Updated content plus the count of newly downloaded images.
   */
  public async processPostMedia(
    content: string,
    outputImagesDir: string,
  ): Promise<ProcessPostMediaResult> {
    if (!content || content.length === 0) {
      return { updatedContent: content, downloadedCount: 0 };
    }
    this.assertOutputDir(outputImagesDir);

    const urls = extractImageUrls(content);
    if (urls.length === 0) {
      return { updatedContent: content, downloadedCount: 0 };
    }

    const downloadedCount = await this.downloadAll(urls, outputImagesDir);
    return { updatedContent: this.rewrite(content, urls), downloadedCount };
  }

  /**
   * Harvest a post's body images **and** its featured image in one batch.
   *
   * Both sources share a single download pass, so the featured image competes
   * for the same `p-limit` slots as body images instead of being fetched in a
   * separate serial round-trip, and a featured image that also appears in the
   * body is downloaded exactly once via {@link urlMap}.
   *
   * @param post Post-shaped input (`content` plus optional `featuredImage`).
   * @param outputImagesDir Local directory to save downloaded images into.
   */
  public async processPost(
    post: PostMediaInput,
    outputImagesDir: string,
  ): Promise<ProcessPostResult> {
    this.assertOutputDir(outputImagesDir);

    const content = post.content ?? "";
    const featuredRaw = post.featuredImage?.trim() ?? "";

    const contentUrls = content.length > 0 ? extractImageUrls(content) : [];
    // Run the featured image through the same extractor so it gets identical
    // entity decoding, protocol normalization and extension validation.
    const featuredUrls =
      featuredRaw.length > 0 ? extractImageUrls(featuredRaw) : [];

    const allUrls = [...new Set([...contentUrls, ...featuredUrls])];
    if (allUrls.length === 0) {
      return {
        updatedContent: content,
        updatedFeaturedImage: featuredRaw.length > 0 ? featuredRaw : null,
        downloadedCount: 0,
      };
    }

    const downloadedCount = await this.downloadAll(allUrls, outputImagesDir);

    const updatedContent =
      contentUrls.length > 0 ? this.rewrite(content, contentUrls) : content;

    let updatedFeaturedImage: string | null =
      featuredRaw.length > 0 ? featuredRaw : null;
    if (featuredUrls.length > 0) {
      updatedFeaturedImage = this.rewrite(featuredRaw, featuredUrls);
    }

    return { updatedContent, updatedFeaturedImage, downloadedCount };
  }

  private assertOutputDir(outputImagesDir: string): void {
    if (!outputImagesDir || outputImagesDir.trim().length === 0) {
      throw new Error("processPostMedia: outputImagesDir must be provided");
    }
  }
}
