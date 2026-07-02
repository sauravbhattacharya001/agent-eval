/**
 * Adapters — convert external agent log formats into agent-eval inputs.
 *
 * @packageDocumentation
 */

export {
  buildSession,
  buildAllSessions,
  listSessions,
} from './openclaw.js';

export type {
  BuiltSession,
  SessionMeta,
  SessionDescriptor,
  SessionSource,
} from './openclaw.js';

// LangSmith / LangChain / LangGraph run-export adapter.
export {
  parseLangSmith,
  triageLangSmith,
} from './langsmith.js';

export type {
  LangSmithRun,
} from './langsmith.js';

// OpenTelemetry (OTLP) GenAI-span adapter - covers Phoenix, Traceloop/OpenLLMetry, raw OTel.
export {
  parseOtlp,
  triageOtlp,
} from './otlp.js';

export type {
  OtlpTrace,
} from './otlp.js';

// AgentLens session-export adapter - closes the loop with the AgentLens recorder.
export {
  parseAgentLens,
  triageAgentLens,
} from './agentlens.js';

export type {
  AgentLensExport,
} from './agentlens.js';
