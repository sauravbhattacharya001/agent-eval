/**
 * Behavioural footprint (Section F, slice 2) — PROOF-only run metrics.
 *
 * Section F evaluates an agent = `(model × harness)` to answer the two
 * selection questions ("given a model, which harness?"; "given a harness, which
 * model?"). It is a **Tier 1 + Tier 2 ONLY** pillar — Tier 3 (model-as-judge)
 * is NEVER used here. This module is the cleanest, fully-mechanical slice: it
 * computes a behavioural footprint of one run from **PROOF only**.
 *
 * What "PROOF only" means here (see the HARD GUARDRAIL in eval-task.md §F and
 * the static map in `../monitoring/trace-provenance.js`):
 *
 *   - Every success/error/timing/token figure is read from a record that
 *     {@link ingestTrace} labeled `proof` — harness/runtime/code-produced data
 *     the agent could not author (`tool_output.is_error`/`exit_code`,
 *     `duration_ms`, `tokens_in`/`tokens_out`, collector rollups).
 *   - No CLAIM field is ever consulted as evidence. The model's chosen
 *     `tool_name`/`tool_input`, its narration (`output_data` on a non-tool
 *     event) and its `decision_trace.*` reasoning are the *hypothesis*, not
 *     proof. `tool_name` is used here ONLY as a label to attribute a retry
 *     streak to "the same tool" — never to decide whether a call succeeded.
 *   - This is a behavioural footprint, so it deliberately answers only what the
 *     harness's own outputs can prove: how many steps, how many errored, did it
 *     thrash, did it recover, what did it cost. The claim↔proof cross-check
 *     (slice 3) and the cross-run ranking (slice 4) build on these signals.
 *
 * The mechanical PROOF readers and derived-metric reducers live in
 * `./trace-footprint-metrics.js`; this module is the orchestrator + public API
 * (the `analyzeFootprint` entry point, the summary string, and the Tier-2
 * predicate helpers). The split is behaviour-preserving.
 *
 * Pure and IO-free: no network, no disk, no mutation of the input. Load a trace
 * from a recorded fixture or a collector at the IO edge — never inside this
 * core.
 *
 * @tier 1 — Deterministic for the counts/errors/timing facts; the *rates* and
 *           threshold flags are Tier-2 statistics computed over those Tier-1
 *           facts. No AI, no IO, no network.
 * @module
 */

import { ingestTrace, type TraceSession, type TraceProvenance } from '../monitoring/trace-provenance.js';
import type { FootprintOptions, FootprintResult } from './trace-footprint-types.js';
import { toolOutcomes, retryStats, recoveryStats, tokenTotals } from './trace-footprint-metrics.js';

// Re-export the type vocabulary so consumers keep a single import path.
export type { FootprintOptions, FootprintResult, ToolOutcome } from './trace-footprint-types.js';

// ─── PUBLIC: analyze one run's behavioural footprint ────────────────────────────

/**
 * Compute the behavioural footprint of a single agent run from PROOF only.
 *
 * Accepts either a raw {@link TraceSession} (it will be ingested internally) or
 * an already-{@link ingestTrace | ingested} {@link TraceProvenance}, so callers
 * that need both the provenance partition and the footprint don't pay to ingest
 * twice. One nuance: token totals prefer the collector session rollup
 * (`total_tokens_in`/`total_tokens_out`) when a raw {@link TraceSession} is
 * passed; given only a {@link TraceProvenance} (which has no top-level session
 * rollup) they fall back to summing the per-event `tokens_*` PROOF meters. Both
 * sources are PROOF; pass the raw session when you want the authoritative rollup.
 *
 * @param trace A decoded trace session, or its {@link TraceProvenance}.
 * @param options Threshold knobs (see {@link FootprintOptions}). None of them
 *   changes what counts as proof — only when the convenience flags trip.
 * @returns A {@link FootprintResult} — the per-run signal slice 4 ranks across
 *   runs to answer the two selection questions.
 */
