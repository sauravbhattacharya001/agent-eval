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
 * This file is the **public barrel** for the path check. The supporting seams
 * live alongside it and are re-exported here so the public surface stays a
 * single `./paths.js` import path:
 * - `./paths-types.js`        — the type vocabulary (references, verify results, options)
 * - `./paths-extraction.js`   — text → URL / path / GitHub reference extraction
 * - `./paths-verification.js` — reference → exists? (HTTP / filesystem / GitHub API) + batch
 * - `./paths-assertions.js`   — the Jest/Vitest-style assertion factories
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

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

// ─── ASSERTION-FACTORY RE-EXPORTS ───────────────────
// The Jest/Vitest-style assertion factories that compose extraction +
// verification live in ./paths-assertions.js.
export {
  toHaveValidUrls,
  toHaveValidPaths,
  toHaveValidGitHubRefs,
  toHaveValidReferences,
  toReferenceUrls,
  toHaveWellFormedUrls,
  toReferencePaths,
} from './paths-assertions.js';
