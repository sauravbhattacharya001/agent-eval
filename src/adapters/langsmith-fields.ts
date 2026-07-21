/**
 * LangSmith per-run field extraction — the pure, single-run helpers that read one
 * {@link LangSmithRun}'s fields (timestamps, tokens, label, event type) without any
 * knowledge of trace grouping or session assembly.
 *
 * Split out of `langsmith.ts` with NO behavior change: `langsmith.ts` owns the
 * trace-grouping / session-building logic, this module owns the "given one run,
 * what does this field mean" primitives. Read-only, dependency-free.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { RunEvent } from '../checks/staleness.js';
import { clip, LABEL_TRUNCATION } from './content-clip.js';

/** Error strings that indicate an explicit timeout/deadline rather than a generic fail. */
export const TIMEOUT_RE =
  /\b(timed?[\s_-]?out|timeout|deadline|deadline[\s_-]?exceeded|etimedout|read timed out)\b/i;

/** A single LangSmith `Run` record (the fields we read; extras ignored). */
export interface LangSmithRun {
  id: string;
  trace_id?: string;
  parent_run_id?: string | null;
  name?: string;
  run_type?: string;
  start_time?: string | number | null;
  end_time?: string | number | null;
  error?: string | null;
  status?: string | null;
  inputs?: unknown;
  outputs?: unknown;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  extra?: { metadata?: Record<string, unknown>; [k: string]: unknown } | null;
  [k: string]: unknown;
}

/** Coerce an ISO string / epoch-ms / epoch-s into epoch ms, or NaN. */
export function toMs(t: string | number | null | undefined): number {
  if (t == null) return NaN;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t; // seconds vs ms
  const p = Date.parse(t);
  return Number.isNaN(p) ? NaN : p;
}

/** Best-effort token total for one run, checking the documented fallback locations. */
export function runTokens(run: LangSmithRun): number {
  if (typeof run.total_tokens === 'number') return run.total_tokens;
  const p = typeof run.prompt_tokens === 'number' ? run.prompt_tokens : 0;
  const c = typeof run.completion_tokens === 'number' ? run.completion_tokens : 0;
  if (p || c) return p + c;
  // Fallbacks seen in real exports:
  const out = run.outputs as { llm_output?: { token_usage?: Record<string, number> } } | undefined;
  const tu = out?.llm_output?.token_usage;
  if (tu && typeof tu.total_tokens === 'number') return tu.total_tokens;
  if (tu && (tu.prompt_tokens || tu.completion_tokens)) {
    return (tu.prompt_tokens ?? 0) + (tu.completion_tokens ?? 0);
  }
  const meta = run.extra?.metadata as Record<string, number> | undefined;
  if (meta && typeof meta.total_tokens === 'number') return meta.total_tokens;
  return 0;
}

/** Pull the first human/user input string from a run's `inputs`, for a session label. */
export function extractLabel(run: LangSmithRun): string {
  const inp = run.inputs as unknown;
  if (typeof inp === 'string') return clip(inp, LABEL_TRUNCATION);
  if (inp && typeof inp === 'object') {
    const o = inp as Record<string, unknown>;
    // Common shapes: { input: "..." }, { question: "..." }, { messages: [...] }
    for (const k of ['input', 'question', 'query', 'prompt', 'text']) {
      if (typeof o[k] === 'string') return clip(o[k], LABEL_TRUNCATION);
    }
    if (Array.isArray(o.messages) && o.messages.length) {
      const last = o.messages[o.messages.length - 1] as Record<string, unknown>;
      const content = last?.content ?? last?.data ?? last;
      return clip(content, LABEL_TRUNCATION);
    }
    return clip(o, LABEL_TRUNCATION);
  }
  return '(no task line)';
}

/** Map a LangSmith run_type to a RunEvent.type. */
export function eventType(run: LangSmithRun): RunEvent['type'] {
  switch (run.run_type) {
    case 'tool': return 'tool_call';
    case 'retriever': return 'tool_call';
    case 'llm': return 'output';
    case 'chain': return 'output';
    default: return run.run_type || 'output';
  }
}
