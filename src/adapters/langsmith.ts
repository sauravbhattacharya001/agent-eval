/**
 * LangSmith run-export adapter - LangSmith/LangChain/LangGraph traces → {@link BuiltSession}.
 *
 * Converts a LangSmith run export (a JSON array of `Run` records, as produced by
 * `client.list_runs(...)` / the `langsmith trace export` CLI) into the
 * {@link BuiltSession} shape agent-eval's fleet triage consumes — so the exact same
 * Tier-1 staleness/timeout/abandonment analysis that runs on an OpenClaw fleet can
 * run on any LangChain-instrumented agent.
 *
 * ### Grouping
 * LangSmith runs form a tree: every run carries a `trace_id` (the root run's id) and
 * a `parent_run_id`. All runs sharing a `trace_id` are ONE logical session; the root
 * run (`parent_run_id == null`, or `id == trace_id`) supplies the session-level
 * label, start, and end. Child LLM/tool runs supply token usage (summed) and the
 * per-event timeline.
 *
 * ### Signals (LangSmith `Run` schema, from langsmith-sdk schemas.py)
 * - `error: string | null`         → an error string ⇒ the run failed.
 * - `end_time: datetime | null`    → missing end ⇒ never finished (abandoned).
 * - `status: 'success' | ...`      → clean terminal status.
 * - `total_tokens` / `prompt_tokens` / `completion_tokens` → cost; also read from
 *   `extra.metadata` / `outputs.llm_output.token_usage` as fallbacks.
 * - `run_type: 'llm'|'chain'|'tool'|'agent'|'retriever'|...` → event typing.
 *
 * ### Timeout heuristic
 * LangSmith has no first-class "timeout" flag. We infer `trajTimedOut` when an
 * `error` string matches timeout/deadline language (case-insensitive), mirroring how
 * the OpenClaw adapter treats idle-timeout error markers.
 *
 * Read-only, dependency-free: pure parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { RunEvent, RunTimeline } from '../checks/staleness.js';
import type { BuiltSession, SessionMeta } from './types.js';
import { toolSig } from './tool-signature.js';
import { clip } from './content-clip.js';
import { runtimeFloorFromActivity } from './runtime-floor.js';
import { buildExportTimeline } from './export-timeline.js';
import { triageBuilt } from '../action/triage.js';
import type { TriageOptions, TriageReport } from '../action/triage.js';
import {
  TIMEOUT_RE,
  toMs,
  runTokens,
  extractLabel,
  eventType,
  type LangSmithRun,
} from './langsmith-fields.js';

// Re-export the run record type so the public barrel surface is unchanged by the split.
export type { LangSmithRun } from './langsmith-fields.js';

// ─── CORE ─────────────────────────────────────────────────────────────────────

/** Build ONE {@link BuiltSession} from all runs sharing a trace. */
function buildTrace(traceId: string, runs: LangSmithRun[]): BuiltSession {
  // Order by start_time so the timeline is chronological.
  runs.sort((a, b) => (toMs(a.start_time) || 0) - (toMs(b.start_time) || 0));

  const root =
    runs.find((r) => !r.parent_run_id) ??
    runs.find((r) => r.id === traceId) ??
    runs[0];
  // buildTrace is only ever called with a non-empty group; assert for the type-checker.
  if (!root) {
    throw new Error(`buildTrace called with empty run group for trace ${traceId}`);
  }

  const startedMs = toMs(root.start_time);
  // Session end = latest end_time across all runs; if ANY run lacks an end, the
  // session did not cleanly finish.
  let latestEnd = NaN;
  let anyMissingEnd = false;
  for (const r of runs) {
    const e = toMs(r.end_time);
    if (Number.isNaN(e)) anyMissingEnd = true;
    else if (Number.isNaN(latestEnd) || e > latestEnd) latestEnd = e;
  }

  const errored = runs.filter((r) => r.error != null && String(r.error).length > 0);
  const sawTimeout = errored.some((r) => TIMEOUT_RE.test(String(r.error)));
  const rootStatus = (root.status ?? '').toLowerCase();

  // endedCleanly: root reports success (or has an end) AND nothing errored AND no run
  // is missing its end_time.
  const cleanStatus = rootStatus === 'success' || (!anyMissingEnd && errored.length === 0);
  const endedCleanly = cleanStatus && errored.length === 0 && !anyMissingEnd;

  // Token accounting: in LangSmith a chain/agent run's `total_tokens` is a ROLLUP of
  // its descendants, so naively summing every run double-counts. Prefer the sum of
  // LEAF llm runs; fall back to the root rollup when leaf usage is absent.
  const llmRuns = runs.filter((r) => r.run_type === 'llm');
  const leafTokens = llmRuns.reduce((sum, r) => sum + runTokens(r), 0);
  const rootRollup = runTokens(root);
  const tokenUsage = leafTokens > 0 ? leafTokens : rootRollup;

  // Runtime. When the session ended cleanly we use start→latestEnd. When it did NOT
  // (a timed-out/hung run has no end_time), report a FLOOR duration: start → the last
  // activity we actually observed across the trace. This is honest — "we saw work for
  // at least this long, then it stopped emitting" — and beats rendering an unknown '?'.
  let runtimeMs =
    Number.isFinite(startedMs) && Number.isFinite(latestEnd) ? latestEnd - startedMs : NaN;
  if (!Number.isFinite(runtimeMs)) {
    runtimeMs = runtimeFloorFromActivity(
      startedMs,
      (function* () {
        for (const r of runs) yield* [toMs(r.start_time), toMs(r.end_time)];
      })(),
    );
  }

  const events: RunEvent[] = [];
  if (Number.isFinite(startedMs)) {
    events.push({ timestamp: startedMs, type: 'start', content: clip(root.name ?? traceId) });
  }
  const assistantTexts: string[] = [];
  const toolCallSignatures: string[] = [];
  for (const r of runs) {
    const ts = toMs(r.start_time);
    if (r.error) {
      events.push({ timestamp: ts, type: 'error', content: clip(r.error) });
    } else {
      const outText = clip(r.outputs);
      if (outText) assistantTexts.push(outText);
      if (r.run_type === 'tool' || r.run_type === 'retriever') {
        toolCallSignatures.push(toolSig(r.name, r.inputs));
      }
      events.push({ timestamp: ts, type: eventType(r), content: outText });
    }
  }
  if (!anyMissingEnd && Number.isFinite(latestEnd)) {
    events.push({ timestamp: latestEnd, type: 'end', content: rootStatus || 'end' });
  }

  const timeline: RunTimeline = buildExportTimeline({
    startMs: startedMs,
    startFallback: root.start_time ?? 0,
    endMs: latestEnd,
    finished: !anyMissingEnd,
    events,
    assistantTexts,
  });

  const abortedAny = errored.length > 0 || anyMissingEnd || sawTimeout;

  const meta: SessionMeta = {
    sessionId: traceId,
    label: extractLabel(root),
    cwd: null,
    tokenUsage,
    msgTokenMax: runs.reduce((m, r) => Math.max(m, runTokens(r)), 0),
    trajTokenTotal: tokenUsage,
    hadTrajectory: true,
    runtimeMs,
    eventCount: events.length,
    assistantCount: assistantTexts.length,
    errorEvents: errored.length,
    sawAborted: abortedAny,
    cleanStop: endedCleanly,
    idleTimeoutErr: false,
    trajIdle: false,
    trajAborted: anyMissingEnd,
    trajTimedOut: sawTimeout,
    trajExternalAbort: false,
    trajFinalStatus: rootStatus || (endedCleanly ? 'success' : 'error'),
    trajError: errored.length > 0,
    abortedAny,
    endedCleanly,
    lastType: events.length ? (events[events.length - 1]?.type ?? null) : null,
    lastRole: null,
    allAssistantText: assistantTexts.join('\n'),
    toolCallSignatures,
    source: 'trajectory',
  };

  return { timeline, meta };
}

