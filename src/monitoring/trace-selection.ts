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
 * The pure scoring/ordering math (normalizers, per-candidate aggregation,
 * weighted scoring, deterministic ordering / rank / winner / summary) lives in
 * the {@link ./trace-selection-scoring.js} leaf; this module keeps trace ingest,
 * axis resolution, grouping, and the public orchestration.
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
import {
  DEFAULT_WEIGHTS,
  aggregateCandidate,
  buildSummary,
  compareCandidates,
  pickWinner,
  rankAt,
  round3,
  sanitizeWeights,
  scoreCandidate,
  type Scored,
} from './trace-selection-scoring.js';

// Re-export the type vocabulary so consumers keep a single import path.
export type {
  SelectionAxis,
  SelectionCandidate,
  SelectionOptions,
  SelectionRun,
  SelectionScorecard,
  SelectionWeights,
} from './trace-selection-types.js';

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
