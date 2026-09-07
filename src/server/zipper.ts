import path from "node:path";
import fs from "fs-extra";
import { ZipArchive } from "archiver";

/**
 * Zip packaging utility for StaticSnap bundles.
 *
 * Streams a generated site directory into a `.zip` file with maximum
 * portability (no absolute paths, POSIX separators).
 */

export interface ZipResult {
  bytes: number;
  entries: number;
  path: string;
}

/**
 * Create a `.zip` archive from `sourceDir`.
 *
 * @param sourceDir Directory containing the static site (must exist).
 * @param zipPath Destination `.zip` file path (parent dirs created).
 * @param onProgress Optional per-entry callback receiving the entry count.
 */
export async function createZip(
  sourceDir: string,
  zipPath: string,
  onProgress?: (entries: number) => void,
): Promise<ZipResult> {
  if (!sourceDir || sourceDir.trim().length === 0) {
    throw new Error("createZip: sourceDir must be a non-empty string");
  }
  if (!zipPath || zipPath.trim().length === 0) {
    throw new Error("createZip: zipPath must be a non-empty string");
  }
  if (!(await fs.pathExists(sourceDir))) {
    throw new Error(`createZip: source directory not found: ${sourceDir}`);
  }

  await fs.ensureDir(path.dirname(zipPath));
  // Remove stale archives so sizes never accumulate across retries.
  await fs.remove(zipPath).catch(() => undefined);

  return new Promise<ZipResult>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let entries = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    archive.on("entry", () => {
      entries += 1;
      if (entries % 25 === 0) onProgress?.(entries);
    });
    archive.on("warning", (warning: Error & { code?: string }) => {
      // Missing files (race with GC) warn; real failures error.
      if (warning.code === "ENOENT") {
        console.warn(`[zip] warning: ${warning.message}`);
      } else {
        fail(warning);
      }
    });
    archive.on("error", (error: Error) => fail(error));

    output.on("close", () => {
      if (settled) return;
      settled = true;
      onProgress?.(entries);
      void fs
        .stat(zipPath)
        .then((stat) => resolve({ bytes: stat.size, entries, path: zipPath }))
        .catch(fail);
    });
    output.on("error", (error: Error) => fail(error));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

export default createZip;
