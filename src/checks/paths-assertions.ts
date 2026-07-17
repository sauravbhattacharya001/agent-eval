/**
 * Path/URL Verifier — assertion factories (Tier 1 Deterministic Check)
 *
 * The Jest/Vitest-style assertion factories that compose reference extraction
 * (`./paths-extraction.js`) + verification (`./paths-verification.js`) into
 * pass/fail assertions. Split out of `paths.ts` so the barrel stays thin and
 * the four "extract → verify → count invalid" assertions share one internal
 * scaffold instead of repeating it. Re-exported through `./paths.js`.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  ExtractedReference,
  ReferenceVerifyResult,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  PathVerifyOptions,
} from './paths-types.js';
import { extractReferences } from './paths-extraction.js';
import { verifyUrl, verifyFilePath, verifyReferences } from './paths-verification.js';

// ─── SHARED SCAFFOLD ────────────────────────────────────────────────────────────

/**
 * Build the pass/fail assertion result shared by the "extract → verify → count
 * invalid" assertions (`toHaveValidUrls`, `toHaveValidPaths`,
 * `toHaveValidGitHubRefs`, `toHaveValidReferences`).
 *
 * Behaviour is identical to the previous inline copies; this only removes the
 * duplication. Each caller supplies its own name, the noun for messages, and an
 * optional evidence/summary formatter so wording is preserved exactly.
 */
function buildRefAssertionResult(params: {
  name: string;
  start: number;
  results: ReferenceVerifyResult[];
  maxInvalid: number;
  /** Message noun, e.g. 'URLs', 'file paths', 'GitHub references', 'references'. */
  noun: string;
  /** Optional trailing summary appended to the message, e.g. '(URLs: 1, ...)'. */
  summary?: string;
  /** Formats one invalid result into an evidence line. */
  evidenceLine: (r: ReferenceVerifyResult) => string;
  /** Message noun used in the failure count, e.g. 'URL(s)', 'path(s)'. */
  invalidNoun: string;
  /** Word used in expected/actual, e.g. 'URLs', 'paths', 'references'. */
  countNoun: string;
}): AssertionResult {
  const { name, start, results, maxInvalid, noun, summary, evidenceLine, invalidNoun, countNoun } =
    params;
  const invalid = results.filter(r => !r.exists);
  const pass = invalid.length <= maxInvalid;
  const suffix = summary ? ` (${summary})` : '';

  return {
    status: pass ? 'pass' : 'fail',
    name,
    message: pass
      ? `All ${results.length} ${noun} verified${suffix}`
      : `${invalid.length} invalid ${invalidNoun} found${suffix}`,
    evidence: invalid.length > 0 ? invalid.map(evidenceLine).join('\n') : undefined,
    expected: `≤${maxInvalid} invalid ${countNoun}`,
    actual: `${invalid.length} invalid of ${results.length} total`,
    durationMs: performance.now() - start,
  };
}

/** The "no references found → pass" early-out shared by the count-invalid assertions. */
function emptyPass(name: string, noun: string, start: number): AssertionResult {
  return {
    status: 'pass',
    name,
    message: `No ${noun} found in output`,
    durationMs: performance.now() - start,
  };
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
  const name = 'has valid URLs';
  return {
    name,
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls: true,
        checkFilePaths: false,
        checkGitHub: false,
      });

      if (refs.length === 0) return emptyPass(name, 'URLs', start);

      const results = await verifyReferences(refs, { urlOptions: urlOpts });
      return buildRefAssertionResult({
        name,
        start,
        results,
        maxInvalid,
        noun: 'URLs',
        invalidNoun: 'URL(s)',
        countNoun: 'URLs',
        evidenceLine: r => `  ✗ ${r.reference.value} — ${r.error ?? 'unreachable'}`,
      });
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
export function toHaveValidPaths(
  options?: FilePathVerifyOptions & { maxInvalid?: number }
): Assertion {
  const { maxInvalid = 0, ...fileOpts } = options ?? {};
  const name = 'has valid file paths';
  return {
    name,
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls: false,
        checkFilePaths: true,
        checkGitHub: false,
      });

      if (refs.length === 0) return emptyPass(name, 'file paths', start);

      const results = await verifyReferences(refs, { fileOptions: fileOpts });
      return buildRefAssertionResult({
        name,
        start,
        results,
        maxInvalid,
        noun: 'file paths',
        invalidNoun: 'path(s)',
        countNoun: 'paths',
        evidenceLine: r => `  ✗ ${r.reference.value} — ${r.error ?? 'not found'}`,
      });
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
export function toHaveValidGitHubRefs(
  options?: UrlVerifyOptions & { maxInvalid?: number }
): Assertion {
  const { maxInvalid = 0, ...urlOpts } = options ?? {};
  const name = 'has valid GitHub references';
  return {
    name,
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

      if (unique.length === 0) return emptyPass(name, 'GitHub references', start);

      const results = await verifyReferences(unique, { urlOptions: urlOpts });
      return buildRefAssertionResult({
        name,
        start,
        results,
        maxInvalid,
        noun: 'GitHub references',
        invalidNoun: 'reference(s)',
        countNoun: 'references',
        evidenceLine: r => `  ✗ ${r.reference.value} — ${r.error ?? 'not found'}`,
      });
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
  const name = 'has valid references';

  return {
    name,
    async evaluate(output: string): Promise<AssertionResult> {
      const start = performance.now();
      const refs = extractReferences(output, {
        checkUrls,
        checkFilePaths,
        checkGitHub,
        excludePatterns,
      });

      if (refs.length === 0) return emptyPass(name, 'references', start);

      const results = await verifyReferences(refs, { urlOptions, fileOptions });
      const summary = [
        `URLs: ${results.filter(r => r.reference.type === 'url').length}`,
        `Paths: ${results.filter(r => r.reference.type === 'file-path').length}`,
        `GitHub: ${results.filter(r => r.reference.type.startsWith('github')).length}`,
      ].join(', ');

      return buildRefAssertionResult({
        name,
        start,
        results,
        maxInvalid,
        noun: 'references',
        summary,
        invalidNoun: 'reference(s)',
        countNoun: 'references',
        evidenceLine: r =>
          `  ✗ [${r.reference.type}] ${r.reference.value} — ${r.error ?? 'invalid'}`,
      });
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

// re-export the ExtractedReference type consumers of this leaf may want inline
export type { ExtractedReference };
