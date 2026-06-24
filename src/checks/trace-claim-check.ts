/**
 * Claim↔Proof cross-check (Section F, slice 3) — falsify model claims with PROOF.
 *
 * Section F evaluates an agent = `(model × harness)` to answer the two
 * selection questions ("given a model, which harness?"; "given a harness, which
 * model?"). It is a **Tier 1 + Tier 2 ONLY** pillar — Tier 3 (model-as-judge)
 * is NEVER used here. This module is the headline slice: it takes each model
 * **CLAIM** (the hypothesis) and falsifies it against Tier-1 **PROOF**.
 *
 * What "claim↔proof" means here (see the HARD GUARDRAIL in eval-task.md §F and
 * the static map in `../monitoring/trace-provenance.js`):
 *
 *   - A CLAIM is anything the model authored: the tool it *chose*
 *     (`tool_call.tool_name`), or an action it *stated* in narration
 *     (`output_data.text`) or reasoning (`decision_trace.reasoning`). The claim
 *     is the QUESTION, never the answer.
 *   - PROOF is what the harness produced and the agent could not author: the
 *     actual `tool_call.tool_output` (`is_error`/`exit_code`/`stdout`/`stderr`).
 *     Each claim is judged ONLY by matching it to a PROOF signature and reading
 *     that PROOF's outcome — NEVER claim-against-claim, NEVER at face value.
 *   - A claim with NO Tier-1/2 anchor is `unverifiable`: it is EXCLUDED from the
 *     score and reported as an instrumentation gap. It is never rescued by a
 *     Tier-3 judgement and never a silent pass. Absence of unforgeable proof is
 *     not a pass.
 *
 * Two cross-check kinds, per the slice plan (intra-event first, then structured
 * cross-event):
 *
 *   1. **Intra-event** — the model chose tool X for this event; the same event
 *      carries the harness's PROOF result. Verdict = did that proven call error?
 *   2. **Cross-event** — model narration/reasoning asserts a structured action
 *      ("pushed", "build passed", "tests green", "score green"). We look for a
 *      matching PROOF tool-result *signature* later/earlier in the run and read
 *      its outcome. Free narrative with no structured predicate → `unverifiable`.
 *
 * Matching is by deterministic structured signature (a small predicate→tool-and-
 * outcome map), so the cross-check itself is incorruptible — the model cannot
 * make a claim "true" by phrasing it differently; only the harness PROOF moves
 * the verdict.
 *
 * Pure and IO-free: no network, no disk, no mutation of the input. Load a trace
 * from a recorded fixture or a collector at the IO edge — never inside this
 * core.
 *
 * @tier 1 — Deterministic: the match is by structured PROOF signature, the
 *           outcome by the harness's own error flags; the integrity ratio is a
 *           Tier-2 statistic over those Tier-1 verdicts. No AI, no IO, no network.
 * @module
 */

import {
  ingestTrace,
  type TraceSession,
  type TraceProvenance,
  type ProvenanceRecord,
} from '../monitoring/trace-provenance.js';
import type {
  ClaimCheck,
  ClaimCheckOptions,
  ClaimCheckResult,
  ClaimSource,
  ClaimVerdict,
} from './trace-claim-check-types.js';

// Re-export the type vocabulary so consumers keep a single import path.
export type {
  ClaimCheck,
  ClaimCheckOptions,
  ClaimCheckResult,
  ClaimSource,
  ClaimVerdict,
} from './trace-claim-check-types.js';

// ─── PROOF READERS (the ONLY place tool results decide an outcome) ──────────────

/**
 * Decide whether a PROOF tool result represents an error — the single
 * unforgeable success/failure verdict. Mirrors the harness-error semantics used
 * by slice 2 and the action adapter: an explicit `is_error === true`, OR a
 * non-zero numeric `exit_code`. Both come from the harness, never the model.
 */
function isErrorResult(toolOutput: unknown): boolean {
  if (toolOutput == null || typeof toolOutput !== 'object') return false;
  const out = toolOutput as Record<string, unknown>;
  if (out.is_error === true) return true;
  if (typeof out.exit_code === 'number' && out.exit_code !== 0) return true;
  return false;
}

