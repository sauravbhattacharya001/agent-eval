/**
 * Fleet triage — rank individual failed trajectories by cost.
 *
 * Where the monitoring {@link Scorecard} answers *"is worker X healthy on
 * average?"*, triage answers the operational question: **"which specific runs
 * failed expensively, worst first?"** It walks a directory of agent sessions
 * (via the OpenClaw {@link buildAllSessions} adapter), runs the deterministic
 * {@link analyzeStaleness} check on each, and emits one ranked row per session
 * that broke — abandoned, timed-out, runaway, or stalled — annotated with the
 * tokens it burned and a projected dollar cost on usage-based pricing.
 *
 * It also catches the **finished-but-bad** family that a crash/staleness check
 * is blind to by construction: a run that ended *cleanly* (exit status OK) yet
 * blew a resource budget — `over-cost` (too many tokens), `over-latency` (too
 * slow), or `excessive-steps` (too many events). These are gated on
 * {@link BuiltSession.meta}'s `endedCleanly` and flagged only when a completed-
 * run threshold is tripped; they never borrow a staleness signal.
 *
 * This is the seam the "Failure Trajectories" view and the wedge pitch consume:
 * a list of incidents with evidence and a price tag, not an aggregate grade.
 *
 * Deterministic and dependency-free: no model-as-judge, no network.
 *
 * Typical use:
 *
 *     import { triageSessions, renderTriageTable } from 'agent-eval';
 *
 *     const report = triageSessions(process.env.SESSIONS_DIR!, { dollarsPerMillionTokens: 9 });
 *     console.log(renderTriageTable(report, 15));
 *     console.log(`Projected waste: $${report.projectedCostUsd.toFixed(0)}`);
 *
 * @tier 1 - Deterministic
 * @module
 */

import { analyzeStaleness } from '../checks/staleness.js';
import type { StalenessIssue } from '../checks/staleness.js';
import { detectLoops, analyzeRepetition } from '../checks/repetition.js';
import { buildAllSessions } from '../adapters/openclaw.js';
import type { BuiltSession } from '../adapters/types.js';

// ─── OPTIONS ────────────────────────────────────────────────────────────────────

/** Tuning for {@link triageSessions}. */
export interface TriageOptions {
  /**
   * Token threshold (max usage seen) at/above which a failed run is "costly"
   * rather than a trivial instant-error. Default `200_000`.
   */
  costlyTokenThreshold?: number;
  /**
   * Runtime threshold in ms at/above which a failed run is "costly" even if its
   * token count is low (e.g. a long externally-aborted run). Default `600_000` (10m).
   */
  costlyRuntimeMs?: number;
  /**
   * Blended price per million tokens for the cost projection. Default `9`
   * (a mid estimate between cache-discounted input and fresh output rates).
   */
  dollarsPerMillionTokens?: number;
  /**
   * When true, only sessions that {@link analyzeStaleness} marks `isStale` are
   * included. When false, any run that did not end cleanly is included (broader).
   * Default `true`.
   *
   * Note: this governs the *failed-process* family only (abandon/timeout/…). The
   * *finished-but-bad* family below is orthogonal — it inspects runs that ended
   * cleanly, and is controlled by {@link includeCompleted}.
   */
  staleOnly?: boolean;
  /**
   * When true, runs that ended cleanly are still inspected for the
   * "finished-but-bad" failure modes — a run that *succeeded* by exit status but
   * was too expensive, too slow, or took far too many steps. This is the class a
   * crash/staleness check is blind to by construction (the run did end cleanly).
   * Flagged only when a completed-run threshold below is tripped. Default `true`.
   */
  includeCompleted?: boolean;
  /**
   * Token budget at/above which a *cleanly finished* run is flagged
   * `over-cost` (mode #4). Set high so ordinary runs pass. Default `1_000_000`.
   */
  overCostTokenThreshold?: number;
  /**
   * Runtime budget in ms at/above which a *cleanly finished* run is flagged
   * `over-latency` (mode #5). Default `1_800_000` (30m).
   */
  overLatencyMs?: number;
  /**
   * Event count at/above which a *cleanly finished* run is flagged
   * `excessive-steps` (mode #6). Uses `eventCount` (falls back to
   * `assistantCount` when the timeline is a coarse trajectory spine).
   * Default `400`.
   */
  excessiveStepThreshold?: number;
  /**
   * Loop/repetition ratio in `[0,1]` at/above which a *cleanly finished* run is
   * flagged `loop-without-progress` (mode #3) — the agent repeated the same
   * assistant text / thrashed while staying under the token cap and never going
   * formally idle. Scans {@link BuiltSession.meta}'s `allAssistantText` with the
   * shared `detectLoops` + `analyzeRepetition` engine. Default `0.5` (half the
   * output is looped/duplicated) — deliberately conservative so a couple of
   * repeated sentences do not trip it. Set lower to be stricter.
   */
  loopRatioThreshold?: number;
  /**
   * Minimum number of assistant segments before the loop check runs at all.
   * A 1–2 message run cannot "thrash". Default `4`.
   */
  loopMinSegments?: number;
}