/**
 * Parse a LangSmith run export into {@link BuiltSession}s (one per trace).
 *
 * Accepts the JSON text of either a top-level array of runs, or `{ runs: [...] }`,
 * or newline-delimited JSON (one run per line, as `langsmith trace export` emits).
 * NDJSON is detected as a fallback too: a multi-line blob whose first character is
 * `{` (so each line is a run object) is parsed line-by-line when it does not parse
 * as a single JSON document. Malformed NDJSON lines are skipped, not fatal.
 *
 * @param text  the raw export file contents
 */
export function parseLangSmith(text: string): BuiltSession[] {
  const runs: LangSmithRun[] = [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pushAll = (arr: unknown) => {
    if (Array.isArray(arr)) for (const r of arr) if (r && typeof r === 'object') runs.push(r as LangSmithRun);
  };

  // NDJSON: one JSON value per line; malformed lines are skipped. Used both as the
  // primary path (text that is neither a single array nor a single object) AND as a
  // fallback when a structured parse of the whole blob fails — because object-per-line
  // NDJSON begins with `{` and would otherwise be mis-routed into the single-object
  // branch and throw on the second line.
  const pushNdjson = () => {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        if (Array.isArray(r)) pushAll(r);
        else if (r && typeof r === 'object') runs.push(r as LangSmithRun);
      } catch {
        /* skip malformed line */
      }
    }
  };

  const first = trimmed[0];
  if (first === '[') {
    // A top-level JSON array of runs is unambiguously one document (this is not how
    // NDJSON is emitted), so parse it directly — a malformed array is a real error.
    pushAll(JSON.parse(trimmed));
  } else if (first === '{') {
    // Ambiguous: this is either ONE object (a `{ runs: [...] }` wrapper or a single
    // run) OR object-per-line NDJSON — both begin with `{`. Try the single-document
    // parse first; if the whole blob does not parse as one JSON value it is
    // newline-delimited runs, so fall back to NDJSON instead of throwing.
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      pushNdjson();
    }
    if (parsed) {
      if (Array.isArray(parsed.runs)) pushAll(parsed.runs);
      else if (parsed.id) runs.push(parsed as LangSmithRun); // single run object
      else pushAll(Object.values(parsed)); // last resort: values are runs
    }
  } else {
    pushNdjson();
  }

  // Group by trace_id (fall back to id when trace_id is absent → each run its own trace).
  const byTrace = new Map<string, LangSmithRun[]>();
  for (const r of runs) {
    const key = r.trace_id ?? r.id;
    if (!key) continue;
    const bucket = byTrace.get(key);
    if (bucket) bucket.push(r);
    else byTrace.set(key, [r]);
  }

  const sessions: BuiltSession[] = [];
  for (const [traceId, group] of byTrace) sessions.push(buildTrace(traceId, group));
  return sessions;
}

/**
 * Convenience: parse a LangSmith export and triage it in one call.
 *
 * @param text     raw LangSmith run-export contents
 * @param options  triage thresholds + pricing (see {@link TriageOptions})
 */
export function triageLangSmith(text: string, options: TriageOptions = {}): TriageReport {
  return triageBuilt(parseLangSmith(text), options);
}
