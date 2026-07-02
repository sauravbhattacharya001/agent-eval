/**
 * agent-eval — A lightweight TypeScript framework for testing and evaluating AI agent outputs.
 *
 * @packageDocumentation
 */

// Core
export {
  runSuite,
  runSuites,
} from './core/runner.js';
export type { RunnerOptions } from './core/runner.js';

// Types
export type {
  Assertion,
  AssertionResult,
  AssertionStatus,
  EvalContext,
  EvalProvider,
  EvalSpec,
  EvalSuiteDefinition,
  ProviderOptions,
  Reporter,
  SpecResult,
  SuiteResult,
} from './core/types.js';

// Assertions
export {
  toContain,
  toMatch,
  toEqual,
  notToContain,
  notToMatch,
  toHaveMinLength,
  toHaveMaxLength,
  toBeValidJson,
  toStartWith,
  toEndWith,
  custom,
} from './core/assertions.js';

// Reporters
export { TerminalReporter, JsonReporter } from './core/reporter.js';

// Providers
export { AzureOpenAIProvider } from './providers/azure-openai.js';
export type { AzureOpenAIConfig } from './providers/azure-openai.js';

export { AgentProvider, defineTool, ToolBuilder, agentContext } from './providers/agent.js';
export type {
  AgentProviderConfig,
  LLMBackendConfig,
  AzureOpenAIBackendConfig,
  GeminiBackendConfig,
  GroqBackendConfig,
  OpenRouterBackendConfig,
  ToolDefinition,
  CapturedToolCall,
  AgentTurn,
  AgentRunResult,
} from './providers/agent.js';

// CLI utilities (for programmatic use)
export { parseCliArgs } from './cli/args.js';
export type { ParsedArgs } from './cli/args.js';
export { discoverSpecs } from './cli/discover.js';

// Checks (Tier 1 — Deterministic)
export {
  // Format validation
  toMatchJsonSchema,
  toBeValidJsonStrict,
  toHaveMarkdownStructure,
  toHaveSections,
  toHaveCodeBlocks,
  toBeFormat,
  validateJsonSchema,
  validateMarkdownStructure,
  parseMarkdownStructure,
  // Path/URL verification
  toHaveValidUrls,
  toHaveValidPaths,
  toHaveValidGitHubRefs,
  toHaveValidReferences,
  toReferenceUrls,
  toHaveWellFormedUrls,
  toReferencePaths,
  extractReferences,
  verifyUrl,
  verifyFilePath,
  verifyGitHubRepo,
  verifyGitHubIssue,
  verifyReferences,
  // Completeness checks
  toBeNonEmpty,
  toMeetLengthRange,
  toBeSubstantive,
  toBeComplete,
  toPassCompletenessCheck,
  analyzeContent,
  checkCompleteness,
  // Constraint validation
  toContainKeywords,
  toNotContainKeywords,
  toMeetKeywordCoverage,
  toSatisfyConstraints,
  toMatchPatterns,
  validateRule,
  validateConstraints,
  calculateKeywordCoverage,
  // Diff analysis
  toHaveMeaningfulDiff,
  toNotBeNoOp,
  toNotParrot,
  toHaveMinimumChanges,
  toHaveMeaningfulUnifiedDiff,
  analyzeDiff,
  detectParroting,
  parseUnifiedDiff,
  textSimilarity,
  // Staleness/timeout detection
  toCompleteWithinTimeout,
  toNotBeAbandoned,
  toNotBeStale,
  toNotBeStalled,
  toBeProductiveRun,
  parseTimestamp,
  formatDuration,
  detectTimeout,
  detectStaleness,
  detectAbandonment,
  analyzeProgress,
  analyzeStaleness,
  // Repetition/Loop detection (Tier 2 — Heuristic)
  toNotRepeat,
  toNotLoop,
  toNotBeSaturated,
  toNotBeRepetitive,
  toNotExceedRepetitions,
  analyzeRepetition,
  detectLoops,
  analyzeNgramSaturation,
  analyzeFullRepetition,
  splitSentences,
  splitParagraphs,
  splitLines,
  segmentSimilarity,
} from './checks/index.js';
export type {
  JsonSchema,
  JsonSchemaType,
  SchemaValidationError,
  SchemaValidationResult,
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
  ExtractedReference,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  ReferenceVerifyResult,
  PathVerifyOptions,
  BatchVerifyOptions,
  ContentMetrics,
  LengthRangeOptions,
  SubstanceOptions,
  StructuralCompletenessOptions,
  CompletenessOptions,
  CompletenessViolation,
  CompletenessResult,
  ConstraintRule,
  KeywordCoverageOptions,
  KeywordCoverageResult,
  ConstraintViolation,
  ViolationLocation,
  ConstraintValidationOptions,
  ConstraintValidationResult,
  ChangeKind,
  DiffChange,
  DiffMetrics,
  DiffOptions,
  DiffResult,
  MeaningfulChangeOptions,
  NotNoOpOptions,
  ParrotingOptions,
  RunEvent,
  RunTimeline,
  TimeoutOptions,
  StalenessOptions,
  AbandonmentOptions,
  ProgressOptions,
  StalenessResult,
  StalenessIssue,
  RepetitionOptions,
  RepetitionInstance,
  RepetitionKind,
  RepetitionResult,
  LoopDetectionOptions,
  LoopInstance,
  LoopResult,
  NgramSaturationOptions,
  NgramSaturationResult,
  FullRepetitionOptions,
  FullRepetitionResult,
} from './checks/index.js';

