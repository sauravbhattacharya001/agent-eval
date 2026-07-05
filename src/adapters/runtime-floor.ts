/**
 * Shared "runtime floor from last observed activity" helper for the trace-export
 * adapters.
 *
 * Every export adapter (OTLP, LangSmith, AgentLens) computes a session's runtime
 * the same way: prefer a real `end - start` span, but when the run is UNFINISHED
 * (no end timestamp — a hung/timed-out/still-active session) fall back to a FLOOR
 * duration measured from the last activity actually observed in the trace. The
 * floor is honest — "we saw work for at least this long, then it stopped
 * emitting" — and beats rendering an unknown `?`.
 *
 * Each adapter previously carried a byte-identical copy of that fallback loop,
 * differing ONLY in how it enumerates candidate timestamps (span start/end,
 * run start/end, event timestamp + duration). This module is their single home
 * for the identical reduction; each call site keeps its own — genuinely
 * source-specific — candidate generation and delegates the shared "max finite
 * candidate above `start`, else NaN" computation here.
 *
 * It is the exact sibling of {@link ./content-clip.clip} and {@link
 * ./tool-signature.toolSig}, which are likewise shared by every adapter.
 *
 * Pure and dependency-free: no IO, no throw.
 *
 * @module
 */

/**
 * Floor a session's runtime from the last observed activity.
 *
 * Given the session `startMs` and a stream of candidate activity timestamps (in
 * ms), returns `lastActivity - startMs` where `lastActivity` is the largest
 * finite candidate that is strictly greater than `startMs`. When no candidate
 * exceeds `startMs` (or `startMs` itself is not finite) the runtime is unknown
 * and `NaN` is returned.
 *
 * This is the deterministic, unfinished-run fallback shared by the OTLP,
 * LangSmith and AgentLens adapters. It mirrors, byte-for-byte, the loop each
 * adapter used inline:
 *
 * ```ts
 * let last = start;
 * for (const t of candidates) if (Number.isFinite(t) && t > last) last = t;
 * if (last > start) runtimeMs = last - start;   // else stays NaN
 * ```
 *
 * Callers still own candidate extraction (which fields, how they are parsed to
 * ms, any duration extension), so no source-specific behaviour moves here.
 *
 * @param startMs     the session start in ms (may be `NaN` if unknown)
 * @param candidates  finite-or-not candidate activity timestamps in ms
 * @returns the floored runtime in ms, or `NaN` when it cannot be determined
 */
export function runtimeFloorFromActivity(
  startMs: number,
  candidates: Iterable<number>,
): number {
  if (!Number.isFinite(startMs)) return NaN;
  let last = startMs;
  for (const t of candidates) {
    if (Number.isFinite(t) && t > last) last = t;
  }
  return last > startMs ? last - startMs : NaN;
}
