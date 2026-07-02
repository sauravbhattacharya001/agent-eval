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
