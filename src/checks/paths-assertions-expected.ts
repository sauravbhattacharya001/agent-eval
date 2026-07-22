/**
 * Path/URL Verifier — expected-reference assertion factories (Tier 1 Deterministic Check)
 *
 * The "did the output reference *these specific* things (and are they valid)?"
 * assertions, plus the format-only well-formed-URL check. Unlike the
 * count-invalid factories in `./paths-assertions.js` (which discover references
 * in the output and count the broken ones), these are seeded with an explicit
 * expected list and check presence + validity. Split out of
 * `./paths-assertions.js` so each seam is a focused leaf; re-exported through
 * `./paths.js`. Behaviour is byte-for-byte identical to the previous inline
 * copies.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type { UrlVerifyOptions, FilePathVerifyOptions } from './paths-types.js';
import { extractReferences } from './paths-extraction.js';
import { verifyUrl, verifyFilePath } from './paths-verification.js';

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