// Helpers
export { defineEval } from './define.js';

// Judge Framework (Tier 3 — Shared-Substrate Judgment)
export {
  buildRubric,
  RubricBuilder,
  CriterionBuilder,
  validateRubric,
  computeVerdict,
  normalizeCriterionWeights,
  getMaxScore,
  getMinScore,
  classifyConfidence,
  buildJudgePrompt,
  parseJudgeResponse,
  extractJson,
  RuleBasedJudge,
  JudgeEvaluator,
  toPassJudge,
  toScoreOnCriterion,
  toHaveJudgeConfidence,
  toMeetAllCriteria,
  toHaveJudgeSuggestions,
  BUILTIN_RUBRICS,
  // Calibration
  calibrate,
  buildCalibrationSet,
  CalibrationSetBuilder,
  CalibrationExampleBuilder,
  detectDrift,
  // Consensus & Adversarial
  runConsensus,
  AdversarialJudge,
  CrossModelJudge,
  toPassConsensusJudge,
  toPassAdversarialJudge,
} from './checks/index.js';
export type {
  RubricCriterion,
  ScoringLevel,
  Rubric,
  JudgeConfidence,
  CriterionScore,
  JudgeVerdict,
  JudgeResult,
  JudgeOptions,
  JudgeBackend,
  JudgeContext,
  RawJudgeResponse,
  RawCriterionScore,
  RubricValidationError,
  ScoringFunction,
  JudgeParseError,
  // Calibration types
  CalibrationExample,
  CalibrationSet,
  CriterionCalibration,
  CriterionDelta,
  CalibrationReport,
  CalibrationOptions,
  CalibrationSnapshot,
  DriftResult,
  // Consensus types
  ConsensusOptions,
  ConsensusResult,
  CriterionAgreement,
  AdversarialOptions,
  CrossModelOptions,
} from './checks/index.js';

// Tiered Runner (Cost Pyramid Orchestration)
export {
  runTiered,
  detectTier,
  classifyAssertions,
  tier1,
  tier2,
  tier3,
} from './core/tiered-runner.js';
export type {
  Tier,
  TieredAssertion,
  TieredRunnerOptions,
  TieredResult,
  TierResult,
} from './core/tiered-runner.js';

// Judge Backends
export { LLMJudgeBackend } from './judges/llm-judge.js';
export type { LLMJudgeConfig } from './judges/llm-judge.js';

// Confidence Labeling (Tier 3 — Meta-evaluation)
export {
  extractSelfReportedConfidence,
  extractEvidenceQuality,
  extractScoreConsistency,
  extractBoundaryProximity,
  extractCoverageCompleteness,
  extractReasoningQuality,
  assessConfidence,
  labelVerdict,
  ConfidenceAwareJudge,
  toPassWithConfidence,
  toHaveAdequateConfidence,
  toHaveNoConfidenceFlags,
  toNotBeOverridden,
} from './checks/index.js';
export type {
  ConfidenceSignal,
  ConfidenceSignalId,
  ConfidenceAssessment,
  ConfidenceRecommendation,
  ConfidenceLabelingOptions,
  LabeledVerdict,
} from './checks/index.js';

// Behavioural footprint (Section F, slice 2 — Tier 1+2, PROOF only)
//
// Mechanical per-run metrics (steps, tool-error rate, retry/thrash, recovery,
// cost) computed over PROOF-labeled trace records only. Pairs with the trace
// provenance map below; feeds harness×model selection. Never reads model claims.
export {
  analyzeFootprint,
  toCompleteWithinSteps,
  toHaveToolErrorRateBelow,
  toNotThrash,
  toRecoverFromErrors,
} from './checks/index.js';
export type {
  FootprintOptions,
  FootprintResult,
  ToolOutcome,
} from './checks/index.js';

