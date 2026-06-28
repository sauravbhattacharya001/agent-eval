/**
 * Behavioral guard — the free, zero-LLM runtime kill-switch (Tier 1/2).
 *
 * This is the "wedge": a drop-in that an agent loop calls as it runs. You push
 * events into it incrementally; it maintains a {@link RunTimeline}, runs the
 * deterministic checks already in this package (staleness / abandonment /
 * timeout / loop), and returns a verdict — keep going, or stop now (with a
 * reason and the offending issues). No model calls, no network, no cost.
 *
 * It is ALSO a trajectory tap: every event it sees is retained, so a finished
 * (or killed) run can be exported as a normalized timeline — the raw material
 * the cost-triage and the future semantic layer consume. The gate is the
 * excuse; the captured corpus is the asset.
 *
 * @example
 * ```ts
 * const guard = createGuard({ maxTokens: 1_000_000, maxDurationMs: 30 * 60_000 });
 * for await (const ev of agentStream) {
 *   const v = guard.observe(ev);            // push one RunEvent
 *   if (v.action === 'stop') {
 *     abortAgent(v.reason);                 // runaway / loop / stall / abandon
 *     break;
 *   }
 * }
 * const timeline = guard.finish();          // hand to triageSessions / capture
 * ```
 *
 * @tier 1/2 - Deterministic + heuristic. No LLM.
 * @module
 */

import { analyzeStaleness } from '../checks/staleness.js';
import { detectLoops } from '../checks/repetition.js';
import type { RunEvent, RunTimeline, StalenessIssue } from '../checks/staleness.js';

/** Why the guard told you to stop. */
export type GuardStopKind = 'runaway' | 'loop' | 'stall' | 'abandoned' | 'timeout';

/** Tuning for the guard. All bounds are optional; omit to disable that bound. */
export interface GuardOptions {
  /** Hard token ceiling for the run; exceeding it => `runaway`. */
  maxTokens?: number;
  /** Wall-clock budget in ms; exceeding it => `timeout`. */
  maxDurationMs?: number;
  /**
   * Max gap (ms) between events before the run is considered stalled. Passed
   * through to the staleness analyzer. Default: 300000 (5 min).
   */
  maxGapMs?: number;
  /**
   * How many recent assistant/output texts to keep for loop detection.
   * Default: 12. Set 0 to disable loop detection.
   */
  loopWindow?: number;
  /**
   * Minimum repeated-segment ratio (0..1) from `detectLoops` that trips a
   * `loop` stop. Default: 0.6.
   */
  loopThreshold?: number;
  /**
   * Re-run the (cheap) staleness analysis at most once per this many ms of
   * observed events, to bound work on very chatty streams. Default: 0 (every
   * event).
   */
  reanalyzeEveryMs?: number;
}

/** The guard's decision after observing an event (or on demand). */
export interface GuardVerdict {
  /** `continue` = keep running; `stop` = abort now. */
  action: 'continue' | 'stop';
  /** Present when `action === 'stop'`. */
  reason?: GuardStopKind;
  /** Human-readable one-liner. */
  message?: string;
  /** The staleness/loop issues that informed the verdict (may be empty). */
  issues: StalenessIssue[];
  /** Cumulative token count observed so far. */
  tokenUsage: number;
  /** Observed runtime so far, ms. */
  runtimeMs: number;
}

/** A live behavioral guard over a single agent run. */
export interface Guard {
  /**
   * Push one event. Optionally attach the run's cumulative token count on this
   * event (the guard keeps the max it has seen). Returns the current verdict.
   */
  observe(event: RunEvent, cumulativeTokens?: number): GuardVerdict;
  /** Re-evaluate without adding an event (e.g. on a heartbeat tick). */
  check(): GuardVerdict;
  /** Final verdict + the captured timeline, for export/triage/capture. */
  finish(): { verdict: GuardVerdict; timeline: RunTimeline };
  /** Snapshot the captured timeline so far (does not close the run). */
  snapshot(): RunTimeline;
}

const DEFAULTS = {
  maxGapMs: 300_000,
  loopWindow: 12,
  loopThreshold: 0.6,
  reanalyzeEveryMs: 0,
} as const;

