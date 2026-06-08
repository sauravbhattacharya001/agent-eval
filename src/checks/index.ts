/**
 * Built-in checks — Tier 1, 2, and 3 evaluation modules.
 *
 * @packageDocumentation
 */

export {
  // Format validation assertions
  toMatchJsonSchema,
  toBeValidJsonStrict,
  toHaveMarkdownStructure,
  toHaveSections,
  toHaveCodeBlocks,
  toBeFormat,
  // Utilities
  validateJsonSchema,
  validateMarkdownStructure,
  parseMarkdownStructure,
} from './format.js';

export type {
  JsonSchema,
  JsonSchemaType,
  SchemaValidationError,
  SchemaValidationResult,
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
} from './format.js';

export {
  // Path/URL verification assertions
  toHaveValidUrls,
  toHaveValidPaths,
  toHaveValidGitHubRefs,
  toHaveValidReferences,
  toReferenceUrls,
  toHaveWellFormedUrls,
  toReferencePaths,
  // Utilities
  extractReferences,
  verifyUrl,
  verifyFilePath,
  verifyGitHubRepo,
  verifyGitHubIssue,
  verifyReferences,
} from './paths.js';

export type {
  ExtractedReference,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  ReferenceVerifyResult,
  PathVerifyOptions,
  BatchVerifyOptions,
} from './paths.js';

export {
  // Completeness assertions
  toBeNonEmpty,
  toMeetLengthRange,
  toBeSubstantive,
  toBeComplete,
  toPassCompletenessCheck,
  // Utilities
  analyzeContent,
  checkCompleteness,
} from './completeness.js';

export type {
  ContentMetrics,
  LengthRangeOptions,
  SubstanceOptions,
  StructuralCompletenessOptions,
  CompletenessOptions,
  CompletenessViolation,
  CompletenessResult,
} from './completeness.js';

export {
  // Constraint validation assertions
  toContainKeywords,
  toNotContainKeywords,
  toMeetKeywordCoverage,
  toSatisfyConstraints,
  toMatchPatterns,
  // Utilities
  validateRule,
  validateConstraints,
  calculateKeywordCoverage,
} from './constraints.js';

export type {
  ConstraintRule,
  KeywordCoverageOptions,
  KeywordCoverageResult,
  ConstraintViolation,
  ViolationLocation,
  ConstraintValidationOptions,
  ConstraintValidationResult,
} from './constraints.js';

export {
  // Diff analysis assertions
  toHaveMeaningfulDiff,
  toNotBeNoOp,
  toNotParrot,
  toHaveMinimumChanges,
  toHaveMeaningfulUnifiedDiff,
  // Utilities
  analyzeDiff,
  detectParroting,
  parseUnifiedDiff,
  textSimilarity,
} from './diff.js';

export type {
  ChangeKind,
  DiffChange,
  DiffMetrics,
  DiffOptions,
  DiffResult,
  MeaningfulChangeOptions,
  NotNoOpOptions,
  ParrotingOptions,
} from './diff.js';

export {
  // Staleness/timeout assertions
  toCompleteWithinTimeout,
  toNotBeAbandoned,
  toNotBeStale,
  toNotBeStalled,
  toBeProductiveRun,
  // Utilities
  parseTimestamp,
  formatDuration,
  detectTimeout,
  detectStaleness,
  detectAbandonment,
  analyzeProgress,
  analyzeStaleness,
} from './staleness.js';

export type {
  RunEvent,
  RunTimeline,
  TimeoutOptions,
  StalenessOptions,
  AbandonmentOptions,
  ProgressOptions,
  StalenessResult,
  StalenessIssue,
} from './staleness.js';

export {
  // Relevance assertions (Tier 2 — Heuristic)
  toBeRelevantTo,
  toNotDriftFrom,
  toHaveTopicOverlap,
  toBeOnTopic,
  // Utilities
  analyzeRelevance,
  cosineSimilarity,
  vectorize,
  extractTopics,
  topicOverlap,
} from './relevance.js';

export type {
  RelevanceOptions,
  RelevanceResult,
  ScoredTerm,
  SectionRelevance,
  TopicExtractionOptions,
  ExtractedTopic,
} from './relevance.js';

export {
  // Repetition/Loop detection assertions (Tier 2 — Heuristic)
  toNotRepeat,
  toNotLoop,
  toNotBeSaturated,
  toNotBeRepetitive,
  toNotExceedRepetitions,
  // Utilities
  analyzeRepetition,
  detectLoops,
  analyzeNgramSaturation,
  analyzeFullRepetition,
  splitSentences,
  splitParagraphs,
  splitLines,
  segmentSimilarity,
} from './repetition.js';

export type {
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
} from './repetition.js';

export {
  // Keyword Coverage Scoring assertions (Tier 2 — Heuristic)
  toCoverKeyTopics,
  toHaveNoTopicGaps,
  toMeetKeywordScore,
  toHaveBalancedCoverage,
  toAddressTask,
  // Utilities
  extractKeyTerms,
  scoreKeywordCoverage,
  identifyTopicGaps,
} from './keyword-coverage.js';

export type {
  KeywordCoverageScoringOptions,
  ExtractedKeyword,
  KeywordCoverageScore,
  SectionCoverageResult,
  TopicGapOptions,
  TopicGap,
  TopicGapResult,
} from './keyword-coverage.js';

export {
  // Judge framework (Tier 3 — Shared-Substrate Judgment)
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
  // Assertion factories
  toPassJudge,
  toScoreOnCriterion,
  toHaveJudgeConfidence,
  toMeetAllCriteria,
  toHaveJudgeSuggestions,
  // Built-in rubrics
  BUILTIN_RUBRICS,
} from './judge.js';

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
} from './judge.js';

export {
  // Hallucination detection (Tier 1+2+3)
  extractClaims,
  verifyClaim,
  verifyClaims,
  analyzeHallucination,
  wordOverlap,
  findBestMatch,
  checkContradiction,
  HALLUCINATION_RUBRIC,
  // Assertion factories
  toNotHallucinate,
  toBeFullyGrounded,
  toNotContradict,
  toHaveHallucinationScoreBelow,
  toHaveGroundingAbove,
} from './hallucination.js';

export type {
  ExtractedClaim,
  ClaimKind,
  ClaimVerification,
  ClaimStatus,
  VerificationTier,
  ClaimExtractionOptions,
  VerificationOptions,
  HallucinationResult,
  HallucinationOptions,
} from './hallucination.js';
