/**
 * Tests for Path/URL Verifier (src/checks/paths.ts)
 *
 * Tests extraction, URL format validation, file path verification,
 * and assertion factories.
 */

import { describe, it, expect } from 'vitest';
import {
  extractReferences,
  verifyFilePath,
  verifyUrl,
  verifyGitHubIssue,
  verifyReferences,
  toHaveValidUrls,
  toHaveValidPaths,
  toHaveValidGitHubRefs,
  toHaveValidReferences,
  toReferenceUrls,
  toHaveWellFormedUrls,
  toReferencePaths,
} from '../src/checks/paths.js';
import type { ExtractedReference } from '../src/checks/paths.js';

// ─── EXTRACTION TESTS ───────────────────────────────────────────────────────────

describe('extractReferences', () => {
  describe('URL extraction', () => {
    it('extracts HTTP URLs', () => {
      const text = 'Visit http://example.com for info';
      const refs = extractReferences(text);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('url');
      expect(refs[0].value).toBe('http://example.com');
      expect(refs[0].line).toBe(1);
    });

    it('extracts HTTPS URLs', () => {
      const text = 'See https://docs.example.com/api/v2/users?page=1';
      const refs = extractReferences(text);
      expect(refs).toHaveLength(1);
      expect(refs[0].value).toBe('https://docs.example.com/api/v2/users?page=1');
    });

    it('extracts multiple URLs', () => {
      const text = `
Check https://example.com and also
http://another.org/path for details.
      `;
      const refs = extractReferences(text, { checkFilePaths: false });
      const urls = refs.filter(r => r.type === 'url');
      expect(urls).toHaveLength(2);
    });

    it('strips trailing punctuation from URLs', () => {
      const text = 'See https://example.com/path.';
      const refs = extractReferences(text, { checkFilePaths: false });
      expect(refs[0].value).toBe('https://example.com/path');
    });

    it('strips trailing parenthesis from URLs', () => {
      const text = '(link: https://example.com/page)';
      const refs = extractReferences(text, { checkFilePaths: false });
      expect(refs[0].value).toBe('https://example.com/page');
    });

    it('deduplicates repeated URLs', () => {
      const text = `
https://example.com/page
https://example.com/page
      `;
      const refs = extractReferences(text, { checkFilePaths: false });
      expect(refs).toHaveLength(1);
    });

    it('records correct line numbers', () => {
      const text = `line 1
https://first.com on line 2
line 3
https://second.com on line 4`;
      const refs = extractReferences(text, { checkFilePaths: false });
      expect(refs[0].line).toBe(2);
      expect(refs[1].line).toBe(4);
    });
  });

  describe('file path extraction', () => {
    it('extracts relative paths with extensions', () => {
      const text = 'Edit src/core/runner.ts for changes';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths.some(p => p.value.includes('src/core/runner.ts'))).toBe(true);
    });

    it('extracts dot-relative paths', () => {
      const text = 'Run ./scripts/build.sh to compile';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.some(p => p.value.includes('./scripts/build.sh'))).toBe(true);
    });

    it('extracts parent-relative paths', () => {
      const text = 'Import from ../utils/helpers.ts';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.some(p => p.value.includes('../utils/helpers.ts'))).toBe(true);
    });

    it('extracts absolute Unix paths', () => {
      const text = 'File at /etc/nginx/nginx.config';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.some(p => p.value.includes('/etc/nginx/nginx.config'))).toBe(true);
    });

    it('extracts Windows-style paths', () => {
      const text = 'Located at C:\\Users\\dev\\project\\src\\index.ts';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.some(p => p.value.includes('C:\\Users\\dev\\project\\src\\index.ts'))).toBe(true);
    });

    it('does not extract URLs as file paths', () => {
      const text = 'Visit https://example.com/path.html for docs';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.every(p => !p.value.startsWith('http'))).toBe(true);
    });

    it('extracts common filename extensions', () => {
      const text = 'Check package.json and tsconfig.json';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      const paths = refs.filter(r => r.type === 'file-path');
      expect(paths.some(p => p.value === 'package.json')).toBe(true);
      expect(paths.some(p => p.value === 'tsconfig.json')).toBe(true);
    });
  });

  describe('GitHub reference extraction', () => {
    it('extracts GitHub repo URLs', () => {
      const text = 'See https://github.com/anthropics/claude-code-action for the source';
      const refs = extractReferences(text);
      const ghRefs = refs.filter(r => r.type === 'github-repo');
      expect(ghRefs).toHaveLength(1);
      expect(ghRefs[0].value).toBe('anthropics/claude-code-action');
    });

    it('extracts GitHub issue URLs', () => {
      const text = 'Related to https://github.com/anthropics/claude-code-action/issues/1368';
      const refs = extractReferences(text);
      const ghRefs = refs.filter(r => r.type === 'github-issue');
      expect(ghRefs).toHaveLength(1);
      expect(ghRefs[0].value).toBe('anthropics/claude-code-action#1368');
    });

    it('extracts GitHub PR URLs', () => {
      const text = 'Fix in https://github.com/owner/repo/pull/42';
      const refs = extractReferences(text);
      const ghRefs = refs.filter(r => r.type === 'github-issue');
      expect(ghRefs).toHaveLength(1);
      expect(ghRefs[0].value).toBe('owner/repo#42');
    });
  });

  describe('options', () => {
    it('respects checkUrls=false', () => {
      const text = 'Visit https://example.com and src/index.ts';
      const refs = extractReferences(text, { checkUrls: false, checkGitHub: false });
      expect(refs.every(r => r.type !== 'url')).toBe(true);
    });

    it('respects checkFilePaths=false', () => {
      const text = 'Check src/index.ts and package.json';
      const refs = extractReferences(text, { checkFilePaths: false });
      expect(refs.every(r => r.type !== 'file-path')).toBe(true);
    });

    it('respects excludePatterns', () => {
      const text = `
https://example.com/ok
https://internal.corp/skip
src/index.ts
      `;
      const refs = extractReferences(text, {
        excludePatterns: [/internal\.corp/],
      });
      expect(refs.some(r => r.value.includes('internal.corp'))).toBe(false);
      expect(refs.some(r => r.value.includes('example.com'))).toBe(true);
    });
  });
});

