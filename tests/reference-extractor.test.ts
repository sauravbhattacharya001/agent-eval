/**
 * Tests for the Reference Extractor - the artifact-reference scanner
 * (`extractReferences` + `looksLikePath`) extracted from `transcript-reader.ts`.
 *
 * These test the functions through their OWN module path
 * (`./reference-extractor.js`) rather than only indirectly through
 * `parseTranscript`, and they pin the individually-fiddly regexes that make up
 * the pattern bank: URL boundary trimming, the `#1234` PR/issue form, the
 * 7-40 hex commit-SHA window with its all-zeros guard, backtick-quoted paths,
 * bare paths recognised only by a known extension, per-kind de-duplication,
 * and the `looksLikePath` guard that stops SHAs / URLs from being mis-tagged
 * as files.
 */

import { describe, expect, it } from 'vitest';

import {
  extractReferences,
  looksLikePath,
} from '../src/monitoring/reference-extractor.js';
import type { TranscriptReference, TranscriptSection } from '../src/monitoring/types.js';

/** Build a minimal section with just the fields extractReferences reads. */
function section(slug: string, body: string): TranscriptSection {
  return { heading: slug, slug, body, depth: 2, startLine: 0, endLine: 0 };
}

/** Convenience: collect the values of a given kind from a section body. */
function valuesOf(kind: TranscriptReference['kind'], body: string, slug = 'key-outputs'): string[] {
  return extractReferences([section(slug, body)])
    .filter((r) => r.kind === kind)
    .map((r) => r.value);
}

describe('extractReferences (direct module)', () => {
  describe('commit SHAs', () => {
    it('extracts a lower-cased 7-40 hex sha', () => {
      expect(valuesOf('commit', 'shipped in fd2f36a today')).toEqual(['fd2f36a']);
    });

    it('does NOT treat uppercase hex as a sha (the pattern is case-sensitive [0-9a-f])', () => {
      // The commit regex is `[0-9a-f]{7,40}` - lower-case only. `.toLowerCase()`
      // is applied only AFTER a match, so an uppercase run is never captured.
      expect(valuesOf('commit', 'commit ABCDEF1 landed')).toEqual([]);
    });

    it('handles backtick-wrapped shas', () => {
      expect(valuesOf('commit', 'see `3069860` for the fix')).toContain('3069860');
    });

    it('accepts a full 40-char sha', () => {
      const sha = 'a'.repeat(40);
      expect(valuesOf('commit', `pinned ${sha} exactly`)).toEqual([sha]);
    });

    it('rejects an all-zero sha', () => {
      expect(valuesOf('commit', '0000000 is not a commit')).toEqual([]);
    });

    it('does not treat a 6-char hex run as a sha (too short)', () => {
      expect(valuesOf('commit', 'color abcdef here')).toEqual([]);
    });

    it('captures a hex run once a non-hex boundary precedes it', () => {
      // The leading boundary is `^|[^A-Fa-f0-9\`]`; the letter `x` is a valid
      // non-hex boundary, so the following 10-hex run IS surfaced. (Documents
      // the true, if slightly permissive, boundary behavior.)
      expect(valuesOf('commit', 'xabcdef1234 embedded')).toEqual(['abcdef1234']);
    });

    it('does not capture a hex run glued to a trailing hex-continuation past 40', () => {
      // A 41-char lower-hex run cannot match the {7,40} window as a standalone
      // token because the 41st char defeats the trailing `(?=\b)` boundary.
      const long = 'a'.repeat(41);
      expect(valuesOf('commit', `x${long}y`)).toEqual([]);
    });
  });

  describe('PR / issue references', () => {
    it('extracts a #1234 reference and keeps the hash', () => {
      expect(valuesOf('issue', 'closes #1368 in review')).toEqual(['#1368']);
    });

    it('extracts a short 2-digit issue number', () => {
      expect(valuesOf('issue', 'fixes #42 today')).toEqual(['#42']);
    });

    it('extracts an issue at the start of the body', () => {
      expect(valuesOf('issue', '#142 was the target')).toEqual(['#142']);
    });

    it('ignores a single-digit #n (below the 2-digit floor)', () => {
      expect(valuesOf('issue', 'step #1 of the plan')).toEqual([]);
    });

    it('does not extract a hash glued to a word char (e.g. anchor#frag)', () => {
      // The leading boundary is `^|[^\w]`, so `abc#123` has a word char before
      // the hash and is not matched.
      expect(valuesOf('issue', 'anchor abc#123 here')).toEqual([]);
    });
  });

  describe('URLs', () => {
    it('extracts an http(s) URL', () => {
      expect(valuesOf('url', 'see https://github.com/example-org/toolforge for more')).toEqual([
        'https://github.com/example-org/toolforge',
      ]);
    });

    it('trims a single trailing sentence punctuation', () => {
      expect(valuesOf('url', 'docs at https://example.com/page.')).toEqual([
        'https://example.com/page',
      ]);
    });

    it('trims a trailing close-paren', () => {
      expect(valuesOf('url', '(https://example.com/x)')).toEqual(['https://example.com/x']);
    });

    it('trims a run of mixed trailing punctuation (e.g. `).`)', () => {
      // The trim class is `[.,;:!?)]+$` - a whole trailing run is stripped, not
      // just the final char. `).` after a query string must both come off.
      expect(valuesOf('url', 'see https://example.com/x?a=1).')).toEqual([
        'https://example.com/x?a=1',
      ]);
    });

    it('trims trailing `!` and `?` sentence punctuation', () => {
      // `!` and `?` are both in the trim class; a `!?` tail comes off entirely.
      expect(valuesOf('url', 'wow https://example.com/y!?')).toEqual([
        'https://example.com/y',
      ]);
    });

    it('stops the URL at whitespace and angle/backtick delimiters', () => {
      expect(valuesOf('url', 'link `https://example.com/a` done')).toEqual([
        'https://example.com/a',
      ]);
    });
  });

  describe('file paths', () => {
    it('extracts a backtick-quoted path with a separator', () => {
      expect(valuesOf('file', 'edited `src/monitoring/runner.ts` here')).toContain(
        'src/monitoring/runner.ts',
      );
    });

    it('extracts a backtick-quoted bare filename by its extension', () => {
      expect(valuesOf('file', 'touched `Program.cs` in the build')).toContain('Program.cs');
    });

    it('extracts a bare (un-quoted) path with a known extension', () => {
      expect(valuesOf('file', 'wrote src/index.ts and moved on')).toContain('src/index.ts');
    });

    it('extracts a bare filename with a recognised extension', () => {
      expect(valuesOf('file', 'updated README.md at the end')).toContain('README.md');
    });

    it('does not surface a bare filename with an UNknown extension', () => {
      expect(valuesOf('file', 'saved output.xyz somewhere')).toEqual([]);
    });

    it('does not surface a backtick token whose extension is 9+ chars (looksLikePath cap)', () => {
      // `looksLikePath`'s extension arm is `/\.[a-z0-9]{1,8}$/i` - a 9-char
      // extension with no path separator fails that guard, so the backtick
      // pattern does not tag it as a file.
      expect(valuesOf('file', 'wrote `archive.gitignore` today')).toEqual([]);
    });

    it('does not misfile a URL as a path', () => {
      const files = valuesOf('file', 'see https://example.com/a.md now');
      expect(files).not.toContain('https://example.com/a.md');
    });

    it('does not misfile a bare sha as a path', () => {
      expect(valuesOf('file', 'commit fd2f36a shipped')).toEqual([]);
    });
  });

  describe('de-duplication and attribution', () => {
    it('de-duplicates the same commit seen twice in one body', () => {
      const commits = valuesOf('commit', 'fd2f36a here and fd2f36a again');
      expect(commits).toEqual(['fd2f36a']);
    });

    it('de-duplicates a commit repeated across sections', () => {
      const refs = extractReferences([
        section('task', 'fd2f36a appears here'),
        section('key-outputs', 'fd2f36a appears here too'),
      ]).filter((r) => r.kind === 'commit' && r.value === 'fd2f36a');
      expect(refs).toHaveLength(1);
      // First occurrence wins the section attribution.
      expect(refs[0]?.section).toBe('task');
    });

    it('keeps same-value references of DIFFERENT kinds (key is kind|value)', () => {
      // "1234567" is both a valid short sha and, as #1234567, an issue number.
      const refs = extractReferences([section('key-outputs', 'sha 1234567 and issue #1234567')]);
      const kinds = refs.filter((r) => r.value.includes('1234567')).map((r) => r.kind).sort();
      expect(kinds).toContain('commit');
      expect(kinds).toContain('issue');
    });

    it('tags each reference with the section slug it was found in', () => {
      const refs = extractReferences([section('actions-taken', 'ran src/index.ts')]);
      const file = refs.find((r) => r.kind === 'file');
      expect(file?.section).toBe('actions-taken');
    });
  });

  describe('empty / edge input', () => {
    it('returns nothing for an empty section list', () => {
      expect(extractReferences([])).toEqual([]);
    });

    it('skips sections with an empty body', () => {
      expect(extractReferences([section('task', '')])).toEqual([]);
    });
  });
});

