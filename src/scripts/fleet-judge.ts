/**
 * fleet-judge.ts — Offline Tier-3 second-opinion runner over an AgentLens fleet.
 *
 * This is the MONEY-SPENDING step. It iterates sessions in an AgentLens SQLite
 * DB, renders each to a transcript-contract@v1 document, runs the Tier-3 judge
 * via the adapter (judgeTranscript), and writes a LABELED, NON-SCORING
 * annotation ("opinion, not evidence") back into the `annotations` table.
 *
 * SAFETY RAILS (all on by default):
 *   - DRY-RUN by default. Nothing is judged or written unless you pass --execute.
 *   - HARD COST CEILING (--max-cost-usd, default 5). Aborts before exceeding.
 *   - PER-SESSION TOKEN CAP (--max-input-tokens, default 8000) via applyTokenCap.
 *   - RESUME: sessions already annotated (annotation_type=tier3-judge) are skipped.
 *   - Reasoning is stripped by the adapter before the model ever sees it.
 *
 * The judge is a SIGNAL, never a verdict. These annotations must never feed the
 * real-time Tier-1+2 gate.
 *
 * Usage:
 *   node dist/scripts/fleet-judge.js --db <path> [--limit N] [--execute]
 *        [--provider groq|openrouter|openai] [--model M]
 *        [--max-cost-usd 5] [--max-input-tokens 8000]
 *        [--dollars-per-mtok-in 0.59] [--dollars-per-mtok-out 0.79]
 *
 * API key is read from JUDGE_API_KEY (preferred) or GROQ_API_KEY/OPENAI_API_KEY/
 * OPENROUTER_API_KEY by provider.
 *
 * NOTE: uses Node's built-in node:sqlite (DatabaseSync), no external deps.
 */

import { randomUUID } from 'node:crypto';
import {
  judgeTranscript,
  estimateTokens,
  type JudgeAnnotation,
} from '../checks/transcript-judge.js';
import { LLMJudgeBackend, type LLMJudgeConfig } from '../judges/llm-judge.js';
import type { JudgeBackend, RawJudgeResponse, Rubric, JudgeContext } from '../checks/judge.js';

// ─── tiny arg parser ─────────────────────────────────────────────────────────

interface Args {
  db?: string;
  limit?: number;
  execute: boolean;
  provider: 'groq' | 'openrouter' | 'openai';
  model?: string;
  maxCostUsd: number;
  maxInputTokens: number;
  dollarsPerMTokIn: number;
  dollarsPerMTokOut: number;
  delayMs: number;
  maxRetries: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    execute: false,
    provider: 'groq',
    maxCostUsd: 5,
    maxInputTokens: 8000,
    dollarsPerMTokIn: 0.59,
    dollarsPerMTokOut: 0.79,
    delayMs: 25000,
    maxRetries: 5,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--db': a.db = next(); break;
      case '--limit': a.limit = Number(next()); break;
      case '--execute': a.execute = true; break;
      case '--provider': a.provider = next() as Args['provider']; break;
      case '--model': a.model = next(); break;
      case '--max-cost-usd': a.maxCostUsd = Number(next()); break;
      case '--max-input-tokens': a.maxInputTokens = Number(next()); break;
      case '--dollars-per-mtok-in': a.dollarsPerMTokIn = Number(next()); break;
      case '--dollars-per-mtok-out': a.dollarsPerMTokOut = Number(next()); break;
      case '--delay-ms': a.delayMs = Number(next()); break;
      case '--max-retries': a.maxRetries = Number(next()); break;
      case '--help': case '-h': a.help = true; break;
      default:
        if (arg?.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    }
  }
  return a;
}

const HELP = `fleet-judge — offline Tier-3 second-opinion over an AgentLens fleet

  --db <path>               AgentLens SQLite DB (required)
  --limit <N>               only the N most-recent sessions
  --execute                 ACTUALLY call the judge + write annotations
                            (omitted = DRY RUN: estimate cost, write nothing)
  --provider <p>            groq | openrouter | openai      (default groq)
  --model <m>               judge model override
  --max-cost-usd <n>        hard ceiling; abort before exceeding   (default 5)
  --max-input-tokens <n>    per-session input cap                  (default 8000)
  --dollars-per-mtok-in     input price $/Mtok          (default 0.59 = groq 70b)
  --dollars-per-mtok-out    output price $/Mtok                    (default 0.79)
  --delay-ms <n>            pause between sessions to respect rate limits
                            (default 25000 = ~2.4 calls/min, under Groq free 12k TPM)
  --max-retries <n>         retries on 429 rate-limit, honoring Retry-After (default 5)
  -h, --help

API key: JUDGE_API_KEY, else GROQ_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY.

The judge sees ARTIFACTS ONLY (reasoning is stripped). Output is a SIGNAL, never
a verdict — annotations are tagged "opinion, not evidence" and never gate a run.`;

