/**
 * OpenClaw session adapter — raw agent logs → `RunTimeline`.
 *
 * Converts on-disk OpenClaw session logs into the {@link RunTimeline} shape the
 * Tier-1 staleness/repetition checks consume, so agent-eval can run against a
 * **live agent fleet** instead of only hand-authored transcripts.
 *
 * Three on-disk file kinds coexist in a sessions directory; this module
 * reconciles all of them into one logical session per id:
 *
 * - `<id>.jsonl` — **bare** session log:
 *   `{ type: 'session' | 'message' | 'model_change' | 'custom' | ... }`, where
 *   `message.message = { role, content[], usage.totalTokens, stopReason }`.
 * - `<id>.trajectory.jsonl` — **rich trace**: `{ type, ts, data }` where `data`
 *   carries `usage.total`, the `idleTimedOut | aborted | timedOut | externalAbort`
 *   flags, `finalStatus`, and `assistantTexts[]`.
 * - `<base>.checkpoint.<uuid>.jsonl` — a saved **snapshot/fork** of `<base>`
 *   (bare format). Not an independent session: collapsed to its base id.
 *
 * An id may have BOTH a bare and a trajectory file; we prefer the bare file for
 * its richer per-event timeline and enrich token/abort signals from the
 * trajectory. Trajectory-only ids build their timeline from the trace directly.
 *
 * Read-only and dependency-free: pure `node:fs` + parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';

import type { RunEvent, RunTimeline } from '../checks/staleness.js';

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/** Max characters retained per event `content` (keeps timelines small). */
const CONTENT_TRUNCATION = 500;

/** Max characters retained for a derived session label. */
const LABEL_TRUNCATION = 120;

// ─── PUBLIC TYPES ───────────────────────────────────────────────────────────────

// The normalized session contract lives in the neutral `./types.js` module so no
// single trace source owns the shape all adapters must satisfy. Re-exported here
// for backward compatibility with existing `./openclaw.js` type imports.
export type {
  SessionSource,
  SessionMeta,
  BuiltSession,
  SessionDescriptor,
} from './types.js';
import type { BuiltSession, SessionMeta, SessionDescriptor, SessionSource } from './types.js';
import { toolSig } from './tool-signature.js';

// ─── INTERNAL: trajectory parse result ──────────────────────────────────────────

interface ParsedTrajectory {
  maxTotal: number;
  idleTimedOut: boolean;
  aborted: boolean;
  timedOut: boolean;
  externalAbort: boolean;
  finalStatus: string | null;
  firstTs: string | number | null;
  lastTs: string | number | null;
  assistantTexts: string[];
  events: RunEvent[];
  recCount: number;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────────

function clip(value: unknown, max = CONTENT_TRUNCATION): string {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

/** Flatten a message `content` (string or block array) into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'toolCall') {
      const args = JSON.stringify(block.arguments ?? {}).slice(0, 160);
      parts.push(`[toolCall ${block.name ?? ''} ${args}]`);
    } else if (block.type === 'toolResult') {
      parts.push('[toolResult]');
    }
  }
  return parts.join('\n');
}

/**
 * Stable signature for one tool call: delegates to the shared {@link toolSig}
 * so every adapter produces identical `name(inputDigest)` strings.
 */
function toolCallSignaturesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block && typeof block === 'object' && block.type === 'toolCall') {
      out.push(toolSig(block.name, block.arguments));
    }
  }
  return out;
}

