import { parse } from "@wordpress/block-serialization-default-parser";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { load } from "cheerio";

/**
 * WordPress block-to-MDX parsing engine.
 *
 * Parses raw WordPress `post_content` with the official block serialization
 * parser and recursively maps Gutenberg blocks to Markdown / MDX components
 * understood by the scaffolded Astro site (Grid, GridColumn,
 * ResponsiveImage, ImageGallery, Callout).
 */

/** Minimal structural type compatible with the WP block parser output. */
export interface Block {
  blockName: string | null;
  attrs: Record<string, unknown> | null;
  innerBlocks: Block[];
  innerHTML: string;
  innerContent: Array<string | null>;
}

/** Alias kept for consumers expecting the parser's `ParsedBlock` name. */
export type ParsedBlock = Block;

/** Image data extracted from `core/image` / `core/gallery` blocks. */
export interface GalleryImage {
  src: string;
  alt: string;
  caption?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Shared Turndown instance configured with GitHub-Flavored Markdown support.
 * Used for `core/paragraph`, `core/heading`, `core/list` and as the fallback
 * for classic content / unrecognized blocks.
 */
export const turndownService = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndownService.use(gfm);

/** Convert an HTML fragment to Markdown, trimming surrounding whitespace. */
export function htmlToMarkdown(html: string): string {
  if (!html || html.trim().length === 0) {
    return "";
  }
  return turndownService.turndown(html).trim();
}

/** Escape a value for use inside a JSX double-quoted attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ")
    .trim();
}

function getAttrs(block: Block): Record<string, unknown> {
  return asRecord(block.attrs);
}

function extractImageData(
  innerHTML: string,
  attrs: Record<string, unknown>,
): GalleryImage | null {
  let src = asString(attrs["url"] ?? attrs["src"] ?? attrs["link"]);
  let alt = asString(attrs["alt"]);
  let caption = asString(attrs["caption"]);

  if (innerHTML.trim().length > 0) {
    try {
      const $ = load(innerHTML);
      const img = $("img").first();
      if (img.length > 0) {
        const domSrc = img.attr("src");
        if (domSrc !== undefined && domSrc.trim().length > 0) {
          src = domSrc.trim();
        }
        const domAlt = img.attr("alt");
        if (domAlt !== undefined) {
          alt = domAlt;
        }
      }
      const figcaption = $("figcaption").first().text().trim();
      if (figcaption.length > 0) {
        caption = figcaption;
      }
    } catch {
      // Fall through to attr-based values on cheerio failure.
    }
  }

  src = src.trim();
  if (src.length === 0) {
    return null;
  }
  const image: GalleryImage = { src, alt: alt ?? "" };
  if (caption.trim().length > 0) {
    image.caption = caption.trim();
  }
  return image;
}

function renderResponsiveImage(image: GalleryImage): string {
  const src = escapeAttribute(image.src);
  const alt = escapeAttribute(image.alt ?? "");
  if (image.caption !== undefined && image.caption.trim().length > 0) {
    return `<ResponsiveImage src="${src}" alt="${alt}" caption="${escapeAttribute(image.caption)}" />`;
  }
  return `<ResponsiveImage src="${src}" alt="${alt}" />`;
}

function transformImage(block: Block): string {
  const image = extractImageData(block.innerHTML, getAttrs(block));
  if (image === null) {
    return htmlToMarkdown(block.innerHTML);
  }
  return renderResponsiveImage(image);
}

function transformGallery(block: Block): string {
  const attrs = getAttrs(block);
  const images: GalleryImage[] = [];

  if (block.innerBlocks.length > 0) {
    for (const inner of block.innerBlocks) {
      if (inner.blockName === "core/image") {
        const image = extractImageData(inner.innerHTML, getAttrs(inner));
        if (image !== null) {
          images.push(image);
        }
      } else {
        // Nested galleries / wrappers: try to pull any <img> out of them.
        const nested = extractImageData(
          inner.innerHTML,
          getAttrs(inner),
        );
        if (
          nested !== null &&
          (inner.blockName === null || inner.blockName === "core/gallery")
        ) {
          images.push(nested);
        }
        for (const deep of inner.innerBlocks) {
          if (deep.blockName === "core/image") {
            const image = extractImageData(deep.innerHTML, getAttrs(deep));
            if (image !== null) {
              images.push(image);
            }
          }
        }
      }
    }
  }

  // Legacy galleries store <img> tags directly in innerHTML.
  if (images.length === 0 && block.innerHTML.trim().length > 0) {
    try {
      const $ = load(block.innerHTML);
      $("img").each((_, el) => {
        const elSrc = $(el).attr("src")?.trim() ?? "";
        if (elSrc.length === 0) {
          return;
        }
        const figure = $(el).closest("figure");
        const figcaption =
          figure.find("figcaption").first().text().trim() ||
          $(el).parent().find("figcaption").first().text().trim();
        const entry: GalleryImage = {
          src: elSrc,
          alt: $(el).attr("alt") ?? "",
        };
        if (figcaption.length > 0) {
          entry.caption = figcaption;
        }
        images.push(entry);
      });
    } catch {
      // Ignore cheerio failures; fallback below handles empty galleries.
    }
  }

  if (images.length === 0) {
    const fallback = htmlToMarkdown(block.innerHTML);
    return fallback;
  }

  const columns =
    asNumber(attrs["columns"]) ??
    asNumber(attrs["columnCount"]) ??
    images.length;

  return `<ImageGallery images={${JSON.stringify(images)}} columns={${columns}} />`;
}

function transformQuote(block: Block): string {
  const attrs = getAttrs(block);
  let citation =
    asString(attrs["citation"] ?? attrs["cite"] ?? attrs["value"]).trim();
  let quoteBody = "";

  if (block.innerBlocks.length > 0) {
    const parts: string[] = [];
    for (const inner of block.innerBlocks) {
      // WP sometimes models the citation as its own inner block.
      if (
        inner.blockName === "core/quote-citation" ||
        inner.blockName === "core/pullquote-citation"
      ) {
        const citeText =
          htmlToMarkdown(inner.innerHTML).trim() ||
          asString(getAttrs(inner)["citation"]).trim();
        if (citeText.length > 0 && citation.length === 0) {
          citation = citeText.replace(/^—\s*/, "").trim();
        }
        continue;
      }
      const rendered = transformBlock(inner).trim();
      if (rendered.length > 0) {
        // A nested citation rendered as markdown (e.g. "— Author") can be
        // promoted to the citation prop instead of body text.
        if (
          citation.length === 0 &&
          (inner.blockName === null ||
            /cite|citation/i.test(inner.blockName ?? "")) &&
          rendered.length < 200
        ) {
          citation = rendered.replace(/^—\s*/, "").trim();
          continue;
        }
        parts.push(rendered);
      }
    }
    quoteBody = parts.join("\n\n").trim();
  }

  if (quoteBody.length === 0 && block.innerHTML.trim().length > 0) {
    try {
      const $ = load(block.innerHTML);
      const citeEl = $("cite").first();
      if (citeEl.length > 0 && citation.length === 0) {
        citation = citeEl.text().trim();
      }
      $("cite").remove();
      const blockquote = $("blockquote").first();
      const quoteHtml =
        blockquote.length > 0 ? (blockquote.html() ?? "") : block.innerHTML;
      // Wrap in a neutral container so Turndown does not emit `> ` prefixes;
      // the Callout component already provides quote styling.
      quoteBody = htmlToMarkdown(`<div>${quoteHtml}</div>`)
        .replace(/^>\s?/gm, "")
        .trim();
    } catch {
      quoteBody = htmlToMarkdown(block.innerHTML).replace(/^>\s?/gm, "").trim();
    }
  }

  if (quoteBody.length === 0) {
    quoteBody = htmlToMarkdown(block.innerHTML)
      .replace(/^>\s?/gm, "")
      .trim();
  }

  if (citation.length > 0) {
    // Strip leading em-dash commonly rendered inside <cite>.
    citation = citation.replace(/^—\s*/, "").trim();
    return `<Callout type="quote" citation="${escapeAttribute(citation)}">\n${quoteBody}\n</Callout>`;
  }
  return `<Callout type="quote">\n${quoteBody}\n</Callout>`;
}

