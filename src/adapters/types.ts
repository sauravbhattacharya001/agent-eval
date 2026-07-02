/**
 * Shared adapter contract — the normalized session shape every trace source
 * produces.
 *
 * This is the neutral core type that all adapters (OpenClaw, LangSmith, OTLP,
 * AgentLens, …) target and that the triage/action layer consumes. It lives here,
 * not inside any single adapter, so that no trace source "owns" the contract the
 * others must satisfy — a LangSmith or OTLP run should not import its shape from
 * the OpenClaw module.
 *
 * The {@link RunTimeline} feeds the deterministic Tier-1 checks; {@link SessionMeta}
 * carries the extra dimensions (token cost, abort provenance, clean-exit
 * determination) a triage or cost layer needs but that the timeline does not model.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { RunTimeline } from '../checks/staleness.js';

/** Which on-disk / export format a session timeline was built from. */
export type SessionSource = 'bare' | 'trajectory';

/**
 * Derived per-session signals that sit alongside the {@link RunTimeline}.
 *
 * The timeline feeds the deterministic checks; this metadata carries the extra
 * dimensions (token cost, abort provenance, clean-exit determination) a triage
 * or cost layer needs but that the timeline shape does not model.
 */
export interface SessionMeta {
  /** Session id (filename stem, no extension). */
  sessionId: string;
  /** Human label derived from the first real user line, or `'(no task line)'`. */
  label: string;
  /** Working directory if the bare log recorded one. */
  cwd: string | null;
  /** Best token count seen (max of bare `usage.totalTokens` and trajectory `usage.total`). */
  tokenUsage: number;
  /** Max per-message token total from the bare log. */
  msgTokenMax: number;
  /** Max cumulative token total from the trajectory trace. */
  trajTokenTotal: number;
  /** Whether a trajectory companion was present and parsed. */
  hadTrajectory: boolean;
  /** Wall-clock runtime in ms (`NaN` if timestamps are missing). */
  runtimeMs: number;
  /** Number of timeline events built. */
  eventCount: number;
  /** Number of assistant text segments captured. */
  assistantCount: number;
  /** Count of error events observed in the bare log. */
  errorEvents: number;
  /** Bare log saw a `stopReason: 'aborted'`. */
  sawAborted: boolean;
  /** Bare log saw an assistant `stopReason: 'stop'` (clean stop). */
  cleanStop: boolean;
  /** An idle-timeout error marker was detected. */
  idleTimeoutErr: boolean;
  /** Trajectory `idleTimedOut` flag. */
  trajIdle: boolean;
  /** Trajectory `aborted` flag. */
  trajAborted: boolean;
  /** Trajectory `timedOut` flag. */
  trajTimedOut: boolean;
  /** Trajectory `externalAbort` flag. */
  trajExternalAbort: boolean;
  /** Trajectory `finalStatus` (e.g. `'success' | 'error'`). */
  trajFinalStatus: string | null;
  /** Trajectory `finalStatus === 'error'`. */
  trajError: boolean;
  /** Any abort/idle/timeout/external/error signal across either source. */
  abortedAny: boolean;
  /** Whether the run reached a clean end (clean stop, no abort, no idle error). */
  endedCleanly: boolean;
  /** Type of the last record seen. */
  lastType: string | null;
  /** Role of the last message seen. */
  lastRole: string | null;
  /** All assistant text concatenated (for repetition/loop analysis). */
  allAssistantText: string;
  /** Which format this timeline was built from. */
  source: SessionSource;
}

/** A built session: the timeline for the checks plus derived metadata. */
export interface BuiltSession {
  timeline: RunTimeline;
  meta: SessionMeta;
}

/** A logical-session descriptor returned by an adapter's session lister. */
export interface SessionDescriptor {
  /** Session id (filename stem). */
  id: string;
  /** Explicit bare-file path when the representative is a checkpoint snapshot. */
  bareOverride?: string;
}
