/**
 * Claim↔Proof cross-check (Section F, slice 3) — type vocabulary.
 *
 * The shared types for the claim↔proof cross-check live here so both the
 * analysis engine (`./trace-claim-check.js`) and any future barrel can depend
 * on them without a cycle, mirroring the established `*-types.ts` / `*.ts` seam
 * used across `src/checks` (see `trace-footprint-types.ts`). Re-exported from
 * `./trace-claim-check.js`, so consumers keep a single import path.
 *
 * Section F judges an agent = `(model × harness)` using **Tier 1 + Tier 2
 * ONLY** — Tier 3 (model-as-judge) is NEVER used here. Slice 3 is the headline:
 * it takes each model **CLAIM** (the hypothesis — a chosen tool, a stated
 * action in narration/reasoning) and **falsifies it against Tier-1 PROOF** (the
 * harness's actual tool results, exit/error flags, side effects) that
 * {@link ../monitoring/trace-provenance.js#ingestTrace | ingestTrace} labeled.
 *
 * The verdict for each claim is therefore a deterministic comparison, never a
 * judgement:
 *
 *   - `verified`     — a Tier-1 PROOF signature matches the claim AND the proven
 *                      outcome is consistent with it (e.g. claim "I pushed" + a
 *                      non-errored `git_push` tool result).
 *   - `contradicted` — a matching PROOF signature exists but its outcome
 *                      refutes the claim (e.g. claim "build passed" + a
 *                      `run_build` result with `is_error: true`).
 *   - `unverifiable` — the claim has NO Tier-1/2 anchor to falsify it against.
 *                      Per the HARD GUARDRAIL this is **excluded from the
 *                      score** and logged as an instrumentation gap — it is
 *                      NEVER rescued by a Tier-3 judgement and NEVER a silent
 *                      pass.
 *
 * @tier 1 — Deterministic: the match is by structured PROOF signature, the
 *           outcome by the harness's own error flags. No AI, no IO, no network.
 * @module
 */

/**
 * The outcome of cross-checking one model CLAIM against Tier-1 PROOF.
 *
 * `unverifiable` is first-class and load-bearing: absence of an unforgeable
 * anchor is never treated as a pass and never escalated to Tier 3 — it is
 * surfaced as an instrumentation gap so the trace can be made checkable.
 */
export type ClaimVerdict = 'verified' | 'contradicted' | 'unverifiable';

/**
 * How a claim was extracted — its *static provenance kind*, not its content.
 * Used only to attribute a claim to where it came from (for debugging and for
 * the instrumentation-gap report); it never changes how the claim is judged.
 *
 * - `tool_invocation` — an intra-event claim: the model CHOSE a tool
 *   (`tool_call.tool_name`), checked against that same event's PROOF result.
 * - `narration`       — a cross-event claim parsed from model narration
 *   (`output_data.text` on a non-tool event).
 * - `reasoning`       — a cross-event claim parsed from `decision_trace.reasoning`.
 */
export type ClaimSource = 'tool_invocation' | 'narration' | 'reasoning';

/**
 * A single model claim paired with the verdict of falsifying it against PROOF.
 * The atomic unit slice 3 produces. Every field that decided the verdict comes
 * from PROOF; the claim text itself is recorded only for explanation.
 */
export interface ClaimCheck {
  /** Index of the event the CLAIM was sourced from (provenance `eventIndex`). */
  eventIndex: number;
  /** How the claim was extracted (provenance kind only — never affects scoring). */
  source: ClaimSource;
  /**
   * A short, normalized predicate the claim asserts, e.g. `push`, `build:pass`,
   * `tool:git_push`. Derived by a deterministic, content-agnostic-as-possible
   * matcher (keyword/structured signature), NOT by comprehension. This is the
   * hypothesis label, not evidence.
   */
  predicate: string;
  /** The verbatim claim text (or chosen tool name), for the explanation only. */
  claimText: string;
  /** The deterministic verdict from falsifying the claim against PROOF. */
  verdict: ClaimVerdict;
  /**
   * The event index of the PROOF tool result that anchored the verdict, when
   * one matched (`verified`/`contradicted`); `null` for `unverifiable`.
   */
  proofEventIndex: number | null;
  /**
   * One-line, evidence-first explanation of WHY this verdict was reached —
   * always citing the PROOF (or its absence), never the model's own words as
   * justification.
   */
  reason: string;
}

/** Options for {@link ../checks/trace-claim-check.js#crossCheckClaims}. */
export interface ClaimCheckOptions {
  /**
   * When `true` (the default), claims with no Tier-1/2 anchor are still emitted
   * as `unverifiable` records (and surface in {@link ClaimCheckResult.instrumentationGaps}).
   * When `false`, free narration that asserts no structured, falsifiable
   * predicate is dropped entirely rather than recorded — useful when you only
   * want the decided (verified/contradicted) claims. Either way, an
   * `unverifiable` claim NEVER counts toward the score.
   */
  reportUnverifiable?: boolean;
}

/**
 * The result of {@link ../checks/trace-claim-check.js#crossCheckClaims}: every
 * model claim from a run, each with a deterministic PROOF-anchored verdict,
 * plus the headline integrity figure.
 *
 * The score is computed over **decided** claims only (`verified` +
 * `contradicted`); `unverifiable` claims are excluded by construction and
 * reported separately as instrumentation gaps. This is the per-run claim
 * integrity signal that slice 4's selection ranking aggregates across runs.
 */
export interface ClaimCheckResult {
  /** Every claim cross-checked, in event order. */
  claims: ClaimCheck[];
  /** Count of claims a PROOF signature confirmed. */
  verified: number;
  /** Count of claims a PROOF signature refuted. */
  contradicted: number;
  /** Count of claims with no Tier-1/2 anchor (EXCLUDED from the score). */
  unverifiable: number;
  /**
   * Number of claims that actually counted toward the score
   * (`verified + contradicted`). When `0`, there was nothing falsifiable to
   * score and {@link integrity} is `null`.
   */
  decided: number;
  /**
   * `verified / decided` over the **decided** claims only (0–1), or `null` when
   * no claim was decidable. NEVER silently treats `unverifiable` as a pass.
   */
  integrity: number | null;
  /**
   * The subset of claims that were `unverifiable` — the instrumentation gaps to
   * close so the trace becomes checkable. Per the guardrail these are logged,
   * not judged.
   */
  instrumentationGaps: ClaimCheck[];
  /** Human-readable one-line summary of claim integrity. */
  summary: string;
}
