/**
 * claude-code-action Execution-File Adapter — Phase 4 CI Integration
 *
 * This is the concrete seam between [`claude-code-action`](https://github.com/anthropics/claude-code-action)
 * and {@link evaluateCiRun}. The action's unified entrypoint (`src/entrypoints/run.ts`)
 * runs Claude, writes a JSON log of the run to
 * `${RUNNER_TEMP}/claude-execution-output.json`, and exposes that path as the
 * `execution_file` GitHub Action output. During its cleanup phase the action
 * reads that same file in two places:
 *
 *   - `writeStepSummary()` → `formatTurnsFromData(data)` renders the markdown
 *     "Claude Code Report" comment from the turns.
 *   - `updateCommentLink()` reads the **last** array element (`type: "result"`)
 *     for `total_cost_usd` / `duration_ms` execution details.
 *
 * The execution file is therefore the single artifact that already contains
 * everything an eval needs at cleanup time: the agent's final answer text, the
 * full turn stream, and the run's cost/duration. This module parses that file
 * (the `Turn[]` shape, mirrored below) into the `{ prompt, output, timeline }`
 * inputs {@link evaluateCiRun} consumes — so a downstream CI step (or a small
 * block inside the action's own cleanup) can score *what the agent produced*
 * before the job is allowed to go green.
 *
 * Everything here is pure parsing of the on-disk JSON — no AI, no network, no
 * dependency on the action's runtime. It is forgery-resistant in the same way
 * the rest of the engine is: it reads the bytes the agent's harness wrote, not a
 * self-graded summary. The shapes below are a *structural* subset of the
 * action's `format-turns.ts` types; we deliberately keep them permissive
 * (optional fields, `unknown` escape hatches) so a version skew in the action
 * cannot crash the eval — an unrecognised log degrades to "no output extracted"
 * rather than throwing.
 *
 * @tier 1 — Deterministic parsing (no AI, reproducible, offline)
 * @module
 */

import type { RunEvent, RunTimeline } from '../checks/staleness.js';

// ─── EXECUTION-FILE SHAPE ────────────────────────────────────────────────────
//
// A structural subset of claude-code-action's `src/entrypoints/format-turns.ts`
// types. The execution file is a JSON array of these turns. We model only what
// the eval reads and leave the rest open.

/** A single content block inside an assistant/user message turn. */
export interface CcaContentItem {
  /** Block type: `"text"`, `"tool_use"`, `"tool_result"`, … */
  type?: string;
  /** Present on `text` blocks — the visible prose. */
  text?: string;
  /** Present on `tool_use` blocks. */
  name?: string;
  /** Tool-call input (shape is tool-specific). */
  input?: unknown;
  /** Tool-call / tool-result correlation id. */
  id?: string;
  tool_use_id?: string;
  /** Tool-result payload (string or nested content blocks). */
  content?: unknown;
  is_error?: boolean;
}

