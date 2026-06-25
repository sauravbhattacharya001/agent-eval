/**
 * Harness×Model selection ranking (Section F, slice 4) — type vocabulary.
 *
 * The shared types for the selection ranking live here so both the ranking
 * engine (`./trace-selection.js`) and the monitoring barrel can depend on them
 * without a cycle, mirroring the established `*-types.ts` / `*.ts` seam used
 * across the monitoring layer (see `scorer.ts`/`scorecard.ts`) and the trace
 * checks (`trace-footprint-types.ts`, `trace-claim-check-types.ts`).
 * Re-exported from `./trace-selection.js`, so consumers keep a single import
 * path.
 *
 * THE GOAL (why slice 4 exists): an agent = `(model × harness)`. Evals are unit
 * tests for that 2-variable system, and they exist to answer the two SELECTION
 * questions:
 *
 *   - **Given a model, which harness is best?** (hold model fixed, vary harness)
 *   - **Given a harness, which model is best?** (hold harness fixed, vary model)
 *
 * Slice 4 is the capstone that produces that answer: given N runs over the SAME
 * task with one axis held fixed and the other varied, it aggregates the per-run
 * signals from slice 2 ({@link ../checks/trace-footprint.js#analyzeFootprint})
 * and slice 3 ({@link ../checks/trace-claim-check.js#crossCheckClaims}) into a
 * **ranked scorecard**, not just a grade.
 *
 * Section F is a **Tier 1 + Tier 2 ONLY** pillar — Tier 3 (model-as-judge) is
 * NEVER used. Every quantity ranked here traces back to PROOF (slice 2's
 * harness-authored footprint) or to a deterministic claim↔proof verdict (slice
 * 3, where `unverifiable` claims are already EXCLUDED from the score). The
 * selection key itself — which model, which harness — is the NEUTRAL
 * `agent_name`, parsed structurally, never judged.
 *
 * @tier 1+2 — Deterministic aggregation + Tier-2 statistics over the slice-2/3
 *             per-run signals. No AI, no IO, no network.
 * @module
 */

/**
 * The variable held FIXED while the other is varied — which selection question
 * a ranking answers.
 *
 * - `model`   — hold the model fixed, vary the harness → "given model M, which
 *               harness?" Candidates are harnesses.
 * - `harness` — hold the harness fixed, vary the model → "given harness H, which
 *               model?" Candidates are models.
 */
export type SelectionAxis = 'model' | 'harness';

/**
 * Options for {@link ../monitoring/trace-selection.js#rankSelection}. Every knob
 * is either a structural parser hint or a weight on a PROOF/claim-integrity
 * signal; none changes what counts as proof (that is fixed by the static
 * provenance map and slice 2/3).
 */
export interface SelectionOptions {
  /**
   * Which axis to hold fixed (and therefore which question to answer). When
   * omitted, the ranker infers it: if every run shares one model it ranks
   * harnesses (`model` fixed); else if every run shares one harness it ranks
   * models (`harness` fixed). If neither is uniform it throws, because a
   * controlled sweep must hold exactly one variable fixed.
   */
  fixed?: SelectionAxis;
  /**
   * Weights for combining the per-run signals into a 0–1 quality score. Each is
   * clamped to `>= 0`; the score is their weighted average over the signals that
   * are present, so the absolute magnitudes don't need to sum to 1. Defaults
   * favour correctness (claim integrity + no contradictions) over economy.
   */
  weights?: SelectionWeights;
  /**
   * Inclusive max tool-error rate (0–1) used only for the `cleanRun` convenience
   * flag on each candidate. Default: `0.5` (mirrors slice 2's
   * {@link ../checks/trace-footprint-types.js#FootprintOptions} default).
   */
  maxToolErrorRate?: number;
}

/**
 * Relative weights for the selection score. The score is a weighted average of
 * the normalized per-signal sub-scores (each already in 0–1, higher = better),
 * so a weight of 0 drops that signal entirely. All are PROOF- or
 * claim-integrity-derived — never a Tier-3 judgement.
 */
export interface SelectionWeights {
  /** Claim integrity (slice 3 `integrity`, verified/decided). Default `2`. */
  integrity?: number;
  /** Freedom from PROOF-contradicted claims (slice 3 `contradicted`). Default `2`. */
  contradictions?: number;
  /** Tool-error rate (slice 2), lower is better. Default `1`. */
  errorRate?: number;
  /** Recovery after error (slice 2 `recoveryRate`). Default `1`. */
  recovery?: number;
  /** Freedom from same-tool thrashing (slice 2 `longestRetryStreak`). Default `1`. */
  thrash?: number;
  /** Step economy (slice 2 `toolCalls`), fewer is better, scored relative to the cohort. Default `1`. */
  steps?: number;
  /** Token economy (slice 2 `tokensIn+tokensOut`), fewer is better, relative to the cohort. Default `0.5`. */
  cost?: number;
}

