/**
 * Spec file discovery — find .eval.ts/.eval.js/.eval.mjs files.
 */

import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Pattern for eval spec files. */
const EVAL_FILE_PATTERN = /\.eval\.(ts|js|mjs)$/;

/**
 * Discover eval spec files from a path.
 * If path is a file, returns it directly.
 * If path is a directory, recursively finds all .eval.ts/.eval.js/.eval.mjs files.
 *
 * @throws If path does not exist
 */
export async function discoverSpecs(inputPath: string): Promise<string[]> {
  const resolved = resolve(inputPath);
  const info = await stat(resolved);

  if (info.isFile()) {
    return [resolved];
  }

  if (info.isDirectory()) {
    const files = await readdir(resolved, { recursive: true });
    return files
      .filter((f) => EVAL_FILE_PATTERN.test(f))
      .map((f) => join(resolved, f))
      .sort();
  }

  return [];
}