const DEFAULTS: Required<TriageOptions> = {
  costlyTokenThreshold: 200_000,
  costlyRuntimeMs: 600_000,
  dollarsPerMillionTokens: 9,
  staleOnly: true,
  includeCompleted: true,
  overCostTokenThreshold: 1_000_000,
  overLatencyMs: 1_800_000,
  excessiveStepThreshold: 400,
  loopRatioThreshold: 0.5,
  loopMinSegments: 4,
};

// ─── RESULT TYPES ───────────────────────────────────────────────────────────────

/**
 * Coarse classification of how a run failed (most-severe wins for sorting).
 *
 * Two families:
 * - *failed process* — the run broke: `abandoned`, `timeout`, `runaway`,
 *   `stalled`, `errored`. Derived from staleness / abort provenance.
 * - *finished but bad* — the run ended **cleanly** yet still wasted resources:
 *   `over-cost` (mode #4), `over-latency` (mode #5), `excessive-steps` (mode #6),
 *   and `loop-without-progress` (mode #3 — the agent repeated itself / thrashed
 *   while staying under the token cap and never going formally idle). A
 *   crash/staleness check is blind to these by construction.
 */
export type FailureKind =
  | 'abandoned'
  | 'timeout'
  | 'runaway'
  | 'stalled'
  | 'errored'
  | 'over-cost'
  | 'over-latency'
  | 'excessive-steps'
  | 'loop-without-progress';

/** The finished-but-bad kinds: a run that ended cleanly but was still wasteful. */
const COMPLETED_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'over-cost',
  'over-latency',
  'excessive-steps',
  'loop-without-progress',
]);

/** One ranked failed trajectory. */
export interface TriageRow {
  /** Session id. */
  id: string;
  /** Derived human label (first user line), or `'(no task line)'`. */
  label: string;
  /** Primary failure classification. */
  kind: FailureKind;
  /** All staleness issue kinds detected on the run. */
  issueKinds: StalenessIssue['kind'][];
  /** Best token count observed (cumulative, cache-inclusive). */
  tokenUsage: number;
  /** Wall-clock runtime in ms (`NaN` if unknown). */
  runtimeMs: number;
  /** Projected dollar cost of the burned tokens at the configured rate. */
  projectedCostUsd: number;
  /** True if this clears the costly token/runtime bar (vs. a trivial error). */
  costly: boolean;
  /** A one-line human summary of what went wrong. */
  summary: string;
  /**
   * Actionable diagnostics for a developer, all derived from real trace fields.
   * Additive/optional so existing consumers and renderers are unaffected.
   */
  diagnosis?: TriageDiagnosis;
}

/**
 * Per-row detail a developer can act on: where the run stopped, how long it
 * went silent, which failure signals fired, and the raw issue evidence. Every
 * field maps to an observed trace field - nothing is inferred beyond the
 * deterministic checks that already ran.
 */
export interface TriageDiagnosis {
  /** Last record type observed (e.g. `tool_call`, `output`), or null. */
  lastEventType: string | null;
  /** Role of the last message observed (e.g. `assistant`, `tool`), or null. */
  lastRole: string | null;
  /** Longest silent gap between events in ms (`NaN` if < 2 events). */
  longestGapMs: number;
  /** Total timeline events built. */
  eventCount: number;
  /** Assistant text segments captured. */
  assistantCount: number;
  /** Whether a trajectory companion was present (affects confidence). */
  hadTrajectory: boolean;
  /** Named failure signals that fired, in priority order. */
  signals: string[];
  /** The deterministic issue lines (`kind: message`) with any evidence. */
  findings: string[];
  /**
   * Self-report vs. measured-evidence contradictions: cases where a run's own
   * status flags disagree with what its timeline actually shows (e.g. claims a
   * timeout, but ended cleanly with no long silence). Empty when consistent.
   */
  contradictions: string[];
}

