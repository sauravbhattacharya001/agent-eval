/**
 * Duration Parser - natural-language run-duration extraction.
 *
 * A single pure function, {@link parseDuration}, that turns the free-form
 * `## Duration` line a cron worker writes ("~15 minutes total",
 * "18:00 → 18:14 PT (~14 minutes)", "1h 23m", "45 sec") into a typed
 * {@link ParsedDuration} (`{ ms, raw, exact }`).
 *
 * Why a separate module? The `## Duration` grammar is the single most
 * ambiguous field in a worker transcript - it mixes explicit `h/m/s` tokens,
 * bare numbers, and start→end clock ranges, sometimes all at once, and the
 * disambiguation rules (prefer the exact clock range over summed tokens so a
 * headline range plus a sub-duration breakdown does not double-count) are the
 * subtlest logic in `transcript-reader.ts`. Isolating it here keeps the
 * transcript parser focused on section/reference extraction, and gives this
 * self-contained sub-grammar its own home and its own direct test suite. The
 * parser re-exports {@link parseDuration}, so the public import path is
 * unchanged.
 *
 * No AI, no network, no clock dependence. Same input ⇒ same output, always.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { ParsedDuration } from './types.js';

/**
 * Parse a duration string like:
 *   - "~15 minutes total"
 *   - "18:00 → 18:14 PT (~14 minutes)"
 *   - "Start 09:00 PT  End ~09:05 PT, ~5 minutes"
 *   - "1h 23m"
 *   - "45 sec"
 *
 * Strategy: try the explicit "h/m/s" tokens first, fall back to a numeric
 * value with a unit word. If two clock times are present, use their diff
 * if no explicit duration is found.
 */
export function parseDuration(body: string): ParsedDuration {
  const raw = body.trim();
  if (!raw) return { ms: Number.NaN, raw, exact: false };

  const lower = raw.toLowerCase();

  // 1) Prefer an explicit clock-time RANGE like "19:08 PT → 19:50 PT".
  //    A start→end range is authoritative and unambiguous. We check it before
  //    token-summing because transcripts often pair a headline range with a
  //    breakdown of sub-durations ("~11 min before kill", "~1 min each"), and
  //    blindly summing every "N min" token double-counts those chunks and
  //    overshoots the true wall-clock time. The range, by contrast, is exact.
  const clockMatches = [...raw.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
  if (clockMatches.length >= 2) {
    const first = clockMatches[0];
    const last = clockMatches[clockMatches.length - 1];
    if (first && last) {
      const startH = parseInt(first[1] ?? '0', 10);
      const startM = parseInt(first[2] ?? '0', 10);
      const endH = parseInt(last[1] ?? '0', 10);
      const endM = parseInt(last[2] ?? '0', 10);
      if (startH < 24 && endH < 24 && startM < 60 && endM < 60) {
        let diffMin = endH * 60 + endM - (startH * 60 + startM);
        if (diffMin < 0) diffMin += 24 * 60; // crossed midnight
        if (diffMin > 0) {
          // A clock range is exact wall-clock time; the prose "~42 minutes" that
          // usually accompanies it is the approximation, not this.
          return { ms: diffMin * 60_000, raw, exact: true };
        }
      }
    }
  }

  // 2) Otherwise sum explicit tokens like "1h 23m 4s", "1 h", "23 min", "5 s".
  let totalMs = 0;
  let matchedAny = false;

  // Hours.
  for (const m of lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/g)) {
    totalMs += parseFloat(m[1] ?? '0') * 3_600_000;
    matchedAny = true;
  }
  // Minutes (must NOT match "min..." inside "minutes" twice; \b after handles it).
  for (const m of lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/g)) {
    totalMs += parseFloat(m[1] ?? '0') * 60_000;
    matchedAny = true;
  }
  // Seconds.
  for (const m of lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/g)) {
    totalMs += parseFloat(m[1] ?? '0') * 1_000;
    matchedAny = true;
  }

  if (matchedAny && totalMs > 0) {
    const approx = /~/.test(raw) || /about\s+/i.test(raw) || /approx/i.test(raw);
    return { ms: totalMs, raw, exact: !approx };
  }

  // 3) Bare number → assume minutes, the most common unit in our transcripts.
  const numMatch = /(\d+(?:\.\d+)?)/.exec(raw);
  if (numMatch) {
    return { ms: parseFloat(numMatch[1] ?? '0') * 60_000, raw, exact: false };
  }

  return { ms: Number.NaN, raw, exact: false };
}