/**
 * The per-run signal pulled from slices 2 and 3 for one trace, plus the parsed
 * selection key. The atomic input the ranker aggregates — every field traces
 * back to PROOF (footprint) or a deterministic claim↔proof verdict (integrity),
 * never to a model claim taken at face value.
 */
export interface SelectionRun {
  /** Session id of the source trace (`''` when absent), for traceability. */
  sessionId: string;
  /** The model half of the selection key (parsed from `agent_name`). */
  model: string;
  /** The harness half of the selection key (parsed from `agent_name`). */
  harness: string;
  /** Tool calls = "steps to completion" (PROOF, slice 2). */
  toolCalls: number;
  /** Tool-error rate 0–1 (PROOF, slice 2). */
  toolErrorRate: number;
  /** Recovery-after-error rate 0–1 (PROOF, slice 2). */
  recoveryRate: number;
  /** Longest same-tool retry-after-error streak (PROOF, slice 2). */
  longestRetryStreak: number;
  /** Total PROOF tokens in+out (slice 2). */
  totalTokens: number;
  /** Claim integrity 0–1 over DECIDED claims, or `null` when nothing was decidable (slice 3). */
  claimIntegrity: number | null;
  /** Count of claims PROOF refuted (slice 3). */
  contradictedClaims: number;
  /** Count of `unverifiable` claims — EXCLUDED from the score, surfaced as instrumentation gaps (slice 3). */
  unverifiableClaims: number;
}

/**
 * One ranked candidate value of the VARIED axis (a harness when model is fixed,
 * a model when harness is fixed), with the aggregated score and the evidence
 * behind it. This is the row a human reads to pick.
 */
export interface SelectionCandidate {
  /** The candidate's value of the varied axis (e.g. a harness name, or a model name). */
  name: string;
  /** Number of runs aggregated for this candidate. */
  runs: number;
  /** Overall 0–1 quality score (weighted average of the normalized sub-scores; higher = better). */
  score: number;
  /** 1-based rank within the cohort (1 = best); ties share the lowest rank. */
  rank: number;
  /** Mean tool calls across this candidate's runs (PROOF). */
  meanToolCalls: number;
  /** Mean tool-error rate across this candidate's runs (PROOF). */
  meanToolErrorRate: number;
  /** Mean recovery-after-error rate across this candidate's runs (PROOF). */
  meanRecoveryRate: number;
  /** Mean PROOF tokens (in+out) across this candidate's runs. */
  meanTotalTokens: number;
  /**
   * Mean claim integrity across the runs that HAD a decidable claim (`null` when
   * none did). Never silently treats `unverifiable` as a pass.
   */
  meanClaimIntegrity: number | null;
  /** Total PROOF-contradicted claims across this candidate's runs (the hard failure). */
  contradictedClaims: number;
  /** Total `unverifiable` claims across this candidate's runs (instrumentation gaps, excluded from score). */
  unverifiableClaims: number;
  /** `true` iff every run was within the error-rate budget, never thrashed, and had no contradiction. */
  cleanRun: boolean;
}

/**
 * The result of {@link ../monitoring/trace-selection.js#rankSelection}: a
 * controlled-sweep scorecard that answers ONE selection question. The headline
 * is {@link ranking} (best-first); {@link winner} is its top row when a unique
 * best exists.
 */
export interface SelectionScorecard {
  /** Which axis was held fixed (the question answered). */
  fixed: SelectionAxis;
  /** Which axis was varied (the candidates ranked). */
  varied: SelectionAxis;
  /** The held-fixed value shared by every run (e.g. the model, when ranking harnesses). */
  fixedValue: string;
  /** Candidates best-first (rank 1 first). The answer to the selection question. */
  ranking: SelectionCandidate[];
  /**
   * The single best candidate when it is strictly better than the runner-up;
   * `null` on an exact top-score tie (no decisive winner) or an empty cohort.
   */
  winner: SelectionCandidate | null;
  /** Total runs aggregated across all candidates. */
  totalRuns: number;
  /** Human-readable one-line verdict, e.g. `for model M: harness A > B > C`. */
  summary: string;
}
