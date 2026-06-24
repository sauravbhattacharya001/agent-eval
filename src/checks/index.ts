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

export {
  // Drift Judge (Tier 3 — Shared-Substrate Judgment)
  decomposeTask,
  segmentOutput,
  mapRequirementsToSegments,
  detectDriftIssues,
  analyzeDrift,
  DRIFT_RUBRIC,
  // Assertion factories
  toNotDrift,
  toAddressRequirements,
  toHaveDriftBelow,
  toNotExhibitDrift,
  toPassDriftJudge,
} from './drift.js';

export type {
  TaskRequirement,
  OutputSegment,
  DriftKind,
  DriftIssue,
  DriftAnalysisOptions,
  DriftAnalysisResult,
} from './drift.js';

export {
  // Calibration system (Tier 3 — Meta-evaluation)
  calibrate,
  buildCalibrationSet,
  CalibrationSetBuilder,
  CalibrationExampleBuilder,
  detectDrift,
} from './calibration.js';

export type {
  CalibrationExample,
  CalibrationSet,
  CriterionCalibration,
  CriterionDelta,
  CalibrationReport,
  CalibrationOptions,
  CalibrationSnapshot,
  DriftResult,
} from './calibration.js';

export {
  // Actionability judge (Tier 2+3 — Heuristic + Shared-Substrate Judgment)
  detectResponseType,
  splitIntoSentences,
  extractActionableElements,
  detectFiller,
  scoreSentence,
  analyzeActionability,
  ACTIONABILITY_RUBRIC,
  // Assertion factories
  toBeActionable,
  toHaveMinimalFiller,
  toBeSpecific,
  toPassActionabilityJudge,
  toHaveActionabilityAbove,
} from './actionability.js';

export type {
  ResponseType,
  ActionableElement,
  ActionableKind,
  FillerPattern,
  FillerKind,
  SentenceAnalysis,
  ActionabilityOptions,
  ActionabilityResult,
} from './actionability.js';

export {
  // Consensus/Adversarial judging (Tier 3 — Enhanced Judgment)
  runConsensus,
  AdversarialJudge,
  CrossModelJudge,
  toPassConsensusJudge,
  toPassAdversarialJudge,
} from './consensus.js';

export type {
  ConsensusOptions,
  ConsensusResult,
  CriterionAgreement,
  AdversarialOptions,
  CrossModelOptions,
} from './consensus.js';

export {
  // Confidence Labeling (Tier 3 — Meta-evaluation)
  extractSelfReportedConfidence,
  extractEvidenceQuality,
  extractScoreConsistency,
  extractBoundaryProximity,
  extractCoverageCompleteness,
  extractReasoningQuality,
  assessConfidence,
  labelVerdict,
  ConfidenceAwareJudge,
  // Assertion factories
  toPassWithConfidence,
  toHaveAdequateConfidence,
  toHaveNoConfidenceFlags,
  toNotBeOverridden,
} from './confidence.js';

export type {
  ConfidenceSignal,
  ConfidenceSignalId,
  ConfidenceAssessment,
  ConfidenceRecommendation,
  ConfidenceLabelingOptions,
  LabeledVerdict,
} from './confidence.js';

export {
  // Behavioural footprint (Section F, slice 2 — Tier 1+2, PROOF only)
  analyzeFootprint,
  // Proof-only predicates
  toCompleteWithinSteps,
  toHaveToolErrorRateBelow,
  toNotThrash,
  toRecoverFromErrors,
} from './trace-footprint.js';

export type {
  FootprintOptions,
  FootprintResult,
  ToolOutcome,
} from './trace-footprint.js';

export {
  // Claim↔proof cross-check (Section F, slice 3 — Tier 1+2, PROOF only)
  crossCheckClaims,
  // Proof-anchored predicates
  toHaveNoContradictedClaims,
  toHaveClaimIntegrityAtLeast,
  toHaveInstrumentationGapsAtMost,
} from './trace-claim-check.js';

export type {
  ClaimCheck,
  ClaimCheckOptions,
  ClaimCheckResult,
  ClaimSource,
  ClaimVerdict,
} from './trace-claim-check.js';
