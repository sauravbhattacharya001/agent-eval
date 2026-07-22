/**
 * Path/URL Verifier — count-invalid assertion factories (Tier 1 Deterministic Check)
 *
 * The Jest/Vitest-style assertion factories that discover references in agent
 * output and count the broken ones. They compose reference extraction
 * (`./paths-extraction.js`) + verification (`./paths-verification.js`) via the
 * shared scaffold (`./paths-assertion-shell.js`). Split out of `paths.ts` so
 * the barrel stays thin; the "expected specific references" and format-only
 * assertions live alongside in `./paths-assertions-expected.js` and are
 * re-exported here so `./paths.js` keeps one import path.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  ExtractedReference,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  PathVerifyOptions,
} from './paths-types.js';
import { extractReferences } from './paths-extraction.js';
import { verifyReferences } from './paths-verification.js';
import { buildRefAssertionResult, emptyPass } from './paths-assertion-shell.js';

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

// ─── EXPECTED-REFERENCE FACTORIES (re-exported from sibling leaf) ─────────────────
// The "did the output reference *these specific* things?" + well-formed-URL
// assertions live in ./paths-assertions-expected.js; re-export so ./paths.js
// keeps a single import path.
export {
  toReferenceUrls,
  toHaveWellFormedUrls,
  toReferencePaths,
} from './paths-assertions-expected.js';

// re-export the ExtractedReference type consumers of this leaf may want inline
export type { ExtractedReference };