/** Read a `.jsonl` file into parsed records, skipping malformed lines. */
function safeParseLines(file: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function elapsedMs(firstTs: unknown, lastTs: unknown): number {
  if (!firstTs || !lastTs) return NaN;
  return new Date(lastTs as string).getTime() - new Date(firstTs as string).getTime();
}

// ─── TRAJECTORY PARSE (format B) ────────────────────────────────────────────────

/** Parse a trajectory companion: usage + abort/idle flags + assistant texts + event spine. */
function parseTrajectory(trajPath: string): ParsedTrajectory | null {
  const recs = safeParseLines(trajPath);
  if (recs.length === 0) return null;

  let maxTotal = 0;
  let idleTimedOut = false;
  let aborted = false;
  let timedOut = false;
  let externalAbort = false;
  let finalStatus: string | null = null;
  let firstTs: string | number | null = null;
  let lastTs: string | number | null = null;
  let assistantTexts: string[] = [];
  const events: RunEvent[] = [];

  for (const rec of recs) {
    const ts = rec.ts as string | number | undefined;
    if (ts != null) {
      if (firstTs == null) firstTs = ts;
      lastTs = ts;
    }
    const d = rec.data as Record<string, unknown> | undefined;
    if (d) {
      const usage = d.usage as { total?: unknown } | undefined;
      if (usage && typeof usage.total === 'number') maxTotal = Math.max(maxTotal, usage.total);
      if (d.idleTimedOut) idleTimedOut = true;
      if (d.aborted) aborted = true;
      if (d.timedOut) timedOut = true;
      if (d.externalAbort) externalAbort = true;
      if (typeof d.finalStatus === 'string') finalStatus = d.finalStatus;
      if (Array.isArray(d.assistantTexts) && d.assistantTexts.length) {
        assistantTexts = (d.assistantTexts as unknown[]).map(String);
      }
    }

    let evType: RunEvent['type'] | null = null;
    switch (rec.type) {
      case 'session.started':
        evType = 'start';
        break;
      case 'prompt.submitted':
      case 'model.completed':
        evType = 'output';
        break;
      case 'trace.artifacts':
        evType = 'tool_result';
        break;
      case 'session.ended':
        evType = 'end';
        break;
      default:
        evType = null;
    }
    if (evType && ts != null) events.push({ timestamp: ts, type: evType, content: clip(rec.type) });
  }

  return {
    maxTotal,
    idleTimedOut,
    aborted,
    timedOut,
    externalAbort,
    finalStatus,
    firstTs,
    lastTs,
    assistantTexts,
    events,
    recCount: recs.length,
  };
}

// ─── BUILD FROM BARE (format A, enriched by B) ──────────────────────────────────

interface MessageRecord {
  role?: string;
  content?: unknown;
  usage?: { totalTokens?: unknown };
  stopReason?: string;
}

function buildFromBare(barePath: string, base: string, trajPath: string | null): BuiltSession | null {
  const recs = safeParseLines(barePath);
  if (recs.length === 0) return null;
  const traj = trajPath && fs.existsSync(trajPath) ? parseTrajectory(trajPath) : null;

  const events: RunEvent[] = [];
  let firstTs: string | number | null = null;
  let lastTs: string | number | null = null;
  let sawAborted = false;
  let cleanStop = false;
  let idleTimeoutErr = false;
  let errorEvents = 0;
  let maxMsgTokens = 0;
  let label: string | null = null;
  let cwd: string | null = null;
  const assistantTexts: string[] = [];
  const toolCallSignatures: string[] = [];
  let lastType: string | null = null;
  let lastRole: string | null = null;

  for (const rec of recs) {
    const data = rec.data as { timestamp?: unknown } | undefined;
    const ts = (rec.timestamp as string | number | undefined) ?? (data?.timestamp as string | number | undefined);
    if (ts != null) {
      if (firstTs == null) firstTs = ts;
      lastTs = ts;
    }
    lastType = (rec.type as string) ?? null;

    if (rec.type === 'session') {
      cwd = (rec.cwd as string) ?? cwd;
      continue;
    }

    if (rec.type === 'custom') {
      const ctype = (rec.customType as string) ?? '';
      const errStr = JSON.stringify(rec.data ?? {});
      if (/prompt-error|error/i.test(ctype) || /idle timeout|timed out|timeout/i.test(errStr)) {
        if (/idle timeout|timed out|timeout/i.test(errStr)) idleTimeoutErr = true;
        errorEvents++;
        events.push({
          timestamp: (ts ?? lastTs) as string | number,
          type: 'error',
          content: clip(ctype + ' ' + errStr),
        });
      }
      continue;
    }

    if (rec.type === 'message') {
      const m = (rec.message as MessageRecord) ?? {};
      const role = m.role;
      lastRole = role ?? null;
      if (m.usage && typeof m.usage.totalTokens === 'number') {
        maxMsgTokens = Math.max(maxMsgTokens, m.usage.totalTokens);
      }
      if (m.stopReason === 'aborted') sawAborted = true;
      if (m.stopReason === 'stop' && role === 'assistant') cleanStop = true;

      const hasToolCall =
        Array.isArray(m.content) && (m.content as ContentBlock[]).some((c) => c && c.type === 'toolCall');
      const text = contentToText(m.content);

      if (role === 'user' && label == null && text) {
        const line = text.split('\n').find((l) => l.trim() && !/^\[/.test(l.trim()));
        label = clip((line ?? text).trim(), LABEL_TRUNCATION);
      }

      let evType: RunEvent['type'];
      if (role === 'user') {
        evType = 'output';
      } else if (role === 'toolResult') {
        evType = 'tool_result';
      } else if (role === 'assistant') {
        if (text && text.trim()) assistantTexts.push(text);
        if (hasToolCall) toolCallSignatures.push(...toolCallSignaturesOf(m.content));
        evType = hasToolCall ? 'tool_call' : 'output';
      } else {
        evType = 'output';
      }
      events.push({ timestamp: (ts ?? lastTs) as string | number, type: evType, content: clip(text) });
    }
  }

  const trajAbort = traj ? traj.aborted || traj.idleTimedOut || traj.timedOut || traj.externalAbort : false;
  const trajError = traj ? traj.finalStatus === 'error' : false;
  const abortedAny = sawAborted || trajAbort || trajError;
  const endedCleanly = cleanStop && !abortedAny && !idleTimeoutErr;
  if (endedCleanly && lastTs != null) events.push({ timestamp: lastTs, type: 'end', content: 'clean stop' });

  const texts = traj && traj.assistantTexts.length ? traj.assistantTexts.map(String) : assistantTexts;
  const output = texts.length ? texts[texts.length - 1] : '';
  const allAssistant = texts.join('\n');
  const tokenUsage = Math.max(traj ? traj.maxTotal : 0, maxMsgTokens);
  const runtimeMs = elapsedMs(firstTs, lastTs);

  const timeline: RunTimeline = { startedAt: firstTs as string | number, events, output };
  if (endedCleanly && lastTs != null) timeline.endedAt = lastTs;
  // A run that idle-timed-out or was timed-out genuinely exceeded its time budget;
  // surface that to the staleness check as an error-severity timeout (not just a
  // warning) by setting the budget to the observed runtime. Plain external aborts
  // are left for the gap/no-end signals so we don't over-claim a timeout.
  const timedOutLike = (traj ? traj.idleTimedOut || traj.timedOut : false) || idleTimeoutErr;
  if (timedOutLike && !endedCleanly && Number.isFinite(runtimeMs) && runtimeMs > 1) {
    // Budget is strictly below the observed runtime: an idle/timeout kill means the
    // run blew past the point it should have stopped. `detectTimeout` requires
    // duration > budget, so subtract an epsilon to register the error.
    timeline.timeoutMs = runtimeMs - 1;
  }

  return {
    timeline,
    meta: makeMeta({
      sessionId: base,
      label,
      cwd,
      tokenUsage,
      msgTokenMax: maxMsgTokens,
      trajTokenTotal: traj ? traj.maxTotal : 0,
      hadTrajectory: !!traj,
      runtimeMs,
      eventCount: events.length,
      assistantCount: texts.length,
      errorEvents,
      sawAborted,
      cleanStop,
      idleTimeoutErr,
      traj,
      abortedAny,
      trajError,
      endedCleanly,
      lastType,
      lastRole,
      allAssistantText: allAssistant,
      toolCallSignatures,
      source: 'bare',
    }),
  };
}

// ─── BUILD FROM TRAJECTORY-ONLY (format B) ──────────────────────────────────────

function buildFromTrajectory(trajPath: string, base: string): BuiltSession | null {
  const traj = parseTrajectory(trajPath);
  if (!traj) return null;

  const abortedAny = traj.aborted || traj.idleTimedOut || traj.timedOut || traj.externalAbort;
  const trajError = traj.finalStatus === 'error';
  const hasEnd = traj.events.some((e) => e.type === 'end');
  const endedCleanly = hasEnd && traj.finalStatus === 'success' && !abortedAny;

  // Keep the 'end' event only when clean; otherwise strip it so `no_end` can fire.
  let events = traj.events;
  let endedAt: string | number | undefined;
  if (endedCleanly) {
    endedAt = traj.lastTs ?? undefined;
  } else {
    events = events.filter((e) => e.type !== 'end');
  }

  const output = traj.assistantTexts.length ? String(traj.assistantTexts[traj.assistantTexts.length - 1]) : '';
  const allAssistant = traj.assistantTexts.map(String).join('\n');
  const runtimeMs = elapsedMs(traj.firstTs, traj.lastTs);

  const timeline: RunTimeline = { startedAt: traj.firstTs as string | number, events, output };
  if (endedAt != null) timeline.endedAt = endedAt;
  // See buildFromBare: an idle/timed-out run exceeded its budget -> error-severity timeout.
  const timedOutLike = traj.idleTimedOut || traj.timedOut;
  if (timedOutLike && !endedCleanly && Number.isFinite(runtimeMs) && runtimeMs > 1) {
    timeline.timeoutMs = runtimeMs - 1;
  }

  return {
    timeline,
    meta: makeMeta({
      sessionId: base,
      label: null,
      cwd: null,
      tokenUsage: traj.maxTotal,
      msgTokenMax: 0,
      trajTokenTotal: traj.maxTotal,
      hadTrajectory: true,
      runtimeMs,
      eventCount: events.length,
      assistantCount: traj.assistantTexts.length,
      errorEvents: 0,
      sawAborted: false,
      cleanStop: traj.finalStatus === 'success',
      idleTimeoutErr: traj.idleTimedOut,
      traj,
      abortedAny,
      trajError,
      endedCleanly,
      lastType: hasEnd ? 'session.ended' : 'trace',
      lastRole: null,
      allAssistantText: allAssistant,
      // Trajectory-only spine does not retain per-tool-call arguments, so we
      // cannot build reliable signatures here — honest empty (see docstring).
      toolCallSignatures: [],
      source: 'trajectory',
    }),
  };
}

// ─── META ASSEMBLY ──────────────────────────────────────────────────────────────

interface MakeMetaArgs {
  sessionId: string;
  label: string | null;
  cwd: string | null;
  tokenUsage: number;
  msgTokenMax: number;
  trajTokenTotal: number;
  hadTrajectory: boolean;
  runtimeMs: number;
  eventCount: number;
  assistantCount: number;
  errorEvents: number;
  sawAborted: boolean;
  cleanStop: boolean;
  idleTimeoutErr: boolean;
  traj: ParsedTrajectory | null;
  abortedAny: boolean;
  trajError: boolean;
  endedCleanly: boolean;
  lastType: string | null;
  lastRole: string | null;
  allAssistantText: string;
  toolCallSignatures: string[];
  source: SessionSource;
}

function makeMeta(a: MakeMetaArgs): SessionMeta {
  return {
    sessionId: a.sessionId,
    label: a.label || '(no task line)',
    cwd: a.cwd,
    tokenUsage: a.tokenUsage,
    msgTokenMax: a.msgTokenMax,
    trajTokenTotal: a.trajTokenTotal,
    hadTrajectory: a.hadTrajectory,
    runtimeMs: a.runtimeMs,
    eventCount: a.eventCount,
    assistantCount: a.assistantCount,
    errorEvents: a.errorEvents,
    sawAborted: a.sawAborted,
    cleanStop: a.cleanStop,
    idleTimeoutErr: a.idleTimeoutErr,
    trajIdle: a.traj ? !!a.traj.idleTimedOut : false,
    trajAborted: a.traj ? !!a.traj.aborted : false,
    trajTimedOut: a.traj ? !!a.traj.timedOut : false,
    trajExternalAbort: a.traj ? !!a.traj.externalAbort : false,
    trajFinalStatus: a.traj ? a.traj.finalStatus : null,
    trajError: a.trajError,
    abortedAny: a.abortedAny,
    endedCleanly: a.endedCleanly,
    lastType: a.lastType,
    lastRole: a.lastRole,
    allAssistantText: a.allAssistantText,
    toolCallSignatures: a.toolCallSignatures,
    source: a.source,
  };
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────────

/**
 * Build a {@link BuiltSession} for one session id, choosing the best source.
 *
 * Prefers the bare `<id>.jsonl` log (richer per-event timeline) and enriches it
 * from the `<id>.trajectory.jsonl` companion when present; falls back to a
 * trajectory-only build when no bare file exists.
 *
 * @param id           session id (filename stem, no extension)
 * @param sessionsDir  directory containing the session files
 * @param bareOverride explicit bare-file path (e.g. a checkpoint representative)
 * @returns the built session, or `null` if nothing parseable was found
 */
export function buildSession(id: string, sessionsDir: string, bareOverride?: string): BuiltSession | null {
  const barePath = bareOverride ?? path.join(sessionsDir, id + '.jsonl');
  const trajPath = path.join(sessionsDir, id + '.trajectory.jsonl');
  const hasBare = fs.existsSync(barePath);
  const hasTraj = fs.existsSync(trajPath);
  try {
    if (hasBare) return buildFromBare(barePath, id, hasTraj ? trajPath : null);
    if (hasTraj) return buildFromTrajectory(trajPath, id);
  } catch {
    return null;
  }
  return null;
}

/**
 * Enumerate the UNION of logical sessions in a directory, collapsing checkpoints.
 *
 * A checkpoint (`<base>.checkpoint.<uuid>.jsonl`) is not an independent session
 * — it is a partial save of `<base>`. All checkpoints collapse to their base id.
 * When `<base>` has a non-checkpoint file we use that; otherwise the **largest**
 * checkpoint file is elected as the representative (most complete snapshot).
 *
 * @param sessionsDir directory containing the session files
 * @returns one {@link SessionDescriptor} per logical session
 */
export function listSessions(sessionsDir: string): SessionDescriptor[] {
  const files = fs.readdirSync(sessionsDir);
  const plainIds = new Set<string>(); // ids with a non-checkpoint file
  const ckptByBase = new Map<string, Array<{ file: string; size: number }>>(); // base id -> snapshots

  for (const f of files) {
    if (f.includes('.checkpoint.')) {
      if (!f.endsWith('.jsonl')) continue;
      const base = f.split('.checkpoint.')[0] ?? f;
      let size = 0;
      try {
        size = fs.statSync(path.join(sessionsDir, f)).size;
      } catch {
        /* ignore stat failure */
      }
      const list = ckptByBase.get(base);
      if (list) list.push({ file: f, size });
      else ckptByBase.set(base, [{ file: f, size }]);
    } else if (f.endsWith('.trajectory.jsonl')) {
      plainIds.add(f.replace('.trajectory.jsonl', ''));
    } else if (f.endsWith('.jsonl')) {
      plainIds.add(f.replace('.jsonl', ''));
    }
  }

  const out: SessionDescriptor[] = [];
  for (const id of plainIds) out.push({ id });
  for (const [base, list] of ckptByBase) {
    if (plainIds.has(base)) continue; // already represented by a plain file
    list.sort((a, b) => b.size - a.size); // largest snapshot = most complete
    const rep = list[0];
    if (rep) out.push({ id: base, bareOverride: path.join(sessionsDir, rep.file) });
  }
  return out;
}

/**
 * Build all logical sessions in a directory in one pass.
 *
 * Convenience over {@link listSessions} + {@link buildSession}; silently skips
 * ids that yield nothing parseable.
 *
 * @param sessionsDir directory containing the session files
 * @returns the built sessions (order follows {@link listSessions})
 */
export function buildAllSessions(sessionsDir: string): BuiltSession[] {
  const out: BuiltSession[] = [];
  for (const desc of listSessions(sessionsDir)) {
    const built = buildSession(desc.id, sessionsDir, desc.bareOverride);
    if (built) out.push(built);
  }
  return out;
}