// Claim↔proof cross-check (Section F, slice 3 — Tier 1+2, PROOF only)
//
// Falsifies each model CLAIM (a chosen tool, or a stated action in narration/
// reasoning) against Tier-1 PROOF (the harness's actual tool results). Verdicts
// are deterministic — verified / contradicted / unverifiable; `unverifiable`
// claims are EXCLUDED from the score and surfaced as instrumentation gaps,
// never Tier-3-judged. Pairs with the behavioural footprint above; feeds
// harness×model selection.
export {
  crossCheckClaims,
  toHaveNoContradictedClaims,
  toHaveClaimIntegrityAtLeast,
  toHaveInstrumentationGapsAtMost,
} from './checks/index.js';
export type {
  ClaimCheck,
  ClaimCheckOptions,
  ClaimCheckResult,
  ClaimSource,
  ClaimVerdict,
} from './checks/index.js';

// Production Monitoring (Phase 3.5 - Transcript Reader + Historical Scoring)
export {
  parseTranscript,
  parseDuration,
  parseOutcome,
  extractTitle,
  extractSections,
  extractListItems,
  slugifyHeading,
  discoverTranscripts,
  loadTranscript,
  loadTranscripts,
  parseTranscriptFiles,
  rollingWindow,
  transcriptToTimeline,
  scoreTranscript,
  scoreTranscripts,
  toScoreRows,
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
  scoreHistory,
  detectTrends,
  extractMetric,
  segmentStats,
  splitSeries,
  hasDegradation,
  formatTrendReport,
  METRIC_DIRECTIONS,
  detectTrendsFromDisk,
  filterRowsByDate,
  aggregateScorecard,
  formatScorecard,
  formatScorecardMarkdown,
  buildScorecard,
  validateTranscript,
  validateParsedTranscript,
  TRANSCRIPT_CONTRACT_V1,
  CONTRACT_OUTCOME_TOKENS,
  labelField,
  provenanceMap,
  ingestTrace,
  rankSelection,
  toSelectionRun,
  parseSelectionKey,
} from './monitoring/index.js';
export type {
  Transcript,
  TranscriptIdentity,
  TranscriptSection,
  TranscriptReference,
  TranscriptFile,
  ParsedDuration,
  ParseTranscriptOptions,
  DiscoveryOptions,
  TimelineBridgeOptions,
  WorkerName,
  OutcomeStatus,
  CheckScore,
  TranscriptScore,
  ScoreTranscriptOptions,
  RunMetadata,
  CheckName,
  ScoreTier,
  ScoreStatus,
  WriteScoresResult,
  WriteScoresOptions,
  ScoreHistoryOptions,
  ScoreHistoryResult,
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
  DetectTrendsFromDiskOptions,
  DetectTrendsFromDiskResult,
  Scorecard,
  WorkerScorecard,
  ScorecardTotals,
  ScorecardTrend,
  CheckBreakdown,
  FailureCategory,
  HealthGrade,
  TrendArrow,
  AggregateScorecardOptions,
  BuildScorecardOptions,
  BuildScorecardResult,
  ContractViolation,
  ContractValidationResult,
  ContractSection,
  ViolationSeverity,
  Provenance,
  ProvenanceRecord,
  TraceProvenance,
  TraceSession,
  TraceEvent,
  TraceToolCall,
  TraceDecision,
  SelectionAxis,
  SelectionOptions,
  SelectionWeights,
  SelectionRun,
  SelectionCandidate,
  SelectionScorecard,
} from './monitoring/index.js';

// Deterministic trace analysis (report, not a gate) + runtime guard
export {
  triageSessions,
  triageBuilt,
  triageOne,
  renderTriageTable,
  createGuard,
} from './action/index.js';
export type { TriageOptions, TriageReport, TriageRow, FailureKind } from './action/index.js';
export type { Guard, GuardOptions, GuardVerdict, GuardStopKind } from './action/index.js';

// Adapters (raw agent log formats -> agent-eval inputs)
export { buildSession, buildAllSessions, listSessions } from './adapters/index.js';
export { parseLangSmith, triageLangSmith } from './adapters/index.js';
export { parseOtlp, triageOtlp } from './adapters/index.js';
export { parseAgentLens, triageAgentLens } from './adapters/index.js';
export type { BuiltSession, SessionMeta, SessionDescriptor, SessionSource } from './adapters/index.js';
export type { LangSmithRun } from './adapters/index.js';
export type { OtlpTrace } from './adapters/index.js';
export type { AgentLensExport } from './adapters/index.js';
