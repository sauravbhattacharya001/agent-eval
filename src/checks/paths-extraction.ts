/**
 * Path/URL Verifier — reference extraction (Tier 1 Deterministic Check)
 *
 * The `text → references` half of the path checker: URL / file-path / GitHub
 * reference patterns plus the line-by-line scanner (`extractReferences`).
 * Extraction is purely string analysis — no filesystem or network access — so
 * it stays independent of the verification seam.
 *
 * @tier 1 — Deterministic
 * @module
 */

import type { ExtractedReference } from './paths-types.js';

// ─── EXTRACTION ─────────────────────────────────────────────────────────────────

/** Common file extensions indicating a path reference. */
export const PATH_EXTENSIONS = [
  '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c', '.h',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.md', '.txt', '.html', '.css', '.scss',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.dockerfile', '.env', '.gitignore', '.eslintrc',
  '.config', '.lock', '.log',
] as const;

/** Regex for URLs — http(s) only. */
const URL_REGEX = /https?:\/\/[^\s<>"')\]},;]+/g;

/**
 * Regex for file paths — Unix and Windows style.
 * Split into three alternatives:
 * 1. Dot-relative paths: ./foo or ../foo
 * 2. Absolute unix paths: /etc/foo (with negative lookbehind to exclude ://)
 * 3. Windows paths: C:\foo\bar
 * 4. Bare filenames with known extensions: package.json, runner.ts, etc.
 *    (word boundary at start to avoid matching URL fragments)
 */
const FILE_PATH_PATTERNS: RegExp[] = [
  // ./relative/path or ../parent/path
  /\.{1,2}\/[\w./-]+/g,
  // /absolute/unix/path (not preceded by :/ or another / which would be URL scheme)
  /(?<![:/])\/[\w][\w./-]*/g,
  // C:\windows\path
  /[A-Z]:\\[\w.\\/-]+/g,
  // bare filename with extension: package.json, runner.ts, src/core/runner.ts etc.
  // Must start at word boundary (space, start, or after certain chars)
  /(?<=^|[\s"'`({\[,;:])\w[\w./-]*\.(?:ts|js|tsx|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|cpp|c|h|json|yaml|yml|toml|xml|csv|md|txt|html|css|scss|sh|bash|zsh|ps1|bat|cmd|dockerfile|env|gitignore|eslintrc|config|lock|log)(?=$|[\s"'`)}\],;:!?])/g,
];

/** Match all file paths in a line using multiple patterns, deduplicated. */
function matchFilePaths(line: string): Array<{ value: string; index: number }> {
  const raw: Array<{ value: string; index: number }> = [];
  for (const pattern of FILE_PATH_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      raw.push({ value: match[0], index: match.index ?? 0 });
    }
  }
  // Deduplicate: remove matches that are substrings of longer matches at overlapping positions
  return raw.filter((m, _i, arr) => {
    return !arr.some(
      other => other !== m &&
        other.value.length > m.value.length &&
        other.index <= m.index &&
        other.index + other.value.length >= m.index + m.value.length
    );
  });
}

/** Regex for GitHub repo references: org/repo. */
export const GITHUB_REPO_REGEX = /(?:github\.com\/|(?<![/\w]))([\w.-]+\/[\w.-]+)(?:#(\d+))?/g;

/**
 * Extract all references (URLs, file paths, GitHub refs) from text.
 */
export function extractReferences(
  text: string,
  options?: { checkUrls?: boolean; checkFilePaths?: boolean; checkGitHub?: boolean; excludePatterns?: RegExp[] }
): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  const {
    checkUrls = true,
    checkFilePaths = true,
    checkGitHub = true,
    excludePatterns = [],
  } = options ?? {};

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';

    // Track URL spans so file path extraction skips regions inside URLs
    const urlSpans: Array<[number, number]> = [];

    // Extract URLs
    if (checkUrls) {
      for (const match of line.matchAll(URL_REGEX)) {
        let url = match[0];
        // Clean trailing punctuation that's likely not part of the URL
        url = url.replace(/[.)>,;:!?]+$/, '');

        const matchStart = match.index ?? 0;
        urlSpans.push([matchStart, matchStart + url.length]);

        if (seen.has(url)) continue;
        if (excludePatterns.some(p => p.test(url))) continue;
        seen.add(url);

        const col = matchStart + 1;

        // Check if this is a GitHub reference
        const ghMatch = url.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\/(?:issues|pull)\/(\d+))?(?:\/|$)/);
        if (ghMatch && ghMatch[1] && checkGitHub) {
          if (ghMatch[2]) {
            refs.push({
              type: 'github-issue',
              value: `${ghMatch[1]}#${ghMatch[2]}`,
              line: lineIdx + 1,
              column: col,
            });
          } else {
            refs.push({
              type: 'github-repo',
              value: ghMatch[1],
              line: lineIdx + 1,
              column: col,
            });
          }
        } else {
          refs.push({
            type: 'url',
            value: url,
            line: lineIdx + 1,
            column: col,
          });
        }
      }
    } else {
      // Even if not extracting URLs, track their spans to exclude from paths
      for (const match of line.matchAll(URL_REGEX)) {
        const matchStart = match.index ?? 0;
        urlSpans.push([matchStart, matchStart + match[0].length]);
      }
    }

    // Extract file paths (skip anything inside a URL span)
    if (checkFilePaths) {
      for (const match of matchFilePaths(line)) {
        const pathValue = match.value;
        // Skip if this path overlaps with a URL
        const overlapsUrl = urlSpans.some(
          ([start, end]) => match.index >= start && match.index < end
        );
        if (overlapsUrl) continue;
        if (seen.has(pathValue)) continue;
        if (excludePatterns.some(p => p.test(pathValue))) continue;
        // Avoid matching URLs as file paths
        if (pathValue.startsWith('http://') || pathValue.startsWith('https://')) continue;
        seen.add(pathValue);
        refs.push({
          type: 'file-path',
          value: pathValue,
          line: lineIdx + 1,
          column: match.index + 1,
        });
      }
    }
  }

  return refs;
}
