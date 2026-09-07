import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/server/server.ts", "src/server/crawler.ts", "src/server/screenshots.ts", "src/server/secrets.ts", "src/server/entitlements.ts", "src/net-guard.ts", "src/fetcher.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  dts: true,
  publicDir: "public",
});
