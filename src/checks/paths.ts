/**
 * Path/URL Verifier — Tier 1 Deterministic Check
 *
 * Validates that file paths, URLs, and references in agent output actually exist:
 * - File paths: checks filesystem existence (relative to a configurable base)
 * - URLs: HEAD/GET requests to verify reachability (with configurable timeout)
 * - GitHub repos/issues/PRs: validates format and optionally checks existence
 * - Package references: validates npm/PyPI package name format
 *
 * All checks are deterministic — they verify concrete facts without AI.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** A reference extracted from text. */
export interface ExtractedReference {
  type: 'url' | 'file-path' | 'github-repo' | 'github-issue' | 'package';
  value: string;
  line: number;
  column: number;
}

/** Options for URL verification. */
export interface UrlVerifyOptions {
  /** Timeout in milliseconds for each URL check. Default: 5000. */
  timeoutMs?: number;
  /** HTTP method to use. Default: 'HEAD' (falls back to GET on 405). */
  method?: 'HEAD' | 'GET';
  /** Accept status codes in this range as valid. Default: [200, 399]. */
  acceptStatusRange?: [number, number];
  /** Maximum number of redirects to follow. Default: 5. */
  maxRedirects?: number;
  /** Custom User-Agent header. Default: 'agent-eval/0.1 link-checker'. */
  userAgent?: string;
}

/** Options for file path verification. */
export interface FilePathVerifyOptions {
  /** Base directory to resolve relative paths against. */
  basePath?: string;
  /** Whether to check that directories exist (not just files). Default: true. */
  checkDirectories?: boolean;
  /** File extensions to consider as path-like. Default: common code/doc extensions. */
  pathExtensions?: string[];
}

/** Result of verifying a single reference. */
export interface ReferenceVerifyResult {
  reference: ExtractedReference;
  exists: boolean;
  error?: string;
  /** HTTP status code (for URLs only). */
  statusCode?: number;
  /** Time taken to verify in ms. */
  durationMs: number;
}

/** Options for the full path verification assertion. */
export interface PathVerifyOptions {
  /** Check URLs. Default: true. */
  checkUrls?: boolean;
  /** Check file paths. Default: true. */
  checkFilePaths?: boolean;
  /** Check GitHub references. Default: true. */
  checkGitHub?: boolean;
  /** URL verification options. */
  urlOptions?: UrlVerifyOptions;
  /** File path verification options. */
  fileOptions?: FilePathVerifyOptions;
  /** Minimum number of references that must be valid to pass. Default: all found. */
  minValid?: number;
  /** Maximum allowed invalid references. Default: 0. */
  maxInvalid?: number;
  /** Patterns to exclude from checking (regex). */
  excludePatterns?: RegExp[];
}

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

// ─── VERIFICATION ───────────────────────────────────────────────────────────────

/**
 * Verify a URL is reachable via HTTP.
 * Returns a verification result (does NOT throw).
 */
export async function verifyUrl(
  url: string,
  options?: UrlVerifyOptions
): Promise<ReferenceVerifyResult> {
  const {
    timeoutMs = 5000,
    method = 'HEAD',
    acceptStatusRange = [200, 399],
    maxRedirects = 5,
    userAgent = 'agent-eval/0.1 link-checker',
  } = options ?? {};

  const start = performance.now();
  const ref: ExtractedReference = { type: 'url', value: url, line: 0, column: 0 };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        redirect: maxRedirects > 0 ? 'follow' : 'manual',
        headers: { 'User-Agent': userAgent },
      });

      clearTimeout(timeout);

      // If HEAD returns 405, retry with GET
      if (response.status === 405 && method === 'HEAD') {
        return verifyUrl(url, { ...options, method: 'GET' });
      }

      const statusOk = response.status >= acceptStatusRange[0] && response.status <= acceptStatusRange[1];

      return {
        reference: ref,
        exists: statusOk,
        statusCode: response.status,
        error: statusOk ? undefined : `HTTP ${response.status}`,
        durationMs: performance.now() - start,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reference: ref,
      exists: false,
      error: message.includes('abort') ? `Timeout after ${timeoutMs}ms` : message,
      durationMs: performance.now() - start,
    };
  }
}

