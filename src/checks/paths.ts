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
 * This file is the **public barrel** for the path check and the home of the
 * assertion factories that compose reference extraction + verification into
 * Jest/Vitest-style assertions. The supporting seams live alongside it and are
 * re-exported here so the public surface stays a single `./paths.js` import path:
 * - `./paths-types.js`        — the type vocabulary (references, verify results, options)
 * - `./paths-extraction.js`   — text → URL / path / GitHub reference extraction
 * - `./paths-verification.js` — reference → exists? (HTTP / filesystem / GitHub API) + batch
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  UrlVerifyOptions,
  FilePathVerifyOptions,
  PathVerifyOptions,
} from './paths-types.js';
import { extractReferences } from './paths-extraction.js';
import { verifyUrl, verifyFilePath, verifyReferences } from './paths-verification.js';

// ─── TYPE RE-EXPORTS ────────────────────────────────
// The path type vocabulary lives in ./paths-types.js; re-export it here so
// consumers keep a single `./paths.js` import path.
export type {
  ExtractedReference,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  ReferenceVerifyResult,
  PathVerifyOptions,
  BatchVerifyOptions,
} from './paths-types.js';

// ─── EXTRACTION RE-EXPORTS ──────────────────────────
// The text → references half (URL/path/GitHub patterns + line scanner) lives alongside.
export { PATH_EXTENSIONS, GITHUB_REPO_REGEX, extractReferences } from './paths-extraction.js';

// ─── VERIFICATION RE-EXPORTS ────────────────────────
// The reference → exists? engine (HTTP / filesystem / GitHub API + batch) lives alongside.
export {
  verifyUrl,
  verifyFilePath,
  verifyGitHubRepo,
  verifyGitHubIssue,
  verifyReferences,
} from './paths-verification.js';

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
