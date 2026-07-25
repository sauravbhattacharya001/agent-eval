/**
 * Behavioural-footprint PROOF readers + derived metrics (Section F, slice 2).
 *
 * This is the mechanical core of {@link ../checks/trace-footprint.ts | trace-footprint}:
 * the pure functions that read PROOF records off an ingested trace and reduce
 * them into the raw metric slices (tool outcomes, retry stats, recovery stats,
 * token totals). It carries the SAME hard guardrail as its caller — it reads
 * PROOF only and never treats a CLAIM field as evidence (see the module doc of
 * `trace-footprint.ts` and the static map in `trace-provenance.ts`).
 *
 * It is split out purely for readability/testability: `trace-footprint.ts`
 * stays the orchestrator + public API, this file holds the number-crunching
 * seams. No behaviour changes on either side.
 *
 * Pure and IO-free: no network, no disk, no mutation of the input.
 *
 * @tier 1 — Deterministic counts/errors/timing; the derived rates are Tier-2
 *           statistics over those Tier-1 facts. No AI, no IO, no network.
 * @module
 */

import type {
  TraceSession,
  TraceProvenance,
  ProvenanceRecord,
} from '../monitoring/trace-provenance.js';
import type { ToolOutcome } from './trace-footprint-types.js';

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
export function isErrorResult(toolOutput: unknown): boolean {
  if (toolOutput == null || typeof toolOutput !== 'object') return false;
  const out = toolOutput as Record<string, unknown>;
  if (out.is_error === true) return true;
  if (typeof out.exit_code === 'number' && out.exit_code !== 0) return true;
  return false;
}

/** Read a numeric PROOF field off a record value, else `null`. */
export function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build the per-tool-call PROOF outcomes for a session. One {@link ToolOutcome}
 * per `tool_call.tool_output` PROOF record, attributed to its event and (for
 * labeling only) its chosen `tool_name`.
 */
export function toolOutcomes(tp: TraceProvenance): ToolOutcome[] {
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
export function retryStats(outcomes: ToolOutcome[]): {
  longestRetryStreak: number;
  retryCount: number;
} {
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
export function recoveryStats(outcomes: ToolOutcome[]): {
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
export function tokenTotals(
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
