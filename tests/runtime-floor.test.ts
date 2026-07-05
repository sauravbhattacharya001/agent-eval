/**
 * Tests for the shared `runtimeFloorFromActivity` helper — the "floor a session's
 * runtime from the last observed activity" fallback that every trace-export
 * adapter (OTLP, LangSmith, AgentLens) uses when a run is UNFINISHED (no end
 * timestamp) and a real `end - start` runtime cannot be computed.
 *
 * This logic previously lived as a byte-identical private loop inside all three
 * adapters, differing only in how each enumerated candidate timestamps; it now
 * has one home (`./runtime-floor.js`) and this suite pins its contract directly
 * instead of only exercising it transitively through each adapter's `parse*`
 * round-trip.
 *
 * The properties that matter for the extraction to be safe (each adapter's inline
 * loop was `let last = start; for (t) if (finite(t) && t > last) last = t; if
 * (last > start) rt = last - start`):
 *   1. Only finite candidates strictly greater than `start` move the floor.
 *   2. When no candidate exceeds `start`, the runtime is unknown → `NaN` (never
 *      `0`, never a negative), matching the old "if (last > start)" guard that
 *      left `runtimeMs` at its `NaN` default.
 *   3. A non-finite `start` short-circuits to `NaN` — the old guard was
 *      `!finite(runtimeMs) && finite(start)`, so a missing start never produced a
 *      runtime.
 */

import { describe, expect, it } from 'vitest';

import { runtimeFloorFromActivity } from '../src/adapters/runtime-floor.js';

describe('runtimeFloorFromActivity — start guards', () => {
  it('returns NaN when start is NaN, regardless of candidates', () => {
    expect(runtimeFloorFromActivity(NaN, [10, 20, 30])).toBeNaN();
  });

  it('returns NaN when start is +Infinity (not finite)', () => {
    expect(runtimeFloorFromActivity(Infinity, [10, 20])).toBeNaN();
  });

  it('returns NaN when start is -Infinity (not finite)', () => {
    // -Infinity is not finite, so the helper short-circuits BEFORE comparing —
    // it never claims a runtime off a bogus start even though every candidate
    // would exceed it.
    expect(runtimeFloorFromActivity(-Infinity, [10, 20])).toBeNaN();
  });
});

describe('runtimeFloorFromActivity — the floor computation', () => {
  it('returns the max candidate minus start when candidates exceed start', () => {
    expect(runtimeFloorFromActivity(100, [150, 300, 200])).toBe(200);
  });

  it('uses the LARGEST exceeding candidate, not the last one seen', () => {
    // order must not matter: 500 is the max even though 250 comes after it
    expect(runtimeFloorFromActivity(100, [500, 250, 120])).toBe(400);
  });

  it('returns NaN when NO candidate exceeds start (unknown, not zero)', () => {
    // every candidate <= start → the old `if (last > start)` guard was false →
    // runtimeMs stayed at its NaN default. Must NOT collapse to 0.
    const out = runtimeFloorFromActivity(100, [100, 90, 50]);
    expect(out).toBeNaN();
    expect(out).not.toBe(0);
  });

  it('returns NaN for an empty candidate stream', () => {
    expect(runtimeFloorFromActivity(100, [])).toBeNaN();
  });

  it('treats a candidate exactly equal to start as non-advancing (strict >)', () => {
    expect(runtimeFloorFromActivity(100, [100])).toBeNaN();
    expect(runtimeFloorFromActivity(100, [100, 101])).toBe(1);
  });
});

describe('runtimeFloorFromActivity — non-finite candidates are skipped', () => {
  it('ignores NaN candidates and floors off the finite ones', () => {
    expect(runtimeFloorFromActivity(100, [NaN, 250, NaN])).toBe(150);
  });

  it('ignores Infinity candidates (Number.isFinite filters them)', () => {
    // a bogus Infinity must not become an astronomically large runtime
    expect(runtimeFloorFromActivity(100, [Infinity, 180])).toBe(80);
  });

  it('returns NaN when every candidate is non-finite', () => {
    expect(runtimeFloorFromActivity(100, [NaN, Infinity, -Infinity])).toBeNaN();
  });
});

describe('runtimeFloorFromActivity — parity with the adapters’ candidate streams', () => {
  it('matches the OTLP/LangSmith pattern: interleaved start/end candidates', () => {
    // adapters yield [start, end] per span/run; a missing end (NaN) is skipped and
    // the floor comes from the last finite activity we DID observe.
    const spans = [
      { startMs: 1000, endMs: 1200 },
      { startMs: 1200, endMs: NaN }, // unfinished span → end missing
      { startMs: 1500, endMs: NaN },
    ];
    const candidates = (function* () {
      for (const s of spans) yield* [s.startMs, s.endMs];
    })();
    // last finite activity is the 1500 start → 1500 - 1000 = 500
    expect(runtimeFloorFromActivity(1000, candidates)).toBe(500);
  });

  it('matches the AgentLens pattern: a duration extension can be the last activity', () => {
    // AgentLens also yields `t + duration_ms`; an event that starts at 1400 and
    // runs 300ms extends observed activity to 1700, beyond any bare timestamp.
    const evs = [
      { t: 1000, dur: 100 },
      { t: 1400, dur: 300 },
    ];
    const candidates = (function* () {
      for (const e of evs) {
        yield e.t;
        yield e.t + e.dur;
      }
    })();
    // furthest activity = 1400 + 300 = 1700 → 1700 - 1000 = 700
    expect(runtimeFloorFromActivity(1000, candidates)).toBe(700);
  });

  it('consumes a one-shot generator exactly once (no re-iteration assumptions)', () => {
    let pulls = 0;
    function* gen() {
      for (const t of [200, 400]) {
        pulls += 1;
        yield t;
      }
    }
    expect(runtimeFloorFromActivity(100, gen())).toBe(300);
    expect(pulls).toBe(2);
  });
});
