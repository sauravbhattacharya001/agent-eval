/**
 * agent-eval — A lightweight TypeScript framework for testing and evaluating AI agent outputs.
 *
 * @packageDocumentation
 */

// Core
export {
  runSuite,
  runSuites,
  resolveProvider,
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
export { LocalProvider } from './providers/local.js';
export type { LocalProviderConfig } from './providers/local.js';

export { AzureOpenAIProvider } from './providers/azure-openai.js';
export type { AzureOpenAIConfig } from './providers/azure-openai.js';

export { AgentProvider, defineTool, ToolBuilder, agentContext } from './providers/agent.js';
export type {
  AgentProviderConfig,
  LLMBackendConfig,
  AzureOpenAIBackendConfig,
  GeminiBackendConfig,
  GroqBackendConfig,
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
  // Relevance (Tier 2 — Heuristic)
  toBeRelevantTo,
  toNotDriftFrom,
  toHaveTopicOverlap,
  toBeOnTopic,
  analyzeRelevance,
  cosineSimilarity,
  vectorize,
  extractTopics,
  topicOverlap,
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
  RelevanceOptions,
  RelevanceResult,
  ScoredTerm,
  SectionRelevance,
  TopicExtractionOptions,
  ExtractedTopic,
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

// Keyword Coverage Scoring (Tier 2 — Heuristic)
export {
  toCoverKeyTopics,
  toHaveNoTopicGaps,
  toMeetKeywordScore,
  toHaveBalancedCoverage,
  toAddressTask,
  extractKeyTerms,
  scoreKeywordCoverage,
  identifyTopicGaps,
} from './checks/index.js';
export type {
  KeywordCoverageScoringOptions,
  ExtractedKeyword,
  KeywordCoverageScore,
  SectionCoverageResult,
  TopicGapOptions,
  TopicGap,
  TopicGapResult,
} from './checks/index.js';

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