/**
 * Verify a file path exists on the filesystem.
 * Uses dynamic import of node:fs to keep the module usable in non-Node environments.
 */
export async function verifyFilePath(
  filePath: string,
  options?: FilePathVerifyOptions
): Promise<ReferenceVerifyResult> {
  const { basePath, checkDirectories = true } = options ?? {};
  const start = performance.now();
  const ref: ExtractedReference = { type: 'file-path', value: filePath, line: 0, column: 0 };

  try {
    // Dynamic import so the module doesn't hard-fail in non-Node environments
    const { access, stat } = await import('node:fs/promises');
    const { resolve, isAbsolute } = await import('node:path');

    const resolvedPath = isAbsolute(filePath) ? filePath : resolve(basePath ?? process.cwd(), filePath);

    await access(resolvedPath);
    const stats = await stat(resolvedPath);

    if (!checkDirectories && stats.isDirectory()) {
      return {
        reference: ref,
        exists: false,
        error: 'Path is a directory (checkDirectories=false)',
        durationMs: performance.now() - start,
      };
    }

    return {
      reference: ref,
      exists: true,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reference: ref,
      exists: false,
      error: message.includes('ENOENT') ? 'File not found' : message,
      durationMs: performance.now() - start,
    };
  }
}

/**
 * Verify a GitHub repository exists via the API.
 */
export async function verifyGitHubRepo(
  repoSlug: string,
  options?: UrlVerifyOptions
): Promise<ReferenceVerifyResult> {
  const url = `https://api.github.com/repos/${repoSlug}`;
  const result = await verifyUrl(url, {
    ...options,
    userAgent: options?.userAgent ?? 'agent-eval/0.1 github-checker',
  });
  result.reference = { type: 'github-repo', value: repoSlug, line: 0, column: 0 };
  return result;
}

/**
 * Verify a GitHub issue/PR exists via the API.
 */
export async function verifyGitHubIssue(
  issueRef: string,
  options?: UrlVerifyOptions
): Promise<ReferenceVerifyResult> {
  // Parse "org/repo#123" format
  const match = issueRef.match(/^(.+?)#(\d+)$/);
  if (!match) {
    return {
      reference: { type: 'github-issue', value: issueRef, line: 0, column: 0 },
      exists: false,
      error: 'Invalid issue reference format (expected "owner/repo#number")',
      durationMs: 0,
    };
  }

  const [, repo, number] = match;
  const url = `https://api.github.com/repos/${repo}/issues/${number}`;
  const result = await verifyUrl(url, {
    ...options,
    userAgent: options?.userAgent ?? 'agent-eval/0.1 github-checker',
  });
  result.reference = { type: 'github-issue', value: issueRef, line: 0, column: 0 };
  return result;
}

// ─── BATCH VERIFICATION ─────────────────────────────────────────────────────────

/** Options for batch verification. */
export interface BatchVerifyOptions {
  /** Maximum concurrent verifications. Default: 5. */
  concurrency?: number;
  /** URL verification options. */
  urlOptions?: UrlVerifyOptions;
  /** File path verification options. */
  fileOptions?: FilePathVerifyOptions;
}

/**
 * Verify multiple references concurrently with controlled parallelism.
 */
export async function verifyReferences(
  refs: ExtractedReference[],
  options?: BatchVerifyOptions
): Promise<ReferenceVerifyResult[]> {
  const { concurrency = 5, urlOptions, fileOptions } = options ?? {};
  const results: ReferenceVerifyResult[] = [];

  // Process in batches
  for (let i = 0; i < refs.length; i += concurrency) {
    const batch = refs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(ref => verifySingleReference(ref, urlOptions, fileOptions))
    );
    results.push(...batchResults);
  }

  return results;
}

