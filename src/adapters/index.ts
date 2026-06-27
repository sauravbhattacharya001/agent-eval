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
