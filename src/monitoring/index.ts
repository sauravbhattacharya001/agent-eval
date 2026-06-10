/**
 * Production Monitoring (Phase 3.5)
 *
 * Tools for parsing, scoring, and tracking historical agent runs from the
 * structured transcript markdown files written by cron workers.
 *
 * Pipeline shape:
 *
 *     transcripts/<worker>/*.md
 *        │
 *        ▼  parseTranscript / loadTranscript / discoverTranscripts
 *     Transcript
 *        │
 *        ▼  transcriptToTimeline
 *     RunTimeline  (consumed by Tier 1 staleness checks)
 *
 * This module ships the parsing + bridging layer. Historical scoring,
 * trend detection, and scorecards build on top of it in subsequent runs.
 *
 * @packageDocumentation
 */

export {
  parseTranscript,
  parseDuration,
  parseOutcome,
  extractTitle,
  extractSections,
  extractListItems,
  extractReferences,
  slugifyHeading,
} from './transcript-reader.js';

export {
  discoverTranscripts,
  loadTranscript,
  loadTranscripts,
  parseTranscriptFiles,
  rollingWindow,
} from './discovery.js';

export type { TranscriptFile, DiscoveryOptions } from './discovery.js';

export { transcriptToTimeline } from './timeline-bridge.js';

export type { TimelineBridgeOptions } from './timeline-bridge.js';

export type {
  Transcript,
  TranscriptIdentity,
  TranscriptSection,
  TranscriptReference,
  ParsedDuration,
  ParseTranscriptOptions,
  WorkerName,
  OutcomeStatus,
} from './types.js';
