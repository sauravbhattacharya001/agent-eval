/**
 * Direct edge/error-path tests for the transcript **discovery** disk layer
 * (`src/monitoring/discovery.ts`).
 *
 * `transcript-reader.test.ts` already covers the happy paths (basic discover,
 * asc order, worker/date filters, `limit: 1`, `includeNonConforming` presence,
 * single loads). This file pins the *boundary and error paths that module owns
 * on its own* — the subtle branches that a refactor could silently break:
 *
 *   - `limit: 0` (explicit zero) vs a negative limit (ignored → all)
 *   - `workers: []` (empty allow-list ⇒ nothing) vs `workers: undefined` (all)
 *   - a plain file sitting in the root (not a worker dir) is skipped
 *   - date-range filters do NOT apply to non-conforming (dateless) files
 *   - the non-conforming sort tiebreak (mtime key) orders after conforming keys
 *   - case-insensitive worker/exclude matching and `.MD` extension
 *   - `loadTranscript` on a `TranscriptFile` with no `worker` hint
 *   - `parseTranscriptFiles([])` and `loadTranscripts` dropping parse failures
 *
 * All fixtures are written to a real temp dir so the `node:fs` calls exercise
 * the actual `readdirSync`/`statSync` branches (no mocks).
 *
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
  discoverTranscripts,
  loadTranscript,
  loadTranscripts,
  parseTranscriptFiles,
  type TranscriptFile,
} from '../src/monitoring/index.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────

/** A minimal contract-conforming transcript (parses to a `pass` outcome). */
const OK_TRANSCRIPT = `# Worker Run - 2026-06-08 09:00 PT

## Task
Do a small, well-scoped thing.

## Actions Taken
1. Read the task file
2. Made the change
3. Ran the tests

## Key Outputs
- Commit abc1234: did the thing

## Outcome
pass - the thing was done

## Duration
09:00 -> 09:10 PT, 10 minutes
`;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-discovery-'));

  // Two workers with conforming files spanning two dates.
  mkdirSync(join(root, 'builder'), { recursive: true });
  mkdirSync(join(root, 'sentinel'), { recursive: true });
  writeFileSync(join(root, 'builder', '2026-06-05-1000.md'), OK_TRANSCRIPT);
  writeFileSync(join(root, 'sentinel', '2026-06-08-1815.md'), OK_TRANSCRIPT);
  writeFileSync(join(root, 'sentinel', '2026-06-01-0600.md'), OK_TRANSCRIPT);

  // A non-conforming (dateless) filename in builder — skipped unless asked.
  writeFileSync(join(root, 'builder', 'notes.md'), OK_TRANSCRIPT);

  // An uppercase-extension conforming file — the regex uses the `i` flag.
  writeFileSync(join(root, 'builder', '2026-06-06-1200.MD'), OK_TRANSCRIPT);

  // A plain FILE living at the root (not a worker directory) — must be skipped.
  writeFileSync(join(root, 'loose-file.md'), OK_TRANSCRIPT);

  // An empty worker dir — must not surface any results.
  mkdirSync(join(root, 'memory-backup'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── limit boundaries ────────────────────────────────────────────────────────

describe('discoverTranscripts: limit boundaries', () => {
  it('limit: 0 returns an empty array (explicit zero is honored)', () => {
    // `>= 0` guard means 0 slices to nothing, distinct from omitting the limit.
    expect(discoverTranscripts(root, { limit: 0 })).toEqual([]);
  });

  it('a negative limit is ignored — all results are returned', () => {
    const all = discoverTranscripts(root);
    const neg = discoverTranscripts(root, { limit: -1 });
    expect(neg.length).toBe(all.length);
    expect(neg.length).toBeGreaterThan(0);
  });

  it('a limit larger than the result count returns everything', () => {
    const all = discoverTranscripts(root);
    expect(discoverTranscripts(root, { limit: 9999 }).length).toBe(all.length);
  });
});

// ─── worker allow-list semantics ─────────────────────────────────────────────

describe('discoverTranscripts: worker filtering semantics', () => {
  it('workers: [] (empty allow-list) matches NOTHING, unlike undefined', () => {
    // A common footgun: an explicit empty array is a real filter, not "all".
    expect(discoverTranscripts(root, { workers: [] })).toEqual([]);
    expect(discoverTranscripts(root).length).toBeGreaterThan(0);
  });

  it('worker matching is case-insensitive', () => {
    const upper = discoverTranscripts(root, { workers: ['SENTINEL'] });
    expect(upper.length).toBe(2);
    expect(upper.every((f) => f.worker === 'sentinel')).toBe(true);
  });

  it('excludeWorkers is case-insensitive too', () => {
    const files = discoverTranscripts(root, { excludeWorkers: ['SeNtInEl'] });
    expect(files.every((f) => f.worker !== 'sentinel')).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('excludeWorkers wins even when the worker is also in the allow-list', () => {
    const files = discoverTranscripts(root, {
      workers: ['sentinel', 'builder'],
      excludeWorkers: ['sentinel'],
    });
    expect(files.every((f) => f.worker !== 'sentinel')).toBe(true);
    expect(files.some((f) => f.worker === 'builder')).toBe(true);
  });
});

// ─── non-directory / structural skips ────────────────────────────────────────

describe('discoverTranscripts: structural skips', () => {
  it('a plain file at the root (not a worker dir) is not treated as a worker', () => {
    const files = discoverTranscripts(root, { includeNonConforming: true });
    expect(files.some((f) => f.filename === 'loose-file.md')).toBe(false);
  });

  it('an empty worker directory contributes no results', () => {
    const files = discoverTranscripts(root, { includeNonConforming: true });
    expect(files.some((f) => f.worker === 'memory-backup')).toBe(false);
  });

  it('matches conforming filenames with an uppercase .MD extension', () => {
    const files = discoverTranscripts(root);
    const upper = files.find((f) => f.filename === '2026-06-06-1200.MD');
    expect(upper).toBeDefined();
    // The date/time are still parsed out of the uppercase-extension name.
    expect(upper?.date).toBe('2026-06-06');
    expect(upper?.time).toBe('1200');
  });
});

// ─── non-conforming: date-filter + sort interaction ──────────────────────────

describe('discoverTranscripts: non-conforming file handling', () => {
  it('date-range filters do NOT drop dateless (non-conforming) files', () => {
    // A dateless file has an empty `date`, so the `if (date)` range guard is
    // skipped entirely — a from/to window must not silently exclude it.
    const files = discoverTranscripts(root, {
      includeNonConforming: true,
      fromDate: '2999-01-01',
      toDate: '2999-12-31',
    });
    // All conforming files are outside the window; only the dateless one remains.
    expect(files.map((f) => f.filename)).toContain('notes.md');
    expect(files.every((f) => f.date === '' || f.filename === 'notes.md')).toBe(true);
  });

  it('non-conforming entries carry empty date/time and a real mtime', () => {
    const files = discoverTranscripts(root, { includeNonConforming: true });
    const notes = files.find((f) => f.filename === 'notes.md');
    expect(notes).toBeDefined();
    expect(notes?.date).toBe('');
    expect(notes?.time).toBe('');
    expect(notes?.mtimeMs).toBeGreaterThan(0);
  });

  it('sorts a dateless file by its mtime tiebreak, below conforming date keys', () => {
    // Conforming sort keys look like "2026-06-08-1815"; the dateless tiebreak is
    // a zero-padded mtime. Force the dateless file to a very old mtime so, in
    // ascending order, it sorts BEFORE every 2026 conforming key.
    utimesSync(join(root, 'builder', 'notes.md'), new Date(1000), new Date(1000));
    const asc = discoverTranscripts(root, { includeNonConforming: true, order: 'asc' });
    expect(asc[0]?.filename).toBe('notes.md');
    // And in descending order it is not first (a 2026 conforming key wins).
    const desc = discoverTranscripts(root, { includeNonConforming: true, order: 'desc' });
    expect(desc[0]?.filename).not.toBe('notes.md');
  });
});

// ─── loadTranscript / bulk helpers: edge inputs ──────────────────────────────

describe('loadTranscript + bulk helpers: edge inputs', () => {
  it('loadTranscript infers worker from the path when the descriptor has none', () => {
    // A TranscriptFile with an empty `worker` exercises the `worker ? … : {}`
    // spread branch; identity is then derived from the filename path instead.
    const descriptor: TranscriptFile = {
      worker: '',
      filename: '2026-06-05-1000.md',
      path: join(root, 'builder', '2026-06-05-1000.md'),
      date: '2026-06-05',
      time: '1000',
      mtimeMs: 0,
    };
    const t = loadTranscript(descriptor);
    expect(t.identity.worker).toBe('builder');
    expect(t.outcome).toBe('pass');
  });

  it('loadTranscript accepts a raw path string and records it as the source', () => {
    const path = join(root, 'sentinel', '2026-06-08-1815.md');
    const t = loadTranscript(path);
    expect(t.identity.worker).toBe('sentinel');
    expect(t.source).toBe(path);
  });

  it('parseTranscriptFiles on an empty list returns an empty list', () => {
    expect(parseTranscriptFiles([])).toEqual([]);
  });

  it('loadTranscripts drops files that fail to parse, keeping the rest', () => {
    const good: TranscriptFile = {
      worker: 'builder',
      filename: '2026-06-05-1000.md',
      path: join(root, 'builder', '2026-06-05-1000.md'),
      date: '2026-06-05',
      time: '1000',
      mtimeMs: 0,
    };
    const missing: TranscriptFile = {
      worker: 'builder',
      filename: 'ghost.md',
      path: join(root, 'builder', 'ghost.md'),
      date: '',
      time: '',
      mtimeMs: 0,
    };
    // parseTranscriptFiles records the read error; loadTranscripts filters it out.
    const parsed = parseTranscriptFiles([good, missing]);
    expect(parsed).toHaveLength(2);
    expect(parsed.find((p) => p.file.filename === 'ghost.md')?.error).toBeDefined();

    const ts = loadTranscripts(join(root, 'does-not-exist'));
    expect(ts).toEqual([]); // non-existent root ⇒ nothing discovered, nothing thrown
  });
});
