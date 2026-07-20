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
 * Value decoding + span normalisation live in the {@link module:adapters/otlp-span}
 * leaf; this module handles session grouping, {@link BuiltSession} assembly, and the
 * public parse/triage API.
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
import { runtimeFloorFromActivity } from './runtime-floor.js';
import { buildExportTimeline } from './export-timeline.js';
import { triageBuilt } from '../action/triage.js';
import type { TriageOptions, TriageReport } from '../action/triage.js';
import { CAP_FINISH, normSpan } from './otlp-span.js';
import type { NormSpan, OtlpKeyValue, OtlpSpan } from './otlp-span.js';

// ─── OTLP TRACE SHAPE ─────────────────────────────────────────────────────────

/** A parsed OTLP trace export. */
export interface OtlpTrace {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpKeyValue[] };
    scopeSpans?: Array<{ scope?: unknown; spans?: OtlpSpan[] }>;
    // OTel <=0.x used `instrumentationLibrarySpans`; accept it too.
    instrumentationLibrarySpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
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
  if (!Number.isFinite(runtimeMs)) {
    runtimeMs = runtimeFloorFromActivity(
      startMs,
      (function* () {
        for (const s of spans) yield* [s.startMs, s.endMs];
      })(),
    );
  }

  const events: RunEvent[] = [];
  const assistantTexts: string[] = [];
  const toolCallSignatures: string[] = [];
  if (Number.isFinite(startMs)) events.push({ timestamp: startMs, type: 'start', content: sessionId });
  for (const s of spans) {
    const ts = Number.isFinite(s.startMs) ? s.startMs : startMs;
    if (s.exceptionMsg || s.isError) {
      events.push({ timestamp: ts, type: 'error', content: clip(s.exceptionMsg || `${s.name} errored`) });
    } else {
      const t = s.op === 'execute_tool' ? 'tool_call' : 'output';
      // Signature on the semantic tool name + args when the exporter recorded
      // them (OTel GenAI); fall back to the span name so "same tool ×N" is still
      // caught even when args are absent.
      if (s.op === 'execute_tool') {
        toolCallSignatures.push(toolSig(s.toolName || s.name, s.toolArgs));
      }
      events.push({ timestamp: ts, type: t, content: clip(s.name) });
      if (s.model) assistantTexts.push(`${s.name} (${s.model})`);
    }
  }
  if (!anyMissingEnd && Number.isFinite(endMs)) events.push({ timestamp: endMs, type: 'end', content: 'end' });

  const timeline: RunTimeline = buildExportTimeline({
    startMs,
    startFallback: 0,
    endMs,
    finished: !anyMissingEnd,
    events,
    assistantTexts,
  });

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
    toolCallSignatures,
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

  // NDJSON: one OTLP payload per line; malformed lines are skipped. Used both as the
  // primary path (text that is neither a single array nor a single object) AND as a
  // fallback when a structured parse of the whole blob fails — a real OTLP payload
  // begins with `{`, so object-per-line NDJSON would otherwise be mis-routed into the
  // single-object branch and throw on the second line.
  const pushNdjson = () => {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        payloads.push(JSON.parse(l) as OtlpTrace);
      } catch {
        /* skip malformed line */
      }
    }
  };

  const first = trimmed[0];
  if (first === '[') {
    // A top-level JSON array of payloads is unambiguously one document (this is not how
    // NDJSON is emitted), so parse it directly — a malformed array is a real error.
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) for (const p of arr) if (p && typeof p === 'object') payloads.push(p as OtlpTrace);
  } else if (first === '{') {
    // Ambiguous: this is either ONE payload (`{ resourceSpans: [...] }`) OR
    // payload-per-line NDJSON — both begin with `{`. Try the single-document parse
    // first; if the whole blob does not parse as one JSON value it is
    // newline-delimited payloads, so fall back to NDJSON instead of throwing.
    try {
      payloads.push(JSON.parse(trimmed) as OtlpTrace);
    } catch {
      pushNdjson();
    }
  } else {
    pushNdjson();
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
