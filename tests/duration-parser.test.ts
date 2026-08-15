/**
 * Tests for the Duration Parser - the natural-language `## Duration` grammar
 * extracted from `transcript-reader.ts`.
 *
 * These test `parseDuration` through its OWN module path (`./duration-parser.js`)
 * rather than only through the re-export on `transcript-reader.js`, and they
 * pin the subtle disambiguation rules that make this the trickiest sub-parser
 * in the monitoring layer: a start→end clock range must win over summed
 * `N min` tokens (so a headline range plus a per-step breakdown does not
 * double-count), and only a clock range or an unqualified token total counts
 * as `exact`.
 */

import { describe, expect, it } from 'vitest';

import { parseDuration } from '../src/monitoring/duration-parser.js';

describe('parseDuration (direct module)', () => {
  describe('explicit h/m/s tokens', () => {
    it('parses bare minutes as exact', () => {
      const d = parseDuration('15 minutes');
      expect(d.ms).toBe(15 * 60_000);
      expect(d.exact).toBe(true);
      expect(d.raw).toBe('15 minutes');
    });

    it('sums combined hour/minute/second tokens', () => {
      const d = parseDuration('1h 23m 4s');
      expect(d.ms).toBe(1 * 3_600_000 + 23 * 60_000 + 4 * 1_000);
      expect(d.exact).toBe(true);
    });

    it('accepts the common abbreviations', () => {
      expect(parseDuration('45 sec').ms).toBe(45_000);
      expect(parseDuration('5 mins').ms).toBe(5 * 60_000);
      expect(parseDuration('2 hr').ms).toBe(2 * 3_600_000);
      expect(parseDuration('2 hrs').ms).toBe(2 * 3_600_000);
      expect(parseDuration('90 secs').ms).toBe(90 * 1_000);
    });

    it('supports fractional token values', () => {
      expect(parseDuration('1.5 hours').ms).toBe(1.5 * 3_600_000);
      expect(parseDuration('2.5 min').ms).toBe(2.5 * 60_000);
    });

    it('is case-insensitive for unit words', () => {
      expect(parseDuration('15 MINUTES').ms).toBe(15 * 60_000);
      expect(parseDuration('2 Hours 30 Min').ms).toBe(2 * 3_600_000 + 30 * 60_000);
    });
  });

  describe('approximation flag', () => {
    it('flags a leading tilde as approximate', () => {
      const d = parseDuration('~15 minutes total');
      expect(d.ms).toBe(15 * 60_000);
      expect(d.exact).toBe(false);
    });

    it('flags "about N" and "approx N" as approximate', () => {
      expect(parseDuration('about 20 minutes').exact).toBe(false);
      expect(parseDuration('approx 20 minutes').exact).toBe(false);
    });

    it('treats an unqualified token total as exact', () => {
      expect(parseDuration('20 minutes').exact).toBe(true);
    });
  });

  describe('clock-time range disambiguation', () => {
    it('uses the start→end diff when no explicit tokens are present', () => {
      const d = parseDuration('18:00 - 18:14 PT');
      expect(d.ms).toBe(14 * 60_000);
      expect(d.exact).toBe(true);
    });

    it('handles a range that crosses midnight', () => {
      const d = parseDuration('23:50 - 00:10 PT');
      expect(d.ms).toBe(20 * 60_000);
    });

    it('parses the arrow form "HH:MM → HH:MM"', () => {
      const d = parseDuration('19:08 PT → 19:50 PT');
      expect(d.ms).toBe(42 * 60_000);
      expect(d.exact).toBe(true);
    });

    it('prefers the clock RANGE over summed sub-duration tokens (no double-count)', () => {
      // Headline wall-clock range is 42 min; the "~11 min" + "~1 min" breakdown
      // must NOT be summed on top of it. The range is authoritative and exact.
      const d = parseDuration('19:08 → 19:50 PT (~42 min; ~11 min before kill, ~1 min each retry)');
      expect(d.ms).toBe(42 * 60_000);
      expect(d.exact).toBe(true);
    });

    it('uses the FIRST and LAST clock time when more than two are present', () => {
      const d = parseDuration('start 09:00, checkpoint 09:30, end 10:15 PT');
      expect(d.ms).toBe(75 * 60_000);
    });

    it('ignores an out-of-range clock component and falls through to tokens', () => {
      // 99:99 is not a valid clock time, so the range branch is skipped and the
      // explicit "~5 minutes" token wins.
      const d = parseDuration('99:99 nonsense ~5 minutes');
      expect(d.ms).toBe(5 * 60_000);
    });

    it('falls through to tokens when a zero-length range is given', () => {
      // 10:00 → 10:00 is a 0-minute diff; the range branch requires diff > 0,
      // so the explicit token wins instead of returning 0.
      const d = parseDuration('10:00 → 10:00 (~30 minutes actual)');
      expect(d.ms).toBe(30 * 60_000);
    });

    it('falls all the way to the bare-number path for a zero-length range with no tokens', () => {
      // 10:00 → 10:00 has diff 0 (range branch requires diff > 0) AND carries no
      // h/m/s tokens, so BOTH the range and token branches are skipped. The only
      // remaining signal is the bare-number fallback, which grabs the FIRST digit
      // run ("10") and assumes minutes - inexact, never 0ms.
      const d = parseDuration('10:00 → 10:00 PT');
      expect(d.ms).toBe(10 * 60_000);
      expect(d.exact).toBe(false);
    });
  });

  describe('zero-valued tokens', () => {
    it('does not treat a lone "0 minutes" as an exact token total', () => {
      // A "0 minutes" token sets matchedAny=true but totalMs=0, which fails the
      // `totalMs > 0` guard on the token branch. So it does NOT take the exact
      // token path; it falls through to the bare-number fallback, which reads the
      // leading "0" as minutes: 0ms, but flagged inexact (not exact).
      const d = parseDuration('0 minutes');
      expect(d.ms).toBe(0);
      expect(d.exact).toBe(false);
    });

    it('treats an all-zero token breakdown ("0h 0m") as inexact zero', () => {
      // Every token is zero, so totalMs stays 0 and the exact token branch is
      // skipped; the bare-number fallback returns 0ms, inexact.
      const d = parseDuration('0h 0m');
      expect(d.ms).toBe(0);
      expect(d.exact).toBe(false);
    });
  });

  describe('bare-number fallback', () => {
    it('assumes minutes for a lone number and marks it inexact', () => {
      const d = parseDuration('5');
      expect(d.ms).toBe(5 * 60_000);
      expect(d.exact).toBe(false);
    });

    it('uses the first number when a unit word is absent', () => {
      const d = parseDuration('roughly 12 or so');
      expect(d.ms).toBe(12 * 60_000);
      expect(d.exact).toBe(false);
    });
  });

  describe('unparseable input', () => {
    it('returns NaN ms for an empty body', () => {
      const d = parseDuration('');
      expect(Number.isNaN(d.ms)).toBe(true);
      expect(d.exact).toBe(false);
      expect(d.raw).toBe('');
    });

    it('returns NaN ms for prose with no digits', () => {
      expect(Number.isNaN(parseDuration('a long while').ms)).toBe(true);
    });

    it('trims and preserves the raw string verbatim', () => {
      expect(parseDuration('  ~8 minutes total  ').raw).toBe('~8 minutes total');
    });
  });

  it('is deterministic (same input ⇒ same output)', () => {
    const input = '19:08 → 19:50 PT (~42 min)';
    const a = parseDuration(input);
    const b = parseDuration(input);
    expect(a).toEqual(b);
  });
});