async function verifySingleReference(
  ref: ExtractedReference,
  urlOptions?: UrlVerifyOptions,
  fileOptions?: FilePathVerifyOptions
): Promise<ReferenceVerifyResult> {
  switch (ref.type) {
    case 'url':
      return verifyUrl(ref.value, urlOptions);
    case 'file-path':
      return verifyFilePath(ref.value, fileOptions);
    case 'github-repo':
      return verifyGitHubRepo(ref.value, urlOptions);
    case 'github-issue':
      return verifyGitHubIssue(ref.value, urlOptions);
    default:
      return {
        reference: ref,
        exists: false,
        error: `Unknown reference type: ${(ref as ExtractedReference).type}`,
        durationMs: 0,
      };
  }
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that all URLs in the output are reachable.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toHaveValidUrls()]
 * ```
 */
export function toHaveValidUrls(options?: UrlVerifyOptions & { maxInvalid?: number }): Assertion {
  const { maxInvalid = 0, ...urlOpts } = options ?? {};
  return {
    name: 'has valid URLs',
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls: true,
        checkFilePaths: false,
        checkGitHub: false,
      });

      if (refs.length === 0) {
        return {
          status: 'pass',
          name: 'has valid URLs',
          message: 'No URLs found in output',
          durationMs: performance.now() - start,
        };
      }

      const results = await verifyReferences(refs, { urlOptions: urlOpts });
      const invalid = results.filter(r => !r.exists);
      const pass = invalid.length <= maxInvalid;

      return {
        status: pass ? 'pass' : 'fail',
        name: 'has valid URLs',
        message: pass
          ? `All ${results.length} URLs verified`
          : `${invalid.length} invalid URL(s) found`,
        evidence: invalid.length > 0
          ? invalid.map(r => `  ✗ ${r.reference.value} — ${r.error ?? 'unreachable'}`).join('\n')
          : undefined,
        expected: `≤${maxInvalid} invalid URLs`,
        actual: `${invalid.length} invalid of ${results.length} total`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that all file paths referenced in the output exist.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toHaveValidPaths({ basePath: './project' })]
 * ```
 */
export function toHaveValidPaths(options?: FilePathVerifyOptions & { maxInvalid?: number }): Assertion {
  const { maxInvalid = 0, ...fileOpts } = options ?? {};
  return {
    name: 'has valid file paths',
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls: false,
        checkFilePaths: true,
        checkGitHub: false,
      });

      if (refs.length === 0) {
        return {
          status: 'pass',
          name: 'has valid file paths',
          message: 'No file paths found in output',
          durationMs: performance.now() - start,
        };
      }

      const results = await verifyReferences(refs, { fileOptions: fileOpts });
      const invalid = results.filter(r => !r.exists);
      const pass = invalid.length <= maxInvalid;

      return {
        status: pass ? 'pass' : 'fail',
        name: 'has valid file paths',
        message: pass
          ? `All ${results.length} file paths verified`
          : `${invalid.length} invalid path(s) found`,
        evidence: invalid.length > 0
          ? invalid.map(r => `  ✗ ${r.reference.value} — ${r.error ?? 'not found'}`).join('\n')
          : undefined,
        expected: `≤${maxInvalid} invalid paths`,
        actual: `${invalid.length} invalid of ${results.length} total`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that all GitHub references (repos, issues/PRs) in the output are valid.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toHaveValidGitHubRefs()]
 * ```
 */
export function toHaveValidGitHubRefs(options?: UrlVerifyOptions & { maxInvalid?: number }): Assertion {
  const { maxInvalid = 0, ...urlOpts } = options ?? {};
  return {
    name: 'has valid GitHub references',
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls: false,
        checkFilePaths: false,
        checkGitHub: true,
      });

      // Re-check URLs that are GitHub URLs
      const urlRefs = extractReferences(output, {
        checkUrls: true,
        checkFilePaths: false,
        checkGitHub: true,
      }).filter(r => r.type === 'github-repo' || r.type === 'github-issue');

      const allRefs = [...refs, ...urlRefs];
      // Deduplicate
      const unique = allRefs.filter(
        (ref, idx, arr) => arr.findIndex(r => r.value === ref.value) === idx
      );

      if (unique.length === 0) {
        return {
          status: 'pass',
          name: 'has valid GitHub references',
          message: 'No GitHub references found in output',
          durationMs: performance.now() - start,
        };
      }

      const results = await verifyReferences(unique, { urlOptions: urlOpts });
      const invalid = results.filter(r => !r.exists);
      const pass = invalid.length <= maxInvalid;

      return {
        status: pass ? 'pass' : 'fail',
        name: 'has valid GitHub references',
        message: pass
          ? `All ${results.length} GitHub references verified`
          : `${invalid.length} invalid reference(s) found`,
        evidence: invalid.length > 0
          ? invalid.map(r => `  ✗ ${r.reference.value} — ${r.error ?? 'not found'}`).join('\n')
          : undefined,
        expected: `≤${maxInvalid} invalid references`,
        actual: `${invalid.length} invalid of ${results.length} total`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that all references (URLs, paths, GitHub) in the output are valid.
 * Combined check that runs all verifiers.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toHaveValidReferences({ checkUrls: true, checkFilePaths: true })]
 * ```
 */
