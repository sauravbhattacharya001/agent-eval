/**
 * Harness×Model selection ranking (Section F, slice 4) — the capstone.
 *
 * Section F evaluates an agent = `(model × harness)` to answer the two SELECTION
 * questions that are the real point of agent evals:
 *
 *   - **Given a model, which harness is best?** (hold model fixed, vary harness)
 *   - **Given a harness, which model is best?** (hold harness fixed, vary model)
 *
 * Slices 1–3 produced the per-run signals; this slice aggregates them across a
 * controlled sweep into a **ranking**. Given N runs over the SAME task with one
 * axis held fixed and the other varied, {@link rankSelection} emits a best-first
 * {@link SelectionScorecard} that says, e.g., "for model M: harness A > B > C" —
 * the output that actually answers the selection question.
 *
 * Tier discipline (HARD GUARDRAIL — see eval-task.md §F): this is **Tier 1 +
 * Tier 2 ONLY**. Tier 3 (model-as-judge) is NEVER used.
 *
 *   - Every quantity ranked is PROOF-derived (slice 2's behavioural footprint:
 *     steps, tool-error rate, retry/thrash, recovery, token cost — all from the
 *     harness's own outputs) or a deterministic claim↔proof verdict (slice 3's
 *     `integrity`/`contradicted`, where `unverifiable` claims are already
 *     EXCLUDED from the score and surfaced as instrumentation gaps).
 *   - `unverifiable` claims are carried for visibility (the cohort's
 *     instrumentation debt) but NEVER move a score — absence of unforgeable
 *     proof is never a pass and never escalated to a Tier-3 judgement.
 *   - The selection key itself (which model, which harness) is the NEUTRAL
 *     `agent_name`, parsed structurally by {@link parseSelectionKey} — a label,
 *     never evidence.
 *
 * Read-only toward trace data: {@link rankSelection} accepts already-decoded
 * sessions or pre-computed per-run signals; it never mutates them, never touches
 * the network, and never reaches a live fleet. Load traces from recorded
 * fixtures or a collector at the IO edge — never inside this core.
 *
 * @tier 1+2 — Deterministic aggregation + Tier-2 statistics over slice-2/3 per-
 *             run signals. No AI, no IO, no network.
 * @module
 */

import { ingestTrace, type TraceSession } from './trace-provenance.js';
import { analyzeFootprint } from '../checks/trace-footprint.js';
import { crossCheckClaims } from '../checks/trace-claim-check.js';
import type {
  SelectionAxis,
  SelectionCandidate,
  SelectionOptions,
  SelectionRun,
  SelectionScorecard,
  SelectionWeights,
} from './trace-selection-types.js';

// Re-export the type vocabulary so consumers keep a single import path.
export type {
  SelectionAxis,
  SelectionCandidate,
  SelectionOptions,
  SelectionRun,
  SelectionScorecard,
  SelectionWeights,
} from './trace-selection-types.js';

/** Default signal weights (see {@link SelectionWeights}): correctness over economy. */
const DEFAULT_WEIGHTS: Required<SelectionWeights> = Object.freeze({
  integrity: 2,
  contradictions: 2,
  errorRate: 1,
  recovery: 1,
  thrash: 1,
  steps: 1,
  cost: 0.5,
});

// ─── SELECTION KEY (NEUTRAL agent_name → model × harness) ──────────────────────

/**
 * Parse a session's selection key from its NEUTRAL `agent_name`, splitting the
 * common `model@harness` form into its two axes. This is pure string structure
 * — the value is a selection LABEL, never behavioural evidence.
 *
 *   - `"claude-sonnet@winsentinel-harness"` → `{ model: 'claude-sonnet', harness: 'winsentinel-harness' }`
 *   - a bare name with no `@` is treated as the model, harness `'<unknown>'`
 *     (so a trace that didn't encode a harness still ranks on the model axis).
 *   - empty/whitespace → both `'<unknown>'`.
 *
 * Only the FIRST `@` splits, so a harness label may itself contain `@`.
 */
export function parseSelectionKey(agentName: string | undefined): { model: string; harness: string } {
  const raw = typeof agentName === 'string' ? agentName.trim() : '';
  if (raw === '') return { model: '<unknown>', harness: '<unknown>' };
  const at = raw.indexOf('@');
  if (at === -1) return { model: raw, harness: '<unknown>' };
  const model = raw.slice(0, at).trim() || '<unknown>';
  const harness = raw.slice(at + 1).trim() || '<unknown>';
  return { model, harness };
}

// ─── PER-RUN SIGNAL (slice 2 footprint + slice 3 claim integrity) ───────────────

/**
 * Reduce one decoded trace session to the {@link SelectionRun} signal the ranker
 * aggregates: the slice-2 behavioural footprint (PROOF only) plus the slice-3
 * claim↔proof integrity, keyed by the parsed model/harness. The session is
 * ingested once and shared by both slices, so this is a single pass.
 *
 * Pure and read-only — it never mutates `session`.
 *
 * @param session A decoded trace session (load it at the IO edge).
 * @param options Forwarded `maxToolErrorRate` only affects slice-2 convenience
 *   flags, not the figures ranked here.
 * @returns The per-run selection signal.
 */
