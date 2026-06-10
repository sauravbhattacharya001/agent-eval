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

// ─── Historical Scoring (Phase 3.5) ──────────────────────────────────────────

export {
  scoreTranscript,
  scoreTranscripts,
  toScoreRows,
} from './scorer.js';

export type {
  CheckScore,
  TranscriptScore,
  ScoreTranscriptOptions,
  CheckName,
  ScoreTier,
  ScoreStatus,
} from './scorer.js';

export {
  scoresPathFor,
  readScores,
  readAllScores,
  parseScoresJsonl,
  serializeScoresJsonl,
  writeScores,
  writeScoresFor,
  writeScoresByWorker,
  upsertScores,
  scoreKey,
  groupRowsByWorker,
} from './scores-store.js';

export type { WriteScoresResult, WriteScoresOptions } from './scores-store.js';

export { scoreHistory } from './score-runner.js';

export type { ScoreHistoryOptions, ScoreHistoryResult } from './score-runner.js';

// ─── Trend Detection (Phase 3.5) ──────────────────────────────────────────────

export {
  detectTrends,
  extractMetric,
  segmentStats,
  splitSeries,
  hasDegradation,
  formatTrendReport,
  METRIC_DIRECTIONS,
} from './trend-detector.js';

export type {
  Direction,
  TrendDirection,
  TrendSeverity,
  TrendMetric,
  TrendPoint,
  SegmentStats,
  Trend,
  WorkerTrend,
  TrendReport,
  DetectTrendsOptions,
} from './trend-detector.js';

export { detectTrendsFromDisk, filterRowsByDate } from './trend-runner.js';

export type {
  DetectTrendsFromDiskOptions,
  DetectTrendsFromDiskResult,
} from './trend-runner.js';

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