/** Concatenate the textual PROOF channels of a tool result (lower-cased), for signature matching. */
function proofText(toolOutput: unknown): string {
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
interface ProofToolResult {
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
function buildProofIndex(tp: TraceProvenance): ProofToolResult[] {
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

// ─── STRUCTURED PREDICATE SIGNATURES (deterministic claim → PROOF matcher) ──────
//
// A claim from narration/reasoning is only admissible if it asserts one of these
// structured, falsifiable predicates. Each predicate knows how to recognise the
// PROOF tool result that would confirm/refute it: by tool-name substring and/or
// by a keyword that the HARNESS (not the model) wrote into the result text. This
// map is the whole "comprehension" budget — intentionally small and mechanical,
// so the matcher cannot be talked into a pass by clever phrasing.

interface PredicateSignature {
  /** Normalized predicate label, e.g. `push`, `build:pass`. */
  predicate: string;
  /** Phrases in the model's CLAIM text that propose this predicate (the hypothesis trigger). */
  claimPhrases: readonly string[];
  /** Tool-name substrings whose PROOF result can anchor this predicate. */
  toolNameHints: readonly string[];
  /**
   * Distinctive substrings the HARNESS writes into a relevant result's text
   * (PROOF), used to anchor a *generic* tool (e.g. a shell `run_command` whose
   * stdout is `score=0.94 PASS`) to this predicate. These must be SPECIFIC to
   * the predicate (e.g. `score=`), not generic success words like `pass`/`ok`,
   * so they don't cross-match another predicate's result. Empty → anchor by
   * tool name only.
   */
  proofSignatureKeywords: readonly string[];
}

const PREDICATE_SIGNATURES: readonly PredicateSignature[] = Object.freeze([
  {
    predicate: 'push',
    claimPhrases: ['pushed', 'push to', 'i push', 'pushing'],
    toolNameHints: ['push'],
    proofSignatureKeywords: [],
  },
  {
    predicate: 'build:pass',
    claimPhrases: [
      'rebuilt green',
      'build passed',
      'built green',
      'build succeeded',
      'build is green',
      'compiles',
    ],
    toolNameHints: ['build', 'compile'],
    proofSignatureKeywords: [],
  },
  {
    predicate: 'tests:pass',
    claimPhrases: ['tests pass', 'tests passed', 'tests are green', 'all tests pass', 'test suite green'],
    toolNameHints: ['test'],
    proofSignatureKeywords: [],
  },
  {
    predicate: 'score:green',
    claimPhrases: ['score was', 'scored', 'is green', 'passed the gate', '(green)'],
    toolNameHints: ['score'],
    proofSignatureKeywords: ['score='],
  },
]);

/**
 * Find every structured predicate a claim text proposes. Deterministic
 * substring matching over a fixed phrase list — NOT comprehension. A single
 * narration can assert several falsifiable actions ("rebuilt green, and
 * pushed"), and EACH is cross-checked independently against PROOF, so the
 * matcher returns all matches in signature order. Empty when the text asserts
 * nothing structured (→ the claim is `unverifiable`).
 */
function matchPredicates(claimTextLower: string): PredicateSignature[] {
  return PREDICATE_SIGNATURES.filter((sig) =>
    sig.claimPhrases.some((p) => claimTextLower.includes(p)),
  );
}

/**
 * Falsify a structured claim against the PROOF index. The verdict is decided
 * ONLY by the harness's tool results — never the model's words:
 *
 *   - a PROOF result ANCHORS this predicate if its tool-name matches a hint OR
 *     its harness-authored result text carries a distinctive signature keyword
 *     (so a generic shell tool whose stdout is `score=0.94 PASS` anchors the
 *     `score:green` predicate);
 *   - `verified` iff an anchored, non-errored PROOF result exists;
 *   - `contradicted` iff anchored PROOF result(s) exist but every one errored;
 *   - `unverifiable` iff NO anchored PROOF result exists at all — nothing to
 *     falsify against, so it is excluded from the score as an instrumentation
 *     gap.
 */
function falsifyAgainstProof(
  sig: PredicateSignature,
  proofs: readonly ProofToolResult[],
): { verdict: ClaimVerdict; proofEventIndex: number | null; reason: string } {
  const anchored = proofs.filter((p) => {
    const nameMatch = sig.toolNameHints.some((hint) => p.toolName.toLowerCase().includes(hint));
    const textMatch = sig.proofSignatureKeywords.some((kw) => p.text.includes(kw));
    return nameMatch || textMatch;
  });
  if (anchored.length === 0) {
    const how =
      sig.proofSignatureKeywords.length > 0
        ? `no '${sig.toolNameHints.join("'/'")}' tool ran and no result text matched '${sig.proofSignatureKeywords.join("'/'")}'`
        : `no '${sig.toolNameHints.join("'/'")}' tool ran`;
    return {
      verdict: 'unverifiable',
      proofEventIndex: null,
      reason: `no harness tool result anchors predicate "${sig.predicate}" (${how}) — instrumentation gap`,
    };
  }

  const success = anchored.find((p) => !p.isError);
  if (success) {
    return {
      verdict: 'verified',
      proofEventIndex: success.eventIndex,
      reason: `PROOF: ${success.toolName} at event ${success.eventIndex} succeeded (no harness error) — confirms "${sig.predicate}"`,
    };
  }

  // Anchored tool result(s) exist but every one errored → the claim is refuted.
  const errored = anchored[anchored.length - 1];
  return {
    verdict: 'contradicted',
    proofEventIndex: errored ? errored.eventIndex : null,
    reason: `PROOF: ${errored?.toolName ?? 'tool'} at event ${errored?.eventIndex ?? '?'} errored — refutes claimed "${sig.predicate}"`,
  };
}

// ─── CLAIM EXTRACTION (model-authored fields only) ──────────────────────────────

/** Pull the textual claim out of a CLAIM provenance record, if it carries text. */
function claimTextOf(record: ProvenanceRecord): string | undefined {
  // output_data on a non-tool event arrives as the whole object; pull `.text`
  // (the common narration field) or stringify a primitive.
  if (record.path === 'output_data') {
    const v = record.value;
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).text === 'string') {
      return (v as Record<string, unknown>).text as string;
    }
    return undefined;
  }
  if (record.path === 'decision_trace.reasoning') {
    return typeof record.value === 'string' ? record.value : undefined;
  }
  return undefined;
}

const SOURCE_BY_PATH: Readonly<Record<string, ClaimSource>> = Object.freeze({
  output_data: 'narration',
  'decision_trace.reasoning': 'reasoning',
});

// ─── PUBLIC: cross-check one run's claims against PROOF ──────────────────────────

/**
 * Cross-check every model claim in a run against Tier-1 PROOF and report claim
 * integrity. The two claim kinds are handled per the slice plan:
 *
 *   - **Intra-event tool invocations** (`tool_call.tool_name` = the model chose
 *     tool X): each is anchored to that same event's PROOF `tool_output`. The
 *     model authored the *intent*; the harness authored the *result*. Verdict =
 *     `verified` when the proven call did not error, `contradicted` when it did.
 *     A chosen tool with no PROOF result is `unverifiable`.
 *   - **Cross-event narration/reasoning** (`output_data.text`,
 *     `decision_trace.reasoning`): admitted ONLY when it asserts a structured,
 *     falsifiable predicate (push / build / tests / score); then falsified
 *     against the matching PROOF tool-result signature. Free narrative that
 *     asserts nothing structured is `unverifiable` — excluded from the score and
 *     logged as an instrumentation gap, NEVER Tier-3-judged.
 *
 * @param trace A decoded trace session, or its already-{@link ingestTrace |
 *   ingested} {@link TraceProvenance} (so callers needing both don't ingest
 *   twice).
 * @param options See {@link ClaimCheckOptions}. None changes what counts as
 *   PROOF (fixed by the static provenance map) — only whether `unverifiable`
 *   claims are emitted.
 * @returns A {@link ClaimCheckResult} — the per-run claim-integrity signal slice
 *   4's selection ranking aggregates across runs.
 */
export function crossCheckClaims(
  trace: TraceSession | TraceProvenance,
  options: ClaimCheckOptions = {},
): ClaimCheckResult {
  const { reportUnverifiable = true } = options;

  const isProvenance = (t: TraceSession | TraceProvenance): t is TraceProvenance =>
    Array.isArray((t as TraceProvenance).records);
  const tp: TraceProvenance = isProvenance(trace) ? trace : ingestTrace(trace);

  const proofs = buildProofIndex(tp);
  const proofByEvent = new Map<number, ProofToolResult>();
  for (const p of proofs) proofByEvent.set(p.eventIndex, p);

  const claims: ClaimCheck[] = [];

  // 1) Intra-event: each model-chosen tool name, anchored to its own PROOF result.
  for (const record of tp.records) {
    if (record.path !== 'tool_call.tool_name') continue;
    const toolName = typeof record.value === 'string' && record.value ? record.value : '<unknown>';
    const proof = proofByEvent.get(record.eventIndex);
    const predicate = `tool:${toolName}`;
    if (!proof) {
      // The model chose a tool but the harness emitted no result → not falsifiable.
      if (reportUnverifiable) {
        claims.push({
          eventIndex: record.eventIndex,
          source: 'tool_invocation',
          predicate,
          claimText: toolName,
          verdict: 'unverifiable',
          proofEventIndex: null,
          reason: `model chose '${toolName}' but the harness emitted no tool_output — instrumentation gap`,
        });
      }
      continue;
    }
    const verdict: ClaimVerdict = proof.isError ? 'contradicted' : 'verified';
    claims.push({
      eventIndex: record.eventIndex,
      source: 'tool_invocation',
      predicate,
      claimText: toolName,
      verdict,
      proofEventIndex: proof.eventIndex,
      reason: proof.isError
        ? `PROOF: '${toolName}' at event ${proof.eventIndex} reported a harness error — the invoked call did not succeed`
        : `PROOF: '${toolName}' at event ${proof.eventIndex} completed without a harness error`,
    });
  }

  // 2) Cross-event: structured narration/reasoning claims, falsified by signature.
  //    A single claim text may assert several falsifiable actions (e.g. "rebuilt
  //    green, and pushed"); each matched predicate is cross-checked against PROOF
  //    independently, so one narration can yield several claim records.
  for (const record of tp.records) {
    const source = SOURCE_BY_PATH[record.path];
    if (!source) continue;
    const text = claimTextOf(record);
    if (text === undefined) continue;
    const sigs = matchPredicates(text.toLowerCase());
    if (sigs.length === 0) {
      // Free narrative with no structured, falsifiable predicate → unverifiable.
      if (reportUnverifiable) {
        claims.push({
          eventIndex: record.eventIndex,
          source,
          predicate: 'narrative',
          claimText: text,
          verdict: 'unverifiable',
          proofEventIndex: null,
          reason:
            'claim asserts no structured, falsifiable action (no push/build/tests/score signal) — excluded from score, logged as instrumentation gap',
        });
      }
      continue;
    }
    for (const sig of sigs) {
      const { verdict, proofEventIndex, reason } = falsifyAgainstProof(sig, proofs);
      if (verdict === 'unverifiable' && !reportUnverifiable) continue;
      claims.push({
        eventIndex: record.eventIndex,
        source,
        predicate: sig.predicate,
        claimText: text,
        verdict,
        proofEventIndex,
        reason,
      });
    }
  }

  // Keep claims in event order, then by a stable source order within an event.
  claims.sort((a, b) => a.eventIndex - b.eventIndex);

  const verified = claims.filter((c) => c.verdict === 'verified').length;
  const contradicted = claims.filter((c) => c.verdict === 'contradicted').length;
  const unverifiable = claims.filter((c) => c.verdict === 'unverifiable').length;
  const decided = verified + contradicted;
  // Score over DECIDED claims only. `unverifiable` is excluded by construction —
  // never a silent pass, never escalated to Tier 3.
  const integrity = decided === 0 ? null : verified / decided;
  const instrumentationGaps = claims.filter((c) => c.verdict === 'unverifiable');

  return {
    claims,
    verified,
    contradicted,
    unverifiable,
    decided,
    integrity,
    instrumentationGaps,
    summary: buildSummary({ verified, contradicted, unverifiable, decided, integrity }),
  };
}

function buildSummary(parts: {
  verified: number;
  contradicted: number;
  unverifiable: number;
  decided: number;
  integrity: number | null;
}): string {
  const pct = parts.integrity === null ? 'n/a' : `${Math.round(parts.integrity * 100)}%`;
  const bits = [
    parts.decided === 0
      ? 'no falsifiable claims'
      : `claim integrity ${pct} (${parts.verified}/${parts.decided} verified)`,
  ];
  if (parts.contradicted > 0) bits.push(`${parts.contradicted} contradicted by PROOF`);
  if (parts.unverifiable > 0) bits.push(`${parts.unverifiable} unverifiable (instrumentation gaps)`);
  return bits.join(', ');
}

// ─── PROOF-ANCHORED PREDICATES (Tier-2 verdicts for selection/gating) ───────────
//
// Like slice 2, slice 3 evaluates a TRACE, so these are predicate helpers over a
// ClaimCheckResult rather than string `Assertion` factories. They give the
// selection layer (slice 4) and any CI gate a stable, mechanical yes/no.

/** `true` iff NO claim was refuted by PROOF (contradictions are the hard failure). */
export function toHaveNoContradictedClaims(result: ClaimCheckResult): boolean {
  return result.contradicted === 0;
}

/**
 * `true` iff claim integrity is at least `min` (0–1) over the DECIDED claims.
 * When nothing was decidable (`integrity === null`) there is no evidence of
 * integrity to assert, so this returns `false` — absence of proof is never a
 * pass.
 */
export function toHaveClaimIntegrityAtLeast(result: ClaimCheckResult, min: number): boolean {
  return result.integrity !== null && result.integrity >= min;
}

/** `true` iff at most `maxGaps` claims were `unverifiable` (instrumentation budget). */
export function toHaveInstrumentationGapsAtMost(
  result: ClaimCheckResult,
  maxGaps: number,
): boolean {
  return result.unverifiable <= maxGaps;
}
