/**
 * OpenClaw session assembly — source-specific `RunTimeline` builders.
 *
 * Internal seam of the {@link ../adapters/openclaw.js} adapter: the two
 * source-specific builders (`buildFromBare`, `buildFromTrajectory`) plus the
 * shared {@link SessionMeta} assembly live here so the public `openclaw.ts`
 * surface focuses on source selection and directory enumeration.
 *
 * Behaviour is identical to the pre-split inline builders — this is a
 * mechanical extraction with no logic change.
 *
 * Read-only and dependency-free: pure `node:fs` + parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import fs from 'node:fs';

import type { RunEvent, RunTimeline } from '../checks/staleness.js';
import type { BuiltSession, SessionMeta, SessionSource } from './types.js';
import { clip, LABEL_TRUNCATION } from './content-clip.js';
import type { ContentBlock, ParsedTrajectory } from './openclaw-parse.js';
import {
  contentToText,
  toolCallSignaturesOf,
  safeParseLines,
  elapsedMs,
  parseTrajectory,
} from './openclaw-parse.js';

// ─── BUILD FROM BARE (format A, enriched by B) ──────────────────────────────────

interface MessageRecord {
  role?: string;
  content?: unknown;
  usage?: { totalTokens?: unknown };
  stopReason?: string;
}

export function buildFromBare(
  barePath: string,
  base: string,
  trajPath: string | null,
): BuiltSession | null {
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

export function buildFromTrajectory(trajPath: string, base: string): BuiltSession | null {
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
