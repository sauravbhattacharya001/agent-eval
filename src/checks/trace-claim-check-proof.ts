/**
 * Claim↔Proof cross-check (Section F, slice 3) — the PROOF side.
 *
 * This module owns everything on the **unforgeable** side of the cross-check:
 * reading the harness's tool results and indexing them so a model claim can be
 * matched against them. It is deliberately split out of `trace-claim-check.ts`
 * so the "what counts as PROOF" logic lives in one small, auditable place — the
 * ONLY place a tool result decides an outcome (see the HARD GUARDRAIL in
 * eval-task.md §F). Nothing here reads a model-authored field as evidence.
 *
 * Pure and IO-free: no network, no disk, no mutation of the input.
 *
 * @tier 1 — Deterministic: the success/failure verdict comes only from the
 *           harness's own error flags; no AI, no IO, no network.
 * @module
 */

import type { TraceProvenance } from '../monitoring/trace-provenance.js';

// ─── PROOF READERS (the ONLY place tool results decide an outcome) ──────────────

/**
 * Decide whether a PROOF tool result represents an error — the single
 * unforgeable success/failure verdict. Mirrors the harness-error semantics used
 * by slice 2 and the action adapter: an explicit `is_error === true`, OR a
 * non-zero numeric `exit_code`. Both come from the harness, never the model.
 */
export function isErrorResult(toolOutput: unknown): boolean {
  if (toolOutput == null || typeof toolOutput !== 'object') return false;
  const out = toolOutput as Record<string, unknown>;
  if (out.is_error === true) return true;
  if (typeof out.exit_code === 'number' && out.exit_code !== 0) return true;
  return false;
}

/** Concatenate the textual PROOF channels of a tool result (lower-cased), for signature matching. */
export function proofText(toolOutput: unknown): string {
  if (toolOutput == null || typeof toolOutput !== 'object') return '';
  const out = toolOutput as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['stdout', 'stderr', 'output', 'result', 'message']) {
    const v = out[key];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join('\n').toLowerCase();
}

// ─── PROOF INDEX: one entry per harness tool result ─────────────────────────────

/** A single PROOF tool result, the unforgeable anchor a claim is matched against. */
export interface ProofToolResult {
  eventIndex: number;
  /** The model-chosen tool name (used as a signature key, not as success evidence). */
  toolName: string;
  /** Whether the harness flagged the call as an error (the only outcome signal). */
  isError: boolean;
  /** Lower-cased PROOF text channels (stdout/stderr/…), for keyword signatures. */
  text: string;
}

/**
 * Build the PROOF index for a session: one {@link ProofToolResult} per
 * `tool_call.tool_output` PROOF record. `tool_name` is read from the CLAIM
 * record purely as a signature label so a predicate can locate "the push tool";
 * the success/failure verdict comes ONLY from the PROOF `tool_output`.
 */
export function buildProofIndex(tp: TraceProvenance): ProofToolResult[] {
  const byEvent = new Map<number, { output?: unknown; toolName: string }>();
  const ensure = (eventIndex: number) => {
    let slot = byEvent.get(eventIndex);
    if (!slot) {
      slot = { toolName: '<unknown>' };
      byEvent.set(eventIndex, slot);
    }
    return slot;
  };

  for (const record of tp.records) {
    if (record.path === 'tool_call.tool_output') {
      ensure(record.eventIndex).output = record.value; // PROOF
    } else if (record.path === 'tool_call.tool_name') {
      const slot = ensure(record.eventIndex);
      if (typeof record.value === 'string' && record.value.length > 0) {
        slot.toolName = record.value; // CLAIM, label only
      }
    }
  }

  return [...byEvent.entries()]
    .filter(([, slot]) => 'output' in slot)
    .sort(([a], [b]) => a - b)
    .map(([eventIndex, slot]) => ({
      eventIndex,
      toolName: slot.toolName,
      isError: isErrorResult(slot.output),
      text: proofText(slot.output),
    }));
}
