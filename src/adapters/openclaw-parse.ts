/**
 * OpenClaw adapter — low-level `.jsonl` parsing seam.
 *
 * Pure, dependency-free parsing helpers shared by the OpenClaw session builder
 * ({@link file://./openclaw.ts}): line-safe JSONL reading, message-content
 * flattening, tool-call signatures, elapsed-time math, and the trajectory
 * companion parse (format B). Kept separate from the session-assembly and
 * public-API layers so each seam stays small and independently testable.
 *
 * Read-only: pure `node:fs` + parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import fs from 'node:fs';

import type { RunEvent } from '../checks/staleness.js';
import { toolSig } from './tool-signature.js';
import { clip } from './content-clip.js';

// ─── INTERNAL: trajectory parse result ──────────────────────────────────────────

export interface ParsedTrajectory {
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

export interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

/** Flatten a message `content` (string or block array) into plain text. */
export function contentToText(content: unknown): string {
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
export function toolCallSignaturesOf(content: unknown): string[] {
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
export function safeParseLines(file: string): Array<Record<string, unknown>> {
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

export function elapsedMs(firstTs: unknown, lastTs: unknown): number {
  if (!firstTs || !lastTs) return NaN;
  return new Date(lastTs as string).getTime() - new Date(firstTs as string).getTime();
}

// ─── TRAJECTORY PARSE (format B) ────────────────────────────────────────────────

/** Parse a trajectory companion: usage + abort/idle flags + assistant texts + event spine. */
export function parseTrajectory(trajPath: string): ParsedTrajectory | null {
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
