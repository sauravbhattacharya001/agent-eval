/**
 * GitHub Action Integration (Phase 4)
 *
 * Turns the monitoring pipeline's {@link Scorecard} into a CI quality gate: a
 * pass/fail decision, GitHub Action outputs, a Markdown step summary, and an
 * exit code. This is the seam an eval-layer contribution to a CI Action plugs
 * into — it consumes the transcripts the workers already write and gates the
 * build on independent Tier 1 / Tier 2 signals (no model-as-judge).
 *
 * Typical step body:
 *
 *     import { runActionEval, emitActionResult } from 'agent-eval';
 *
 *     const { evaluation } = runActionEval(process.env.TRANSCRIPTS_DIR!, {
 *       window: 7,
 *       gate: 'watch',          // healthy/watch pass; at-risk/critical fail
 *       minScore: 0.6,          // also require a fleet score floor
 *     });
 *     process.exitCode = emitActionResult(evaluation);  // writes outputs + summary
 *
 * @packageDocumentation
 */

export {
  evaluateForAction,
  toActionOutputs,
  renderActionSummary,
} from './adapter.js';

export type {
  GateGrade,
  NoDataPolicy,
  EvaluateForActionOptions,
  WorkerVerdict,
  ActionEvidence,
  ActionEvaluation,
  ActionOutputs,
} from './adapter.js';

export {
  runActionEval,
  emitActionResult,
  runAndEmit,
  createEnvWriter,
  createMemoryWriter,
} from './runner.js';

export type {
  ActionWriter,
  MemoryWriter,
  RunActionEvalOptions,
  RunActionEvalResult,
} from './runner.js';

export {
  scoreCiRun,
  evaluateCiRun,
  analyzeActionability,
  analyzeCiStaleness,
  analyzeTaskGrounding,
} from './ci-run.js';

export type {
  CiCheckStatus,
  CiCheckResult,
  EvaluateCiRunOptions,
  CiRunEvaluation,
  ActionableArtifacts,
  StalenessAnalysis,
  TaskGroundingResult,
} from './ci-run.js';

export {
  parseCcaExecutionLog,
  extractCcaRun,
  extractCcaRunFromFile,
} from './cca-execution.js';

export type {
  CcaContentItem,
  CcaMessage,
  CcaTurn,
  CcaExecutionLog,
  CcaResultDetails,
  CcaRunExtract,
  ExtractCcaRunOptions,
} from './cca-execution.js';
