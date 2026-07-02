/**
 * OpenTelemetry (OTLP) trace adapter - GenAI spans → {@link BuiltSession}.
 *
 * Converts an OTLP trace export (the JSON produced by an OTLP/HTTP exporter, i.e.
 * `{ resourceSpans: [...] }`) into the {@link BuiltSession} shape agent-eval's fleet
 * triage consumes. This is the **standard-format** adapter: any OpenTelemetry-native
 * LLM tracer - Arize Phoenix, Traceloop / OpenLLMetry, or the raw OTel GenAI SDK -
 * emits these spans, so ONE adapter covers the whole OTel ecosystem.
 *
 * ### Structure (real OTLP-JSON, per the OTel proto)
 *   { resourceSpans: [ { resource, scopeSpans: [ { scope, spans: [ Span, ... ] } ] } ] }
 * Each `Span` carries `traceId`, `spanId`, `name`, `kind`, `startTimeUnixNano`,
 * `endTimeUnixNano` (nanosecond strings), a typed-KV `attributes` list
 * (`{ key, value: { stringValue | intValue | boolValue | arrayValue } }`), an
 * optional `events` list (exceptions land here), and `status { code, message }`.
 *
 * ### Session grouping
 * LLM spans don't inherently share one root span, so we group by the GenAI
 * **`gen_ai.conversation.id`** attribute (the OTel equivalent of a session id),
 * falling back to `traceId` when conversation id is absent.
 *
 * ### Signals (GenAI semantic conventions, names verified against opentelemetry.semconv)
 * - `gen_ai.usage.input_tokens` / `output_tokens` (+ legacy `prompt_tokens` /
 *   `completion_tokens`) → cost.
 * - `gen_ai.response.finish_reasons` containing `length` (OpenAI) or `max_tokens`
 *   (Anthropic) → the model hit its cap ⇒ `trajTimedOut`.
 * - Span `status.code == 'STATUS_CODE_ERROR'` or an `exception` event ⇒ error.
 * - A span with a start but no end ⇒ never finished.
 *
 * Read-only, dependency-free: pure parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { RunEvent, RunTimeline } from '../checks/staleness.js';
import type { BuiltSession, SessionMeta } from './openclaw.js';
import { triageBuilt } from '../action/triage.js';
import type { TriageOptions, TriageReport } from '../action/triage.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const CONTENT_TRUNCATION = 500;
const LABEL_TRUNCATION = 120;
/** finish_reason values that mean "hit the token cap" (OpenAI: length, Anthropic: max_tokens). */
const CAP_FINISH = new Set(['length', 'max_tokens', 'model_length']);

// ─── OTLP VALUE TYPES ─────────────────────────────────────────────────────────

