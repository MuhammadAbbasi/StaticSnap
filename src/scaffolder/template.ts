import fs from "fs-extra";
import path from "node:path";

/**
 * Site scaffolding module for `wp-to-astro`.
 *
 * Programmatically writes a minimal, modern Astro 5 project into the target
 * output directory, including package/config files, MDX components, layouts,
 * and routing templates.
 */

function buildPackageJson(): string {
  const pkg = {
    name: "migrated-astro-site",
    type: "module",
    version: "0.0.1",
    private: true,
    scripts: {
      dev: "astro dev",
      build: "astro build",
      preview: "astro preview",
      astro: "astro",
    },
    dependencies: {
      astro: "^5.0.0",
      "@astrojs/mdx": "^4.0.0",
      "@astrojs/tailwind": "^5.1.0",
      tailwindcss: "^3.4.0",
      "@tailwindcss/typography": "^0.5.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

const ASTRO_CONFIG_MJS = `import fs from "node:fs";
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import tailwind from "@astrojs/tailwind";

// redirects.json is written by the migration (WordPress permalink -> new
// route). It is absent on a fresh scaffold, so the read is guarded.
const migrated = fs.existsSync("./redirects.json")
  ? JSON.parse(fs.readFileSync("./redirects.json", "utf8"))
  : {};

// Astro matches route patterns, not absolute URLs, so each WordPress
// permalink is reduced to its pathname ("https://old.site/hello/" -> "/hello/").
// Self-referential entries are dropped: they would collide with the real route.
const redirects = Object.fromEntries(
  Object.entries(migrated)
    .map(([from, to]) => {
      try {
        return [new URL(from).pathname, to];
      } catch {
        return [from, to];
      }
    })
    .filter(([pattern, to]) => pattern.startsWith("/") && pattern !== to),
);

// https://astro.build/config
export default defineConfig({
  redirects,
  integrations: [mdx(), tailwind()],
});
`;

const CONTENT_CONFIG_TS = `import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Blog collection fed by migrated WordPress posts.
// Frontmatter schema mirrors the migration frontmatter types
// (title / slug / date / excerpt / categories / tags / featuredImage).
const blog = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    date: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    slug: z.string().optional(),
    categories: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    featuredImage: z.string().optional(),
    heroImage: z.string().optional(),
    draft: z.boolean().optional(),
  }),
});

export const collections = { blog };
`;

const TAILWIND_CONFIG_MJS = `import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [typography],
};
`;

const TSCONFIG_JSON = `{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "strict": true
  }
}
`;

const GRID_ASTRO = `---
/**
 * Grid.astro — responsive CSS grid container supporting dynamic column props.
 */
interface Props {
  columns?: number;
  gap?: string;
  class?: string;
}

const { columns = 2, gap = "1rem", class: className = "" } = Astro.props;
---
<div class:list={["grid", className]} style={"--grid-columns: " + columns + "; --grid-gap: " + gap}>
  <slot />
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--grid-gap);
  }

  @media (min-width: 640px) {
    .grid {
      grid-template-columns: repeat(var(--grid-columns), minmax(0, 1fr));
    }
  }
</style>
`;

const GRID_COLUMN_ASTRO = `---
/**
 * GridColumn.astro — flex/block child wrapper for use inside Grid.astro.
 */
interface Props {
  span?: number;
  class?: string;
}

const { span, class: className = "" } = Astro.props;
---
<div
  class:list={["block", "flex", "min-w-0", "flex-col", className]}
  style={span ? "grid-column: span " + span + " / span " + span : undefined}
>
  <slot />
</div>
`;

const RESPONSIVE_IMAGE_ASTRO = `---
/**
 * ResponsiveImage.astro — Astro native Image wrapper rendering WebP/AVIF
 * with a responsive srcset plus an optional figcaption.
 *
 * Migrated MDX passes 'src' as a string path (e.g.
 * "../../assets/images/photo.webp"). astro:assets rejects string filepaths,
 * so local file names are resolved to ImageMetadata via import.meta.glob.
 * Anything unresolved (remote URL left after a failed download, missing file)
 * degrades to a plain <img> instead of failing the build.
 */
import { Image } from "astro:assets";

interface Props {
  src: ImageMetadata | string;
  alt: string;
  widths?: number[];
  sizes?: string;
  caption?: string;
  class?: string;
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
}

const {
  src,
  alt,
  widths = [320, 640, 960, 1280],
  sizes = "(max-width: 640px) 100vw, (max-width: 1024px) 80vw, 960px",
  caption,
  class: className = "",
  loading = "lazy",
  decoding = "async",
} = Astro.props;

const assets = import.meta.glob<{ default: ImageMetadata }>(
  "../assets/images/*",
  { eager: true },
);
const assetsByName = new Map(
  Object.entries(assets).map(([filePath, mod]) => [
    filePath.split("/").pop(),
    mod.default,
  ]),
);

const resolved: ImageMetadata | string =
  typeof src === "string"
    ? (assetsByName.get(src.split("/").pop() ?? "") ?? src)
    : src;
---
<figure class:list={["my-6", "overflow-hidden", "rounded-lg", className]}>
  {
    typeof resolved === "string" ? (
      <img
        src={resolved}
        alt={alt}
        loading={loading}
        decoding={decoding}
        class="h-auto w-full object-cover"
      />
    ) : (
      <Image
        src={resolved}
        alt={alt}
        widths={widths}
        sizes={sizes}
        formats={["avif", "webp"]}
        loading={loading}
        decoding={decoding}
        class="h-auto w-full object-cover"
      />
    )
  }
  {caption && <figcaption class="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">{caption}</figcaption>}
</figure>
`;

const IMAGE_GALLERY_ASTRO = `---
/**
 * ImageGallery.astro — grid-based image gallery with modal lightbox behavior.
 *
 * Like ResponsiveImage, incoming 'src' values are string paths produced by the
 * migration; they are resolved to ImageMetadata via import.meta.glob, and any
 * unresolved value degrades to a plain <img>.
 */
import { Image } from "astro:assets";

interface GalleryImage {
  src: ImageMetadata | string;
  alt: string;
  caption?: string;
}

interface Props {
  images: GalleryImage[];
  columns?: number;
  gap?: string;
  class?: string;
}

const { images = [], columns = 3, gap = "0.75rem", class: className = "" } = Astro.props;
const galleryId = "gallery-" + Math.random().toString(36).slice(2);

const assets = import.meta.glob<{ default: ImageMetadata }>(
  "../assets/images/*",
  { eager: true },
);
const assetsByName = new Map(
  Object.entries(assets).map(([filePath, mod]) => [
    filePath.split("/").pop(),
    mod.default,
  ]),
);

const resolvedImages = images.map((image) => ({
  ...image,
  resolved:
    typeof image.src === "string"
      ? (assetsByName.get(image.src.split("/").pop() ?? "") ?? image.src)
      : image.src,
}));
---
<div
  class:list={["grid", className]}
  style={"--gallery-columns: " + columns + "; --gallery-gap: " + gap}
  data-gallery={galleryId}
>
  {
    resolvedImages.map((image, index) => (
      <button
        type="button"
        data-index={index}
        data-caption={image.caption || image.alt}
        data-lightbox-trigger
        class="group overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        {typeof image.resolved === "string" ? (
          <img
            src={image.resolved}
            alt={image.alt}
            loading="lazy"
            class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <Image
            src={image.resolved}
            alt={image.alt}
            widths={[320, 640, 960]}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            formats={["avif", "webp"]}
            loading="lazy"
            class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        )}
      </button>
    ))
  }
</div>

<dialog data-lightbox class="rounded-lg bg-transparent p-0 backdrop:bg-black/80">
  <div class="relative max-h-[90vh] max-w-[90vw]">
    <img data-lightbox-image alt="" class="max-h-[80vh] w-auto max-w-full rounded-lg object-contain" />
    <p data-lightbox-caption class="mt-2 text-center text-sm text-white"></p>
    <button
      type="button"
      data-lightbox-close
      class="absolute -top-2 -right-2 rounded-full bg-white px-3 py-1 text-sm shadow"
    >
      Close
    </button>
  </div>
</dialog>

<script>
  function initImageGalleries() {
    var galleries = document.querySelectorAll("[data-gallery]");
    galleries.forEach(function (gallery) {
      var dialog = gallery.nextElementSibling;
      if (!dialog || dialog.tagName !== "DIALOG") return;
      var lightboxImage = dialog.querySelector("[data-lightbox-image]");
      var lightboxCaption = dialog.querySelector("[data-lightbox-caption]");
      var closeButton = dialog.querySelector("[data-lightbox-close]");
      var triggers = gallery.querySelectorAll("[data-lightbox-trigger]");
      triggers.forEach(function (trigger) {
        trigger.addEventListener("click", function () {
          var img = trigger.querySelector("img");
          if (!img || !lightboxImage) return;
          lightboxImage.setAttribute("src", img.getAttribute("src") || "");
          lightboxImage.setAttribute("alt", img.getAttribute("alt") || "");
          var caption = trigger.getAttribute("data-caption") || img.getAttribute("alt") || "";
          if (lightboxCaption) lightboxCaption.textContent = caption;
          if (typeof dialog.showModal === "function") dialog.showModal();
          else dialog.setAttribute("open", "");
        });
      });
      if (closeButton) {
        closeButton.addEventListener("click", function () {
          if (typeof dialog.close === "function") dialog.close();
          else dialog.removeAttribute("open");
        });
      }
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) {
          if (typeof dialog.close === "function") dialog.close();
          else dialog.removeAttribute("open");
        }
      });
    });
  }
  initImageGalleries();
</script>

<style>
  [data-gallery] {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gallery-gap);
  }

  @media (min-width: 768px) {
    [data-gallery] {
      grid-template-columns: repeat(var(--gallery-columns), minmax(0, 1fr));
    }
  }
</style>
`;

const CALLOUT_ASTRO = `---
/**
 * Callout.astro — styled blockquote/callout box with citation support.
 *
 * The 'quote' type and the 'citation' prop name match exactly what the
 * block transformer emits for core/quote and core/pullquote.
 */
interface Props {
  type?: "info" | "note" | "warning" | "tip" | "danger" | "quote";
  title?: string;
  citation?: string;
}

const { type = "info", title, citation } = Astro.props;

const tones: Record<string, string> = {
  info: "border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  note: "border-gray-400 bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100",
  warning: "border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  tip: "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  danger: "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  quote: "border-slate-400 bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100",
};

const tone = tones[type] || tones["info"] || "";
---
<aside class:list={["my-6", "rounded-lg", "border-l-4", "p-4", "shadow-sm", tone]}>
  {title && <p class="mb-2 font-semibold">{title}</p>}
  <blockquote class="prose prose-sm max-w-none">
    <slot />
  </blockquote>
  {citation && <footer class="mt-2 text-sm opacity-80"><cite>{citation}</cite></footer>}
</aside>
`;

const BASE_LAYOUT_ASTRO = `---
/**
 * BaseLayout.astro — common HTML shell with meta tags and styling.
 */
interface Props {
  title: string;
  description?: string;
}

const { title, description = "Migrated WordPress site built with Astro." } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description} />
    <meta name="generator" content={Astro.generator} />
    <title>{title}</title>
  </head>
  <body class="min-h-screen bg-white text-gray-900 antialiased dark:bg-gray-950 dark:text-gray-100">
    <header class="border-b border-gray-200 dark:border-gray-800">
      <nav class="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4">
        <a href="/" class="text-lg font-bold">Home</a>
        <a href="/blog" class="text-sm text-gray-600 hover:underline dark:text-gray-300">Blog</a>
      </nav>
    </header>
    <main class="mx-auto w-full max-w-3xl px-4 py-8">
      <slot />
    </main>
    <footer class="border-t border-gray-200 py-6 dark:border-gray-800">
      <p class="mx-auto w-full max-w-3xl px-4 text-sm text-gray-500">Built with Astro.</p>
    </footer>
  </body>
</html>
`;

const BLOG_POST_LAYOUT_ASTRO = `---
/**
 * BlogPostLayout.astro — article layout injecting global MDX components
 * into the Content renderer.
 */
import type { CollectionEntry } from "astro:content";
import { render } from "astro:content";
import BaseLayout from "./BaseLayout.astro";
import Grid from "../components/Grid.astro";
import GridColumn from "../components/GridColumn.astro";
import ResponsiveImage from "../components/ResponsiveImage.astro";
import ImageGallery from "../components/ImageGallery.astro";
import Callout from "../components/Callout.astro";

interface Props {
  entry: CollectionEntry<"blog">;
}

const { entry } = Astro.props;
const { Content } = await render(entry);
const components = { Grid, GridColumn, ResponsiveImage, ImageGallery, Callout };
const { title, description, excerpt, date } = entry.data;
const pageDescription = description || excerpt || "";
const displayDate = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
---
<BaseLayout title={title} description={pageDescription}>
  <article class="prose prose-slate max-w-none dark:prose-invert">
    <header class="mb-8">
      <h1>{title}</h1>
      <p>
        <time datetime={displayDate}>{displayDate}</time>
      </p>
    </header>
    <Content components={components} />
  </article>
</BaseLayout>
`;

const BLOG_SLUG_ASTRO = `---
/**
 * src/pages/blog/[...slug].astro — dynamic routing template for blog posts.
 * Fetches posts via getCollection('blog') and renders each entry.
 */
import { getCollection } from "astro:content";
import BlogPostLayout from "../../layouts/BlogPostLayout.astro";

export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return posts.map((entry) => {
    const rawId = entry.id.replace(/\\.(md|mdx)$/, "");
    const slug = entry.data.slug || rawId;
    return {
      params: { slug },
      props: { entry },
    };
  });
}

const { entry } = Astro.props;
// Rendered via BlogPostLayout using render(entry) and the shared MDX components.
---
<BlogPostLayout entry={entry} />
`;

const INDEX_ASTRO = `---
/**
 * src/pages/index.astro — homepage listing all migrated posts with links and dates.
 */
import { getCollection } from "astro:content";
import BaseLayout from "../layouts/BaseLayout.astro";

const posts = (await getCollection("blog"))
  .filter((post) => !post.data.draft)
  .sort((a, b) => Number(b.data.date) - Number(a.data.date));
---
<BaseLayout title="Home" description="Migrated WordPress posts.">
  <section class="prose prose-slate max-w-none dark:prose-invert">
    <h1>Posts</h1>
    {
      posts.length === 0 ? (
        <p>No posts yet.</p>
      ) : (
        <ul>
          {posts.map((post) => {
            const rawId = post.id.replace(/\\.(md|mdx)$/, "");
            const slug = post.data.slug || rawId;
            const href = "/blog/" + slug;
            const displayDate =
              post.data.date instanceof Date
                ? post.data.date.toISOString().slice(0, 10)
                : String(post.data.date);
            return (
              <li>
                <a href={href}>{post.data.title}</a>
                <span>{" — "}</span>
                <time datetime={displayDate}>{displayDate}</time>
              </li>
            );
          })}
        </ul>
      )
    }
  </section>
</BaseLayout>
`;

/**
 * Returns the full relative-path -> file-content map for the scaffolded
 * Astro project. Paths use POSIX separators.
 */
export function getTemplateFiles(): Record<string, string> {
  return {
    "package.json": buildPackageJson(),
    "astro.config.mjs": ASTRO_CONFIG_MJS,
    "tailwind.config.mjs": TAILWIND_CONFIG_MJS,
    "tsconfig.json": TSCONFIG_JSON,
    "src/content.config.ts": CONTENT_CONFIG_TS,
    "src/components/Grid.astro": GRID_ASTRO,
    "src/components/GridColumn.astro": GRID_COLUMN_ASTRO,
    "src/components/ResponsiveImage.astro": RESPONSIVE_IMAGE_ASTRO,
    "src/components/ImageGallery.astro": IMAGE_GALLERY_ASTRO,
    "src/components/Callout.astro": CALLOUT_ASTRO,
    "src/layouts/BaseLayout.astro": BASE_LAYOUT_ASTRO,
    "src/layouts/BlogPostLayout.astro": BLOG_POST_LAYOUT_ASTRO,
    "src/pages/blog/[...slug].astro": BLOG_SLUG_ASTRO,
    "src/pages/index.astro": INDEX_ASTRO,
  };
}

/** Backwards/forwards-compatible alias for the template file map. */
export const TEMPLATE_FILES: Record<string, string> = getTemplateFiles();

/**
 * Writes a minimal, modern Astro 5 project into `targetDir`.
 *
 * Creates all parent directories as needed. Existing scaffold files are
 * overwritten; other files in the directory are left untouched.
 *
 * @param targetDir Target output directory for the Astro project.
 */
export async function scaffoldTemplate(targetDir: string): Promise<void> {
  if (!targetDir || targetDir.trim().length === 0) {
    throw new Error("scaffoldTemplate: targetDir must be a non-empty string");
  }

  const files = getTemplateFiles();

  await fs.ensureDir(targetDir);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(targetDir, relativePath);
    await fs.ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, content, "utf8");
  }

  // Ensure runtime content/asset directories exist so later migration steps
  // (MDX writing, image downloading) have a place to land.
  await fs.ensureDir(path.join(targetDir, "src", "content", "blog"));
  await fs.ensureDir(path.join(targetDir, "src", "assets", "images"));
  await fs.ensureDir(path.join(targetDir, "public"));
}

/** Alias: scaffold an Astro site into the target directory. */
export const scaffoldSite = scaffoldTemplate;

/** Alias: write the Astro template into the target directory. */
export const writeTemplate = scaffoldTemplate;

/** Alias: create the Astro site scaffold in the target directory. */
export const createSiteTemplate = scaffoldTemplate;

/** Alias: create the Astro site scaffold in the target directory. */
export const createSiteScaffold = scaffoldTemplate;

export default scaffoldTemplate;
