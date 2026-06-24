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
 * Pure and IO-free: no network, no disk, no mutation of the input. Load a trace
 * from a recorded fixture or a collector at the IO edge — never inside this
 * core.
 *
 * @tier 1 — Deterministic for the counts/errors/timing facts; the *rates* and
 *           threshold flags are Tier-2 statistics computed over those Tier-1
 *           facts. No AI, no IO, no network.
 * @module
 */

import {
  ingestTrace,
  type TraceSession,
  type TraceProvenance,
  type ProvenanceRecord,
} from '../monitoring/trace-provenance.js';
import type {
  FootprintOptions,
  FootprintResult,
  ToolOutcome,
} from './trace-footprint-types.js';

// Re-export the type vocabulary so consumers keep a single import path.
export type { FootprintOptions, FootprintResult, ToolOutcome } from './trace-footprint-types.js';

// ─── PROOF READERS (the ONLY place tool results are inspected) ──────────────────

/**
 * Decide whether a PROOF tool result represents an error — the single
 * unforgeable success/failure verdict. Mirrors the harness-error semantics used
 * elsewhere in the action adapter: an explicit `is_error === true`, OR a
 * non-zero numeric `exit_code`. Both come from the harness, never the model.
 *
 * A result that is `null`, non-object, or carries neither signal is treated as
 * NOT an error (absence of an error flag is not evidence of failure).
 */
function isErrorResult(toolOutput: unknown): boolean {
  if (toolOutput == null || typeof toolOutput !== 'object') return false;
  const out = toolOutput as Record<string, unknown>;
  if (out.is_error === true) return true;
  if (typeof out.exit_code === 'number' && out.exit_code !== 0) return true;
  return false;
}

/** Read a numeric PROOF field off a record value, else `null`. */
function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build the per-tool-call PROOF outcomes for a session. One {@link ToolOutcome}
 * per `tool_call.tool_output` PROOF record, attributed to its event and (for
 * labeling only) its chosen `tool_name`.
 */
function toolOutcomes(tp: TraceProvenance): ToolOutcome[] {
  // Group the relevant records by event so each tool call yields one outcome.
  // tool_output / tool_call.duration_ms are PROOF; tool_name is a CLAIM used
  // strictly as a grouping label (never as success/failure evidence).
  const byEvent = new Map<
    number,
    { output?: unknown; durationMs: number | null; toolName: string }
  >();

  const ensure = (eventIndex: number) => {
    let slot = byEvent.get(eventIndex);
    if (!slot) {
      slot = { durationMs: null, toolName: '<unknown>' };
      byEvent.set(eventIndex, slot);
    }
    return slot;
  };

  for (const record of tp.records) {
    if (record.path === 'tool_call.tool_output') {
      // PROOF: the actual tool result.
      ensure(record.eventIndex).output = record.value;
    } else if (record.path === 'tool_call.duration_ms') {
      // PROOF: harness timing for the tool.
      ensure(record.eventIndex).durationMs = numericValue(record.value);
    } else if (record.path === 'tool_call.tool_name') {
      // CLAIM: label only, so a retry streak can be attributed to the same tool.
      const slot = ensure(record.eventIndex);
      if (typeof record.value === 'string' && record.value.length > 0) {
        slot.toolName = record.value;
      }
    }
  }

  return [...byEvent.entries()]
    .filter(([, slot]) => 'output' in slot) // only events that produced a tool result
    .sort(([a], [b]) => a - b)
    .map(([eventIndex, slot]) => ({
      eventIndex,
      toolName: slot.toolName,
      isError: isErrorResult(slot.output),
      durationMs: slot.durationMs,
    }));
}

// ─── DERIVED FOOTPRINT METRICS (all mechanical over PROOF) ──────────────────────

/** Longest run of same-tool calls that began with an errored call, and total retries. */
function retryStats(outcomes: ToolOutcome[]): { longestRetryStreak: number; retryCount: number } {
  let longestRetryStreak = 0;
  let retryCount = 0;

  let i = 0;
  while (i < outcomes.length) {
    const head = outcomes[i];
    if (head === undefined) break;
    // A retry streak is a maximal run of the SAME tool whose first call errored
    // (the agent re-running the same tool after a failure). We only count the
    // run as a retry streak when it starts from an error.
    let j = i + 1;
    while (j < outcomes.length && outcomes[j]?.toolName === head.toolName) {
      j++;
    }
    const streakLength = j - i;
    if (streakLength >= 2 && head.isError) {
      longestRetryStreak = Math.max(longestRetryStreak, streakLength);
      retryCount += streakLength - 1;
    }
    i = j;
  }

  return { longestRetryStreak, retryCount };
}

/**
 * Recovery accounting: of the errors that were followed by *any* later tool
 * call, how many were eventually followed by a *successful* later tool call.
 * Errors with no subsequent tool call are excluded (you can't recover after the
 * run ended — that is not recovery debt, it is just the end of the run).
 */
function recoveryStats(outcomes: ToolOutcome[]): {
  recoveredErrors: number;
  unrecoveredErrors: number;
  recoveryRate: number;
} {
  let recoveredErrors = 0;
  let unrecoveredErrors = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const current = outcomes[i];
    if (current === undefined || !current.isError) continue;
    const later = outcomes.slice(i + 1);
    if (later.length === 0) continue; // no chance to recover; excluded
    if (later.some((o) => !o.isError)) recoveredErrors++;
    else unrecoveredErrors++;
  }

  const recoverable = recoveredErrors + unrecoveredErrors;
  // No recoverable errors → no recovery debt → rate 1 (nothing to recover from).
  const recoveryRate = recoverable === 0 ? 1 : recoveredErrors / recoverable;
  return { recoveredErrors, unrecoveredErrors, recoveryRate };
}

/** Sum PROOF tokens: prefer the collector session rollup, else sum per-event meters. */
function tokenTotals(
  session: TraceSession,
  records: ProvenanceRecord[],
): { tokensIn: number; tokensOut: number } {
  const rollupIn = numericValue(session.total_tokens_in);
  const rollupOut = numericValue(session.total_tokens_out);

  const sumField = (path: string) =>
    records
      .filter((r) => r.path === path)
      .reduce((acc, r) => acc + (numericValue(r.value) ?? 0), 0);

  return {
    tokensIn: rollupIn ?? sumField('tokens_in'),
    tokensOut: rollupOut ?? sumField('tokens_out'),
  };
}

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

/** `true` iff the run used at most `maxToolCalls` tool calls (step budget). */
export function toCompleteWithinSteps(result: FootprintResult, maxToolCalls: number): boolean {
  return result.toolCalls <= maxToolCalls;
}

/** `true` iff the tool-error rate is at most `maxRate` (0–1). */
export function toHaveToolErrorRateBelow(result: FootprintResult, maxRate: number): boolean {
  return result.toolErrorRate <= maxRate;
}

/** `true` iff the longest same-tool retry-after-error streak is at most `maxStreak`. */
export function toNotThrash(result: FootprintResult, maxStreak = 2): boolean {
  return result.longestRetryStreak <= maxStreak;
}

/** `true` iff every recoverable error was eventually followed by a success. */
export function toRecoverFromErrors(result: FootprintResult): boolean {
  return result.unrecoveredErrors === 0;
}