export function toSelectionRun(
  session: TraceSession,
  options: { maxToolErrorRate?: number } = {},
): SelectionRun {
  const tp = ingestTrace(session);
  const fp = analyzeFootprint(session, { maxToolErrorRate: options.maxToolErrorRate });
  const claims = crossCheckClaims(tp);
  const { model, harness } = parseSelectionKey(session.agent_name);

  return {
    sessionId: tp.sessionId,
    model,
    harness,
    toolCalls: fp.toolCalls,
    toolErrorRate: fp.toolErrorRate,
    recoveryRate: fp.recoveryRate,
    longestRetryStreak: fp.longestRetryStreak,
    totalTokens: fp.tokensIn + fp.tokensOut,
    claimIntegrity: claims.integrity,
    contradictedClaims: claims.contradicted,
    unverifiableClaims: claims.unverifiable,
  };
}

// ─── AXIS RESOLUTION (which variable is held fixed?) ─────────────────────────

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Decide which axis to hold fixed for a controlled sweep. An explicit
 * `options.fixed` is honoured (and validated as uniform); otherwise the axis is
 * inferred: if every run shares one model, hold `model` (rank harnesses); else
 * if every run shares one harness, hold `harness` (rank models). A sweep that
 * holds neither variable fixed isn't a controlled comparison, so this throws
 * with an explanatory message naming the offending values.
 */
function resolveAxis(runs: readonly SelectionRun[], explicit?: SelectionAxis): SelectionAxis {
  const models = distinct(runs.map((r) => r.model));
  const harnesses = distinct(runs.map((r) => r.harness));

  if (explicit === 'model') {
    if (models.length > 1) {
      throw new Error(
        `selection sweep must hold the model fixed, but found ${models.length} models: ${models.join(', ')}`,
      );
    }
    return 'model';
  }
  if (explicit === 'harness') {
    if (harnesses.length > 1) {
      throw new Error(
        `selection sweep must hold the harness fixed, but found ${harnesses.length} harnesses: ${harnesses.join(', ')}`,
      );
    }
    return 'harness';
  }

  // Infer: prefer holding whichever axis is uniform.
  if (models.length === 1 && harnesses.length === 1) {
    // Degenerate cohort (one model AND one harness): nothing varies. Rank the
    // harness axis by convention so the single candidate still reports cleanly.
    return 'model';
  }
  if (models.length === 1) return 'model';
  if (harnesses.length === 1) return 'harness';

  throw new Error(
    `selection sweep must hold exactly one variable fixed, but both vary — models: ${models.join(', ')}; harnesses: ${harnesses.join(', ')}. ` +
      `Pass options.fixed to choose, or split the runs into controlled cohorts.`,
  );
}

// ─── SUB-SCORE NORMALIZERS (each → 0–1, higher = better; Tier 1+2 only) ─────────

/** Clamp to [0, 1]. */
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Map a "lower is better" cohort value to a 0–1 sub-score relative to the cohort
 * max (so the leanest candidate scores 1 and the heaviest scores 0). When every
 * candidate is equal (or the max is 0) the signal is non-discriminating →
 * everyone scores 1 (no penalty). This keeps steps/cost comparisons RELATIVE to
 * the runs actually being compared, never an arbitrary absolute.
 */
function relativeLowerBetter(value: number, cohortMax: number): number {
  if (!(cohortMax > 0)) return 1;
  return clamp01(1 - value / cohortMax);
}