describe('looksLikePath (direct)', () => {
  it('accepts a path with a forward slash', () => {
    expect(looksLikePath('src/index.ts')).toBe(true);
  });

  it('accepts a path with a backslash', () => {
    expect(looksLikePath('src\\index.ts')).toBe(true);
  });

  it('accepts a bare filename with a short extension', () => {
    expect(looksLikePath('README.md')).toBe(true);
  });

  it('rejects a bare word with no separator or extension', () => {
    expect(looksLikePath('runner')).toBe(false);
  });

  it('accepts an 8-char extension but rejects a 9-char one (the {1,8} cap)', () => {
    // The separator-less accept path is `/\.[a-z0-9]{1,8}$/i`; exactly 8 hits
    // the upper bound, 9 falls through to `return false`.
    expect(looksLikePath('a.abcdefgh')).toBe(true);
    expect(looksLikePath('a.abcdefghi')).toBe(false);
  });

  it('rejects an http(s) URL', () => {
    expect(looksLikePath('https://example.com/a.md')).toBe(false);
  });

  it('rejects a bare commit sha', () => {
    expect(looksLikePath('fd2f36a')).toBe(false);
    expect(looksLikePath('a'.repeat(40))).toBe(false);
  });

  it('rejects a token containing a space', () => {
    expect(looksLikePath('src/two words.ts')).toBe(false);
  });

  it('rejects an over-long token (>200 chars)', () => {
    expect(looksLikePath(`${'a/'.repeat(150)}x.ts`)).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(looksLikePath('')).toBe(false);
  });
});