/** The message envelope on an `assistant` / `user` turn. */
export interface CcaMessage {
  role?: string;
  content?: CcaContentItem[] | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * One turn in the execution log. The stream is a mix of `system` (init),
 * `assistant` / `user` (messages), and a final `result` turn carrying the
 * agent's final answer text and run-level cost/duration.
 */
export interface CcaTurn {
  /** `"system" | "assistant" | "user" | "result"` (and possibly others). */
  type?: string;
  /** Present on `assistant` / `user` turns. */
  message?: CcaMessage;
  /** Present on the final `result` turn — the agent's final answer text. */
  result?: string;
  /** Run subtype on the `result` turn, e.g. `"success"` / `"error_max_turns"`. */
  subtype?: string;
  /** Whether the run errored (on the `result` turn). */
  is_error?: boolean;
  /** Run-level totals (on the `result` turn). */
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  /** Top-level timestamp some logs carry (ISO-8601 or Unix ms). */
  timestamp?: string | number;
}

/** The parsed execution file: an ordered array of turns. */
export type CcaExecutionLog = CcaTurn[];

// ─── EXTRACTION RESULT ───────────────────────────────────────────────────────

/** Run-level details pulled from the final `result` turn. */
export interface CcaResultDetails {
  /** `subtype` of the result turn (e.g. `"success"`, `"error_max_turns"`). */
  subtype?: string;
  /** Whether the result turn reported an error. */
  isError: boolean;
  /** Total run cost in USD, if present. */
  totalCostUsd?: number;
  /** Wall-clock run duration in ms, if present. */
  durationMs?: number;
  /** API-time duration in ms, if present. */
  durationApiMs?: number;
  /** Number of turns the agent took, if present. */
  numTurns?: number;
}

/**
 * The eval-ready projection of a claude-code-action execution log. Spread the
 * relevant fields straight into {@link evaluateCiRun}:
 *
 *     const x = extractCcaRun(log, { prompt });
 *     const { evaluation } = evaluateCiRun({
 *       prompt: x.prompt,
 *       output: x.output,
 *       timeline: x.timeline,
 *       worker: 'claude-review',
 *     });
 */
export interface CcaRunExtract {
  /**
   * The task the agent was given. The execution file does **not** contain the
   * prompt (the action passes it via a prompt file), so this is taken from the
   * `prompt` option when provided and is otherwise an empty string.
   */
  prompt: string;
  /**
   * The agent's output. Prefers the final `result` turn's text (the agent's
   * final answer — what `updateCommentLink` keys off); falls back to the
   * concatenated assistant `text` blocks when there is no result turn.
   */
  output: string;
  /** Source of {@link output}: the `result` turn, or assembled assistant text. */
  outputSource: 'result' | 'assistant-text' | 'none';
  /** Concatenated assistant `text` blocks across all turns (the full prose). */
  assistantText: string;
  /** The final `result` turn's text, if a result turn was present. */
  resultText?: string;
  /** Run-level details from the `result` turn (cost, duration, error, …). */
  details: CcaResultDetails;
  /**
   * A {@link RunTimeline} synthesised from the turn stream for the staleness
   * check: one `output` event per assistant text turn, `tool_call` / `tool_result`
   * events for tool turns, and an `end` event when a `result` turn is present.
   * `timeoutMs` is left unset (the caller knows the action's `--max-turns` /
   * job timeout, the log does not). Pass it as `evaluateCiRun({ timeline })`.
   */
  timeline: RunTimeline;
}

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

/** Coerce a tool-result `content` field (string | block[] | other) to text. */
function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

/** Pull the visible `text` blocks out of a message's content. */
function textBlocksOf(message: CcaMessage | undefined): string[] {
  if (!message) return [];
  const { content } = message;
  if (typeof content === 'string') {
    return content.trim().length > 0 ? [content] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    if (item && (item.type === 'text' || item.type === undefined) && typeof item.text === 'string') {
      if (item.text.trim().length > 0) out.push(item.text);
    }
  }
  return out;
}

/** Does this message contain any `tool_use` block? */
function hasToolUse(message: CcaMessage | undefined): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => item && item.type === 'tool_use');
}

/** Does this message contain any `tool_result` block? */
function hasToolResult(message: CcaMessage | undefined): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => item && item.type === 'tool_result');
}

// ─── PARSING ─────────────────────────────────────────────────────────────────

/**
 * Parse a claude-code-action execution file's raw JSON text into a typed
 * {@link CcaExecutionLog}. Returns an empty array (never throws) when the text
 * is not a JSON array of objects — a malformed or unexpected log degrades to
 * "no turns" so the eval can fall through to a `completeness`/no-data verdict
 * rather than crashing the CI job.
 *
 * @param raw - The file contents of `claude-execution-output.json`.
 */
export function parseCcaExecutionLog(raw: string): CcaExecutionLog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((t): t is CcaTurn => typeof t === 'object' && t !== null);
}

// ─── EXTRACTION ──────────────────────────────────────────────────────────────

/** Options for {@link extractCcaRun}. */
export interface ExtractCcaRunOptions {
  /**
   * The task the agent was given (PR title+body, issue text, the action's
   * resolved prompt). The execution file does not contain it, so supply it here
   * to enable the coverage / relevance checks. Without it those checks have an
   * empty reference and {@link evaluateCiRun} will lean on completeness +
   * staleness only.
   */
  prompt?: string;
  /**
   * A synthetic per-turn timestamp step (ms) used only when turns carry no
   * `timestamp` of their own, so the synthesised timeline still has ordered,
   * monotonic event times. Default: 1000.
   */
  syntheticStepMs?: number;
  /** Anchor time (ms) for the first synthetic timestamp. Default: `Date.now()`. */
  syntheticStartMs?: number;
}

/**
 * Project a parsed {@link CcaExecutionLog} into the eval-ready
 * {@link CcaRunExtract}. This walks the turn stream once and:
 *
 *   - collects every assistant `text` block (the full visible prose),
 *   - captures the final `result` turn's text + cost/duration details,
 *   - chooses {@link CcaRunExtract.output} = result text if present, else the
 *     concatenated assistant text (matching what a human sees in the comment),
 *   - synthesises a {@link RunTimeline} (one event per turn) for the staleness
 *     no-op / abandonment check.
 *
 * Pure and total: any shape it does not recognise simply contributes nothing.
 *
 * @param log - The parsed execution log (see {@link parseCcaExecutionLog}).
 * @param options - Prompt and timeline-synthesis knobs.
 */