export function toHaveValidReferences(options?: PathVerifyOptions): Assertion {
  const {
    checkUrls = true,
    checkFilePaths = true,
    checkGitHub = true,
    urlOptions,
    fileOptions,
    maxInvalid = 0,
    excludePatterns,
  } = options ?? {};

  return {
    name: 'has valid references',
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls,
        checkFilePaths,
        checkGitHub,
        excludePatterns,
      });

      if (refs.length === 0) {
        return {
          status: 'pass',
          name: 'has valid references',
          message: 'No references found in output',
          durationMs: performance.now() - start,
        };
      }

      const results = await verifyReferences(refs, { urlOptions, fileOptions });
      const invalid = results.filter(r => !r.exists);
      const pass = invalid.length <= maxInvalid;

      const summary = [
        `URLs: ${results.filter(r => r.reference.type === 'url').length}`,
        `Paths: ${results.filter(r => r.reference.type === 'file-path').length}`,
        `GitHub: ${results.filter(r => r.reference.type.startsWith('github')).length}`,
      ].join(', ');

      return {
        status: pass ? 'pass' : 'fail',
        name: 'has valid references',
        message: pass
          ? `All ${results.length} references verified (${summary})`
          : `${invalid.length} invalid reference(s) found (${summary})`,
        evidence: invalid.length > 0
          ? invalid.map(r => `  ✗ [${r.reference.type}] ${r.reference.value} — ${r.error ?? 'invalid'}`).join('\n')
          : undefined,
        expected: `≤${maxInvalid} invalid references`,
        actual: `${invalid.length} invalid of ${results.length} total`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that specific URLs are found AND reachable in the output.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toReferenceUrls(['https://docs.example.com/api'])]
 * ```
 */
export function toReferenceUrls(expectedUrls: string[], options?: UrlVerifyOptions): Assertion {
  return {
    name: `references expected URLs (${expectedUrls.length})`,
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const missing: string[] = [];
      const unreachable: Array<{ url: string; error: string }> = [];

      for (const url of expectedUrls) {
        if (!output.includes(url)) {
          missing.push(url);
        } else {
          const result = await verifyUrl(url, options);
          if (!result.exists) {
            unreachable.push({ url, error: result.error ?? 'unreachable' });
          }
        }
      }

      const pass = missing.length === 0 && unreachable.length === 0;
      const evidence: string[] = [];
      if (missing.length > 0) {
        evidence.push('Missing from output:');
        evidence.push(...missing.map(u => `  ✗ ${u}`));
      }
      if (unreachable.length > 0) {
        evidence.push('Found but unreachable:');
        evidence.push(...unreachable.map(u => `  ✗ ${u.url} — ${u.error}`));
      }

      return {
        status: pass ? 'pass' : 'fail',
        name: `references expected URLs (${expectedUrls.length})`,
        message: pass
          ? `All ${expectedUrls.length} expected URLs present and reachable`
          : `${missing.length} missing, ${unreachable.length} unreachable`,
        evidence: evidence.length > 0 ? evidence.join('\n') : undefined,
        expected: `All ${expectedUrls.length} URLs present and reachable`,
        actual: `${missing.length} missing, ${unreachable.length} unreachable`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output does NOT contain any broken/invalid URLs.
 * Unlike toHaveValidUrls which checks reachability, this only checks URL format validity.
 *
 * @tier 1 — Deterministic
 */
export function toHaveWellFormedUrls(): Assertion {
  return {
    name: 'has well-formed URLs',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls: true,
        checkFilePaths: false,
        checkGitHub: false,
      });

      const malformed: Array<{ url: string; reason: string }> = [];

      for (const ref of refs) {
        try {
          const parsed = new URL(ref.value);
          // Check for obviously broken URLs
          if (!parsed.hostname || parsed.hostname.length < 2) {
            malformed.push({ url: ref.value, reason: 'missing or invalid hostname' });
          } else if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
            malformed.push({ url: ref.value, reason: 'hostname has no TLD' });
          }
        } catch {
          malformed.push({ url: ref.value, reason: 'invalid URL syntax' });
        }
      }

      const pass = malformed.length === 0;

      return {
        status: pass ? 'pass' : 'fail',
        name: 'has well-formed URLs',
        message: pass
          ? `All ${refs.length} URLs are well-formed`
          : `${malformed.length} malformed URL(s) found`,
        evidence: malformed.length > 0
          ? malformed.map(m => `  ✗ ${m.url} — ${m.reason}`).join('\n')
          : undefined,
        expected: '0 malformed URLs',
        actual: `${malformed.length} malformed`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that expected file paths are referenced in the output.
 *
 * @tier 1 — Deterministic
 */
export function toReferencePaths(
  expectedPaths: string[],
  options?: FilePathVerifyOptions
): Assertion {
  return {
    name: `references expected paths (${expectedPaths.length})`,
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const missing: string[] = [];
      const notFound: Array<{ path: string; error: string }> = [];

      for (const path of expectedPaths) {
        if (!output.includes(path)) {
          missing.push(path);
        } else {
          const result = await verifyFilePath(path, options);
          if (!result.exists) {
            notFound.push({ path, error: result.error ?? 'not found' });
          }
        }
      }

      const pass = missing.length === 0 && notFound.length === 0;
      const evidence: string[] = [];
      if (missing.length > 0) {
        evidence.push('Missing from output:');
        evidence.push(...missing.map(p => `  ✗ ${p}`));
      }
      if (notFound.length > 0) {
        evidence.push('Referenced but not found on disk:');
        evidence.push(...notFound.map(p => `  ✗ ${p.path} — ${p.error}`));
      }

      return {
        status: pass ? 'pass' : 'fail',
        name: `references expected paths (${expectedPaths.length})`,
        message: pass
          ? `All ${expectedPaths.length} expected paths present and verified`
          : `${missing.length} missing, ${notFound.length} not found`,
        evidence: evidence.length > 0 ? evidence.join('\n') : undefined,
        expected: `All ${expectedPaths.length} paths present and exist`,
        actual: `${missing.length} missing, ${notFound.length} not found`,
        durationMs: performance.now() - start,
      };
    },
  };
}