// ─── AGGREGATION ────────────────────────────────────────────────────────

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sanitize caller weights: drop non-finite/negative values so they fall back to defaults. */
function sanitizeWeights(weights?: SelectionWeights): SelectionWeights {
  if (!weights) return {};
  const out: SelectionWeights = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS) as Array<keyof SelectionWeights>) {
    const v = weights[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

/** Per-candidate aggregate of the raw signals, before scoring. */
interface CandidateAgg {
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

function aggregateCandidate(
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
function scoreCandidate(
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

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ─── PUBLIC: rank a controlled sweep ─────────────────────────────────────

/**
 * Rank a controlled sweep of agent runs to answer one selection question.
 *
 * Accepts either decoded {@link TraceSession}s (reduced internally via
 * {@link toSelectionRun}) or pre-computed {@link SelectionRun} signals (when a
 * caller already ran slices 2/3 and wants to avoid recomputing). All runs must
 * hold ONE of model/harness fixed; the held axis is taken from `options.fixed`
 * or inferred (see {@link SelectionOptions.fixed}). The varied axis's distinct
 * values become the ranked candidates.
 *
 * Ranking is deterministic and fully Tier 1+2: candidates are ordered by the
 * weighted score (descending), ties broken by a stable, evidence-based cascade —
 * fewer PROOF contradictions, then higher claim integrity, then lower tool-error
 * rate, then fewer steps, then fewer tokens, then name — so the same cohort
 * always ranks identically. `unverifiable` claims are reported but never affect
 * the order.
 *
 * @param runs Decoded sessions or pre-computed per-run signals (≥ 0). An empty
 *   cohort yields an empty ranking and a `null` winner.
 * @param options See {@link SelectionOptions}.
 * @returns A {@link SelectionScorecard} answering the chosen selection question.
 * @throws If the sweep does not hold exactly one variable fixed (a sweep that
 *   varies both axes is not a controlled comparison).
 */
export function rankSelection(
  runs: ReadonlyArray<TraceSession | SelectionRun>,
  options: SelectionOptions = {},
): SelectionScorecard {
  const maxToolErrorRate = options.maxToolErrorRate ?? 0.5;
  const weights: Required<SelectionWeights> = {
    ...DEFAULT_WEIGHTS,
    ...sanitizeWeights(options.weights),
  };

  // Normalize inputs to SelectionRun (a SelectionRun carries `toolErrorRate` +
  // the parsed model/harness; a TraceSession does not — use that to tell them
  // apart).
  const isRun = (r: TraceSession | SelectionRun): r is SelectionRun =>
    typeof (r as SelectionRun).toolErrorRate === 'number' &&
    typeof (r as SelectionRun).model === 'string' &&
    typeof (r as SelectionRun).harness === 'string';
  const signals: SelectionRun[] = runs.map((r) =>
    isRun(r) ? r : toSelectionRun(r, { maxToolErrorRate }),
  );

  if (signals.length === 0) {
    const fixed = options.fixed ?? 'model';
    const varied: SelectionAxis = fixed === 'model' ? 'harness' : 'model';
    return {
      fixed,
      varied,
      fixedValue: '<none>',
      ranking: [],
      winner: null,
      totalRuns: 0,
      summary: `no runs to rank (${varied} given a fixed ${fixed})`,
    };
  }

  const fixed = resolveAxis(signals, options.fixed);
  const varied: SelectionAxis = fixed === 'model' ? 'harness' : 'model';
  const first = signals[0] as SelectionRun;
  const fixedValue = first[fixed];

  // Group runs by the VARIED axis value → one candidate per distinct value.
  const groups = new Map<string, SelectionRun[]>();
  for (const run of signals) {
    const key = run[varied];
    const bucket = groups.get(key);
    if (bucket) bucket.push(run);
    else groups.set(key, [run]);
  }

  const aggs = [...groups.entries()].map(([name, group]) =>
    aggregateCandidate(name, group, maxToolErrorRate),
  );
  const cohortMaxSteps = Math.max(0, ...aggs.map((a) => a.meanToolCalls));
  const cohortMaxTokens = Math.max(0, ...aggs.map((a) => a.meanTotalTokens));

  const scored: Scored[] = aggs.map((agg) => ({
    agg,
    score: scoreCandidate(agg, weights, cohortMaxSteps, cohortMaxTokens),
  }));

  // Deterministic order: score desc, then an evidence-based tie-break cascade.
  scored.sort(compareCandidates);

  const ranking: SelectionCandidate[] = scored.map(({ agg, score }, i) => ({
    name: agg.name,
    runs: agg.runs.length,
    score: round3(score),
    // Ties (identical tie-break key) share the lowest rank; otherwise 1-based.
    rank: rankAt(scored, i),
    meanToolCalls: round3(agg.meanToolCalls),
    meanToolErrorRate: round3(agg.meanToolErrorRate),
    meanRecoveryRate: round3(agg.meanRecoveryRate),
    meanTotalTokens: round3(agg.meanTotalTokens),
    meanClaimIntegrity: agg.meanClaimIntegrity === null ? null : round3(agg.meanClaimIntegrity),
    contradictedClaims: agg.contradictedClaims,
    unverifiableClaims: agg.unverifiableClaims,
    cleanRun: agg.cleanRun,
  }));

  return {
    fixed,
    varied,
    fixedValue,
    ranking,
    winner: pickWinner(ranking),
    totalRuns: signals.length,
    summary: buildSummary(fixed, varied, fixedValue, ranking),
  };
}

// ─── ORDERING HELPERS (deterministic, evidence-based) ────────────────────────

interface Scored {
  agg: CandidateAgg;
  score: number;
}

/**
 * Compare two scored candidates for the ranking order: score descending, then a
 * stable, evidence-based tie-break cascade so equal scores still order
 * reproducibly (and meaningfully): fewer PROOF contradictions → higher claim
 * integrity → lower tool-error rate → fewer steps → fewer tokens → name asc.
 */
function compareCandidates(a: Scored, b: Scored): number {
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
function tieKey(s: Scored): string {
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
function rankAt(scored: readonly Scored[], i: number): number {
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
function pickWinner(ranking: readonly SelectionCandidate[]): SelectionCandidate | null {
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
function buildSummary(
  fixed: SelectionAxis,
  varied: SelectionAxis,
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
