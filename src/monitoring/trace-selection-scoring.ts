/**
 * Selection scoring & ordering internals (Section F, slice 4) — the pure math
 * seam extracted from {@link ../monitoring/trace-selection.js}.
 *
 * This leaf holds everything the ranker does to per-run signals ONCE they exist:
 * per-signal normalization, per-candidate aggregation, weighted scoring, and the
 * deterministic evidence-based ordering / rank / winner / summary helpers. The
 * engine module keeps trace ingest, axis resolution, grouping, and the public
 * {@link ../monitoring/trace-selection.js#rankSelection} orchestration.
 *
 * Tier discipline is inherited unchanged: every quantity here is Tier 1+2
 * (PROOF-derived footprint or deterministic claim↔proof verdicts). No AI, no IO,
 * no network, no mutation of inputs. Splitting the file changed no behaviour.
 *
 * @tier 1+2 — Deterministic aggregation + Tier-2 statistics. No AI, no IO.
 * @module
 */

import type {
  SelectionCandidate,
  SelectionRun,
  SelectionWeights,
} from './trace-selection-types.js';

/** Default signal weights (see {@link SelectionWeights}): correctness over economy. */
export const DEFAULT_WEIGHTS: Required<SelectionWeights> = Object.freeze({
  integrity: 2,
  contradictions: 2,
  errorRate: 1,
  recovery: 1,
  thrash: 1,
  steps: 1,
  cost: 0.5,
});

// ─── SUB-SCORE NORMALIZERS (each → 0–1, higher = better; Tier 1+2 only) ─────────

/** Clamp to [0, 1]. */
export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Map a "lower is better" cohort value to a 0–1 sub-score relative to the cohort
 * max (so the leanest candidate scores 1 and the heaviest scores 0). When every
 * candidate is equal (or the max is 0) the signal is non-discriminating →
 * everyone scores 1 (no penalty). This keeps steps/cost comparisons RELATIVE to
 * the runs actually being compared, never an arbitrary absolute.
 */
export function relativeLowerBetter(value: number, cohortMax: number): number {
  if (!(cohortMax > 0)) return 1;
  return clamp01(1 - value / cohortMax);
}

