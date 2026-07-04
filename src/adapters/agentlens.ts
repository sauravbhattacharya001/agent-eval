/**
 * AgentLens export adapter - AgentLens session JSON → {@link BuiltSession}.
 *
 * Converts an AgentLens session export - the JSON emitted by the AgentLens SDK's
 * `SessionExporter.to_json()` / `as_json()` - into the {@link BuiltSession} shape
 * agent-eval's fleet triage consumes. This closes the loop between the two tools:
 * **AgentLens records the run, agent-eval grades it**, with no glue code.
 *
 * ### Structure (authoritative, from `SessionExporter.as_json`)
 *   {
 *     "session": { session_id, agent_name, started_at, ended_at, status, metadata },
 *     "stats":   { total_tokens, total_tokens_in, total_tokens_out,
 *                  session_duration_ms, error_count, event_count, ... },
 *     "events":  [ { event_type, timestamp, model, tokens_in, tokens_out,
 *                    input_data, output_data, tool_call, duration_ms }, ... ]
 *   }
 *
 * The `stats` block is pre-computed by AgentLens itself, so token totals, duration,
 * and error count are read straight from it (with an events-based fallback).
 *
 * ### Signals (AgentLens model)
 * - `session.status`: `active` | `completed` | `error`. `completed` ⇒ clean;
 *   `error` ⇒ failed; `active` with no `ended_at` ⇒ never finished.
 * - `stats.total_tokens` (or summed `tokens_in`+`tokens_out`) → cost.
 * - `stats.session_duration_ms` (or `ended_at - started_at`) → runtime.
 * - an event with `event_type == 'error'`, or `stats.error_count > 0` → error.
 * - a still-`active` session with no `ended_at` ⇒ abandoned / timed-out.
 *
 * Read-only, dependency-free: pure parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { RunEvent, RunTimeline } from '../checks/staleness.js';
import type { BuiltSession, SessionMeta } from './types.js';
import { toolSig } from './tool-signature.js';
import { clip, LABEL_TRUNCATION } from './content-clip.js';
import { triageBuilt } from '../action/triage.js';
import type { TriageOptions, TriageReport } from '../action/triage.js';

// ─── TYPES (the fields we read; extras ignored) ───────────────────────────────

interface AgentLensToolCall {
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  reasoning?: string;
}
interface AgentLensEvent {
  event_id?: string;
  session_id?: string;
  event_type?: string; // llm_call | tool_call | decision | error | generic
  timestamp?: string;
  input_data?: unknown;
  output_data?: unknown;
  model?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  tool_call?: AgentLensToolCall | null;
  duration_ms?: number | null;
}
interface AgentLensStats {
  total_tokens?: number;
  total_tokens_in?: number;
  total_tokens_out?: number;
  session_duration_ms?: number | null;
  error_count?: number;
  event_count?: number;
}
/** One AgentLens session export (the shape `SessionExporter.as_json()` emits). */
export interface AgentLensExport {
  session?: {
    session_id?: string;
    agent_name?: string;
    started_at?: string | null;
    ended_at?: string | null;
    status?: string; // active | completed | error
    metadata?: Record<string, unknown>;
  };
  stats?: AgentLensStats;
  events?: AgentLensEvent[];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function toMs(t: string | null | undefined): number {
  if (!t) return NaN;
  const p = Date.parse(t);
  return Number.isNaN(p) ? NaN : p;
}

/** Pull a label from the first event's input, or the agent name. */
function deriveLabel(exp: AgentLensExport): string {
  const first = exp.events?.find((e) => e.input_data != null);
  if (first?.input_data) {
    const inp = first.input_data as Record<string, unknown> | string;
    if (typeof inp === 'string') return clip(inp, LABEL_TRUNCATION);
    for (const k of ['prompt', 'input', 'question', 'query', 'text']) {
      if (typeof (inp as Record<string, unknown>)[k] === 'string') {
        return clip((inp as Record<string, unknown>)[k], LABEL_TRUNCATION);
      }
    }
    return clip(inp, LABEL_TRUNCATION);
  }
  return exp.session?.agent_name ? `${exp.session.agent_name} session` : '(no task line)';
}

function mapEventType(t: string | undefined): RunEvent['type'] {
  switch (t) {
    case 'error': return 'error';
    case 'tool_call': return 'tool_call';
    case 'llm_call': return 'output';
    case 'decision': return 'output';
    default: return t || 'output';
  }
}

// ─── CORE ─────────────────────────────────────────────────────────────────────

function buildSession(exp: AgentLensExport): BuiltSession {
  const s = exp.session ?? {};
  const stats = exp.stats ?? {};
  const evs = exp.events ?? [];
  const sessionId = s.session_id ?? exp.events?.[0]?.session_id ?? 'agentlens-session';

  const status = (s.status ?? '').toLowerCase();
  const startMs = toMs(s.started_at);
  const endMs = toMs(s.ended_at);
  const neverEnded = !s.ended_at || Number.isNaN(endMs);

  // Tokens: prefer AgentLens's own pre-computed total; fall back to summing events.
  const tokenUsage =
    typeof stats.total_tokens === 'number'
      ? stats.total_tokens
      : typeof stats.total_tokens_in === 'number' || typeof stats.total_tokens_out === 'number'
        ? (stats.total_tokens_in ?? 0) + (stats.total_tokens_out ?? 0)
        : evs.reduce((sum, e) => sum + (e.tokens_in ?? 0) + (e.tokens_out ?? 0), 0);

  // Duration: prefer stats; else ended-started; else floor from last event timestamp.
  let runtimeMs =
    typeof stats.session_duration_ms === 'number'
      ? stats.session_duration_ms
      : Number.isFinite(startMs) && Number.isFinite(endMs)
        ? endMs - startMs
        : NaN;
  if (!Number.isFinite(runtimeMs) && Number.isFinite(startMs)) {
    let last = startMs;
    for (const e of evs) {
      const t = toMs(e.timestamp);
      if (Number.isFinite(t) && t > last) last = t;
      // AgentLens events carry their own duration; an event that started at `t` and
      // ran `duration_ms` extends the last observed activity to t + duration.
      if (Number.isFinite(t) && typeof e.duration_ms === 'number' && t + e.duration_ms > last) {
        last = t + e.duration_ms;
      }
    }
    if (last > startMs) runtimeMs = last - startMs;
  }

  const errorEventCount =
    typeof stats.error_count === 'number'
      ? stats.error_count
      : evs.filter((e) => e.event_type === 'error').length;

  // Verdict flags.
  const isError = status === 'error' || errorEventCount > 0;
  const abandoned = neverEnded || status === 'active';
  const endedCleanly = status === 'completed' && !isError && !neverEnded;
  const abortedAny = isError || abandoned;

  // Timeline.
  const events: RunEvent[] = [];
  const assistantTexts: string[] = [];
  const toolCallSignatures: string[] = [];
  if (Number.isFinite(startMs)) events.push({ timestamp: startMs, type: 'start', content: sessionId });
  for (const e of evs) {
    const ts = toMs(e.timestamp);
    if (e.event_type === 'error') {
      events.push({ timestamp: ts, type: 'error', content: clip(e.output_data ?? 'error') });
    } else {
      const text = clip(e.output_data ?? e.tool_call?.tool_name ?? e.model ?? e.event_type);
      if (text) assistantTexts.push(text);
      // Carry an AgentLens reasoning field through, if present.
      if (e.tool_call?.reasoning) assistantTexts.push(`reasoning: ${clip(e.tool_call.reasoning)}`);
      if (e.event_type === 'tool_call' && e.tool_call) {
        toolCallSignatures.push(toolSig(e.tool_call.tool_name, e.tool_call.tool_input));
      }
      events.push({ timestamp: ts, type: mapEventType(e.event_type), content: text });
    }
  }
  if (!neverEnded && Number.isFinite(endMs)) events.push({ timestamp: endMs, type: 'end', content: status || 'end' });

  const timeline: RunTimeline = {
    startedAt: Number.isFinite(startMs) ? startMs : (s.started_at ?? 0),
    ...(neverEnded || !Number.isFinite(endMs) ? {} : { endedAt: endMs }),
    events,
    output: assistantTexts.join('\n').slice(0, 4000),
  };

  const meta: SessionMeta = {
    sessionId,
    label: deriveLabel(exp),
    cwd: null,
    tokenUsage,
    msgTokenMax: evs.reduce((m, e) => Math.max(m, (e.tokens_in ?? 0) + (e.tokens_out ?? 0)), 0),
    trajTokenTotal: tokenUsage,
    hadTrajectory: true,
    runtimeMs,
    eventCount: events.length,
    assistantCount: assistantTexts.length,
    errorEvents: errorEventCount,
    sawAborted: abortedAny,
    cleanStop: endedCleanly,
    idleTimeoutErr: false,
    trajIdle: false,
    trajAborted: abandoned,
    // AgentLens has no explicit timeout flag; a still-active run that never ended is
    // the closest analog (idle abandon), so mark it so triage classifies it as timeout.
    trajTimedOut: abandoned && !isError,
    trajExternalAbort: false,
    trajFinalStatus: status || (endedCleanly ? 'completed' : 'error'),
    trajError: isError,
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

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Parse an AgentLens export into {@link BuiltSession}s.
 *
 * Accepts the JSON text of a single AgentLens session export (`{ session, stats,
 * events }`), an array of such exports, or NDJSON with one export per line.
 *
 * @param text  raw AgentLens export contents
 */
export function parseAgentLens(text: string): BuiltSession[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const exports: AgentLensExport[] = [];
  const pushOne = (o: unknown) => {
    if (o && typeof o === 'object' && ('session' in o || 'events' in o)) exports.push(o as AgentLensExport);
  };

  if (trimmed[0] === '[') {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) for (const o of arr) pushOne(o);
  } else if (trimmed[0] === '{') {
    pushOne(JSON.parse(trimmed));
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        pushOne(JSON.parse(l));
      } catch {
        /* skip */
      }
    }
  }

  return exports.map(buildSession);
}

/**
 * Convenience: parse an AgentLens export and triage it in one call.
 *
 * Note: AgentLens records failure in `session.status` (`active` | `completed` |
 * `error`) and `ended_at`, which is richer than the raw-timeline gap signal the
 * default `staleOnly:true` mode looks for. Pass `staleOnly:false` (recommended for
 * AgentLens) so triage consumes that status verdict via `!endedCleanly` and flags
 * still-`active`/never-ended and `error` sessions - not just timeline-gap stalls.
 *
 * @param text     raw AgentLens export contents
 * @param options  triage thresholds + pricing (see {@link TriageOptions})
 */
export function triageAgentLens(text: string, options: TriageOptions = {}): TriageReport {
  return triageBuilt(parseAgentLens(text), options);
}
