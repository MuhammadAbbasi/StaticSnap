import { z } from "zod";

export const WpPostSchema = z.object({
  title: z.string(),
  slug: z.string(),
  date: z.string(),
  status: z.string(),
  content: z.string(),
  excerpt: z.string(),
  categories: z.array(z.string()),
  tags: z.array(z.string()),
  featuredImage: z.string().nullish(),
});

export type WpPost = z.infer<typeof WpPostSchema>;

export const MediaItemSchema = z.object({
  originalUrl: z.string().url(),
  localPath: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
});

export type MediaItem = z.infer<typeof MediaItemSchema>;

export const MigrationConfigSchema = z.object({
  source: z.string().min(1),
  outDir: z.string().min(1),
  optimizeImages: z.boolean(),
  concurrency: z.number().int().min(1).max(32),
});

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
