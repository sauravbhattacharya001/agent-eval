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
      return 'ran away - a huge token burn with no clean stop';
    case 'errored':
      return 'errored out mid-run';
    case 'abandoned':
      return 'was abandoned before producing a final answer';
    case 'stalled':
      return 'stalled - went idle without completing';
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
  const truncated = (meta.allAssistantText || '').length > 2000;
  const approxK = Math.round(meta.tokenUsage / 1000);

  // Does the recorded failure leave a *visible* deficit in the replayed output?
  //   - abandoned / stalled: the run produced no final answer -> empty output is
  //     itself the failing signal; asserting a real answer keeps it red honestly.
  //   - timeout / runaway / errored: the run often emitted PARTIAL text before
  //     dying, so the replayed string looks fine. The real signal (token burn /
  //     non-completion) is NOT in the string. Replaying it and asserting
  //     "non-empty" would flip the case green on promotion and silently drop the
  //     incident. So we freeze the failure kind + measured burn and gate on that.
  const visibleInOutput = row.kind === 'abandoned' || row.kind === 'stalled';

  const header = `/**
 * AUTO-PROMOTED regression case - sanitize before committing (see SCRUBBING.md).
 *
 *   sourceTraceId : ${row.id}
 *   failureKind   : ${row.kind}
 *   wastedTokens  : ${meta.tokenUsage.toLocaleString()}  (~$${row.projectedCostUsd.toFixed(2)})
 *   promotedAt    : ${new Date().toISOString()}
 *
 * WHAT THIS GUARDS: the run above ${describeFailure(row.kind)}. This case freezes
 * that incident so the failure can never silently regress. It is EXPECTED TO FAIL
 * until the agent is fixed - that red is the captured incident.
 *
 * BEFORE COMMITTING: replace any real content in CAPTURED_INPUT / CAPTURED_OUTPUT
 * with <REDACTED_*> placeholders. The assertions test structure, not content.
 */

import { defineEval, LocalProvider, toHaveMinLength, custom } from ${JSON.stringify(importFrom)};

const CAPTURED_INPUT = ${JSON.stringify(capturedInput)};

// The output the agent actually produced on the failing run (replayed offline).${truncated ? '\n// NOTE: truncated to 2,000 chars for the fixture; the real run emitted more.' : ''}
const CAPTURED_OUTPUT = ${JSON.stringify(capturedOutput)};
`;

  if (visibleInOutput) {
    // No-final-answer failure: the deficit is real and in the output. A fixed run
    // that actually answers will pass; the replayed empty/partial output fails.
    return `${header}
export default defineEval({
  name: ${JSON.stringify(`Regression: ${safeIdent(row.id)} (${row.kind})`)},
  provider: new LocalProvider({ outputs: { [CAPTURED_INPUT]: CAPTURED_OUTPUT } }),
  specs: [
    {
      name: ${JSON.stringify(`must not repeat ${row.kind} failure from ${row.id}`)},
      prompt: CAPTURED_INPUT,
      assertions: [
        // Tier 1 - deterministic. The corrected run must produce a real,
        // non-empty final answer (the source run did not).
        toHaveMinLength(1),
        custom('produced a usable final answer', (output) => {
          const empty = !output || output.trim().length === 0;
          return empty
            ? { pass: false, message: 'No final answer - same failure as the source trace.' }
            : { pass: true };
        }),
      ],
    },
  ],
});
`;
  }

  // Resource/error failure: the signal is NOT in the replayed string. Freeze the
  // measured burn and gate on an explicit, unforgeable flag. This is red BY
  // CONSTRUCTION - a truncated non-empty replay cannot turn it green.
  return `${header}
// The measured failure signal from the source run. This is what makes the case
// red - not the replayed text, which may look fine because the run emitted
// partial output (~${approxK}k tokens) before it ${row.kind === 'errored' ? 'errored' : 'blew its budget'}.
const SOURCE_FAILURE_KIND = ${JSON.stringify(row.kind)};
const SOURCE_WASTED_TOKENS = ${meta.tokenUsage};
const TOKEN_CEILING = ${Math.max(50_000, Math.round(meta.tokenUsage * 0.5))};

// Flip to false ONLY after you have (a) repointed \`provider\` at the FIXED agent
// and (b) confirmed from its fresh trace that the run completes cleanly under
// TOKEN_CEILING. Until then this case stays red - that is the frozen incident.
const INCIDENT_RESOLVED = false;

export default defineEval({
  name: ${JSON.stringify(`Regression: ${safeIdent(row.id)} (${row.kind})`)},
  provider: new LocalProvider({ outputs: { [CAPTURED_INPUT]: CAPTURED_OUTPUT } }),
  specs: [
    {
      name: ${JSON.stringify(`must not repeat ${row.kind} failure from ${row.id} (~${approxK}k tokens)`)},
      prompt: CAPTURED_INPUT,
      assertions: [
        // Tier 1 - deterministic and unforgeable. The recorded run ${describeFailure(row.kind)};
        // that signal lives in the token burn, not the (possibly partial) text, so
        // we gate on the frozen incident flag rather than replaying text as success.
        custom(${JSON.stringify(`${row.kind} incident from ${row.id} is resolved`)}, () => {
          return INCIDENT_RESOLVED
            ? { pass: true }
            : {
                pass: false,
                message:
                  'Unresolved ' + SOURCE_FAILURE_KIND + ' incident: source run burned ' +
                  SOURCE_WASTED_TOKENS.toLocaleString() + ' tokens (ceiling ' +
                  TOKEN_CEILING.toLocaleString() + '). Repoint provider at the fixed agent, ' +
                  'confirm a clean bounded run, then set INCIDENT_RESOLVED = true.',
              };
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