// ─── transcript rendering (inline, from DB rows) ─────────────────────────────

const STATUS_TO_OUTCOME: Record<string, string> = {
  completed: 'pass', ok: 'pass', success: 'pass',
  error: 'fail', errored: 'fail', failed: 'fail', timeout: 'fail', killed: 'fail',
};

interface EventRow {
  event_type: string;
  input_data: string | null;
  output_data: string | null;
  tool_call: string | null;
  decision_trace: string | null;
}
interface SessionRow {
  session_id: string;
  agent_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string | null;
  metadata: string | null;
}

function safeParse(v: string | null): unknown {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}
function summarize(v: unknown, max = 200): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Render a session's rows into a transcript-contract@v1 markdown doc — the same
 * shape AgentLens export_transcript() produces, including `(decision) ...` lines
 * (which the adapter then strips). Keeping them here means the adapter, not the
 * renderer, owns the doctrine boundary.
 */
function renderTranscript(sess: SessionRow, events: EventRow[]): string {
  const name = sess.agent_name ?? 'agent';
  const when = sess.started_at ?? '';
  const lines: string[] = [`# ${name} Run - ${when}`, ''];

  // session.metadata holds the richest task/outcome signal for these runs:
  //   { agent, model, durationMs, summary: "[fleet-triage] aborted ...", ... }
  const meta = (safeParse(sess.metadata) ?? {}) as Record<string, unknown>;
  const metaSummary = typeof meta.summary === 'string' ? meta.summary : '';
  const metaModel = typeof meta.model === 'string' ? meta.model : '';

  // ## Task — prefer an explicit task field; else the human metadata.summary;
  // else the first task-file the agent read (its path IS the task identity).
  let task = '';
  for (const e of events) {
    const inp = safeParse(e.input_data) as Record<string, unknown> | string | null;
    if (inp && typeof inp === 'object') {
      for (const k of ['task', 'prompt', 'goal', 'description']) {
        const val = (inp as Record<string, unknown>)[k];
        if (typeof val === 'string' && val.length > 0) { task = val; break; }
      }
    }
    if (task) break;
  }
  if (!task) {
    // first read tool-call's path → the task file the agent worked from
    for (const e of events) {
      const tc = readToolCall(e.tool_call);
      if (tc && tc.name === 'read' && typeof tc.path === 'string') {
        task = `Worked from task file: ${tc.path}`;
        break;
      }
    }
  }
  if (metaSummary) {
    task = task ? `${metaSummary}\n${task}` : metaSummary;
  }
  if (!task) task = '(no explicit task recorded)';
  lines.push('## Task', task, '');

  // ## Actions Taken — tool calls (real schema: {name, arguments, is_error})
  // plus assistant reasoning text from decision_trace. Reasoning lines are
  // marked `(decision)` so the adapter strips them before the judge sees them.
  lines.push('## Actions Taken');
  let n = 0;
  for (const e of events) {
    const tc = readToolCall(e.tool_call);
    if (tc) {
      n++;
      const argStr = tc.arguments !== undefined ? summarize(tc.arguments, 120) : '';
      const err = tc.is_error ? ' [error]' : '';
      lines.push(`${n}. \`${tc.name ?? 'tool'}\`${argStr ? `(${argStr})` : ''}${err}`);
    }
    const dt = safeParse(e.decision_trace) as Record<string, unknown> | null;
    if (dt && typeof dt === 'object') {
      const text = typeof dt.text === 'string' ? dt.text
        : typeof dt.reasoning === 'string' ? dt.reasoning : '';
      if (text.trim()) {
        n++;
        lines.push(`${n}. (decision) ${text.trim()}`);
      }
    }
  }
  if (n === 0) lines.push('(no actions recorded)');
  lines.push('');

  // ## Key Outputs — last event output
  lines.push('## Key Outputs');
  const last = [...events].reverse().find((e) => e.output_data);
  lines.push(last ? `- Final output: ${summarize(safeParse(last.output_data))}` : '(no output recorded)');
  lines.push('');

  // ## Outcome
  const token = STATUS_TO_OUTCOME[(sess.status ?? '').toLowerCase()] ?? 'unknown';
  const outcomeDetail = metaSummary ? ` - ${metaSummary}` : '';
  lines.push('## Outcome', `${token} - session status: ${sess.status ?? 'unknown'}${outcomeDetail}`, '');

  // ## Duration — prefer recorded metadata.durationMs, else timestamp delta
  const durMs = typeof meta.durationMs === 'number' ? meta.durationMs
    : (sess.started_at && sess.ended_at)
      ? new Date(sess.ended_at).getTime() - new Date(sess.started_at).getTime()
      : NaN;
  if (Number.isFinite(durMs)) {
    lines.push('## Duration', `- ${(durMs / 1000).toFixed(1)}s${metaModel ? ` (model: ${metaModel})` : ''}`, '');
  }

  return lines.join('\n');
}