function transformCode(block: Block): string {
  const attrs = getAttrs(block);
  let language = asString(attrs["language"]).trim();
  let code = "";

  if (block.innerHTML.trim().length > 0) {
    try {
      const $ = load(block.innerHTML);
      const codeEl = $("code").first();
      const preEl = $("pre").first();
      const target = codeEl.length > 0 ? codeEl : preEl;
      if (target.length > 0) {
        code = target.text().replace(/^\n+|\n+$/g, "");
        if (language.length === 0) {
          const classAttr = target.attr("class") ?? "";
          const match =
            /language-([\w+-]+)/i.exec(classAttr) ??
            /lang(?:uage)?-([\w+-]+)/i.exec(classAttr);
          if (match?.[1] !== undefined) {
            language = match[1].trim();
          }
        }
      } else {
        code = $.root().text().replace(/^\n+|\n+$/g, "");
      }
    } catch {
      code = "";
    }
  }

  if (code.length === 0) {
    code = asString(attrs["content"]).replace(/^\n+|\n+$/g, "");
  }

  const fence = language.length > 0 ? `\`\`\`${language}` : "```";
  return `${fence}\n${code}\n\`\`\``;
}

function transformColumns(block: Block): string {
  const attrs = getAttrs(block);
  const columns =
    asNumber(attrs["columns"]) ??
    (block.innerBlocks.length > 0 ? block.innerBlocks.length : 1);
  const inner =
    block.innerBlocks.length > 0
      ? block.innerBlocks
          .map((child) => transformBlock(child))
          .filter((part) => part.trim().length > 0)
          .join("\n\n")
      : htmlToMarkdown(block.innerHTML);
  return `<Grid columns={${columns}}>\n${inner}\n</Grid>`;
}

