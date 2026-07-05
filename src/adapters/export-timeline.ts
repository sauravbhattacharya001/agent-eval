/**
 * Shared "finalize a trace-export session timeline" helper for the trace-export
 * adapters.
 *
 * Every export adapter (OTLP, LangSmith, AgentLens) assembles its final
 * {@link RunTimeline} the same way once it has computed the session's start ms,
 * end ms, finished-ness, ordered events, and per-segment assistant text:
 *
 *   - `startedAt` is the finite start ms, or a source-specific fallback when the
 *     start could not be parsed to a number (each source carries its own raw
 *     start value to fall back to — e.g. the original ISO string — so that stays
 *     a caller-supplied parameter);
 *   - `endedAt` is attached ONLY when the run reached a clean end AND that end is
 *     a finite ms — an unfinished / hung / still-active run deliberately omits
 *     `endedAt` so the staleness checks treat it as "no end observed";
 *   - `events` are carried through as-is;
 *   - `output` is the assistant segments joined with newlines and hard-capped at
 *     {@link TIMELINE_OUTPUT_CAP} characters (the timeline output is a preview for
 *     content-based abandonment detection, not the full transcript).
 *
 * Each adapter previously carried a byte-identical copy of this object literal,
 * differing ONLY in the `startedAt` fallback expression and which locals fed the
 * values. This module is their single home for the identical assembly; each call
 * site keeps its own — genuinely source-specific — start/end/finished derivation
 * and delegates the shared shaping here.
 *
 * It is the exact sibling of {@link ./runtime-floor.runtimeFloorFromActivity},
 * {@link ./content-clip.clip} and {@link ./tool-signature.toolSig}, which are
 * likewise shared by every adapter.
 *
 * Pure and dependency-free: no IO, no throw.
 *
 * @module
 */

import type { RunEvent, RunTimeline } from '../checks/staleness.js';

/**
 * Max characters retained for a built timeline's `output` preview.
 *
 * The timeline `output` feeds content-based abandonment/staleness detection, which
 * looks at the shape and tail of the response, so a bounded preview is sufficient;
 * the full assistant text is preserved separately (e.g. `SessionMeta.allAssistantText`).
 */
export const TIMELINE_OUTPUT_CAP = 4000;

/** Inputs for {@link buildExportTimeline}. */
export interface ExportTimelineInput {
  /** Session start in ms (may be `NaN` when it could not be parsed). */
  startMs: number;
  /**
   * Source-specific value to use for `startedAt` when `startMs` is not finite —
   * typically the original raw start value (e.g. an ISO string) so no information
   * is lost, falling back to `0`.
   */
  startFallback: string | number;
  /** Session end in ms (may be `NaN` when the run never cleanly ended). */
  endMs: number;
  /**
   * Whether the run reached a clean end (i.e. NOT missing-end). `endedAt` is
   * attached only when this is `true` AND `endMs` is finite.
   */
  finished: boolean;
  /** Ordered timeline events (carried through unchanged). */
  events: RunEvent[];
  /** Assistant text segments, in order; joined + capped for the `output` preview. */
  assistantTexts: string[];
}

/**
 * Assemble the final {@link RunTimeline} an export adapter hands to triage.
 *
 * Reproduces, byte-for-byte, the object literal each of the OTLP, LangSmith and
 * AgentLens adapters built inline:
 *
 * ```ts
 * const timeline: RunTimeline = {
 *   startedAt: Number.isFinite(startMs) ? startMs : startFallback,
 *   ...(finished && Number.isFinite(endMs) ? { endedAt: endMs } : {}),
 *   events,
 *   output: assistantTexts.join('\n').slice(0, TIMELINE_OUTPUT_CAP),
 * };
 * ```
 *
 * The property order (`startedAt`, then the optional `endedAt`, then `events`,
 * then `output`) is preserved so the produced object is indistinguishable from
 * the previous inline literals.
 */
export function buildExportTimeline(input: ExportTimelineInput): RunTimeline {
  const { startMs, startFallback, endMs, finished, events, assistantTexts } = input;
  return {
    startedAt: Number.isFinite(startMs) ? startMs : startFallback,
    ...(finished && Number.isFinite(endMs) ? { endedAt: endMs } : {}),
    events,
    output: assistantTexts.join('\n').slice(0, TIMELINE_OUTPUT_CAP),
  };
}
