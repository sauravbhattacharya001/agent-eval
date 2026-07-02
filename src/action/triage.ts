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
   */
  staleOnly?: boolean;
}

const DEFAULTS: Required<TriageOptions> = {
  costlyTokenThreshold: 200_000,
  costlyRuntimeMs: 600_000,
  dollarsPerMillionTokens: 9,
  staleOnly: true,
};

// ─── RESULT TYPES ───────────────────────────────────────────────────────────────

/** Coarse classification of how a run failed (most-severe wins for sorting). */
export type FailureKind = 'abandoned' | 'timeout' | 'runaway' | 'stalled' | 'errored';

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
}

/** The full triage report for a sessions directory. */
export interface TriageReport {
  /** Total logical sessions scanned. */
  scanned: number;
  /** Sessions flagged as failed trajectories. */
  flagged: number;
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
): TriageDiagnosis {
  // Named signals, most-actionable first. Each maps to a real observed flag.
  const signals: string[] = [];
  if (meta.trajExternalAbort) signals.push('external-abort (killed from outside)');
  if (meta.idleTimeoutErr || meta.trajIdle) signals.push('idle-timeout (went quiet)');
  if (meta.trajTimedOut) signals.push('hard-timeout (exceeded budget)');
  if (meta.sawAborted || meta.trajAborted) signals.push('aborted (stopReason: aborted)');
  if (meta.trajError || meta.trajFinalStatus === 'error') signals.push('final-status: error');
  if (meta.errorEvents > 0) signals.push(`${meta.errorEvents} error event(s) in log`);
  if (!meta.cleanStop && signals.length === 0) signals.push('no clean stop recorded');

  const findings = result.issues.map((i) =>
    i.evidence ? `${i.kind}: ${i.message} — ${i.evidence}` : `${i.kind}: ${i.message}`,
  );

  return {
    lastEventType: meta.lastType,
    lastRole: meta.lastRole,
    longestGapMs: result.longestGapMs,
    eventCount: meta.eventCount,
    assistantCount: meta.assistantCount,
    hadTrajectory: meta.hadTrajectory,
    signals,
    findings,
  };
}

const EMPTY_BY_KIND = (): Record<FailureKind, number> => ({
  abandoned: 0,
  timeout: 0,
  runaway: 0,
  stalled: 0,
  errored: 0,
});

/**
 * Triage a single built session into a {@link TriageRow}, or `null` if it ran
 * cleanly (or, under `staleOnly`, was not flagged stale).
 */
export function triageOne(built: BuiltSession, options: TriageOptions = {}): TriageRow | null {
  const opts = { ...DEFAULTS, ...options };
  const { meta, timeline } = built;

  const result = analyzeStaleness(timeline);
  const failed = opts.staleOnly ? result.isStale : !meta.endedCleanly;
  if (!failed) return null;

  const issueKinds = result.issues.map((i) => i.kind);
  const tokenUsage = meta.tokenUsage || 0;
  const runtimeMs = meta.runtimeMs;
  const projectedCostUsd = (tokenUsage / 1_000_000) * opts.dollarsPerMillionTokens;
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

  return {
    scanned: sessions.length,
    flagged: rows.length,
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
  lines.push(
    `Scanned ${report.scanned} sessions — ${report.flagged} failed (${report.costly} costly). ` +
      `Projected waste: $${report.projectedCostUsd.toFixed(0)} @ $${report.dollarsPerMillionTokens}/M tokens.`,
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
