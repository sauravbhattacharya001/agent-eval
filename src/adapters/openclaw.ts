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
 * This module owns **source selection and directory enumeration**; the two
 * source-specific `RunTimeline` builders live in the {@link ./openclaw-build.js}
 * leaf, and the low-level `.jsonl` parsing in {@link ./openclaw-parse.js}.
 *
 * Read-only and dependency-free: pure `node:fs` + parsing, no network, no AI.
 *
 * @tier 1 - Deterministic
 * @module
 */

import fs from 'node:fs';
import path from 'node:path';

// The normalized session contract lives in the neutral `./types.js` module so no
// single trace source owns the shape all adapters must satisfy. Re-exported here
// for backward compatibility with existing `./openclaw.js` type imports.
export type {
  SessionSource,
  SessionMeta,
  BuiltSession,
  SessionDescriptor,
} from './types.js';
import type { BuiltSession, SessionDescriptor } from './types.js';

// Source-specific timeline builders (bare / trajectory-only) + meta assembly.
import { buildFromBare, buildFromTrajectory } from './openclaw-build.js';

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