// ─── AGGREGATION ────────────────────────────────────────────────────────

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sanitize caller weights: drop non-finite/negative values so they fall back to defaults. */
export function sanitizeWeights(weights?: SelectionWeights): SelectionWeights {
  if (!weights) return {};
  const out: SelectionWeights = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS) as Array<keyof SelectionWeights>) {
    const v = weights[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

/** Per-candidate aggregate of the raw signals, before scoring. */
export interface CandidateAgg {
  name: string;
  runs: SelectionRun[];
  meanToolCalls: number;
  meanToolErrorRate: number;
  meanRecoveryRate: number;
  meanTotalTokens: number;
  meanClaimIntegrity: number | null;
  meanThrash: number;
  contradictedClaims: number;
  unverifiableClaims: number;
  cleanRun: boolean;
}

export function aggregateCandidate(
  name: string,
  runs: SelectionRun[],
  maxToolErrorRate: number,
): CandidateAgg {
  const decidedIntegrities = runs
    .map((r) => r.claimIntegrity)
    .filter((v): v is number => v !== null);

  const cleanRun = runs.every(
    (r) =>
      r.toolErrorRate <= maxToolErrorRate && r.longestRetryStreak <= 2 && r.contradictedClaims === 0,
  );

  return {
    name,
    runs,
    meanToolCalls: mean(runs.map((r) => r.toolCalls)),
    meanToolErrorRate: mean(runs.map((r) => r.toolErrorRate)),
    meanRecoveryRate: mean(runs.map((r) => r.recoveryRate)),
    meanTotalTokens: mean(runs.map((r) => r.totalTokens)),
    // Mean integrity over the runs that HAD a decidable claim; null when none did
    // (never invent a pass for runs with no falsifiable claim).
    meanClaimIntegrity: decidedIntegrities.length === 0 ? null : mean(decidedIntegrities),
    meanThrash: mean(runs.map((r) => r.longestRetryStreak)),
    contradictedClaims: runs.reduce((a, r) => a + r.contradictedClaims, 0),
    unverifiableClaims: runs.reduce((a, r) => a + r.unverifiableClaims, 0),
    cleanRun,
  };
}

/**
 * Combine one candidate's aggregated signals into a 0–1 score: the weighted
 * average of the per-signal sub-scores that are present. Steps and cost are
 * scored RELATIVE to the cohort (via the passed maxima); the rest are absolute
 * 0–1 quantities. A signal with weight 0 is dropped. When the total weight is 0
 * (all signals disabled) the score is 0.
 */
export function scoreCandidate(
  agg: CandidateAgg,
  weights: Required<SelectionWeights>,
  cohortMaxSteps: number,
  cohortMaxTokens: number,
): number {
  const subs: Array<{ w: number; v: number }> = [];

  // Correctness signals (claim↔proof, slice 3).
  if (agg.meanClaimIntegrity !== null) {
    subs.push({ w: weights.integrity, v: clamp01(agg.meanClaimIntegrity) });
  }
  // No PROOF-contradicted claims is binary per candidate: any contradiction → 0.
  subs.push({ w: weights.contradictions, v: agg.contradictedClaims === 0 ? 1 : 0 });

  // Behavioural footprint signals (PROOF, slice 2).
  subs.push({ w: weights.errorRate, v: clamp01(1 - agg.meanToolErrorRate) });
  subs.push({ w: weights.recovery, v: clamp01(agg.meanRecoveryRate) });
  // Thrash: 0 streak → 1; scale down toward a streak of 5 (cap), where it hits 0.
  subs.push({ w: weights.thrash, v: clamp01(1 - agg.meanThrash / 5) });
  subs.push({ w: weights.steps, v: relativeLowerBetter(agg.meanToolCalls, cohortMaxSteps) });
  subs.push({ w: weights.cost, v: relativeLowerBetter(agg.meanTotalTokens, cohortMaxTokens) });

  const totalWeight = subs.reduce((a, s) => a + s.w, 0);
  if (totalWeight <= 0) return 0;
  const weighted = subs.reduce((a, s) => a + s.w * s.v, 0);
  return clamp01(weighted / totalWeight);
}

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ─── ORDERING HELPERS (deterministic, evidence-based) ────────────────────────

export interface Scored {
  agg: CandidateAgg;
  score: number;
}

/**
 * Compare two scored candidates for the ranking order: score descending, then a
 * stable, evidence-based tie-break cascade so equal scores still order
 * reproducibly (and meaningfully): fewer PROOF contradictions → higher claim
 * integrity → lower tool-error rate → fewer steps → fewer tokens → name asc.
 */
export function compareCandidates(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.agg.contradictedClaims !== b.agg.contradictedClaims) {
    return a.agg.contradictedClaims - b.agg.contradictedClaims;
  }
  const ai = a.agg.meanClaimIntegrity ?? -1;
  const bi = b.agg.meanClaimIntegrity ?? -1;
  if (ai !== bi) return bi - ai;
  if (a.agg.meanToolErrorRate !== b.agg.meanToolErrorRate) {
    return a.agg.meanToolErrorRate - b.agg.meanToolErrorRate;
  }
  if (a.agg.meanToolCalls !== b.agg.meanToolCalls) return a.agg.meanToolCalls - b.agg.meanToolCalls;
  if (a.agg.meanTotalTokens !== b.agg.meanTotalTokens) {
    return a.agg.meanTotalTokens - b.agg.meanTotalTokens;
  }
  return a.agg.name.localeCompare(b.agg.name);
}

/**
 * A stable key capturing everything the tie-break cascade considers (sans name).
 * Two candidates with the same key are a genuine tie and share a rank.
 */
export function tieKey(s: Scored): string {
  return [
    s.score,
    s.agg.contradictedClaims,
    s.agg.meanClaimIntegrity ?? -1,
    s.agg.meanToolErrorRate,
    s.agg.meanToolCalls,
    s.agg.meanTotalTokens,
  ].join('|');
}

/**
 * The 1-based rank of the candidate at sorted index `i`: candidates tied with an
 * earlier candidate (identical {@link tieKey}) share that earlier candidate's
 * (lowest) rank; otherwise the rank is `i + 1`. Standard "competition ranking"
 * over a list already sorted by {@link compareCandidates}.
 */
export function rankAt(scored: readonly Scored[], i: number): number {
  const cur = scored[i];
  if (!cur) return i + 1;
  const key = tieKey(cur);
  let j = i;
  while (j > 0) {
    const prev = scored[j - 1];
    if (!prev || tieKey(prev) !== key) break;
    j--;
  }
  return j + 1;
}

/**
 * The decisive winner is the rank-1 candidate ONLY when it is strictly better
 * than the runner-up (no tie at the top). A top tie means the sweep did not
 * produce a decisive answer → `null` (never break the tie arbitrarily and call
 * it a winner). A single-candidate cohort wins by default.
 */
export function pickWinner(ranking: readonly SelectionCandidate[]): SelectionCandidate | null {
  if (ranking.length === 0) return null;
  const top = ranking[0];
  if (!top) return null;
  if (ranking.length === 1) return top;
  const second = ranking[1];
  // A shared rank-1 (tie at the top) is not a decisive winner.
  if (second && second.rank === top.rank) return null;
  return top;
}

/**
 * A human-readable one-line verdict, e.g. `for model claude-sonnet: harnessA >
 * harnessB > harnessC`. Candidates are joined best-first with `>`, and genuine
 * ties are joined with `=` so the summary never overstates a non-result.
 */
export function buildSummary(
  fixed: string,
  varied: string,
  fixedValue: string,
  ranking: readonly SelectionCandidate[],
): string {
  if (ranking.length === 0) return `for ${fixed} ${fixedValue}: no ${varied} candidates`;
  let chain = ranking[0]?.name ?? '';
  for (let i = 1; i < ranking.length; i++) {
    const prev = ranking[i - 1];
    const cur = ranking[i];
    if (!prev || !cur) continue;
    chain += cur.rank === prev.rank ? ` = ${cur.name}` : ` > ${cur.name}`;
  }
  return `for ${fixed} ${fixedValue}: ${chain}`;
}