/** The full triage report for a sessions directory. */
export interface TriageReport {
  /** Total logical sessions scanned. */
  scanned: number;
  /** Sessions flagged as failed trajectories. */
  flagged: number;
  /**
   * Of the flagged, how many are the *finished-but-bad* family (`over-cost`,
   * `over-latency`, `excessive-steps`) — runs that ended cleanly yet blew a
   * resource budget. The rest are failed-process rows (abandon/timeout/…).
   */
  completedBad: number;
  /** Of the flagged, how many clear the costly bar. */
  costly: number;
  /** Sum of `tokenUsage` across costly rows. */
  costlyTokens: number;
  /** Projected dollar cost across costly rows at the configured rate. */
  projectedCostUsd: number;
  /** Price per million tokens used for the projection. */
  dollarsPerMillionTokens: number;
  /** Count of flagged rows by failure kind. */
  byKind: Record<FailureKind, number>;
  /** All flagged rows, sorted worst-first (costly desc, then tokens desc). */
  rows: TriageRow[];
}

// ─── CLASSIFICATION ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Pick the single most-descriptive failure kind for a row. */
function classify(meta: BuiltSession['meta'], issues: StalenessIssue[]): FailureKind {
  const kinds = new Set(issues.map((i) => i.kind));
  // Idle/explicit timeout is the most specific signal.
  if (meta.trajIdle || meta.trajTimedOut || meta.idleTimeoutErr || kinds.has('timeout')) return 'timeout';
  // Abandoned: aborted with no clean end.
  if (kinds.has('abandoned') || (meta.abortedAny && !meta.endedCleanly)) return 'abandoned';
  // Runaway: huge token burn that still didn't finish cleanly.
  if (!meta.endedCleanly && meta.tokenUsage >= 1_000_000) return 'runaway';
  if (kinds.has('stale_gap') || kinds.has('no_progress')) return 'stalled';
  return 'errored';
}

/**
 * Best available step count for the excessive-steps check. Prefers the full
 * `eventCount`; on a coarse trajectory-only spine (few events) falls back to
 * `assistantCount` so a chatty run is not undercounted.
 */
function stepCount(meta: BuiltSession['meta']): number {
  return Math.max(meta.eventCount || 0, meta.assistantCount || 0);
}

/**
 * Loop/thrash signal for a *completed* run (mode #3). Scans `allAssistantText`
 * with the shared deterministic engine — same detectors the inline `guard.ts`
 * uses, but post-hoc. Returns the max of the cyclic-loop ratio and the
 * repetition score so both "cycling steps" and "same paragraph N times" count.
 * Guarded so it can never throw inside triage.
 */
