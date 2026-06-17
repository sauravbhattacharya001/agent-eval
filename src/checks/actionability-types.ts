/**
 * Actionability — type vocabulary
 *
 * Pure type/interface definitions for the actionability check (Tier 2+3).
 * Extracted from `actionability.ts` so the type surface is testable and
 * importable without pulling in the regex tables, scoring engine, or the
 * Tier-3 judge wiring. Re-exported from `./actionability.js`, so consumers
 * keep a single public import path.
 *
 * @tier mixed (2+3)
 * @module
 */

/** The expected type of response, which affects scoring. */
export type ResponseType =
  | 'code-review'
  | 'how-to'
  | 'explanation'
  | 'fix'
  | 'summary'
  | 'decision'
  | 'general';

/** A single actionable element found in the output. */
export interface ActionableElement {
  /** The text fragment identified as actionable. */
  text: string;
  /** What kind of actionable signal this is. */
  kind: ActionableKind;
  /** Position in the output (character offset). */
  startOffset: number;
  /** End position. */
  endOffset: number;
  /** Specificity score for this element (0–1). */
  specificity: number;
}

/** Types of actionable signals we look for. */
export type ActionableKind =
  | 'imperative'      // Direct instruction: "Run npm install", "Delete the file"
  | 'code-snippet'    // Actual code that can be copy-pasted
  | 'file-reference'  // Points to specific file/path/line
  | 'step'            // Numbered/ordered step in a process
  | 'command'         // Shell command or CLI invocation
  | 'example'         // Concrete example illustrating a concept
  | 'decision-point'  // Clear option with tradeoffs laid out
  | 'specific-value'  // Concrete number, name, config value (not "a value")
  | 'url-reference';  // Link to specific resource

/** A detected filler/hedge pattern. */
export interface FillerPattern {
  /** The text that matched. */
  text: string;
  /** What kind of filler this is. */
  kind: FillerKind;
  /** Position in the output. */
  startOffset: number;
  /** End position. */
  endOffset: number;
}

/** Types of filler patterns. */
export type FillerKind =
  | 'hedge'           // "it might be", "you could consider", "perhaps"
  | 'platitude'       // "ensure quality", "follow best practices"
  | 'restatement'     // Repeating the task/question back
  | 'generic-advice'  // "test thoroughly", "document your code"
  | 'weasel-word'     // "some", "many", "various", "numerous"
  | 'circular'        // Defines X using X: "the solution is to solve it"
  | 'non-answer';     // "there are many ways to do this" without picking one

/** Result of analyzing a single sentence for actionability. */
export interface SentenceAnalysis {
  /** The sentence text. */
  text: string;
  /** Start offset in original output. */
  startOffset: number;
  /** End offset. */
  endOffset: number;
  /** Actionability score for this sentence (0–1). */
  score: number;
  /** Actionable elements found in this sentence. */
  actionableElements: ActionableElement[];
  /** Filler patterns found in this sentence. */
  fillerPatterns: FillerPattern[];
  /** Is this sentence actionable (score > threshold)? */
  isActionable: boolean;
}

/** Configuration for actionability analysis. */
export interface ActionabilityOptions {
  /** Expected response type (affects scoring weights). */
  responseType?: ResponseType;
  /** Minimum actionability score to pass (0–1). Default: 0.4 */
  minScore?: number;
  /** Minimum percentage of sentences that must be actionable. Default: 0.3 */
  minActionableRatio?: number;
  /** Whether to include the task text for restatement detection. */
  taskText?: string;
  /** Custom hedge patterns to add to the built-in list. */
  additionalHedges?: RegExp[];
  /** Custom specificity markers to add. */
  additionalSpecificityMarkers?: RegExp[];
}

/** Full result of actionability analysis. */
export interface ActionabilityResult {
  /** Overall actionability score (0–1). */
  score: number;
  /** Classification of the response type. */
  detectedResponseType: ResponseType;
  /** Per-sentence breakdown. */
  sentences: SentenceAnalysis[];
  /** All actionable elements found. */
  actionableElements: ActionableElement[];
  /** All filler patterns found. */
  fillerPatterns: FillerPattern[];
  /** Ratio of actionable sentences. */
  actionableRatio: number;
  /** Ratio of filler sentences. */
  fillerRatio: number;
  /** Specificity score — how concrete the references are (0–1). */
  specificityScore: number;
  /** Summary of findings. */
  summary: string;
  /** Does this pass at the configured threshold? */
  pass: boolean;
  /** Confidence in the result (0–1). */
  confidence: number;
}
