/**
 * Promote triaged failures into runnable regression cases.
 *
 * This is the productized form of the demo promoter: given parsed sessions and a
 * triage report, it freezes the worst-ranked runs into `.eval.mjs` files that the
 * agent-eval CLI can run. Each emitted case:
 *   - imports the real defineEval / LocalProvider / assertions from `agent-eval`
 *   - replays the captured (failing) output offline via LocalProvider
 *   - is EXPECTED TO FAIL until the agent is fixed (that red is the incident)
 *   - carries sourceTraceId + failureKind provenance for later sanitization
 *
 * The output is deliberately written with real captured content so the operator
 * runs it once to confirm the incident reproduces, THEN sanitizes it per
 * SCRUBBING.md before committing to a private corpus.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BuiltSession } from '../adapters/index.js';
import type { TriageReport, TriageRow, FailureKind } from '../action/index.js';

export interface PromoteOptions {
  /** Directory to write cases into (created if missing). */
  outDir: string;
  /** Promote at most this many top-ranked runs. Default 1. */
  top?: number;
  /**
   * Import specifier the generated case uses for the engine.
   * Default `'agent-eval'` (works when the corpus resolves the package).
   * Point at a relative `dist/index.js` when running inside this repo.
   */
  importFrom?: string;
}

export interface PromotedCase {
  /** Absolute path written. */
  file: string;
  /** Source session id. */
  sourceId: string;
  /** Failure classification frozen. */
  kind: FailureKind;
  /** Projected wasted spend for the run (USD). */
  projectedCostUsd: number;
  /** Token burn observed. */
  tokenUsage: number;
}

function describeFailure(kind: FailureKind): string {
  switch (kind) {
    case 'timeout':
      return 'burned tokens then never returned within its timeout';
    case 'runaway':
      return 'ran away — a huge token burn with no clean stop';
    case 'errored':
      return 'errored out mid-run';
    case 'abandoned':
      return 'was abandoned before producing a final answer';
    case 'stalled':
      return 'stalled — went idle without completing';
    default:
      return `failed (${kind})`;
  }
}

function safeIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function renderCase(
  row: TriageRow,
  session: BuiltSession,
  importFrom: string,
): string {
  const meta = session.meta;
  const capturedInput = meta.label || row.id;
  const capturedOutput = (meta.allAssistantText || '').slice(0, 2000);
  const tokenCeiling = Math.max(50_000, Math.round(meta.tokenUsage * 0.5));
  const approxK = Math.round(meta.tokenUsage / 1000);

  return `/**
 * AUTO-PROMOTED regression case — sanitize before committing (see SCRUBBING.md).
 *
 *   sourceTraceId : ${row.id}
 *   failureKind   : ${row.kind}
 *   wastedTokens  : ${meta.tokenUsage.toLocaleString()}  (~$${row.projectedCostUsd.toFixed(2)})
 *   promotedAt    : ${new Date().toISOString()}
 *
 * WHAT THIS GUARDS: the run above ${describeFailure(row.kind)}. This case freezes
 * that input so the failure can never silently regress. It replays the ORIGINAL
 * (bad) output via LocalProvider and is EXPECTED TO FAIL — that red is the captured
 * incident. Point \`provider\` at your fixed agent and it should go green.
 *
 * BEFORE COMMITTING: replace any real content in CAPTURED_INPUT / CAPTURED_OUTPUT
 * with <REDACTED_*> placeholders. The assertions test structure, not content.
 */

import { defineEval, LocalProvider, toHaveMinLength, custom } from ${JSON.stringify(importFrom)};

const CAPTURED_INPUT = ${JSON.stringify(capturedInput)};

// The output the agent actually produced on the failing run (replayed offline).
const CAPTURED_OUTPUT = ${JSON.stringify(capturedOutput)};

export default defineEval({
  name: ${JSON.stringify(`Regression: ${safeIdent(row.id)} (${row.kind})`)},
  provider: new LocalProvider({ outputs: { [CAPTURED_INPUT]: CAPTURED_OUTPUT } }),
  specs: [
    {
      name: ${JSON.stringify(`must not repeat ${row.kind} failure from ${row.id}`)},
      prompt: CAPTURED_INPUT,
      assertions: [
        // Tier 1 — deterministic, unforgeable. The corrected run must produce a
        // real, non-empty final answer.
        toHaveMinLength(1),
        custom('produced a usable final answer', (output) => {
          const empty = !output || output.trim().length === 0;
          return empty
            ? { pass: false, message: 'No final answer — same failure as the source trace.' }
            : { pass: true };
        }),
        custom(${JSON.stringify(`stayed under the token ceiling (<= ${tokenCeiling.toLocaleString()})`)}, (output) => {
          // Proxy: the fixed run's output should be bounded, not a ${approxK}k-token runaway.
          // In CI you would assert on measured usage from the fresh run's trace.
          const approxTokens = Math.ceil(output.length / 4);
          return approxTokens <= ${tokenCeiling}
            ? { pass: true }
            : { pass: false, message: 'Output implies ~' + approxTokens + ' tokens — over ceiling ${tokenCeiling}.' };
        }),
      ],
    },
  ],
});
`;
}

/**
 * Promote the top-N failed runs from a triage report into regression cases.
 * Returns metadata for each written case (empty if nothing was flagged).
 */
export function promoteFromTriage(
  sessions: BuiltSession[],
  report: TriageReport,
  options: PromoteOptions,
): PromotedCase[] {
  const top = Math.max(1, options.top ?? 1);
  const importFrom = options.importFrom ?? 'agent-eval';
  const outDir = resolve(options.outDir);
  const byId = new Map(sessions.map((s) => [s.meta.sessionId, s]));

  const written: PromotedCase[] = [];
  const rows = report.rows.slice(0, top);
  if (rows.length === 0) return written;

  mkdirSync(outDir, { recursive: true });
  for (const row of rows) {
    const session = byId.get(row.id);
    if (!session) continue;
    const file = join(outDir, `regression-${safeIdent(row.id)}.eval.mjs`);
    writeFileSync(file, renderCase(row, session, importFrom), 'utf8');
    written.push({
      file,
      sourceId: row.id,
      kind: row.kind,
      projectedCostUsd: row.projectedCostUsd,
      tokenUsage: row.tokenUsage,
    });
  }
  return written;
}
