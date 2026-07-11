/**
 * Direct tests for two previously-untested exported symbols:
 *   - detectStub          (src/checks/completeness-analysis.ts)
 *   - verifyGitHubRepo    (src/checks/paths-verification.ts)
 *
 * Both are public exports (re-exported through the checks barrels) but were only
 * exercised INDIRECTLY (detectStub via checkCompleteness; verifyGitHubRepo not at
 * all). These pin their behaviour directly so a regression in the stub-pattern
 * table or the GitHub-repo URL/reference shaping is caught at the seam.
 *
 * @tier 1 — Deterministic
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { detectStub } from '../src/checks/completeness-analysis.js';
import { verifyGitHubRepo } from '../src/checks/paths-verification.js';

// ─── detectStub (pure, no IO) ───────────────────────────────────────────────

describe('detectStub', () => {
  it('flags very short output as a stub', () => {
    expect(detectStub('too short')).toBe(true);
  });

  it('does not flag a deliberate short answer (yes/no/number)', () => {
    expect(detectStub('yes')).toBe(false);
    expect(detectStub('No')).toBe(false);
    expect(detectStub('TRUE')).toBe(false);
    expect(detectStub('42')).toBe(false);
  });

  it('flags a substantial but placeholder-y TODO line', () => {
    expect(detectStub('TODO: implement this whole feature later on')).toBe(true);
  });

  it('flags "lorem ipsum" filler that is long enough to pass the length gate', () => {
    expect(detectStub('lorem ipsum dolor sit amet consectetur adipiscing')).toBe(true);
  });

  it('flags a refusal stub', () => {
    expect(detectStub("I cannot help with that particular request today")).toBe(true);
    expect(detectStub("I'm sorry, but I am not able to assist here")).toBe(true);
  });

  it('flags an ellipsis-only line', () => {
    expect(detectStub('..........')).toBe(true);
  });

  it('does not flag genuine substantial prose', () => {
    const text =
      'The function parses the transcript, extracts each tool call, and scores ' +
      'the run against the Tier 1 deterministic checks before returning a report.';
    expect(detectStub(text)).toBe(false);
  });

  it('honours caller-supplied extra patterns', () => {
    const text = 'This looks like a perfectly ordinary sentence with substance.';
    expect(detectStub(text)).toBe(false);
    expect(detectStub(text, [/ordinary sentence/])).toBe(true);
  });

  it('does not throw and returns a boolean for empty input', () => {
    expect(detectStub('')).toBe(true);
  });
});

// ─── verifyGitHubRepo (delegates to fetch → mock global.fetch) ──────────────

describe('verifyGitHubRepo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the GitHub repos API URL and reports existence on 200', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyGitHubRepo('octocat/Hello-World');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toBe('https://api.github.com/repos/octocat/Hello-World');
    expect(result.exists).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('stamps a github-repo reference regardless of outcome', async () => {
    const fetchMock = vi.fn(async () => ({ status: 404 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyGitHubRepo('nope/does-not-exist');

    expect(result.reference).toEqual({
      type: 'github-repo',
      value: 'nope/does-not-exist',
      line: 0,
      column: 0,
    });
    expect(result.exists).toBe(false);
    expect(result.error).toBe('HTTP 404');
  });

  it('sends the github-checker User-Agent by default', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await verifyGitHubRepo('octocat/Hello-World');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toBe('agent-eval/0.1 github-checker');
  });

  it('lets a caller override the User-Agent', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await verifyGitHubRepo('octocat/Hello-World', { userAgent: 'custom-ua/9.9' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toBe('custom-ua/9.9');
  });
});