/** Parse a tool_call cell into the real AgentLens shape {name, arguments, is_error, path?}. */
function readToolCall(raw: string | null): { name?: string; arguments?: unknown; is_error?: boolean; path?: string } | null {
  const tc = safeParse(raw);
  if (!tc || typeof tc !== 'object') return null;
  const o = tc as Record<string, unknown>;
  const args = o.arguments as Record<string, unknown> | undefined;
  return {
    name: typeof o.name === 'string' ? o.name : undefined,
    arguments: o.arguments,
    is_error: o.is_error === true,
    path: args && typeof args.path === 'string' ? args.path : undefined,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

function resolveApiKey(provider: string): string | undefined {
  return (
    process.env.JUDGE_API_KEY ??
    (provider === 'groq' ? process.env.GROQ_API_KEY
      : provider === 'openai' ? process.env.OPENAI_API_KEY
      : provider === 'openrouter' ? process.env.OPENROUTER_API_KEY
      : undefined)
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (!args.db) { console.error('error: --db <path> is required\n'); console.log(HELP); process.exit(2); }

  // Built-in node:sqlite — no external dependency.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(args.db);

  // Pick sessions (most recent first), skipping already-judged ones.
  const limitClause = args.limit ? `LIMIT ${Number(args.limit)}` : '';
  const sessions = db
    .prepare(
      `SELECT s.session_id, s.agent_name, s.started_at, s.ended_at, s.status, s.metadata
         FROM sessions s
        WHERE s.session_id NOT IN (
              SELECT session_id FROM annotations WHERE annotation_type = 'insight' AND author LIKE 'judge/%')
          AND (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) > 0
        ORDER BY s.started_at DESC ${limitClause}`,
    )
    .all() as unknown as SessionRow[];

  console.log(`\nfleet-judge  [${args.execute ? 'EXECUTE' : 'DRY RUN'}]`);
  console.log(`  db:        ${args.db}`);
  console.log(`  provider:  ${args.provider}${args.model ? ` (${args.model})` : ''}`);
  console.log(`  sessions:  ${sessions.length} unjudged (with events)${args.limit ? ` (limited to ${args.limit})` : ''}`);
  console.log(`  token cap: ${args.maxInputTokens}/session   cost ceiling: $${args.maxCostUsd}`);

  let backend: JudgeBackend;
  if (args.execute) {
    const apiKey = resolveApiKey(args.provider);
    if (!apiKey) {
      console.error(`\nerror: no API key. Set JUDGE_API_KEY (or ${args.provider.toUpperCase()}_API_KEY).`);
      process.exit(2);
    }
    const cfg: LLMJudgeConfig = { type: args.provider, apiKey, ...(args.model ? { model: args.model } : {}) };
    backend = new LLMJudgeBackend(cfg);
  } else {
    backend = new EstimateBackend(); // dry-run: no network, just measures input
  }

  const insert = db.prepare(
    `INSERT INTO annotations (annotation_id, session_id, text, author, annotation_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'insight', ?, ?)`,
  );

  // Idempotent re-judge: a session may be judged more than once across runs
  // (e.g. a recovery pass retrying earlier JSON-parse failures). Without this,
  // each pass appends a NEW annotation, leaving duplicate verdicts in the DB.
  // Delete any prior judge annotation from THIS provider for the session first,
  // so a re-judge replaces rather than accumulates.
  const delPrev = db.prepare(
    `DELETE FROM annotations
      WHERE session_id = ? AND annotation_type = 'insight' AND author = ?`,
  );

  let spentUsd = 0;
  // `judged` and `errors` are incremented in the loop; `skipped` is reserved for
  // the summary line and never reassigned (resume-skips are filtered out by the
  // SQL `NOT IN (... already-judged ...)` query), so it stays const.
  let judged = 0, errors = 0;
  const skipped = 0;
  const startedAt = Date.now();
  let firstCall = true;

  for (const sess of sessions) {
    const events = db
      .prepare(
        `SELECT event_type, input_data, output_data, tool_call, decision_trace
           FROM events WHERE session_id = ? ORDER BY timestamp`,
      )
      .all(sess.session_id) as unknown as EventRow[];

    const markdown = renderTranscript(sess, events);

    // Pre-flight cost estimate for THIS session (input only; output is bounded by maxTokens).
    const inTokEstimate = Math.min(estimateTokens(markdown), args.maxInputTokens);
    const projCostUsd =
      (inTokEstimate / 1e6) * args.dollarsPerMTokIn +
      (4096 / 1e6) * args.dollarsPerMTokOut; // worst-case output

    if (spentUsd + projCostUsd > args.maxCostUsd) {
      console.log(`\n⛔ cost ceiling reached ($${spentUsd.toFixed(4)} + ~$${projCostUsd.toFixed(4)} > $${args.maxCostUsd}). Stopping.`);
      break;
    }

    try {
      // Pace calls so we stay under the provider's tokens-per-minute limit.
      if (args.execute && !firstCall && args.delayMs > 0) {
        await sleep(args.delayMs);
      }
      firstCall = false;

      const ann: JudgeAnnotation = await withRetry(
        () => judgeTranscript(markdown, backend, { maxInputTokens: args.maxInputTokens }),
        args.maxRetries,
        (waitMs, attempt) =>
          console.log(`     ↻ rate-limited, waiting ${(waitMs / 1000).toFixed(1)}s (retry ${attempt}/${args.maxRetries})`),
      );

      // Cost: use the real measured input tokens from the adapter.
      const costUsd =
        (ann.meta.inputTokens / 1e6) * args.dollarsPerMTokIn +
        (4096 / 1e6) * args.dollarsPerMTokOut;
      spentUsd += args.execute ? costUsd : 0;

      const verdict = ann.result.verdict;
      const conf = ann.result.confidence;
      const flags = [
        ann.meta.reasoningStripped ? 'reasoning-stripped' : '',
        ann.meta.inputTruncated ? 'truncated' : '',
      ].filter(Boolean).join(',');

      console.log(
        `  ${args.execute ? '✓' : '·'} ${sess.session_id.slice(0, 8)}  ` +
        `${verdict.padEnd(18)} conf=${conf.padEnd(6)} in=${ann.meta.inputTokens}tok ` +
        `${flags ? `[${flags}]` : ''}`,
      );

      if (args.execute) {
        const text =
          `[Tier-3 judge - opinion, not evidence] verdict=${verdict} confidence=${conf} ` +
          `(${ann.result.confidenceValue.toFixed(2)})\n` +
          `${ann.result.summary ?? ''}\n` +
          (ann.result.suggestions?.length ? `suggestions: ${ann.result.suggestions.join('; ')}` : '');
        const now = new Date().toISOString();
        const authorId = `judge/${args.provider}`;
        delPrev.run(sess.session_id, authorId);
        insert.run(randomUUID(), sess.session_id, text.trim(), authorId, now, now);
      }
      judged++;
    } catch (err) {
      errors++;
      console.log(`  ✗ ${sess.session_id.slice(0, 8)}  ERROR: ${(err as Error).message}`);
    }
  }

  db.close();
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n── summary ──────────────────────────────`);
  console.log(`  judged:  ${judged}   skipped: ${skipped}   errors: ${errors}`);
  console.log(`  spent:   $${spentUsd.toFixed(4)} ${args.execute ? '(real)' : '(dry run — $0)'}`);
  console.log(`  elapsed: ${secs}s`);
  if (!args.execute) {
    console.log(`\n  DRY RUN complete. Re-run with --execute to judge + write annotations.`);
  }
}

/** Dry-run backend: never calls the network. Returns a fixed neutral response so
 *  the full pipeline (parse→strip→cap→annotate) runs and reports token counts. */
class EstimateBackend implements JudgeBackend {
  name = 'estimate (dry-run, no network)';
  async evaluate(_output: string, rubric: Rubric, _ctx: JudgeContext): Promise<RawJudgeResponse> {
    return {
      scores: rubric.criteria.map((c) => ({
        criterionId: c.id,
        score: getMid(c.levels.map((l) => l.score)),
        reasoning: 'dry-run estimate (no model called)',
        evidence: [],
        confidence: 0.0, // forces needs-human-review; never a real pass/fail in dry run
      })),
      summary: 'dry-run — no judgment performed',
      suggestions: [],
    };
  }
}
function getMid(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a call on 429 rate-limit errors, honoring the wait the provider asks for.
 * Groq returns the delay in the error message ("Please try again in 12.585s");
 * we parse it and wait that long (+250ms slack), otherwise exponential backoff.
 * Non-429 errors are rethrown immediately.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  onWait?: (waitMs: number, attempt: number) => void,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const is429 = msg.includes('429') || /rate.?limit/i.test(msg);
      if (!is429 || attempt >= maxRetries) throw err;
      attempt++;
      const m = msg.match(/try again in ([0-9.]+)\s*s/i);
      const waitMs = m ? Math.ceil(parseFloat(m[1] ?? '0') * 1000) + 250 : Math.min(30000, 1000 * 2 ** attempt);
      onWait?.(waitMs, attempt);
      await sleep(waitMs);
    }
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
