/**
 * Path/URL Verifier — type vocabulary (Tier 1 Deterministic Check)
 *
 * The reference/verification type vocabulary shared by the extraction,
 * verification, and assertion-factory seams of the path checker. Split out of
 * `paths.ts` so each seam imports its types from one place and the public
 * barrel stays a single `./paths.js` import path.
 *
 * @tier 1 — Deterministic
 * @module
 */

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
