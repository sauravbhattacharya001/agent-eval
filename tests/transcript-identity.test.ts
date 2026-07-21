/**
 * Tests for the Transcript Identity module - the filename + timezone cluster
 * (`inferIdentity`, `resolveTimezone`, `inferPacificOffset`, `basenameOf`,
 * `parentDirectoryName`) extracted from `transcript-reader.ts`.
 *
 * These test the helpers through their OWN module path
 * (`./transcript-identity.js`) rather than only indirectly through
 * `parseTranscript`, pinning the individually-fiddly pieces: the
 * `YYYY-MM-DD-HHmm.md` filename grammar and its warning path, worker inference
 * precedence (option > parent dir > title prefix), POSIX/Windows basename +
 * parent-dir extraction, and the approximate Pacific-Time DST offset with its
 * March/November Sunday-boundary math.
 */

import { describe, expect, it } from 'vitest';

import {
  basenameOf,
  inferIdentity,
  inferPacificOffset,
  parentDirectoryName,
  resolveTimezone,
} from '../src/monitoring/transcript-identity.js';

describe('basenameOf', () => {
  it('returns the final segment for POSIX and Windows paths', () => {
    expect(basenameOf('transcripts/eval/2026-07-20-1800.md')).toBe('2026-07-20-1800.md');
    expect(basenameOf('C:\\a\\b\\c.md')).toBe('c.md');
  });

  it('returns the input when there is no separator, and "" for empty', () => {
    expect(basenameOf('file.md')).toBe('file.md');
    expect(basenameOf('')).toBe('');
  });
});

describe('parentDirectoryName', () => {
  it('returns the lower-cased parent directory as the worker hint', () => {
    expect(parentDirectoryName('transcripts/Eval/2026-07-20-1800.md')).toBe('eval');
    expect(parentDirectoryName('a\\Sentinel\\x.md')).toBe('sentinel');
  });

  it('returns "" when there is no parent segment', () => {
    expect(parentDirectoryName('x.md')).toBe('');
    expect(parentDirectoryName('')).toBe('');
  });
});

describe('resolveTimezone', () => {
  it('honours an explicit override verbatim', () => {
    expect(resolveTimezone('2026-07-20', '+05:30')).toBe('+05:30');
  });

  it('defaults to PDT when no override is given', () => {
    expect(resolveTimezone('2026-07-20')).toBe('-07:00');
    expect(resolveTimezone('')).toBe('-07:00');
  });

  it('infers the Pacific offset from the date when override is "auto"', () => {
    expect(resolveTimezone('2026-07-20', 'auto')).toBe('-07:00'); // summer → PDT
    expect(resolveTimezone('2026-01-15', 'auto')).toBe('-08:00'); // winter → PST
  });

  it('falls back to PDT when "auto" but no date', () => {
    expect(resolveTimezone('', 'auto')).toBe('-07:00');
  });
});

describe('inferPacificOffset', () => {
  it('is PDT for mid-summer and PST for mid-winter', () => {
    expect(inferPacificOffset('2026-07-01')).toBe('-07:00');
    expect(inferPacificOffset('2026-12-01')).toBe('-08:00');
  });

  it('returns PDT for a malformed date', () => {
    expect(inferPacificOffset('not-a-date')).toBe('-07:00');
  });

  it('switches at the second Sunday of March (2026-03-08)', () => {
    // 2026-03-08 is the second Sunday of March.
    expect(inferPacificOffset('2026-03-07')).toBe('-08:00'); // day before → PST
    expect(inferPacificOffset('2026-03-08')).toBe('-07:00'); // DST begins → PDT
  });

  it('switches at the first Sunday of November (2026-11-01)', () => {
    // 2026-11-01 is the first Sunday of November.
    expect(inferPacificOffset('2026-10-31')).toBe('-07:00'); // still PDT
    expect(inferPacificOffset('2026-11-01')).toBe('-08:00'); // DST ends → PST
  });
});

describe('inferIdentity', () => {
  it('parses date/time/start-ms from a canonical filename', () => {
    const warnings: string[] = [];
    const id = inferIdentity('Eval Run - 2026-07-20', { filename: 'transcripts/eval/2026-07-20-1800.md' }, warnings);
    expect(id.worker).toBe('eval');
    expect(id.date).toBe('2026-07-20');
    expect(id.time).toBe('18:00');
    expect(id.startedAt).toBe('2026-07-20T18:00:00-07:00');
    expect(Number.isFinite(id.startedAtMs)).toBe(true);
    expect(id.filename).toBe('2026-07-20-1800.md');
    expect(warnings).toHaveLength(0);
  });

  it('warns and leaves timestamp blank for a non-canonical filename', () => {
    const warnings: string[] = [];
    const id = inferIdentity('', { filename: 'notes.txt' }, warnings);
    expect(id.date).toBe('');
    expect(id.time).toBe('');
    expect(id.startedAt).toBe('');
    expect(Number.isNaN(id.startedAtMs)).toBe(true);
    expect(warnings.some((w) => w.includes('does not match'))).toBe(true);
  });

  it('prefers an explicit worker option over the directory and title', () => {
    const id = inferIdentity('Sentinel Run - x', { filename: 'transcripts/eval/2026-07-20-1800.md', worker: 'builder' }, []);
    expect(id.worker).toBe('builder');
  });

  it('falls back to the title prefix when no filename/dir worker is present', () => {
    const id = inferIdentity('Repo Gardener Run - 2026-07-20', {}, []);
    expect(id.worker).toBe('repo-gardener');
  });

  it('is "unknown" when nothing identifies the worker', () => {
    const id = inferIdentity('', {}, []);
    expect(id.worker).toBe('unknown');
  });

  it('applies the defaultTimezone override to the start timestamp', () => {
    const id = inferIdentity('', { filename: '2026-01-15-0900.md', defaultTimezone: 'auto' }, []);
    expect(id.startedAt).toBe('2026-01-15T09:00:00-08:00'); // winter → PST via auto
  });
});