/** An OTLP `AnyValue` (only the variants we read). */
interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
}
interface OtlpKeyValue {
  key: string;
  value?: OtlpValue;
}
interface OtlpEvent {
  timeUnixNano?: string;
  name?: string;
  attributes?: OtlpKeyValue[];
}
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  kind?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  events?: OtlpEvent[];
  status?: { code?: string | number; message?: string };
}
/** A parsed OTLP trace export. */
export interface OtlpTrace {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: Array<{ scope?: unknown; spans?: OtlpSpan[] }>;
    // OTel <=0.x used `instrumentationLibrarySpans`; accept it too.
    instrumentationLibrarySpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

// ─── VALUE DECODING ───────────────────────────────────────────────────────────

/** Flatten an OTLP typed-KV attribute list into a plain map with decoded values. */
function attrMap(attrs: OtlpKeyValue[] | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (!attrs) return m;
  for (const kv of attrs) {
    if (kv && typeof kv.key === 'string') m.set(kv.key, decodeValue(kv.value));
  }
  return m;
}

function decodeValue(v: OtlpValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(decodeValue);
  return undefined;
}

function asNumber(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** OTLP nanosecond string → epoch ms. */
function nanoToMs(nano: string | undefined): number {
  if (!nano) return NaN;
  const n = Number(nano);
  return Number.isFinite(n) ? Math.floor(n / 1e6) : NaN;
}

function clip(value: unknown, max = CONTENT_TRUNCATION): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── SPAN → NORMALISED ────────────────────────────────────────────────────────

interface NormSpan {
  name: string;
  startMs: number;
  endMs: number;
  tokens: number;
  finishReasons: string[];
  isError: boolean;
  exceptionMsg: string;
  conversationId: string | undefined;
  op: string;
  model: string;
}

function normSpan(span: OtlpSpan): NormSpan {
  const a = attrMap(span.attributes);
  const inTok =
    asNumber(a.get('gen_ai.usage.input_tokens')) || asNumber(a.get('gen_ai.usage.prompt_tokens'));
  const outTok =
    asNumber(a.get('gen_ai.usage.output_tokens')) || asNumber(a.get('gen_ai.usage.completion_tokens'));
  const finishRaw = a.get('gen_ai.response.finish_reasons');
  const finishReasons = Array.isArray(finishRaw)
    ? finishRaw.map((x) => String(x))
    : finishRaw != null
      ? [String(finishRaw)]
      : [];

  const statusCode = String(span.status?.code ?? '');
  const isError = statusCode === 'STATUS_CODE_ERROR' || statusCode === '2';

  let exceptionMsg = '';
  for (const ev of span.events ?? []) {
    if (ev.name === 'exception') {
      const ea = attrMap(ev.attributes);
      exceptionMsg = `${ea.get('exception.type') ?? 'Exception'}: ${ea.get('exception.message') ?? ''}`.trim();
      break;
    }
  }

  return {
    name: span.name ?? '(span)',
    startMs: nanoToMs(span.startTimeUnixNano),
    endMs: nanoToMs(span.endTimeUnixNano),
    tokens: inTok + outTok,
    finishReasons,
    isError,
    exceptionMsg,
    conversationId:
      (a.get('gen_ai.conversation.id') as string | undefined) ??
      (a.get('session.id') as string | undefined),
    op: String(a.get('gen_ai.operation.name') ?? ''),
    model: String(a.get('gen_ai.request.model') ?? a.get('gen_ai.response.model') ?? ''),
  };
}

// ─── SESSION BUILD ────────────────────────────────────────────────────────────

function buildSession(sessionId: string, spans: NormSpan[]): BuiltSession {
  spans.sort((x, y) => (x.startMs || 0) - (y.startMs || 0));

  let startMs = NaN;
  let endMs = NaN;
  let anyMissingEnd = false;
  for (const s of spans) {
    if (Number.isFinite(s.startMs) && (Number.isNaN(startMs) || s.startMs < startMs)) startMs = s.startMs;
    if (Number.isFinite(s.endMs)) {
      if (Number.isNaN(endMs) || s.endMs > endMs) endMs = s.endMs;
    } else {
      anyMissingEnd = true;
    }
  }

  const tokenUsage = spans.reduce((sum, s) => sum + s.tokens, 0);
  const errored = spans.filter((s) => s.isError || s.exceptionMsg);
  const sawCap = spans.some((s) => s.finishReasons.some((r) => CAP_FINISH.has(r)));
  const endedCleanly = errored.length === 0 && !anyMissingEnd;

  // Runtime; if unfinished, fall back to a floor from last observed activity.
  let runtimeMs =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : NaN;
  if (!Number.isFinite(runtimeMs) && Number.isFinite(startMs)) {
    let last = startMs;
    for (const s of spans) for (const t of [s.startMs, s.endMs]) if (Number.isFinite(t) && t > last) last = t;
    if (last > startMs) runtimeMs = last - startMs;
  }

  const events: RunEvent[] = [];
  const assistantTexts: string[] = [];
  if (Number.isFinite(startMs)) events.push({ timestamp: startMs, type: 'start', content: sessionId });
  for (const s of spans) {
    const ts = Number.isFinite(s.startMs) ? s.startMs : startMs;
    if (s.exceptionMsg || s.isError) {
      events.push({ timestamp: ts, type: 'error', content: clip(s.exceptionMsg || `${s.name} errored`) });
    } else {
      const t = s.op === 'execute_tool' ? 'tool_call' : 'output';
      events.push({ timestamp: ts, type: t, content: clip(s.name) });
      if (s.model) assistantTexts.push(`${s.name} (${s.model})`);
    }
  }
  if (!anyMissingEnd && Number.isFinite(endMs)) events.push({ timestamp: endMs, type: 'end', content: 'end' });

  const timeline: RunTimeline = {
    startedAt: Number.isFinite(startMs) ? startMs : 0,
    ...(anyMissingEnd || !Number.isFinite(endMs) ? {} : { endedAt: endMs }),
    events,
    output: assistantTexts.join('\n').slice(0, 4000),
  };

  const firstErr = errored[0];
  const label =
    (spans.find((s) => s.op === 'chat')?.model
      ? `${spans.find((s) => s.op === 'chat')?.model} session`
      : spans[0]?.name) ?? '(no task line)';

  const abortedAny = errored.length > 0 || anyMissingEnd;
  const meta: SessionMeta = {
    sessionId,
    label: clip(label, LABEL_TRUNCATION),
    cwd: null,
    tokenUsage,
    msgTokenMax: spans.reduce((m, s) => Math.max(m, s.tokens), 0),
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
    trajTimedOut: sawCap,
    trajExternalAbort: false,
    trajFinalStatus: endedCleanly ? 'success' : 'error',
    trajError: errored.length > 0,
    abortedAny,
    endedCleanly,
    lastType: events.length ? (events[events.length - 1]?.type ?? null) : null,
    lastRole: null,
    allAssistantText: assistantTexts.join('\n') + (firstErr ? `\n${firstErr.exceptionMsg}` : ''),
    source: 'trajectory',
  };

  return { timeline, meta };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Parse an OTLP trace export into {@link BuiltSession}s (one per conversation).
 *
 * Accepts the JSON text of an OTLP/HTTP trace payload (`{ resourceSpans: [...] }`),
 * or an array of such payloads, or NDJSON with one payload per line.
 *
 * @param text  raw OTLP-JSON export contents
 */
export function parseOtlp(text: string): BuiltSession[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const payloads: OtlpTrace[] = [];
  if (trimmed[0] === '[') {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) for (const p of arr) if (p && typeof p === 'object') payloads.push(p as OtlpTrace);
  } else if (trimmed[0] === '{') {
    payloads.push(JSON.parse(trimmed) as OtlpTrace);
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        payloads.push(JSON.parse(l) as OtlpTrace);
      } catch {
        /* skip */
      }
    }
  }

  // Collect every span, group by conversation id (fallback: traceId, then a synthetic key).
  const bySession = new Map<string, NormSpan[]>();
  let synthetic = 0;
  for (const payload of payloads) {
    for (const rs of payload.resourceSpans ?? []) {
      const scopes = rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? [];
      for (const ss of scopes) {
        for (const rawSpan of ss.spans ?? []) {
          const ns = normSpan(rawSpan);
          const key = ns.conversationId ?? rawSpan.traceId ?? `otlp-${synthetic++}`;
          const bucket = bySession.get(key);
          if (bucket) bucket.push(ns);
          else bySession.set(key, [ns]);
        }
      }
    }
  }

  const sessions: BuiltSession[] = [];
  for (const [id, spans] of bySession) sessions.push(buildSession(id, spans));
  return sessions;
}

/**
 * Convenience: parse an OTLP trace export and triage it in one call.
 *
 * @param text     raw OTLP-JSON export contents
 * @param options  triage thresholds + pricing (see {@link TriageOptions})
 */
export function triageOtlp(text: string, options: TriageOptions = {}): TriageReport {
  return triageBuilt(parseOtlp(text), options);
}
