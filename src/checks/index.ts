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
