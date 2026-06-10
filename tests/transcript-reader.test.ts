/**
 * Tests for the Transcript Reader - Phase 3.5 Tier 1 Production Monitoring
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
  parseTranscript,
  parseDuration,
  parseOutcome,
  extractTitle,
  extractSections,
  extractListItems,
  slugifyHeading,
  discoverTranscripts,
  loadTranscript,
  loadTranscripts,
  parseTranscriptFiles,
  rollingWindow,
  transcriptToTimeline,
} from '../src/monitoring/index.js';
import { detectTimeout, detectStaleness } from '../src/checks/staleness.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────

const SENTINEL_TRANSCRIPT = `# Sentinel Run - 2026-06-08 18:15 PT

## Task
Execute WinSentinel Builder sentinel run: pick 2 tasks from different lanes.

## Actions Taken
1. Read sentinel-task.md and worker-common.md for rules
2. Evaluated remaining Free lane tasks - F10/F13/F15-F18 already done
3. Identified F13 badge handler was only partially complete
4. Wrote HandleBadge method in \`ws-pub/src/WinSentinel.Cli/Program.cs\`
5. Built and verified: \`dotnet build\` 0 errors

## Key Outputs
- **Commit fd2f36a** (WinSentinel public): \`feat(cli): implement badge command handler (F13)\`
- **Commit 3069860** (winsentinel-pro private): \`feat(fleet): add alert webhook delivery system (C#10)\`
- Files changed: Program.cs, CliParser.cs, worker.mjs, schema.sql, worker.test.mjs

## Outcome
pass - both tasks fully implemented, tested, and pushed

## Errors & Retries
- Initial \`dotnet build --no-restore\` failed due to missing assets.json - ran restore first.
- Tests needed restore for WinSentinel.Tests.csproj - ran restore, 70/70 pass

## Duration
~15 minutes total
`;

const BUILDER_TRANSCRIPT = `# Builder Run - 2026-06-05 10:00 PT

## Task
Recurring cron (10 AM PT): Add a small/medium agentic feature to a random repo.

## Actions Taken
1. Selected target repo agentlens
2. Wrote part 6 of \`tool_dependency_advisor.py\`
3. Verified Python syntax with \`ast.parse()\` - passed
4. Wrote test file with 17 test cases

## Key Outputs
- Commit \`6f5c1ae\` feat: add ToolDependencyAdvisor
- New file: \`sdk/agentlens/tool_dependency_advisor.py\` (~900 lines)
- Modified: \`sdk/agentlens/__init__.py\` (added 12 exports)
- See https://github.com/sauravbhattacharya001/agentlens for details
- Closes #142

## Outcome
pass - Feature implemented, tested (17/17), committed, pushed.

## Errors & Retries
None.

## Duration
~8 minutes total
`;

const MINIMAL_TRANSCRIPT = `# Eval Run - 2026-06-09 12:00 PT
## Task
Trivial.
## Actions Taken
1. Did one thing
## Key Outputs
Done.
## Outcome
pass
## Errors & Retries
No errors
## Duration
2 minutes
`;

const PARTIAL_TRANSCRIPT = `# Gardener Run - 2026-06-08 09:00 PT

## Task
Pick 2 repos.

## Actions Taken
1. Picked repo A
2. Picked repo B - it was archived

## Key Outputs
- One repo updated
- One repo skipped

## Outcome
partial - one repo skipped due to archive

## Errors & Retries
- Archive 403 on push to repo B

## Duration
05:00 - 05:08 PT
`;

const FAILING_TRANSCRIPT = `# Tempcheck Run - 2026-06-07 13:00 PT

## Task
Check temperature.

## Actions Taken
- Tried to read sensor

## Key Outputs


## Outcome
fail - sensor unavailable

## Errors & Retries
Sensor read failed twice; gave up.

## Duration
45 seconds
`;

// ─── slugifyHeading ────────────────────────────────────────────────────────────

describe('slugifyHeading', () => {
  it('lowercases and dasherizes', () => {
    expect(slugifyHeading('Actions Taken')).toBe('actions-taken');
  });

  it('strips emoji and punctuation', () => {
    expect(slugifyHeading('🔥 Errors & Retries')).toBe('errors-and-retries');
  });

  it('collapses whitespace', () => {
    expect(slugifyHeading('Key   Outputs')).toBe('key-outputs');
  });

  it('handles unicode letters', () => {
    expect(slugifyHeading('Étape Une')).toBe('étape-une');
  });

  it('returns empty for empty input', () => {
    expect(slugifyHeading('')).toBe('');
  });
});

// ─── extractTitle ──────────────────────────────────────────────────────────────

describe('extractTitle', () => {
  it('finds the # heading at the top', () => {
    const lines = ['# My Title', '', '## Section'];
    expect(extractTitle(lines)).toBe('My Title');
  });

  it('skips leading blank lines', () => {
    const lines = ['', '', '# My Title'];
    expect(extractTitle(lines)).toBe('My Title');
  });

  it('returns empty string when no title is present', () => {
    expect(extractTitle(['## A section', 'body'])).toBe('');
  });

  it('returns empty when first non-blank line is body text', () => {
    expect(extractTitle(['some prose', '# Title'])).toBe('');
  });
});

// ─── extractSections ───────────────────────────────────────────────────────────

describe('extractSections', () => {
  it('extracts every ## section', () => {
    const lines = SENTINEL_TRANSCRIPT.split(/\r?\n/);
    const sections = extractSections(lines);
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual([
      'Task',
      'Actions Taken',
      'Key Outputs',
      'Outcome',
      'Errors & Retries',
      'Duration',
    ]);
  });

  it('captures section bodies trimmed of trailing whitespace', () => {
    const sections = extractSections(MINIMAL_TRANSCRIPT.split(/\r?\n/));
    const task = sections.find((s) => s.heading === 'Task');
    expect(task?.body).toBe('Trivial.');
  });

  it('records start/end line indices', () => {
    const sections = extractSections(SENTINEL_TRANSCRIPT.split(/\r?\n/));
    const first = sections[0]!;
    expect(first.startLine).toBeGreaterThan(0);
    expect(first.endLine).toBeGreaterThan(first.startLine);
  });

  it('handles deeper headings (### and below)', () => {
    const text = '# T\n## A\nbody\n### Sub\nmore body';
    const sections = extractSections(text.split('\n'));
    expect(sections.map((s) => s.depth)).toEqual([2, 3]);
  });

  it('returns empty array for input with no ## headings', () => {
    expect(extractSections(['# Just a title', 'body text'])).toEqual([]);
  });
});

// ─── extractListItems ──────────────────────────────────────────────────────────

describe('extractListItems', () => {
  it('extracts numbered items', () => {
    const items = extractListItems('1. First\n2. Second\n3. Third');
    expect(items).toEqual(['First', 'Second', 'Third']);
  });

  it('extracts bulleted items', () => {
    const items = extractListItems('- One\n* Two\n+ Three');
    expect(items).toEqual(['One', 'Two', 'Three']);
  });

  it('folds wrapped continuation lines into the previous item', () => {
    const items = extractListItems('1. First line\n   continued\n2. Second');
    expect(items[0]).toBe('First line continued');
    expect(items[1]).toBe('Second');
  });

  it('treats blank lines as item terminators', () => {
    const items = extractListItems('1. A\n\nNot a list');
    expect(items).toEqual(['A']);
  });

  it('returns empty for empty body', () => {
    expect(extractListItems('')).toEqual([]);
  });

  it('handles parenthesized numbering "1)"', () => {
    expect(extractListItems('1) Foo\n2) Bar')).toEqual(['Foo', 'Bar']);
  });
});

// ─── parseOutcome ──────────────────────────────────────────────────────────────

describe('parseOutcome', () => {
  it('detects pass', () => {
    expect(parseOutcome('pass - everything ok')).toBe('pass');
    expect(parseOutcome('Passed.')).toBe('pass');
    expect(parseOutcome('success')).toBe('pass');
  });

  it('detects fail', () => {
    expect(parseOutcome('fail - timed out')).toBe('fail');
    expect(parseOutcome('failure')).toBe('fail');
    expect(parseOutcome('crashed during step 3')).toBe('fail');
  });

  it('detects partial', () => {
    expect(parseOutcome('partial - one repo skipped')).toBe('partial');
    expect(parseOutcome('incomplete')).toBe('partial');
  });

  it('returns unknown for blank or weird input', () => {
    expect(parseOutcome('')).toBe('unknown');
    expect(parseOutcome('something happened')).toBe('unknown');
  });

  it('uses only the first non-blank line', () => {
    expect(parseOutcome('\n\nfail\nlater pass')).toBe('fail');
  });
});

// ─── parseDuration ─────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses bare minutes', () => {
    const d = parseDuration('15 minutes');
    expect(d.ms).toBe(15 * 60_000);
    expect(d.exact).toBe(true);
  });

  it('flags approximate durations', () => {
    const d = parseDuration('~15 minutes total');
    expect(d.ms).toBe(15 * 60_000);
    expect(d.exact).toBe(false);
  });

  it('parses combined hour/minute/second tokens', () => {
    const d = parseDuration('1h 23m 4s');
    expect(d.ms).toBe(1 * 3_600_000 + 23 * 60_000 + 4 * 1_000);
  });

  it('parses common abbreviations', () => {
    expect(parseDuration('45 sec').ms).toBe(45_000);
    expect(parseDuration('5 mins').ms).toBe(5 * 60_000);
    expect(parseDuration('2 hr').ms).toBe(2 * 3_600_000);
  });

  it('falls back to clock-time diff', () => {
    const d = parseDuration('18:00 - 18:14 PT');
    expect(d.ms).toBe(14 * 60_000);
  });

  it('handles cross-midnight clock diff', () => {
    const d = parseDuration('23:50 - 00:10 PT');
    expect(d.ms).toBe(20 * 60_000);
  });

  it('falls back to bare number assuming minutes', () => {
    const d = parseDuration('5');
    expect(d.ms).toBe(5 * 60_000);
    expect(d.exact).toBe(false);
  });

  it('returns NaN for empty body', () => {
    expect(Number.isNaN(parseDuration('').ms)).toBe(true);
  });

  it('returns NaN for non-numeric body', () => {
    expect(Number.isNaN(parseDuration('a long while').ms)).toBe(true);
  });

  it('preserves the raw string', () => {
    expect(parseDuration('~8 minutes total').raw).toBe('~8 minutes total');
  });
});

// ─── parseTranscript ───────────────────────────────────────────────────────────

describe('parseTranscript', () => {
  it('parses a full sentinel transcript', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'transcripts/sentinel/2026-06-08-1815.md',
    });
    expect(t.identity.worker).toBe('sentinel');
    expect(t.identity.date).toBe('2026-06-08');
    expect(t.identity.time).toBe('18:15');
    expect(t.identity.startedAt).toMatch(/^2026-06-08T18:15:00-0[78]:00$/);
    expect(Number.isFinite(t.identity.startedAtMs)).toBe(true);
    expect(t.title).toBe('Sentinel Run - 2026-06-08 18:15 PT');
    expect(t.outcome).toBe('pass');
    expect(t.task).toContain('WinSentinel Builder sentinel run');
    expect(t.actions).toContain('HandleBadge');
    expect(t.keyOutputs).toContain('fd2f36a');
    expect(t.actionItems.length).toBe(5);
    expect(t.duration.ms).toBe(15 * 60_000);
    expect(t.duration.exact).toBe(false);
    expect(t.endedAt).toBeDefined();
    expect(t.endedAtMs).toBe(t.identity.startedAtMs + 15 * 60_000);
    expect(t.hadErrors).toBe(true);
    expect(t.warnings).toEqual([]);
  });

  it('infers worker from filename parent directory', () => {
    const t = parseTranscript(BUILDER_TRANSCRIPT, {
      filename: '/abs/path/transcripts/builder/2026-06-05-1000.md',
    });
    expect(t.identity.worker).toBe('builder');
  });

  it('infers worker from title when no filename hint', () => {
    const t = parseTranscript(BUILDER_TRANSCRIPT);
    expect(t.identity.worker).toBe('builder');
  });

  it('honors explicit worker override', () => {
    const t = parseTranscript(MINIMAL_TRANSCRIPT, { worker: 'custom-worker' });
    expect(t.identity.worker).toBe('custom-worker');
  });

  it('warns when title is missing', () => {
    const t = parseTranscript('## Task\nbody');
    expect(t.warnings.some((w) => /title/i.test(w))).toBe(true);
  });

  it('warns when Task section is missing', () => {
    const t = parseTranscript('# Run Title');
    expect(t.warnings.some((w) => /Task/.test(w))).toBe(true);
  });

  it('warns on duplicate sections', () => {
    const t = parseTranscript('# Title\n## Task\nA\n## Task\nB');
    expect(t.warnings.some((w) => /[Dd]uplicate/.test(w))).toBe(true);
    expect(t.task).toBe('A');
  });

  it('warns on filename that does not match convention', () => {
    const t = parseTranscript(MINIMAL_TRANSCRIPT, { filename: 'random.md' });
    expect(t.warnings.some((w) => /filename/i.test(w))).toBe(true);
  });

  it('handles partial outcomes', () => {
    const t = parseTranscript(PARTIAL_TRANSCRIPT, {
      filename: 'transcripts/gardener/2026-06-08-0900.md',
    });
    expect(t.outcome).toBe('partial');
  });

  it('handles fail outcomes', () => {
    const t = parseTranscript(FAILING_TRANSCRIPT, {
      filename: 'transcripts/tempcheck/2026-06-07-1300.md',
    });
    expect(t.outcome).toBe('fail');
    expect(t.hadErrors).toBe(true);
  });

  it('returns hadErrors=false when errors body says "None"', () => {
    const t = parseTranscript(BUILDER_TRANSCRIPT, {
      filename: 'transcripts/builder/2026-06-05-1000.md',
    });
    expect(t.hadErrors).toBe(false);
    expect(t.outcome).toBe('pass');
  });

  it('records source path when provided', () => {
    const t = parseTranscript(MINIMAL_TRANSCRIPT, {
      filename: 'eval/2026-06-09-1200.md',
      source: '/transcripts/eval/2026-06-09-1200.md',
    });
    expect(t.source).toBe('/transcripts/eval/2026-06-09-1200.md');
  });

  it('produces a bySlug map', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    expect(Object.keys(t.bySlug)).toContain('actions-taken');
    expect(Object.keys(t.bySlug)).toContain('errors-and-retries');
    expect(t.bySlug['outcome']?.body).toContain('pass');
  });

  it('does not throw on garbage input', () => {
    expect(() => parseTranscript('')).not.toThrow();
    expect(() => parseTranscript('not even close to markdown')).not.toThrow();
    expect(() => parseTranscript('\u0000\u0001\u0002')).not.toThrow();
  });

  it('handles Windows CRLF line endings', () => {
    const crlf = MINIMAL_TRANSCRIPT.replace(/\n/g, '\r\n');
    const t = parseTranscript(crlf, { filename: 'eval/2026-06-09-1200.md' });
    expect(t.task).toBe('Trivial.');
    expect(t.outcome).toBe('pass');
  });

  it('uses the auto timezone heuristic', () => {
    const t = parseTranscript(MINIMAL_TRANSCRIPT, {
      filename: 'eval/2026-06-09-1200.md',
      defaultTimezone: 'auto',
    });
    expect(t.identity.startedAt).toMatch(/-07:00$/);
  });

  it('uses an explicit timezone override', () => {
    const t = parseTranscript(MINIMAL_TRANSCRIPT, {
      filename: 'eval/2026-06-09-1200.md',
      defaultTimezone: '+00:00',
    });
    expect(t.identity.startedAt).toMatch(/\+00:00$/);
  });

  it('falls back gracefully when filename time is missing', () => {
    const t = parseTranscript(MINIMAL_TRANSCRIPT, { filename: 'eval/notes.md' });
    expect(t.identity.startedAt).toBe('');
    expect(Number.isNaN(t.identity.startedAtMs)).toBe(true);
    expect(Number.isNaN(t.endedAtMs)).toBe(true);
  });
});

// ─── extractReferences ─────────────────────────────────────────────────────────

describe('extractReferences', () => {
  it('extracts commit SHAs from key outputs', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const commits = t.references.filter((r) => r.kind === 'commit').map((r) => r.value);
    expect(commits).toContain('fd2f36a');
    expect(commits).toContain('3069860');
  });

  it('extracts file paths surrounded by backticks', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const files = t.references.filter((r) => r.kind === 'file').map((r) => r.value);
    expect(files.some((f) => f.includes('Program.cs'))).toBe(true);
  });

  it('extracts URLs and trims trailing punctuation', () => {
    const t = parseTranscript(BUILDER_TRANSCRIPT, {
      filename: 'builder/2026-06-05-1000.md',
    });
    const urls = t.references.filter((r) => r.kind === 'url').map((r) => r.value);
    expect(urls).toContain('https://github.com/sauravbhattacharya001/agentlens');
  });

  it('extracts issue numbers like #142', () => {
    const t = parseTranscript(BUILDER_TRANSCRIPT, {
      filename: 'builder/2026-06-05-1000.md',
    });
    const issues = t.references.filter((r) => r.kind === 'issue').map((r) => r.value);
    expect(issues).toContain('#142');
  });

  it('deduplicates references', () => {
    const text = `# T\n## Task\nfd2f36a appears here\n## Key Outputs\nfd2f36a appears here too`;
    const t = parseTranscript(text, { filename: 'x/2026-01-01-0100.md' });
    const commits = t.references.filter((r) => r.kind === 'commit' && r.value === 'fd2f36a');
    expect(commits.length).toBe(1);
  });

  it('rejects all-zero shas', () => {
    const text = `# T\n## Task\n0000000 is not a commit`;
    const t = parseTranscript(text, { filename: 'x/2026-01-01-0100.md' });
    expect(t.references.filter((r) => r.kind === 'commit').length).toBe(0);
  });
});

// ─── transcriptToTimeline ──────────────────────────────────────────────────────

describe('transcriptToTimeline', () => {
  it('produces a valid RunTimeline from a parsed transcript', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t);
    expect(typeof tl.startedAt).toBe('string');
    expect(tl.endedAt).toBeDefined();
    expect((tl.events ?? []).length).toBeGreaterThan(0);
  });

  it('includes a start event and an end event', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t);
    expect(tl.events?.[0]?.type).toBe('start');
    expect(tl.events?.[tl.events.length - 1]?.type).toBe('end');
  });

  it('emits an error event when transcript reports errors', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t);
    expect(tl.events?.some((e) => e.type === 'error')).toBe(true);
  });

  it('skips error event when emitErrorEvent=false', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t, { emitErrorEvent: false });
    expect(tl.events?.some((e) => e.type === 'error')).toBe(false);
  });

  it('skips action expansion when expandActions=false', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t, { expandActions: false });
    const outputCount = (tl.events ?? []).filter((e) => e.type === 'output').length;
    expect(outputCount).toBe(0);
  });

  it('passes timeoutMs through to the timeline', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t, { timeoutMs: 60_000 });
    expect(tl.timeoutMs).toBe(60_000);
  });

  it('uses transcript keyOutputs as the timeline output', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t);
    expect(tl.output).toContain('fd2f36a');
  });

  it('integrates with detectTimeout (Tier 1 staleness module)', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t, { timeoutMs: 60_000 });
    const issue = detectTimeout(tl);
    expect(issue).not.toBeNull();
    if (issue) expect(issue.kind).toBe('timeout');
  });

  it('produces a non-stale timeline for a healthy run', () => {
    const t = parseTranscript(SENTINEL_TRANSCRIPT, {
      filename: 'sentinel/2026-06-08-1815.md',
    });
    const tl = transcriptToTimeline(t);
    const issues = detectStaleness(tl, { maxGapMs: 60 * 60 * 1000 });
    expect(issues).toEqual([]);
  });

  it('handles transcripts with no parseable duration', () => {
    const t = parseTranscript('# T\n## Task\nx', { filename: 'x/notes.md' });
    const tl = transcriptToTimeline(t);
    expect((tl.events ?? []).length).toBeGreaterThanOrEqual(0);
  });
});

// ─── discoverTranscripts / loadTranscript ──────────────────────────────────────

describe('discovery + loading', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-eval-trans-'));
    mkdirSync(join(root, 'builder'), { recursive: true });
    mkdirSync(join(root, 'sentinel'), { recursive: true });
    mkdirSync(join(root, 'gardener'), { recursive: true });
    mkdirSync(join(root, 'memory-backup'), { recursive: true });

    writeFileSync(join(root, 'builder', '2026-06-05-1000.md'), BUILDER_TRANSCRIPT);
    writeFileSync(join(root, 'sentinel', '2026-06-08-1815.md'), SENTINEL_TRANSCRIPT);
    writeFileSync(join(root, 'gardener', '2026-06-08-0900.md'), PARTIAL_TRANSCRIPT);
    // Older file for from/to filtering tests:
    writeFileSync(join(root, 'sentinel', '2026-06-01-0600.md'), SENTINEL_TRANSCRIPT);
    // Non-conforming filename should be skipped by default:
    writeFileSync(join(root, 'builder', 'random.md'), BUILDER_TRANSCRIPT);
    // Empty memory-backup directory left intentionally to verify it does not appear in results.
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers all conforming transcripts', () => {
    const files = discoverTranscripts(root);
    expect(files.length).toBe(4);
  });

  it('sorts newest first by default', () => {
    const files = discoverTranscripts(root);
    expect(files[0]?.filename).toBe('2026-06-08-1815.md');
  });

  it('supports asc order', () => {
    const files = discoverTranscripts(root, { order: 'asc' });
    expect(files[0]?.filename).toBe('2026-06-01-0600.md');
  });

  it('filters by worker', () => {
    const files = discoverTranscripts(root, { workers: ['sentinel'] });
    expect(files.every((f) => f.worker === 'sentinel')).toBe(true);
    expect(files.length).toBe(2);
  });

  it('filters by date range', () => {
    const files = discoverTranscripts(root, {
      fromDate: '2026-06-08',
      toDate: '2026-06-08',
    });
    expect(files.length).toBe(2);
    expect(files.every((f) => f.date === '2026-06-08')).toBe(true);
  });

  it('respects limit', () => {
    const files = discoverTranscripts(root, { limit: 1 });
    expect(files.length).toBe(1);
  });

  it('skips non-conforming filenames by default', () => {
    const files = discoverTranscripts(root);
    expect(files.some((f) => f.filename === 'random.md')).toBe(false);
  });

  it('includes non-conforming filenames when asked', () => {
    const files = discoverTranscripts(root, { includeNonConforming: true });
    expect(files.some((f) => f.filename === 'random.md')).toBe(true);
  });

  it('excludes specified workers', () => {
    const files = discoverTranscripts(root, { excludeWorkers: ['sentinel'] });
    expect(files.every((f) => f.worker !== 'sentinel')).toBe(true);
  });

  it('returns empty array for non-existent root', () => {
    expect(discoverTranscripts(join(root, 'does-not-exist'))).toEqual([]);
  });

  it('loads a single transcript via TranscriptFile', () => {
    const files = discoverTranscripts(root, { workers: ['builder'] });
    expect(files.length).toBe(1);
    const t = loadTranscript(files[0]!);
    expect(t.identity.worker).toBe('builder');
    expect(t.outcome).toBe('pass');
    expect(t.source).toBe(files[0]?.path);
  });

  it('loads a single transcript via raw path', () => {
    const path = join(root, 'sentinel', '2026-06-08-1815.md');
    const t = loadTranscript(path);
    expect(t.identity.worker).toBe('sentinel');
    expect(t.source).toBe(path);
  });

  it('parseTranscriptFiles returns one entry per file', () => {
    const files = discoverTranscripts(root);
    const parsed = parseTranscriptFiles(files);
    expect(parsed.length).toBe(files.length);
    expect(parsed.every((p) => p.transcript)).toBe(true);
    expect(parsed.every((p) => !p.error)).toBe(true);
  });

  it('loadTranscripts is a one-shot discover+parse', () => {
    const ts = loadTranscripts(root, { workers: ['gardener'] });
    expect(ts.length).toBe(1);
    expect(ts[0]?.outcome).toBe('partial');
  });

  it('parseTranscriptFiles records error for missing file', () => {
    const result = parseTranscriptFiles([
      {
        worker: 'builder',
        filename: 'ghost.md',
        path: join(root, 'builder', 'ghost.md'),
        date: '',
        time: '',
        mtimeMs: 0,
      },
    ]);
    expect(result.length).toBe(1);
    expect(result[0]?.transcript).toBeUndefined();
    expect(result[0]?.error).toBeDefined();
  });
});

// ─── rollingWindow ────────────────────────────────────────────────────────────

describe('rollingWindow', () => {
  it('returns the same day for days=1', () => {
    const today = new Date('2026-06-09T12:00:00Z');
    const w = rollingWindow(1, today);
    expect(w.fromDate).toBe('2026-06-09');
    expect(w.toDate).toBe('2026-06-09');
  });

  it('returns a 7-day window inclusive', () => {
    const today = new Date('2026-06-09T12:00:00Z');
    const w = rollingWindow(7, today);
    expect(w.fromDate).toBe('2026-06-03');
    expect(w.toDate).toBe('2026-06-09');
  });

  it('handles month boundaries', () => {
    const today = new Date('2026-06-02T12:00:00Z');
    const w = rollingWindow(7, today);
    expect(w.fromDate).toBe('2026-05-27');
    expect(w.toDate).toBe('2026-06-02');
  });

  it('clamps days=0 to a single day', () => {
    const today = new Date('2026-06-09T12:00:00Z');
    const w = rollingWindow(0, today);
    expect(w.fromDate).toBe(w.toDate);
  });
});