// ─── VERIFICATION TESTS ─────────────────────────────────────────────────────────

describe('verifyFilePath', () => {
  it('verifies existing file returns exists=true', async () => {
    // package.json exists in the project root
    const result = await verifyFilePath('package.json', {
      basePath: process.cwd(),
    });
    expect(result.exists).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('verifies non-existent file returns exists=false', async () => {
    const result = await verifyFilePath('definitely-not-a-real-file-xyz.ts', {
      basePath: process.cwd(),
    });
    expect(result.exists).toBe(false);
    expect(result.error).toBe('File not found');
  });

  it('verifies existing directory', async () => {
    const result = await verifyFilePath('src', {
      basePath: process.cwd(),
      checkDirectories: true,
    });
    expect(result.exists).toBe(true);
  });

  it('rejects directory when checkDirectories=false', async () => {
    const result = await verifyFilePath('src', {
      basePath: process.cwd(),
      checkDirectories: false,
    });
    expect(result.exists).toBe(false);
    expect(result.error).toContain('directory');
  });
});

describe('verifyUrl', () => {
  it('handles timeout gracefully', async () => {
    // Use a non-routable IP to trigger timeout quickly
    const result = await verifyUrl('http://192.0.2.1/nothing', {
      timeoutMs: 100,
    });
    expect(result.exists).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('handles invalid URLs gracefully', async () => {
    const result = await verifyUrl('http://');
    expect(result.exists).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('verifyGitHubIssue', () => {
  it('rejects invalid format', async () => {
    const result = await verifyGitHubIssue('invalid-format');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Invalid issue reference format');
  });
});

describe('verifyReferences', () => {
  it('processes empty array', async () => {
    const results = await verifyReferences([]);
    expect(results).toHaveLength(0);
  });

  it('processes file paths in batch', async () => {
    const refs: ExtractedReference[] = [
      { type: 'file-path', value: 'package.json', line: 1, column: 1 },
      { type: 'file-path', value: 'nonexistent-file.xyz', line: 2, column: 1 },
    ];
    const results = await verifyReferences(refs, {
      fileOptions: { basePath: process.cwd() },
    });
    expect(results).toHaveLength(2);
    expect(results[0].exists).toBe(true);
    expect(results[1].exists).toBe(false);
  });

  it('respects concurrency limit', async () => {
    const refs: ExtractedReference[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'file-path' as const,
      value: `fake-file-${i}.ts`,
      line: i + 1,
      column: 1,
    }));
    const results = await verifyReferences(refs, { concurrency: 2 });
    expect(results).toHaveLength(10);
  });
});

// ─── ASSERTION FACTORY TESTS ────────────────────────────────────────────────────

describe('toHaveValidPaths', () => {
  it('passes when no file paths found', async () => {
    const assertion = toHaveValidPaths();
    const result = await assertion.evaluate('This text has no file paths at all');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('No file paths');
  });

  it('passes when referenced paths exist', async () => {
    const assertion = toHaveValidPaths({ basePath: process.cwd() });
    const result = await assertion.evaluate('Check package.json for config');
    expect(result.status).toBe('pass');
  });

  it('fails when referenced paths do not exist', async () => {
    const assertion = toHaveValidPaths({ basePath: process.cwd() });
    const result = await assertion.evaluate('Edit ./nonexistent/fake-module.ts now');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('fake-module.ts');
  });

  it('respects maxInvalid option', async () => {
    const assertion = toHaveValidPaths({ basePath: process.cwd(), maxInvalid: 5 });
    const result = await assertion.evaluate('Edit ./nonexistent/fake-module.ts now');
    expect(result.status).toBe('pass');
  });
});

describe('toHaveWellFormedUrls', () => {
  it('passes when no URLs found', () => {
    const assertion = toHaveWellFormedUrls();
    const result = assertion.evaluate('No links here');
    expect(result.status).toBe('pass');
  });

  it('passes for well-formed URLs', () => {
    const assertion = toHaveWellFormedUrls();
    const result = assertion.evaluate('See https://example.com/docs and http://api.test.org/v2');
    expect(result.status).toBe('pass');
  });

  it('fails for URLs with no hostname', () => {
    const assertion = toHaveWellFormedUrls();
    // This is hard to trigger via regex extraction (only valid-looking URLs get extracted),
    // so we test with a URL that has a very short hostname
    const result = assertion.evaluate('Visit https://x for info');
    // Single-char hostname with no TLD — should fail
    expect(result.status).toBe('fail');
  });
});

describe('toHaveValidUrls', () => {
  it('passes when no URLs in output', async () => {
    const assertion = toHaveValidUrls();
    const result = await assertion.evaluate('Just plain text here');
    expect(result.status).toBe('pass');
  });

  it('provides evidence for failures', async () => {
    const assertion = toHaveValidUrls({ timeoutMs: 500 });
    // Non-routable IP to ensure failure
    const result = await assertion.evaluate('Check http://192.0.2.1/nothing for details');
    expect(result.status).toBe('fail');
    expect(result.evidence).toBeDefined();
  });
});

describe('toHaveValidGitHubRefs', () => {
  it('passes when no GitHub references found', async () => {
    const assertion = toHaveValidGitHubRefs();
    const result = await assertion.evaluate('Plain text without any github links');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('No GitHub references');
  });
});

describe('toHaveValidReferences', () => {
  it('passes when no references found', async () => {
    const assertion = toHaveValidReferences();
    const result = await assertion.evaluate('Hello world');
    expect(result.status).toBe('pass');
  });

  it('checks only specified reference types', async () => {
    const assertion = toHaveValidReferences({
      checkUrls: false,
      checkFilePaths: true,
      checkGitHub: false,
    });
    // Only file paths will be checked
    const result = await assertion.evaluate(
      'See https://nonexistent.invalid and package.json'
    );
    // Should pass because URLs are not checked, and package.json exists
    expect(result.status).toBe('pass');
  });

  it('respects excludePatterns', async () => {
    const assertion = toHaveValidReferences({
      checkUrls: true,
      checkFilePaths: false,
      checkGitHub: false,
      excludePatterns: [/192\.0\.2/],
    });
    const result = await assertion.evaluate('Visit http://192.0.2.1/fake for info');
    expect(result.status).toBe('pass'); // excluded
  });
});

describe('toReferenceUrls', () => {
  it('fails when expected URL is not in output', async () => {
    const assertion = toReferenceUrls(['https://expected.example.com/page']);
    const result = await assertion.evaluate('No URLs here');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Missing from output');
    expect(result.evidence).toContain('https://expected.example.com/page');
  });
});

describe('toReferencePaths', () => {
  it('passes when expected paths are present and exist', async () => {
    const assertion = toReferencePaths(['package.json'], { basePath: process.cwd() });
    const result = await assertion.evaluate('Check the package.json file');
    expect(result.status).toBe('pass');
  });

  it('fails when expected path is missing from output', async () => {
    const assertion = toReferencePaths(['package.json'], { basePath: process.cwd() });
    const result = await assertion.evaluate('No references here');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Missing from output');
  });

  it('fails when path is referenced but does not exist', async () => {
    const assertion = toReferencePaths(['nonexistent-xyz.ts'], { basePath: process.cwd() });
    const result = await assertion.evaluate('Edit nonexistent-xyz.ts');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('not found');
  });
});
