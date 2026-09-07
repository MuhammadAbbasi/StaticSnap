#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  MigrationConfigSchema,
  type MigrationConfig,
} from "./types/index.js";
import { runMigration, type PipelineStage } from "./pipeline.js";

interface CliOptions {
  source?: string | undefined;
  out: string;
  optimizeImages: boolean;
  concurrency: number;
}

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 32) {
    throw new Error(
      `Invalid concurrency value: "${value}". Must be an integer between 1 and 32.`,
    );
  }
  return parsed;
}

function createProgram(): Command {
  const program = new Command();
  program
    .name("wp-to-astro")
    .description(
      "Convert WordPress sites into an Astro/MDX code-based site",
    )
    .version("0.1.0")
    .option("--source <path>", "Path to WordPress WXR XML export file")
    .option(
      "--out <dir>",
      "Target output directory for the Astro project",
      "./astro-site",
    )
    .option("--optimize-images", "Enable WebP conversion", false)
    .option(
      "--concurrency <number>",
      "Asset download concurrency limit",
      parseConcurrency,
      5,
    );
  return program;
}

async function promptForMissingValues(
  options: CliOptions,
): Promise<MigrationConfig> {
  p.intro(pc.cyan("wp-to-astro"));

  let source = options.source;
  if (source === undefined || source.trim().length === 0) {
    const answer = await p.text({
      message: "Path to WordPress WXR XML export file:",
      placeholder: "./export.xml",
      validate: (value: string | undefined) => {
        if (value === undefined || value.trim().length === 0) {
          return "Source path is required.";
        }
        return undefined;
      },
    });
    if (p.isCancel(answer)) {
      p.cancel("Migration cancelled.");
      process.exit(0);
    }
    source = answer.trim();
  }

  let outDir = options.out;
  const outAnswer =
    options.source === undefined
      ? await p.text({
          message: "Target output directory for the Astro project:",
          placeholder: "./astro-site",
          initialValue: outDir,
          validate: (value: string | undefined) => {
            if (value === undefined || value.trim().length === 0) {
              return "Output directory is required.";
            }
            return undefined;
          },
        })
      : undefined;

  if (outAnswer !== undefined) {
    if (p.isCancel(outAnswer)) {
      p.cancel("Migration cancelled.");
      process.exit(0);
    }
    outDir = outAnswer.trim();
  }

  let optimizeImages = options.optimizeImages;
  if (options.source === undefined && options.optimizeImages === false) {
    const answer = await p.confirm({
      message: "Enable WebP image optimization?",
      initialValue: false,
    });
    if (p.isCancel(answer)) {
      p.cancel("Migration cancelled.");
      process.exit(0);
    }
    optimizeImages = answer;
  }

  let concurrency = options.concurrency;
  if (options.source === undefined) {
    const answer = await p.text({
      message: "Asset download concurrency limit:",
      placeholder: "5",
      initialValue: String(concurrency),
      validate: (value: string | undefined) => {
        if (value === undefined) {
          return "Enter an integer between 1 and 32.";
        }
        const parsed = Number.parseInt(value.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 32) {
          return "Enter an integer between 1 and 32.";
        }
        return undefined;
      },
    });
    if (p.isCancel(answer)) {
      p.cancel("Migration cancelled.");
      process.exit(0);
    }
    concurrency = Number.parseInt(answer.trim(), 10);
  }

  const config = MigrationConfigSchema.parse({
    source,
    outDir,
    optimizeImages,
    concurrency,
  });

  p.outro(pc.green("Configuration ready."));
  return config;
}

function printConfig(config: MigrationConfig): void {
  console.log(pc.bold("\nMigration configuration:"));
  console.log(`  ${pc.dim("source:")}          ${pc.cyan(config.source)}`);
  console.log(`  ${pc.dim("outDir:")}          ${pc.cyan(config.outDir)}`);
  console.log(
    `  ${pc.dim("optimizeImages:")} ${pc.cyan(String(config.optimizeImages))}`,
  );
  console.log(
    `  ${pc.dim("concurrency:")}    ${pc.cyan(String(config.concurrency))}`,
  );
}

export async function resolveConfig(argv: string[]): Promise<MigrationConfig> {
  const program = createProgram();
  program.parse(argv);
  const raw = program.opts() as CliOptions;
  const normalized: CliOptions = {
    source: raw.source,
    out: raw.out ?? "./astro-site",
    optimizeImages: raw.optimizeImages ?? false,
    concurrency: raw.concurrency ?? 5,
  };
  return promptForMissingValues(normalized);
}

async function main(): Promise<void> {
  const config = await resolveConfig(process.argv);
  printConfig(config);

  const spinner = p.spinner();
  const stageMessages: Record<PipelineStage, string> = {
    validate: "Validating inputs…",
    scaffold: "Scaffolding Astro project…",
    parse: "Parsing WordPress XML…",
    media: "Downloading media assets…",
    mdx: "Compiling MDX…",
    redirects: "Writing redirects.json…",
  };

  spinner.start("Starting migration…");
  try {
    const result = await runMigration(config, {
      onStage: (stage, status) => {
        if (status === "start") {
          spinner.message(stageMessages[stage]);
        }
      },
    });
    spinner.stop(pc.green("Migration finished."));

    const seconds = (result.executionTimeMs / 1000).toFixed(1);
    const relativeOut =
      path.relative(process.cwd(), result.outDir) || result.outDir;
    const displayOut =
      relativeOut.length === 0 ? result.outDir : relativeOut;
    const mediaLine = config.optimizeImages
      ? `${result.mediaDownloaded} (WebP optimized)`
      : `${result.mediaDownloaded}`;

    p.note(
      [
        `Posts converted:  ${result.totalPosts}`,
        `Media assets:     ${mediaLine}`,
        ...(result.mediaFailed > 0
          ? [pc.yellow(`Media failed:     ${result.mediaFailed}`)]
          : []),
        `Execution time:   ${seconds}s`,
        `Run log:          migration-log.json`,
        ``,
        `Next steps:`,
        `  cd ${displayOut} && npm install && npm run dev`,
      ].join("\n"),
      "Migration complete",
    );
    if (result.mediaFailed > 0) {
      console.log(
        pc.yellow(
          `\n${result.mediaFailed} asset(s) could not be downloaded and still point at the original site. See migration-log.json -> mediaFailures.`,
        ),
      );
    }
    p.outro(pc.green(`Done in ${seconds}s. Happy shipping!`));
  } catch (error: unknown) {
    spinner.stop(pc.red("Migration failed."));
    throw error;
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(pc.red(`Error: ${error.message}`));
  } else {
    console.error(pc.red("An unknown error occurred."));
  }
  process.exit(1);
});