function loopSignal(
  meta: BuiltSession['meta'],
  opts: Required<TriageOptions>,
): { ratio: number; detail: string } {
  const text = meta.allAssistantText || '';
  const sigs = meta.toolCallSignatures || [];

  // ── Tool-call loop: the same call fired many times (thrash) ───────────────
  // This half needs no prose to repeat — an agent retrying the same failing
  // command is the most common thrash. Ratio = (repeats of the most-frequent
  // signature) / (total calls); a run that is mostly one repeated call → ~1.0.
  //
  // Honesty guard: a signature with NO argument digest — `name()`, emitted when
  // the source didn't capture per-call args — is weak evidence. Six scattered
  // `edit()` calls to six DIFFERENT files must not look like a loop just because
  // the tool name matches. So a bare-name signature only counts toward the ratio
  // via the consecutive-streak channel (a genuine back-to-back retry burst),
  // never via bare share-of-calls. A signature WITH real args counts either way.
  let toolRatio = 0;
  let toolDetail = '';
  if (sigs.length >= opts.loopMinSegments) {
    const counts = new Map<string, number>();
    let maxConsecutive = 1;
    let run = 1;
    let prev: string | undefined;
    for (const sig of sigs) {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
      if (prev !== undefined && sig === prev) {
        run += 1;
        if (run > maxConsecutive) maxConsecutive = run;
      } else {
        run = 1;
      }
      prev = sig;
    }
    let topSig = '';
    let topCount = 0;
    for (const [sig, c] of counts) {
      if (c > topCount) {
        topCount = c;
        topSig = sig;
      }
    }
    // A signature is "specific" when it carries a non-empty arg digest: `name(…)`
    // with something between the parens. Bare `name()` is not specific.
    const isSpecific = /\([^)]/.test(topSig);
    const shareRatio = topCount / sigs.length;
    const streakRatio = maxConsecutive / sigs.length;
    // Specific args → trust either channel. Bare name → streak only.
    toolRatio = isSpecific ? Math.max(shareRatio, streakRatio) : streakRatio;
    if (topCount >= 2) {
      // Render the tool NAME clearly even when args are absent, and say so, so a
      // human reading the report always knows which tool thrashed.
      const name = topSig.replace(/\(.*$/s, '') || 'tool';
      const shownArgs = isSpecific
        ? `\`${topSig.slice(0, 90)}\``
        : `\`${name}\` (args not captured by this source)`;
      toolDetail =
        `tool ${shownArgs} called ×${topCount} of ${sigs.length}` +
        (maxConsecutive >= 2 ? ` (×${maxConsecutive} back-to-back)` : '');
    }
  }

  // ── Text loop: same assistant prose repeated (existing behavior) ───────────
  // Too few segments to "thrash", or empty output (that's the produced-nothing
  // failure, handled elsewhere) — do not claim a text loop.
  let textRatio = 0;
  let textDetail = '';
  if ((meta.assistantCount || 0) >= opts.loopMinSegments && text.trim().length >= 40) {
    try {
      const loop = detectLoops(text);
      const rep = analyzeRepetition(text);
      textRatio = Math.max(loop.loopRatio || 0, rep.score || 0);
      if (loop.hasLoop && loop.longestLoop) {
        const c = loop.longestLoop;
        textDetail = `cycle ×${c.repetitions} (${c.cycleLength}-segment) — "${(c.cycle[0] ?? '').slice(0, 60)}"`;
      } else if (rep.instances[0]) {
        const i = rep.instances[0];
        textDetail = `"${i.text.slice(0, 60)}" repeated ×${i.count} (${i.kind})`;
      }
    } catch {
      /* detectLoops/analyzeRepetition are best-effort; never break triage */
    }
  }

  // The run is looping if EITHER channel loops; report the stronger one, but
  // prefer the tool detail when tool-thrash is the dominant signal.
  const ratio = Math.max(toolRatio, textRatio);
  const detail = toolRatio >= textRatio ? toolDetail || textDetail : textDetail || toolDetail;
  return { ratio, detail };
}

/**
 * Classify a run that **ended cleanly** against the finished-but-bad thresholds,
 * or return `null` when it is within budget on all of them. Most-expensive
 * signal wins for the single-kind label (cost › latency › steps › loop), but
 * every tripped threshold is still recorded on the row's `issueKinds`.
 */
function classifyCompleted(
  meta: BuiltSession['meta'],
  opts: Required<TriageOptions>,
): { kind: FailureKind; tripped: FailureKind[]; loop: { ratio: number; detail: string } } | null {
  const tripped: FailureKind[] = [];
  if (meta.tokenUsage >= opts.overCostTokenThreshold) tripped.push('over-cost');
  if (Number.isFinite(meta.runtimeMs) && meta.runtimeMs >= opts.overLatencyMs)
    tripped.push('over-latency');
  if (stepCount(meta) >= opts.excessiveStepThreshold) tripped.push('excessive-steps');
  const loop = loopSignal(meta, opts);
  if (loop.ratio >= opts.loopRatioThreshold) tripped.push('loop-without-progress');
  if (tripped.length === 0) return null;
  // Priority for the primary label: cost first (it's what the pitch sells on),
  // then latency, then step-count, then loop (the softest, qualitative signal).
  const kind: FailureKind = tripped.includes('over-cost')
    ? 'over-cost'
    : tripped.includes('over-latency')
      ? 'over-latency'
      : tripped.includes('excessive-steps')
        ? 'excessive-steps'
        : 'loop-without-progress';
  return { kind, tripped, loop };
}

function summarize(row: Omit<TriageRow, 'summary'>): string {
  const tok = formatTokens(row.tokenUsage);
  const dur = formatDuration(row.runtimeMs);
  const cost = row.projectedCostUsd >= 1 ? ` (~$${row.projectedCostUsd.toFixed(0)})` : '';
  switch (row.kind) {
    case 'timeout':
      return `idle/timeout abandon — ${dur}, ${tok} tokens burned${cost}, never finished`;
    case 'abandoned':
      return `aborted with no clean end — ${dur}, ${tok} tokens${cost}`;
    case 'runaway':
      return `runaway — ${tok} tokens over ${dur}${cost}, did not complete`;
    case 'stalled':
      return `stalled / no forward progress — ${dur}, ${tok} tokens${cost}`;
    case 'over-cost':
      return `finished-but-over-cost — completed cleanly yet burned ${tok} tokens${cost} (over budget)`;
    case 'over-latency':
      return `finished-but-over-latency — completed cleanly but took ${dur} (over budget)`;
    case 'excessive-steps':
      return `finished-but-excessive-steps — completed cleanly in ${row.diagnosis?.eventCount ?? '?'} events (${tok} tokens${cost})`;
    case 'loop-without-progress':
      return `finished-but-looping — completed cleanly but repeated itself / thrashed (${dur}, ${tok} tokens${cost})`;
    default:
      return `errored — ${dur}, ${tok} tokens${cost}`;
  }
}

// ─── CORE ───────────────────────────────────────────────────────────────────────

/**
 * Build the actionable {@link TriageDiagnosis} for a row from the session meta
 * and the staleness result. Pure mapping over already-observed fields.
 */
function diagnose(
  meta: BuiltSession['meta'],
  result: ReturnType<typeof analyzeStaleness>,
  completed?: {
    tripped: FailureKind[];
    opts: Required<TriageOptions>;
    loop?: { ratio: number; detail: string };
  } | null,
): TriageDiagnosis {
  // Named signals, most-actionable first. Each maps to a real observed flag.
  const signals: string[] = [];
  if (meta.trajExternalAbort) signals.push('external-abort (killed from outside)');
  if (meta.idleTimeoutErr || meta.trajIdle) signals.push('idle-timeout (went quiet)');
  if (meta.trajTimedOut) signals.push('hard-timeout (exceeded budget)');
  if (meta.sawAborted || meta.trajAborted) signals.push('aborted (stopReason: aborted)');
  if (meta.trajError || meta.trajFinalStatus === 'error') signals.push('final-status: error');
  if (meta.errorEvents > 0) signals.push(`${meta.errorEvents} error event(s) in log`);
  if (!meta.cleanStop && signals.length === 0 && !completed) signals.push('no clean stop recorded');

  // Staleness findings apply to the failed-process family. For a cleanly-ended
  // run flagged only on resource budget, the staleness gap lines are noise (the
  // run *did* finish) — so we start clean and record only the budget evidence.
  const findings: string[] = completed
    ? []
    : result.issues.map((i) =>
        i.evidence ? `${i.kind}: ${i.message} — ${i.evidence}` : `${i.kind}: ${i.message}`,
      );

  // Finished-but-bad signals + synthetic findings. These runs ended cleanly, so
  // staleness produced nothing — the evidence is the budget each threshold names.
  if (completed && completed.tripped.length > 0) {
    signals.push('completed cleanly (exit status OK) — flagged on resource budget, not a crash');
    const o = completed.opts;
    for (const t of completed.tripped) {
      if (t === 'over-cost') {
        signals.push('over-cost (token budget exceeded on a successful run)');
        findings.push(
          `over-cost: ${formatTokens(meta.tokenUsage)} tokens ≥ ${formatTokens(o.overCostTokenThreshold)} budget — finished cleanly`,
        );
      } else if (t === 'over-latency') {
        signals.push('over-latency (wall-clock budget exceeded on a successful run)');
        findings.push(
          `over-latency: ran ${formatDuration(meta.runtimeMs)} ≥ ${formatDuration(o.overLatencyMs)} budget — finished cleanly`,
        );
      } else if (t === 'excessive-steps') {
        signals.push('excessive-steps (step budget exceeded on a successful run)');
        findings.push(
          `excessive-steps: ${stepCount(meta)} events ≥ ${o.excessiveStepThreshold} budget — finished cleanly`,
        );
      } else if (t === 'loop-without-progress') {
        signals.push('loop-without-progress (repeated itself / thrashed while under the token cap)');
        const r = completed.loop?.ratio ?? 0;
        const d = completed.loop?.detail ? ` — ${completed.loop.detail}` : '';
        findings.push(
          `loop-without-progress: loop/repetition ratio ${r.toFixed(2)} ≥ ${o.loopRatioThreshold} over ${meta.assistantCount} segments${d}`,
        );
      }
    }
  }

  // Self-report vs. measured-evidence contradictions. The timeline's own
  // staleness bar is `maxGapMs` (default 5m); a longest gap well under it means
  // the events do NOT support a "went quiet / timed out" story.
  const STALE_GAP_MS = 300_000; // matches detectStaleness default maxGapMs
  const contradictions: string[] = [];
  const claimsTimeBased = meta.trajTimedOut || meta.trajIdle || meta.idleTimeoutErr;
  const gap = result.longestGapMs;
  const gapIsShort = Number.isFinite(gap) && gap < STALE_GAP_MS;
  if (claimsTimeBased && result.hasEndEvent && gapIsShort) {
    contradictions.push(
      `self-report says timeout/idle, but the run reached an end event with only ` +
      `${formatDuration(gap)} of silence (staleness bar is ${formatDuration(STALE_GAP_MS)}) ` +
      `— the timing does not support a timeout; suspect a mislabeled trajectory flag`,
    );
  }
  if (meta.trajFinalStatus === 'success' && (meta.trajError || meta.errorEvents > 0)) {
    contradictions.push(
      `self-report says finalStatus=success, but ${meta.errorEvents} error event(s) were logged`,
    );
  }

  return {
    lastEventType: meta.lastType,
    lastRole: meta.lastRole,
    longestGapMs: result.longestGapMs,
    eventCount: meta.eventCount,
    assistantCount: meta.assistantCount,
    hadTrajectory: meta.hadTrajectory,
    signals,
    findings,
    contradictions,
  };
}

const EMPTY_BY_KIND = (): Record<FailureKind, number> => ({
  abandoned: 0,
  timeout: 0,
  runaway: 0,
  stalled: 0,
  errored: 0,
  'over-cost': 0,
  'over-latency': 0,
  'excessive-steps': 0,
  'loop-without-progress': 0,
});

/**
 * Triage a single built session into a {@link TriageRow}, or `null` if it ran
 * cleanly (or, under `staleOnly`, was not flagged stale).
 */
export function triageOne(built: BuiltSession, options: TriageOptions = {}): TriageRow | null {
  const opts = { ...DEFAULTS, ...options };
  const { meta, timeline } = built;

  const result = analyzeStaleness(timeline);
  const tokenUsage = meta.tokenUsage || 0;
  const runtimeMs = meta.runtimeMs;
  const projectedCostUsd = (tokenUsage / 1_000_000) * opts.dollarsPerMillionTokens;

  // ── Finished-but-bad family (modes #4 cost / #5 latency / #6 steps / #3 loop) ─
  // A run that ended cleanly is invisible to staleness/abort checks by
  // construction. Inspect it against the completed-run budgets instead (incl. a
  // loop/thrash scan of its assistant text); flag only when one is tripped.
  // This path never uses staleness signals.
  if (meta.endedCleanly) {
    if (!opts.includeCompleted) return null;
    const completed = classifyCompleted(meta, opts);
    if (!completed) return null;
    // `costly` stays cost-based (tokens/runtime), same bar as the broken family,
    // so the $ projection is honest. A cheap thrash run (loop/excessive-steps
    // under the cap) is a *quality* flag, surfaced via `completedBad`, not the
    // dollar total — it is not counted as costly.
    const costly =
      tokenUsage >= opts.costlyTokenThreshold ||
      (Number.isFinite(runtimeMs) && runtimeMs >= opts.costlyRuntimeMs);
    const base: Omit<TriageRow, 'summary'> = {
      id: meta.sessionId,
      label: meta.label,
      kind: completed.kind,
      // Every tripped budget is recorded; primary kind leads.
      issueKinds: completed.tripped as unknown as StalenessIssue['kind'][],
      tokenUsage,
      runtimeMs,
      projectedCostUsd,
      costly,
      diagnosis: diagnose(meta, result, {
        tripped: completed.tripped,
        opts,
        loop: completed.loop,
      }),
    };
    return { ...base, summary: summarize(base) };
  }

  // ── Failed-process family (abandon/timeout/runaway/stall/error) ───────────
  const failed = opts.staleOnly ? result.isStale : !meta.endedCleanly;
  if (!failed) return null;

  const issueKinds = result.issues.map((i) => i.kind);
  const costly =
    tokenUsage >= opts.costlyTokenThreshold ||
    (Number.isFinite(runtimeMs) && runtimeMs >= opts.costlyRuntimeMs);

  const kind = classify(meta, result.issues);
  const base: Omit<TriageRow, 'summary'> = {
    id: meta.sessionId,
    label: meta.label,
    kind,
    issueKinds,
    tokenUsage,
    runtimeMs,
    projectedCostUsd,
    costly,
    diagnosis: diagnose(meta, result),
  };
  return { ...base, summary: summarize(base) };
}

/**
 * Scan a sessions directory and produce a ranked {@link TriageReport}.
 *
 * @param sessionsDir directory of OpenClaw session logs
 * @param options     thresholds + pricing (see {@link TriageOptions})
 */
export function triageSessions(sessionsDir: string, options: TriageOptions = {}): TriageReport {
  const opts = { ...DEFAULTS, ...options };
  const built = buildAllSessions(sessionsDir);
  return triageBuilt(built, opts);
}

/**
 * Triage already-built sessions (useful when the caller has them in hand, e.g.
 * from a stream or a custom source). Pure: does no I/O.
 */
export function triageBuilt(sessions: BuiltSession[], options: TriageOptions = {}): TriageReport {
  const opts = { ...DEFAULTS, ...options };
  const rows: TriageRow[] = [];
  const byKind = EMPTY_BY_KIND();

  for (const built of sessions) {
    const row = triageOne(built, opts);
    if (!row) continue;
    rows.push(row);
    byKind[row.kind]++;
  }

  // Worst-first: costly before trivial, then by burned tokens, then runtime.
  rows.sort((a, b) => {
    if (a.costly !== b.costly) return a.costly ? -1 : 1;
    if (b.tokenUsage !== a.tokenUsage) return b.tokenUsage - a.tokenUsage;
    const ar = Number.isFinite(a.runtimeMs) ? a.runtimeMs : 0;
    const br = Number.isFinite(b.runtimeMs) ? b.runtimeMs : 0;
    return br - ar;
  });

  const costlyRows = rows.filter((r) => r.costly);
  const costlyTokens = costlyRows.reduce((sum, r) => sum + r.tokenUsage, 0);
  const projectedCostUsd = (costlyTokens / 1_000_000) * opts.dollarsPerMillionTokens;
  const completedBad = rows.filter((r) => COMPLETED_KINDS.has(r.kind)).length;

  return {
    scanned: sessions.length,
    flagged: rows.length,
    completedBad,
    costly: costlyRows.length,
    costlyTokens,
    projectedCostUsd,
    dollarsPerMillionTokens: opts.dollarsPerMillionTokens,
    byKind,
    rows,
  };
}

// ─── RENDER ─────────────────────────────────────────────────────────────────────

/**
 * Render the top-N failed trajectories as a compact Markdown table.
 *
 * @param report the {@link TriageReport} to render
 * @param limit  max rows to show (default 15)
 */
export function renderTriageTable(report: TriageReport, limit = 15): string {
  const lines: string[] = [];
  const brokeCount = report.flagged - report.completedBad;
  const completedNote =
    report.completedBad > 0
      ? ` (${brokeCount} broke, ${report.completedBad} finished-but-over-budget)`
      : '';
  lines.push(
    `Scanned ${report.scanned} sessions — ${report.flagged} flagged${completedNote} (${report.costly} costly). ` +
      `Projected over-budget spend: $${report.projectedCostUsd.toFixed(0)} @ $${report.dollarsPerMillionTokens}/M tokens.`,
  );
  lines.push('');
  lines.push('| # | Session | Kind | Duration | Tokens | ~$ | What went wrong |');
  lines.push('|---|---|---|---|---|---|---|');
  const shown = report.rows.slice(0, limit);
  shown.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | \`${r.id.slice(0, 8)}\` | ${r.kind} | ${formatDuration(r.runtimeMs)} | ` +
        `${formatTokens(r.tokenUsage)} | ${r.projectedCostUsd >= 1 ? '$' + r.projectedCostUsd.toFixed(0) : '—'} | ${r.summary} |`,
    );
  });
  return lines.join('\n');
}
