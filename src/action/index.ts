/**
 * Deterministic trace analysis — the report surface.
 *
 * `triage` reads a normalized set of runs and reports what failed the *process*
 * (timeouts, aborts, runaway spend, loops, stalls, errors) using only Tier 1/2
 * deterministic + heuristic checks — no model-as-judge. It is a REPORT, not a
 * gate: it never blocks anything. A human reads the findings and decides the
 * fix (code or prompt), then feeds it back to the agent.
 *
 * `guard` is the runtime companion: the same deterministic checks applied live,
 * as a zero-cost kill-switch an agent loop can call to stop a runaway/looping
 * run mid-flight. Not a CI gate.
 *
 * @packageDocumentation
 */

export {
  triageSessions,
  triageBuilt,
  triageOne,
  renderTriageTable,
} from './triage.js';

export type {
  TriageOptions,
  TriageReport,
  TriageRow,
  FailureKind,
} from './triage.js';

export { createGuard } from './guard.js';

export type {
  Guard,
  GuardOptions,
  GuardVerdict,
  GuardStopKind,
} from './guard.js';