export function analyzeFootprint(
  trace: TraceSession | TraceProvenance,
  options: FootprintOptions = {},
): FootprintResult {
  const { maxToolCalls = Infinity, maxToolErrorRate = 0.5, maxRetryStreak = 2 } = options;

  // Normalize to (session, provenance). A TraceProvenance carries `records`;
  // a TraceSession carries `events` — use that to tell them apart.
  const isProvenance = (t: TraceSession | TraceProvenance): t is TraceProvenance =>
    Array.isArray((t as TraceProvenance).records);
  const tp: TraceProvenance = isProvenance(trace) ? trace : ingestTrace(trace);
  // Reconstruct the session view for token rollups (only the two totals + events
  // count are needed, and they are NEUTRAL/PROOF top-level session fields, not
  // per-event records). When given a TraceProvenance we don't have the raw
  // session, so fall back to summing the PROOF per-event token records.
  const session: TraceSession = isProvenance(trace) ? {} : trace;

  const outcomes = toolOutcomes(tp);
  const toolCalls = outcomes.length;
  const toolErrors = outcomes.filter((o) => o.isError).length;
  const toolErrorRate = toolCalls === 0 ? 0 : toolErrors / toolCalls;

  const { longestRetryStreak, retryCount } = retryStats(outcomes);
  const { recoveredErrors, unrecoveredErrors, recoveryRate } = recoveryStats(outcomes);
  const { tokensIn, tokensOut } = tokenTotals(session, tp.records);

  const toolDurationMs = outcomes.reduce((acc, o) => acc + (o.durationMs ?? 0), 0);

  const withinStepBudget = toolCalls <= maxToolCalls;
  const excessiveErrors = toolErrorRate > maxToolErrorRate;
  const thrashing = longestRetryStreak > maxRetryStreak;

  const summary = buildSummary({
    totalEvents: tp.eventCount,
    toolCalls,
    toolErrors,
    toolErrorRate,
    longestRetryStreak,
    recoveredErrors,
    unrecoveredErrors,
    tokensIn,
    tokensOut,
  });

  return {
    totalEvents: tp.eventCount,
    toolCalls,
    toolErrors,
    toolErrorRate,
    longestRetryStreak,
    retryCount,
    recoveryRate,
    recoveredErrors,
    unrecoveredErrors,
    toolDurationMs,
    tokensIn,
    tokensOut,
    withinStepBudget,
    excessiveErrors,
    thrashing,
    outcomes,
    summary,
  };
}

function buildSummary(parts: {
  totalEvents: number;
  toolCalls: number;
  toolErrors: number;
  toolErrorRate: number;
  longestRetryStreak: number;
  recoveredErrors: number;
  unrecoveredErrors: number;
  tokensIn: number;
  tokensOut: number;
}): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const bits = [
    `${parts.totalEvents} events`,
    `${parts.toolCalls} tool calls`,
    `${parts.toolErrors} errors (${pct(parts.toolErrorRate)})`,
  ];
  if (parts.longestRetryStreak >= 2) {
    bits.push(`longest same-tool retry streak ${parts.longestRetryStreak}`);
  }
  if (parts.unrecoveredErrors > 0) {
    bits.push(`${parts.unrecoveredErrors} unrecovered`);
  } else if (parts.recoveredErrors > 0) {
    bits.push(`all ${parts.recoveredErrors} recovered`);
  }
  bits.push(`${parts.tokensIn}/${parts.tokensOut} tok in/out`);
  return bits.join(', ');
}

// ─── PROOF-ONLY PREDICATES (Tier-2 verdicts for use in selection/gating) ────────
//
// Slice 2 evaluates a TRACE, not a string, so these are predicate helpers over
// a FootprintResult rather than string `Assertion` factories (which take output
// text and don't fit a trace). They give the selection layer (slice 4) and any
// CI gate a stable, mechanical yes/no over PROOF.

/**
 * `true` iff the run used at most `maxToolCalls` tool calls (step budget).
 *
 * A non-finite `maxToolCalls` (`NaN`/`±Infinity`, e.g. a mis-computed budget)
 * would make the raw `<=` silently return `false` for `NaN` — flagging a clean
 * run as over-budget — or accept everything for `+Infinity`. We treat a
 * non-finite bound as "no step budget" (unbounded → pass), never as a silent
 * fail, so a broken threshold can't manufacture a false gate failure.
 */
export function toCompleteWithinSteps(result: FootprintResult, maxToolCalls: number): boolean {
  if (!Number.isFinite(maxToolCalls)) return true; // no/invalid budget ⇒ unbounded
  return result.toolCalls <= maxToolCalls;
}

/**
 * `true` iff the tool-error rate is at most `maxRate` (0–1).
 *
 * A non-finite `maxRate` (`NaN`/`±Infinity`) is not a usable bound: `rate <= NaN`
 * is always `false`, so a `NaN` threshold would fail every run — a false alarm.
 * Treat a non-finite bound as "no error-rate ceiling" (unbounded → pass) rather
 * than letting a broken threshold silently condemn a clean run.
 */
export function toHaveToolErrorRateBelow(result: FootprintResult, maxRate: number): boolean {
  if (!Number.isFinite(maxRate)) return true; // no/invalid ceiling ⇒ unbounded
  return result.toolErrorRate <= maxRate;
}

/**
 * `true` iff the longest same-tool retry-after-error streak is at most
 * `maxStreak`. A non-finite `maxStreak` is treated as "no thrash ceiling"
 * (unbounded → pass) for the same reason: `streak <= NaN` is always `false`,
 * which would report thrashing on a run that never retried.
 */
export function toNotThrash(result: FootprintResult, maxStreak = 2): boolean {
  if (!Number.isFinite(maxStreak)) return true; // no/invalid ceiling ⇒ unbounded
  return result.longestRetryStreak <= maxStreak;
}

/** `true` iff every recoverable error was eventually followed by a success. */
export function toRecoverFromErrors(result: FootprintResult): boolean {
  return result.unrecoveredErrors === 0;
}
