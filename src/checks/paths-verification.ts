/**
 * Path/URL Verifier — reference verification (Tier 1 Deterministic Check)
 *
 * The `reference → exists?` half of the path checker: HTTP reachability for
 * URLs, filesystem existence for file paths, and GitHub repo/issue existence
 * via the API, plus the bounded-concurrency batch runner. All verifiers return
 * a result and never throw, so callers can aggregate failures.
 *
 * @tier 1 — Deterministic
 * @module
 */

import type {
  ExtractedReference,
  ReferenceVerifyResult,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  BatchVerifyOptions,
} from './paths-types.js';

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
