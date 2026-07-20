/**
 * OTLP span decoding leaf — typed-KV value decode + span normalisation.
 *
 * The pure, IO-free bottom layer of the {@link module:adapters/otlp} adapter: it
 * turns raw OTLP `Span` objects (with their typed-KV `attributes`, nanosecond
 * timestamps, and `events`/`status`) into the flat {@link NormSpan} shape the
 * session builder consumes. No grouping, no {@link BuiltSession} assembly, no
 * triage — those live in `otlp.ts`. Splitting this out keeps the value-decoding
 * seam independently testable and shrinks the adapter body.
 *
 * @tier 1 - Deterministic
 * @module
 */

// ─── OTLP VALUE TYPES ─────────────────────────────────────────────────────────

/** An OTLP `AnyValue` (only the variants we read). */
export interface OtlpValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
}
export interface OtlpKeyValue {
  key: string;
  value?: OtlpValue;
}
export interface OtlpEvent {
  timeUnixNano?: string;
  name?: string;
  attributes?: OtlpKeyValue[];
}
export interface OtlpSpan {
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

/** finish_reason values that mean "hit the token cap" (OpenAI: length, Anthropic: max_tokens). */
export const CAP_FINISH = new Set(['length', 'max_tokens', 'model_length']);

// ─── VALUE DECODING ───────────────────────────────────────────────────────────

/** Flatten an OTLP typed-KV attribute list into a plain map with decoded values. */
export function attrMap(attrs: OtlpKeyValue[] | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (!attrs) return m;
  for (const kv of attrs) {
    if (kv && typeof kv.key === 'string') m.set(kv.key, decodeValue(kv.value));
  }
  return m;
}

export function decodeValue(v: OtlpValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(decodeValue);
  return undefined;
}

export function asNumber(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/** OTLP nanosecond string → epoch ms. */
export function nanoToMs(nano: string | undefined): number {
  if (!nano) return NaN;
  const n = Number(nano);
  return Number.isFinite(n) ? Math.floor(n / 1e6) : NaN;
}

// ─── SPAN → NORMALISED ────────────────────────────────────────────────────────

export interface NormSpan {
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
  /** Tool identity for `execute_tool` spans (OTel GenAI); empty otherwise. */
  toolName: string;
  /** Raw tool arguments if the exporter recorded them; `undefined` if not. */
  toolArgs: unknown;
}

export function normSpan(span: OtlpSpan): NormSpan {
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

  const op = String(a.get('gen_ai.operation.name') ?? '');
  // OTel GenAI tool spans: prefer the semantic tool name, fall back to the
  // code.function.* convention, then the raw span name. Arguments live under a
  // few vendor spellings — take the first one the exporter actually recorded.
  const toolName = String(
    a.get('gen_ai.tool.name') ?? a.get('code.function.name') ?? '',
  );
  const toolArgs =
    a.get('gen_ai.tool.call.arguments') ??
    a.get('gen_ai.tool.arguments') ??
    a.get('gen_ai.tool.input') ??
    a.get('tool.arguments') ??
    a.get('code.function.arguments') ??
    undefined;

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
    op,
    model: String(a.get('gen_ai.request.model') ?? a.get('gen_ai.response.model') ?? ''),
    toolName,
    toolArgs,
  };
}
