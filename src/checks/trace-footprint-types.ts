/**
 * Behavioural footprint (Section F, slice 2) — type vocabulary.
 *
 * The shared types for the PROOF-only behavioural-footprint checks live here so
 * both the analysis engine (`./trace-footprint.js`) and any future barrel can
 * depend on them without a cycle, mirroring the established
 * `*-types.ts` / `*.ts` seam used across `src/checks`. Re-exported from
 * `./trace-footprint.js`, so consumers keep a single import path.
 *
 * Section F judges an agent = `(model × harness)` using **Tier 1 + Tier 2
 * ONLY** — Tier 3 (model-as-judge) is NEVER used. Slice 2 is the cleanest,
 * fully-mechanical part: it aggregates over the **PROOF-labeled** records that
 * {@link ../monitoring/trace-provenance.js#ingestTrace | ingestTrace} produced
 * — harness/runtime/code-authored data the agent could not forge (tool results
 * incl. `is_error`/`exit_code`, timing, token meters). No CLAIM field (the
 * model's chosen tool/args, its narration or reasoning) is ever read here.
 *
 * @tier 1 — Deterministic for counts/errors/timing; the rates are Tier-2
 *           statistics over those Tier-1 facts. No AI, no IO, no network.
 * @module
 */

/**
 * Options for {@link ../checks/trace-footprint.js#analyzeFootprint}. Every knob
 * is a threshold on a PROOF-derived quantity; none changes *what* counts as
 * proof (that is fixed by the static provenance map).
 */
export interface FootprintOptions {
  /**
   * Inclusive max number of tool calls for a run to be considered economical.
   * Used only for the `withinStepBudget` convenience flag and the
   * {@link ../checks/trace-footprint.js#toCompleteWithinSteps} assertion.
   * Default: `Infinity` (no budget).
   */
  maxToolCalls?: number;
  /**
   * Inclusive max tool-error rate (0–1) tolerated before `excessiveErrors` is
   * set. Default: `0.5`.
   */
  maxToolErrorRate?: number;
  /**
   * Inclusive max number of consecutive same-tool retries after an error before
   * `thrashing` is set. Default: `2`.
   */
  maxRetryStreak?: number;
}

/**
 * The unforgeable outcome of a single tool call, read ONLY from the PROOF-
 * labeled `tool_call.tool_output` (and `event_type`/timing) — never from the
 * model's chosen `tool_name`/`tool_input`, which are CLAIM.
 *
 * `toolName` is recorded purely as a label so retry/thrash streaks can be
 * attributed; it is NOT used as evidence of success or failure (the
 * success/error verdict comes only from `is_error`/`exit_code` in the result).
 */
export interface ToolOutcome {
  /** Index of the owning event within the session (from the provenance record). */
  eventIndex: number;
  /**
   * The tool's name, used only to group retries of the *same* tool. Sourced
   * from the CLAIM `tool_name` for labeling; absent → `'<unknown>'`. Never
   * consulted to decide success/failure.
   */
  toolName: string;
  /**
   * Whether the harness reported this call as an error. `true` iff the PROOF
   * result has `is_error === true` or a non-zero numeric `exit_code`.
   */
  isError: boolean;
  /** Tool execution time in ms when the harness recorded it (PROOF), else `null`. */
  durationMs: number | null;
}

/**
 * The result of {@link ../checks/trace-footprint.js#analyzeFootprint}: a purely
 * mechanical behavioural summary of one run, derived only from PROOF. This is
 * the per-run signal that slice 4's selection ranking aggregates across runs to
 * answer "given a model, which harness?" / "given a harness, which model?".
 */
export interface FootprintResult {
  // ── Steps to completion ──────────────────────────────────────────────────
  /** Total events in the session (PROOF: every event has a harness `event_type`). */
  totalEvents: number;
  /** Number of tool-call events (PROOF). The primary "steps to completion" signal. */
  toolCalls: number;

  // ── Tool-error behaviour ─────────────────────────────────────────────────
  /** Number of tool calls the harness flagged as errors (PROOF). */
  toolErrors: number;
  /** `toolErrors / toolCalls` (0 when there were no tool calls). */
  toolErrorRate: number;

  // ── Retry / thrash ───────────────────────────────────────────────────────
  /**
   * Longest run of consecutive calls to the *same* tool that began with an
   * errored call — the agent retrying the same thing without changing approach.
   * `0` when no same-tool retry-after-error streak exists.
   */
  longestRetryStreak: number;
  /** Total retried calls across all such streaks (sum of `(streakLength − 1)`). */
  retryCount: number;

  // ── Recovery after error ─────────────────────────────────────────────────
  /**
   * Of the tool errors that were followed by any later tool call, the fraction
   * that were *eventually* followed by a successful tool call. `1` when there
   * were no recoverable errors (nothing to recover from is treated as "no
   * recovery debt"). Pure PROOF: success/error both come from tool results.
   */
  recoveryRate: number;
  /** Count of errors that had a later successful tool call (recovered). */
  recoveredErrors: number;
  /** Count of errors that had a later tool call but never a later success. */
  unrecoveredErrors: number;

  // ── Cost (PROOF rollups / per-event meters) ──────────────────────────────
  /** Sum of PROOF tool `duration_ms` across tool calls (ms); `0` if none recorded. */
  toolDurationMs: number;
  /** Prompt tokens (PROOF): session `total_tokens_in` if present, else summed events. */
  tokensIn: number;
  /** Completion tokens (PROOF): session `total_tokens_out` if present, else summed events. */
  tokensOut: number;

  // ── Threshold flags (Tier-2 verdicts over the Tier-1 facts) ──────────────
  /** `true` when `toolCalls <= maxToolCalls`. */
  withinStepBudget: boolean;
  /** `true` when `toolErrorRate > maxToolErrorRate`. */
  excessiveErrors: boolean;
  /** `true` when `longestRetryStreak > maxRetryStreak`. */
  thrashing: boolean;

  /** Per-tool-call outcomes in event order (the audit trail behind the rollups). */
  outcomes: ToolOutcome[];
  /** Human-readable one-line summary of the footprint. */
  summary: string;
}