function toMs(ts: string | number | undefined): number {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Create a behavioral guard. Stateful; one per run. Pure/deterministic — the
 * same event stream always yields the same verdicts.
 */
export function createGuard(options: GuardOptions = {}): Guard {
  const maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;
  const loopWindow = options.loopWindow ?? DEFAULTS.loopWindow;
  const loopThreshold = options.loopThreshold ?? DEFAULTS.loopThreshold;
  const reanalyzeEveryMs = options.reanalyzeEveryMs ?? DEFAULTS.reanalyzeEveryMs;

  const events: RunEvent[] = [];
  let startMs = NaN;
  let lastMs = NaN;
  let tokenUsage = 0;
  let lastAnalyzedAtMs = -Infinity;
  let stopped: GuardVerdict | null = null;
  const recentTexts: string[] = [];

  function runtimeMs(): number {
    return Number.isFinite(startMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - startMs) : 0;
  }

  function makeTimeline(closed: boolean): RunTimeline {
    const tl: RunTimeline = {
      startedAt: Number.isFinite(startMs) ? startMs : (events[0]?.timestamp ?? 0),
      events: events.slice(),
      output: recentTexts.length ? recentTexts[recentTexts.length - 1] : '',
    };
    if (options.maxDurationMs != null) tl.timeoutMs = options.maxDurationMs;
    if (closed) {
      const hasEnd = events.some((e) => e.type === 'end');
      if (hasEnd && Number.isFinite(lastMs)) tl.endedAt = lastMs;
    }
    return tl;
  }

  function evaluate(): GuardVerdict {
    if (stopped) return stopped;
    const rt = runtimeMs();

    // 1. Runaway: hard token ceiling (cheapest possible check).
    if (options.maxTokens != null && tokenUsage >= options.maxTokens) {
      return stop('runaway', `token ceiling exceeded: ${tokenUsage} >= ${options.maxTokens}`, [
        {
          kind: 'no_progress',
          severity: 'error',
          message: `runaway token usage (${tokenUsage} tokens)`,
        },
      ]);
    }

    // 2. Timeout: wall-clock budget.
    if (options.maxDurationMs != null && rt > options.maxDurationMs) {
      return stop('timeout', `runtime ${rt}ms exceeded budget ${options.maxDurationMs}ms`, [
        { kind: 'timeout', severity: 'error', message: `run exceeded ${options.maxDurationMs}ms` },
      ]);
    }

    // 3. Loop: repeated assistant/output segments (heuristic, no LLM).
    // `detectLoops` takes a single text and splits it into line-segments
    // internally, so we join the recent window with newlines.
    if (loopWindow > 0 && recentTexts.length >= 3) {
      try {
        const loop = detectLoops(recentTexts.slice(-loopWindow).join('\n'));
        const ratio = typeof loop?.loopRatio === 'number' ? loop.loopRatio : 0;
        const looped = loop?.hasLoop === true && ratio >= loopThreshold;
        if (looped) {
          return stop('loop', `repeated output detected (ratio ${ratio.toFixed(2)})`, [
            {
              kind: 'no_progress',
              severity: 'error',
              message: `output loop (repetition ${ratio.toFixed(2)})`,
            },
          ]);
        }
      } catch {
        /* detectLoops is best-effort; never let it crash the guard */
      }
    }

    // 4. Stall: defer to the staleness analyzer, but ONLY act on a real time
    //    GAP between events while the run is live. `no_output` / `no_progress`
    //    / `no_end` all mean "too little has happened" — which is expected
    //    mid-run and must not kill a healthy in-progress run; those are only
    //    meaningful at finish().
    const due = reanalyzeEveryMs <= 0 || lastMs - lastAnalyzedAtMs >= reanalyzeEveryMs;
    if (due) {
      lastAnalyzedAtMs = lastMs;
      const sr = analyzeStaleness(makeTimeline(false), { staleness: { maxGapMs } });
      // The underlying analyzer rates a gap as a *warning* (it stays advisory).
      // The guard is a kill-switch: if the caller set maxGapMs, exceeding it is
      // an actionable stall regardless of the analyzer's own severity.
      const gap = sr.issues.find((i) => i.kind === 'stale_gap');
      if (gap) {
        return stop('stall', gap.message, [{ ...gap, severity: 'error' }]);
      }
    }

    return {
      action: 'continue',
      issues: [],
      tokenUsage,
      runtimeMs: rt,
    };
  }

  function stop(reason: GuardStopKind, message: string, issues: StalenessIssue[]): GuardVerdict {
    stopped = { action: 'stop', reason, message, issues, tokenUsage, runtimeMs: runtimeMs() };
    return stopped;
  }

  function observe(event: RunEvent, cumulativeTokens?: number): GuardVerdict {
    events.push(event);
    const ms = toMs(event.timestamp);
    if (!Number.isNaN(ms)) {
      if (Number.isNaN(startMs)) startMs = ms;
      lastMs = ms;
    }
    if (typeof cumulativeTokens === 'number' && cumulativeTokens > tokenUsage) {
      tokenUsage = cumulativeTokens;
    }
    if ((event.type === 'output' || event.type === 'tool_call') && event.content && event.content.trim()) {
      recentTexts.push(event.content);
      if (recentTexts.length > Math.max(loopWindow, 1) * 2) recentTexts.shift();
    }
    return evaluate();
  }

  function check(): GuardVerdict {
    return evaluate();
  }

  function finish(): { verdict: GuardVerdict; timeline: RunTimeline } {
    const timeline = makeTimeline(true);
    // On finish, run the full staleness verdict. A run that never emitted a
    // clean `end` event (and wasn't already stopped) is treated as abandoned;
    // an over-budget run as timeout. The analyzer keeps these advisory
    // (warning) severities, but at finish the guard renders a hard verdict.
    if (!stopped) {
      const sr = analyzeStaleness(timeline, { staleness: { maxGapMs } });
      const hasEnd = events.some((e) => e.type === 'end');
      const timedOut = sr.issues.some((i) => i.kind === 'timeout');
      const gap = sr.issues.some((i) => i.kind === 'stale_gap');
      // `no_end` from the analyzer, or simply the absence of an end event we
      // emitted, means the run did not complete cleanly.
      const noEnd = !hasEnd || sr.issues.some((i) => i.kind === 'no_end');
      if (timedOut) {
        stop('timeout', sr.summary, [
          { kind: 'timeout', severity: 'error', message: sr.summary },
        ]);
      } else if (noEnd || gap) {
        stop('abandoned', sr.summary, [
          { kind: 'abandoned', severity: 'error', message: sr.summary },
        ]);
      }
    }
    const verdict =
      stopped ?? { action: 'continue' as const, issues: [], tokenUsage, runtimeMs: runtimeMs() };
    return { verdict, timeline };
  }

  function snapshot(): RunTimeline {
    return makeTimeline(false);
  }

  return { observe, check, finish, snapshot };
}