function transformColumn(block: Block): string {
  let inner = "";
  if (block.innerBlocks.length > 0) {
    inner = block.innerBlocks
      .map((child) => transformBlock(child))
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
  }
  if (inner.trim().length === 0 && block.innerHTML.trim().length > 0) {
    inner = htmlToMarkdown(block.innerHTML);
  }
  return `<GridColumn>\n${inner}\n</GridColumn>`;
}

function transformListItem(block: Block): string {
  const text = htmlToMarkdown(block.innerHTML).replace(/\n+/g, " ").trim();
  if (block.innerBlocks.length === 0) {
    return text;
  }
  const nested = block.innerBlocks
    .map((child) => transformBlock(child))
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return [text, nested].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Recursively map a single WordPress block to Markdown / MDX.
 *
 * - `core/paragraph`, `core/heading`, `core/list` → Turndown Markdown.
 * - `core/columns` / `core/column` → `<Grid>` / `<GridColumn>`.
 * - `core/image` → `<ResponsiveImage>`.
 * - `core/gallery` → `<ImageGallery>`.
 * - `core/quote` / `core/pullquote` → `<Callout type="quote">`.
 * - `core/code` → fenced code block.
 * - Classic content (`blockName === null`) and unrecognized blocks fall back
 *   to Turndown Markdown generation.
 */
export function transformBlock(block: Block): string {
  const name = block.blockName;

  // Classic / freeform content: no block delimiters, raw HTML only.
  if (name === null || name === undefined || name === "") {
    return htmlToMarkdown(block.innerHTML);
  }

  switch (name) {
    case "core/paragraph":
    case "core/heading":
    case "core/list": {
      if (block.innerBlocks.length > 0) {
        const outer = block.innerHTML.trim()
          ? htmlToMarkdown(block.innerHTML)
          : "";
        const inner = block.innerBlocks
          .map((child) => transformBlock(child))
          .filter((part) => part.trim().length > 0)
          .join("\n\n");
        // For lists with structured items, prefer the joined items; the
        // wrapper `<ul>`/`ol` alone converts to an empty string.
        if (name === "core/list" && inner.length > 0 && outer.length === 0) {
          return inner;
        }
        return [outer, inner].filter((part) => part.length > 0).join("\n\n");
      }
      return htmlToMarkdown(block.innerHTML);
    }

    case "core/list-item":
      return transformListItem(block);

    case "core/columns":
      return transformColumns(block);

    case "core/column":
      return transformColumn(block);

    case "core/image":
      return transformImage(block);

    case "core/gallery":
      return transformGallery(block);

    case "core/quote":
    case "core/pullquote":
      return transformQuote(block);

    case "core/code":
      return transformCode(block);

    default: {
      // Unrecognized blocks: recurse into inner blocks when present so
      // container wrappers (group, cover, media-text, …) keep their content,
      // otherwise fall back to Turndown Markdown generation.
      if (block.innerBlocks.length > 0) {
        const inner = block.innerBlocks
          .map((child) => transformBlock(child))
          .filter((part) => part.trim().length > 0)
          .join("\n\n");
        const outer = block.innerHTML.trim()
          ? htmlToMarkdown(block.innerHTML)
          : "";
        const combined = [outer, inner]
          .filter((part) => part.length > 0)
          .join("\n\n");
        if (combined.length > 0) {
          return combined;
        }
      }
      if (block.innerHTML.trim().length > 0) {
        return htmlToMarkdown(block.innerHTML);
      }
      return "";
    }
  }
}

/**
 * Map an array of blocks to a single MDX body string.
 *
 * Empty blocks are dropped and the remainder joined with blank lines.
 */
export function transformBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => transformBlock(block).trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** Alias for {@link transformBlocks}. */
export const convertBlocksToMdx = transformBlocks;

/** Alias for {@link transformBlocks}. */
export const blocksToMdx = transformBlocks;

/**
 * Parse raw WordPress `post_content` into a block tree.
 *
 * Thin wrapper around the official block serialization parser that also
 * normalizes the loose parser output to the local {@link Block} type.
 */
export function parsePostContent(postContent: string): Block[] {
  if (!postContent || postContent.length === 0) {
    return [];
  }
  return parse(postContent) as unknown as Block[];
}

/**
 * Convert raw WordPress `post_content` straight to an MDX body string
 * (without frontmatter).
 */
export function postContentToMdx(postContent: string): string {
  return transformBlocks(parsePostContent(postContent));
}

/** Alias for {@link postContentToMdx}. */
export const convertPostContentToMdx = postContentToMdx;

/** Alias for {@link postContentToMdx}. */
export const transformPostContent = postContentToMdx;

/** Alias for {@link postContentToMdx}. */
export const parsePostContentToMdx = postContentToMdx;

/** Alias for {@link postContentToMdx}. */
export const convertContentToMdx = postContentToMdx;

export default postContentToMdx;