export function extractCcaRun(
  log: CcaExecutionLog,
  options: ExtractCcaRunOptions = {},
): CcaRunExtract {
  const stepMs = options.syntheticStepMs ?? 1000;
  const startMs = options.syntheticStartMs ?? Date.now();

  const assistantParts: string[] = [];
  const events: RunEvent[] = [];
  let resultText: string | undefined;
  let details: CcaResultDetails = { isError: false };
  let sawResult = false;
  let syntheticIndex = 0;

  const tsFor = (turn: CcaTurn): string | number => {
    if (typeof turn.timestamp === 'string' || typeof turn.timestamp === 'number') {
      return turn.timestamp;
    }
    return startMs + syntheticIndex++ * stepMs;
  };

  // Lead with a synthetic `start` event so single-turn logs still have a
  // start anchor for duration math.
  events.push({ timestamp: startMs, type: 'start' });

  for (const turn of log) {
    const type = turn.type;

    if (type === 'result') {
      sawResult = true;
      if (typeof turn.result === 'string' && turn.result.trim().length > 0) {
        resultText = turn.result;
      }
      details = {
        subtype: turn.subtype,
        isError: turn.is_error === true || turn.subtype === 'error' || (typeof turn.subtype === 'string' && turn.subtype.startsWith('error')),
        totalCostUsd: typeof turn.total_cost_usd === 'number' ? turn.total_cost_usd : undefined,
        durationMs: typeof turn.duration_ms === 'number' ? turn.duration_ms : undefined,
        durationApiMs: typeof turn.duration_api_ms === 'number' ? turn.duration_api_ms : undefined,
        numTurns: typeof turn.num_turns === 'number' ? turn.num_turns : undefined,
      };
      events.push({
        timestamp: tsFor(turn),
        type: 'end',
        content: resultText,
      });
      continue;
    }

    if (type === 'assistant' || type === 'user') {
      const texts = textBlocksOf(turn.message);
      if (type === 'assistant') {
        for (const t of texts) assistantParts.push(t);
      }
      if (texts.length > 0) {
        events.push({
          timestamp: tsFor(turn),
          type: 'output',
          content: texts.join('\n'),
        });
      }
      if (hasToolUse(turn.message)) {
        events.push({ timestamp: tsFor(turn), type: 'tool_call' });
      }
      if (hasToolResult(turn.message)) {
        const content = Array.isArray(turn.message?.content)
          ? turn.message?.content.find((i) => i && i.type === 'tool_result')?.content
          : undefined;
        events.push({
          timestamp: tsFor(turn),
          type: 'tool_result',
          content: stringifyToolContent(content) || undefined,
        });
      }
      continue;
    }

    // `system` (init) and any unknown turn types: record a lightweight event so
    // the timeline reflects activity, but contribute no output text.
    events.push({ timestamp: tsFor(turn), type: type ?? 'output' });
  }

  const assistantText = assistantParts.join('\n\n').trim();
  const finalResultText = resultText?.trim();

  let output = '';
  let outputSource: CcaRunExtract['outputSource'] = 'none';
  if (finalResultText && finalResultText.length > 0) {
    output = finalResultText;
    outputSource = 'result';
  } else if (assistantText.length > 0) {
    output = assistantText;
    outputSource = 'assistant-text';
  }

  const timeline: RunTimeline = {
    startedAt: startMs,
    // Only declare an end when the log actually carried a `result` turn —
    // a missing result is exactly the "abandoned / no end" signal the
    // staleness check is meant to catch.
    ...(sawResult ? { endedAt: events[events.length - 1]?.timestamp } : {}),
    events,
    output,
  };

  return {
    prompt: options.prompt ?? '',
    output,
    outputSource,
    assistantText,
    resultText: finalResultText,
    details,
    timeline,
  };
}

/**
 * Convenience wrapper: parse raw execution-file JSON and project it in one call.
 *
 *     import { readFileSync } from 'node:fs';
 *     const x = extractCcaRunFromFile(readFileSync(executionFile, 'utf8'), { prompt });
 *
 * @param raw - The contents of `claude-execution-output.json`.
 * @param options - Forwarded to {@link extractCcaRun}.
 */
export function extractCcaRunFromFile(
  raw: string,
  options: ExtractCcaRunOptions = {},
): CcaRunExtract {
  return extractCcaRun(parseCcaExecutionLog(raw), options);
}
