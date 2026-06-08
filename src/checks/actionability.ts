/**
 * Actionability Judge — Tier 2+3 "Can a human act on this, or is it filler?"
 *
 * This module evaluates whether an agent's output provides concrete,
 * actionable information that a human can use to make a decision or take
 * a step forward. It catches common failure modes:
 *
 * - Vague platitudes ("consider best practices", "ensure quality")
 * - Hedge-heavy non-answers ("it depends", "there are many approaches")
 * - Restating the question without answering it
 * - Generic advice unanchored to the specific task/context
 * - Missing concrete details (no paths, no code, no steps, no examples)
 *
 * Architecture:
 * - Tier 2 (heuristic): Sentence-level signal extraction — imperative verbs,
 *   specificity markers, hedge detection, concreteness scoring
 * - Tier 3 (judge): Structured rubric evaluation for subjective actionability
 *   when heuristics are insufficient
 *
 * Key design decision: Actionability is task-type-dependent. A code review
 * needs specific file/line references; a summary needs key facts; a how-to
 * needs numbered steps. The module classifies the expected response type
 * and applies type-appropriate scoring.
 *
 * @tier mixed (2+3)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  JudgeBackend,
  Rubric,
  JudgeOptions,
} from './judge.js';
import {
  buildRubric,
  JudgeEvaluator,
} from './judge.js';

// ═══ TYPES ═══════════════════════════════════════════════════════════════════════

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

// ═══ CONSTANTS ═══════════════════════════════════════════════════════════════════

/** Words/phrases that signal hedging — lack of commitment to a recommendation. */
const HEDGE_PATTERNS: readonly RegExp[] = [
  /\b(?:might|could|may|perhaps|possibly|potentially)\s+(?:want to|consider|look into|try)\b/i,
  /\b(?:it depends|depends on (?:your|the) (?:situation|context|needs|requirements))\b/i,
  /\bthere are (?:many|several|various|numerous|different) (?:ways|approaches|options|methods)\b/i,
  /\byou (?:might|could|may) (?:want to|wish to)\b/i,
  /\b(?:generally|typically|usually|often|sometimes) (?:it's|it is) (?:recommended|advised|suggested)\b/i,
  /\b(?:in some cases|in certain situations|under certain circumstances)\b/i,
  /\bone (?:approach|option|way|method) (?:would be|could be|is) to\b/i,
];

/** Platitudes — empty advice that sounds wise but provides no direction. */
const PLATITUDE_PATTERNS: readonly RegExp[] = [
  /\b(?:ensure|make sure) (?:you follow|to follow) best practices\b/i,
  /\b(?:maintain|ensure) (?:code )?quality\b/i,
  /\btest (?:your code )?thoroughly\b/i,
  /\b(?:keep|maintain) (?:your |the )?code (?:clean|readable|maintainable)\b/i,
  /\b(?:always|remember to) (?:document|comment) (?:your )?code\b/i,
  /\b(?:follow|adhere to|stick to) (?:the )?(?:SOLID|DRY|KISS|YAGNI) (?:principle|pattern)s?\b/i,
  /\b(?:consider|think about) (?:the )?(?:edge cases|error handling|performance)\b/i,
  /\buse (?:appropriate|proper|correct|suitable) (?:tools|methods|techniques)\b/i,
  /\b(?:it is|it's) important to\b/i,
];

/** Weasel words — vague quantifiers that avoid specifics. */
const WEASEL_PATTERNS: readonly RegExp[] = [
  /\b(?:some|many|various|numerous|several|a number of) (?:people|developers|teams|users|experts)\b/i,
  /\b(?:some|many|various|numerous|several) (?:ways|approaches|methods|options|tools|frameworks)\b/i,
  /\b(?:significant|substantial|considerable|notable)\b/i,
  /\bresearch (?:shows|suggests|indicates)\b/i,
  /\b(?:it is|it's) (?:well-known|widely accepted|generally agreed)\b/i,
];

/** Patterns that signal concrete, specific actionable content. */
const IMPERATIVE_PATTERN = /^(?:run|execute|install|create|add|remove|delete|move|copy|rename|update|change|set|configure|enable|disable|open|close|start|stop|build|deploy|push|pull|merge|commit|checkout|navigate|click|type|enter|import|export|replace|modify|use|apply|initialize|call|invoke|write|read|check|verify|test|debug|log|print|throw|catch|return|define|declare|implement|extend|override|refactor|extract|inline|split|join|wrap|unwrap)\b/i;

const CODE_SNIPPET_PATTERN = /```[\s\S]*?```|`[^`]+`/;

const FILE_REFERENCE_PATTERN = /(?:(?:\.\/|\.\.\/|\/|[A-Z]:\\|~\/)[^\s,;)]+|(?:src|lib|test|config|dist|build|node_modules)\/[^\s,;)]+|\b[\w-]+\.(?:ts|js|tsx|jsx|py|rs|go|java|json|yaml|yml|toml|md|html|css|sql|sh|bash|zsh)\b)/;

const COMMAND_PATTERN = /(?:npm|npx|yarn|pnpm|pip|cargo|go|dotnet|mvn|gradle|make|docker|kubectl|git|apt|brew|choco|curl|wget)\s+\S+/;

const URL_PATTERN = /https?:\/\/[^\s)>]+/;

const STEP_PATTERN = /^(?:\d+[\.\)]\s|step\s+\d+)/im;

const SPECIFIC_VALUE_PATTERN = /(?:\b(?:port|version|timeout|limit|max|min|size|count|length|width|height|depth|level|priority|threshold|interval|delay|retries?)\s*(?:=|:|\bis\b)\s*\d+|\b\d+(?:\.\d+)?(?:ms|s|m|h|px|rem|em|%|MB|GB|KB)\b|`[A-Z_][A-Z0-9_]*`|\b0x[0-9a-f]+\b)/i;

// ═══ RESPONSE TYPE DETECTION ═════════════════════════════════════════════════════

/**
 * Infer the expected response type from the task/prompt.
 *
 * @param task - The original task given to the agent
 * @returns The most likely response type
 */
export function detectResponseType(task: string): ResponseType {
  const lower = task.toLowerCase();

  // Code review patterns
  if (/\b(?:review|pr|pull request|code review|diff|changes?)\b/.test(lower) &&
      /\b(?:review|check|look at|feedback|comments?)\b/.test(lower)) {
    return 'code-review';
  }

  // How-to patterns
  if (/\b(?:how (?:to|do|can)|steps? to|guide|tutorial|walkthrough|set ?up|configure|install)\b/.test(lower)) {
    return 'how-to';
  }

  // Fix patterns
  if (/\b(?:fix|resolve|debug|troubleshoot|repair|patch|solve|workaround)\b/.test(lower)) {
    return 'fix';
  }

  // Summary patterns
  if (/\b(?:summarize|summary|tldr|overview|brief|digest|recap)\b/.test(lower)) {
    return 'summary';
  }

  // Decision patterns
  if (/\b(?:which|should i|compare|trade-?offs?|pros? and cons?|recommend|choose|pick|select|decision)\b/.test(lower)) {
    return 'decision';
  }

  // Explanation patterns
  if (/\b(?:explain|what (?:is|are)|why (?:does|is|are)|describe|clarify|elaborate)\b/.test(lower)) {
    return 'explanation';
  }

  return 'general';
}

/**
 * Response type weights — what matters most for each type.
 */
const RESPONSE_TYPE_WEIGHTS: Record<ResponseType, {
  imperative: number;
  specificity: number;
  examples: number;
  completeness: number;
}> = {
  'code-review': { imperative: 0.3, specificity: 0.4, examples: 0.2, completeness: 0.1 },
  'how-to':      { imperative: 0.4, specificity: 0.2, examples: 0.2, completeness: 0.2 },
  'explanation': { imperative: 0.1, specificity: 0.3, examples: 0.4, completeness: 0.2 },
  'fix':         { imperative: 0.3, specificity: 0.3, examples: 0.3, completeness: 0.1 },
  'summary':     { imperative: 0.1, specificity: 0.4, examples: 0.2, completeness: 0.3 },
  'decision':    { imperative: 0.2, specificity: 0.3, examples: 0.2, completeness: 0.3 },
  'general':     { imperative: 0.25, specificity: 0.3, examples: 0.25, completeness: 0.2 },
};

// ═══ SENTENCE SPLITTING ══════════════════════════════════════════════════════════

/**
 * Split output into sentences with offset tracking.
 * Handles code blocks as atomic units.
 */
export function splitIntoSentences(text: string): Array<{ text: string; startOffset: number; endOffset: number }> {
  const results: Array<{ text: string; startOffset: number; endOffset: number }> = [];

  // First, protect code blocks by replacing them with placeholders
  const codeBlocks: Array<{ text: string; start: number; end: number }> = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // If there are code blocks, treat them as separate "sentences"
  let pos = 0;
  for (const block of codeBlocks) {
    // Process text before this code block
    if (pos < block.start) {
      const before = text.slice(pos, block.start);
      splitPlainText(before, pos, results);
    }
    // Add the code block as a single sentence
    const trimmed = block.text.trim();
    if (trimmed.length > 0) {
      results.push({ text: trimmed, startOffset: block.start, endOffset: block.end });
    }
    pos = block.end;
  }

  // Process remaining text after last code block
  if (pos < text.length) {
    const remaining = text.slice(pos);
    splitPlainText(remaining, pos, results);
  }

  return results.filter((s) => s.text.trim().length > 0);
}

function splitPlainText(
  text: string,
  baseOffset: number,
  results: Array<{ text: string; startOffset: number; endOffset: number }>,
): void {
  // Split on sentence boundaries: period/exclamation/question followed by space or end,
  // OR on newlines (each line is a sentence in technical content)
  const sentenceRegex = /[^.!?\n]+(?:[.!?](?:\s|$)|\n|$)/g;
  let m: RegExpExecArray | null;

  while ((m = sentenceRegex.exec(text)) !== null) {
    const trimmed = m[0].trim();
    if (trimmed.length > 0) {
      results.push({
        text: trimmed,
        startOffset: baseOffset + m.index,
        endOffset: baseOffset + m.index + m[0].length,
      });
    }
  }
}

// ═══ ELEMENT EXTRACTION ══════════════════════════════════════════════════════════

/**
 * Extract actionable elements from a sentence.
 */
export function extractActionableElements(
  sentence: string,
  sentenceOffset: number,
  additionalMarkers?: RegExp[],
): ActionableElement[] {
  const elements: ActionableElement[] = [];

  // Check for imperative verbs at start of sentence (or after bullet/number)
  const stripped = sentence.replace(/^(?:\d+[.)]\s*|[-*•]\s*|>\s*)/, '');
  if (IMPERATIVE_PATTERN.test(stripped)) {
    elements.push({
      text: sentence,
      kind: 'imperative',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
      specificity: 0.7,
    });
  }

  // Code snippets
  const codeMatches = sentence.matchAll(/```[\s\S]*?```|`([^`]+)`/g);
  for (const cm of codeMatches) {
    elements.push({
      text: cm[0],
      kind: 'code-snippet',
      startOffset: sentenceOffset + (cm.index ?? 0),
      endOffset: sentenceOffset + (cm.index ?? 0) + cm[0].length,
      specificity: 0.9,
    });
  }

  // File references
  const fileMatches = sentence.matchAll(new RegExp(FILE_REFERENCE_PATTERN.source, 'gi'));
  for (const fm of fileMatches) {
    elements.push({
      text: fm[0],
      kind: 'file-reference',
      startOffset: sentenceOffset + (fm.index ?? 0),
      endOffset: sentenceOffset + (fm.index ?? 0) + fm[0].length,
      specificity: 0.85,
    });
  }

  // Shell commands
  const cmdMatches = sentence.matchAll(new RegExp(COMMAND_PATTERN.source, 'gi'));
  for (const cmd of cmdMatches) {
    elements.push({
      text: cmd[0],
      kind: 'command',
      startOffset: sentenceOffset + (cmd.index ?? 0),
      endOffset: sentenceOffset + (cmd.index ?? 0) + cmd[0].length,
      specificity: 0.9,
    });
  }

  // URL references
  const urlMatches = sentence.matchAll(new RegExp(URL_PATTERN.source, 'g'));
  for (const url of urlMatches) {
    elements.push({
      text: url[0],
      kind: 'url-reference',
      startOffset: sentenceOffset + (url.index ?? 0),
      endOffset: sentenceOffset + (url.index ?? 0) + url[0].length,
      specificity: 0.8,
    });
  }

  // Numbered steps
  if (STEP_PATTERN.test(sentence)) {
    elements.push({
      text: sentence,
      kind: 'step',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
      specificity: 0.6,
    });
  }

  // Specific values (port numbers, timeouts, versions, etc.)
  const valueMatches = sentence.matchAll(new RegExp(SPECIFIC_VALUE_PATTERN.source, 'gi'));
  for (const vm of valueMatches) {
    elements.push({
      text: vm[0],
      kind: 'specific-value',
      startOffset: sentenceOffset + (vm.index ?? 0),
      endOffset: sentenceOffset + (vm.index ?? 0) + vm[0].length,
      specificity: 0.75,
    });
  }

  // Decision points — "Option A: ... Option B: ..." or "If X, then Y"
  if (/\b(?:option [a-c]|alternative|instead|if .+?, (?:then|you (?:should|can)))\b/i.test(sentence)) {
    elements.push({
      text: sentence,
      kind: 'decision-point',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
      specificity: 0.6,
    });
  }

  // Examples with concrete content
  if (/\b(?:for example|e\.g\.|such as|like this)\b/i.test(sentence) && sentence.length > 30) {
    elements.push({
      text: sentence,
      kind: 'example',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
      specificity: 0.65,
    });
  }

  // Check additional specificity markers
  if (additionalMarkers) {
    for (const marker of additionalMarkers) {
      if (marker.test(sentence)) {
        elements.push({
          text: sentence,
          kind: 'specific-value',
          startOffset: sentenceOffset,
          endOffset: sentenceOffset + sentence.length,
          specificity: 0.7,
        });
      }
    }
  }

  return elements;
}

// ═══ FILLER DETECTION ════════════════════════════════════════════════════════════

/**
 * Detect filler patterns in a sentence.
 */
export function detectFiller(
  sentence: string,
  sentenceOffset: number,
  taskText?: string,
  additionalHedges?: RegExp[],
): FillerPattern[] {
  const patterns: FillerPattern[] = [];

  // Check hedge patterns
  for (const pattern of HEDGE_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match) {
      patterns.push({
        text: match[0],
        kind: 'hedge',
        startOffset: sentenceOffset + (match.index ?? 0),
        endOffset: sentenceOffset + (match.index ?? 0) + match[0].length,
      });
    }
  }

  // Check platitude patterns
  for (const pattern of PLATITUDE_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match) {
      patterns.push({
        text: match[0],
        kind: 'platitude',
        startOffset: sentenceOffset + (match.index ?? 0),
        endOffset: sentenceOffset + (match.index ?? 0) + match[0].length,
      });
    }
  }

  // Check weasel words
  for (const pattern of WEASEL_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match) {
      patterns.push({
        text: match[0],
        kind: 'weasel-word',
        startOffset: sentenceOffset + (match.index ?? 0),
        endOffset: sentenceOffset + (match.index ?? 0) + match[0].length,
      });
    }
  }

  // Check for restatement of the task
  if (taskText && taskText.length > 10) {
    const taskWords = new Set(
      taskText.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
    );
    const sentenceWords = sentence.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (sentenceWords.length > 0) {
      const overlap = sentenceWords.filter((w) => taskWords.has(w)).length / sentenceWords.length;
      if (overlap > 0.6 && sentenceWords.length > 4) {
        patterns.push({
          text: sentence,
          kind: 'restatement',
          startOffset: sentenceOffset,
          endOffset: sentenceOffset + sentence.length,
        });
      }
    }
  }

  // Generic advice detection — short sentences with no specifics
  if (
    sentence.length < 80 &&
    !CODE_SNIPPET_PATTERN.test(sentence) &&
    !FILE_REFERENCE_PATTERN.test(sentence) &&
    !URL_PATTERN.test(sentence) &&
    !SPECIFIC_VALUE_PATTERN.test(sentence) &&
    /\b(?:always|never|remember|make sure|be sure|don't forget)\b/i.test(sentence)
  ) {
    patterns.push({
      text: sentence,
      kind: 'generic-advice',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
    });
  }

  // Circular reasoning — sentence that restates its own concept
  if (/\b(?:the (?:solution|answer|fix|way) (?:is|would be) to (?:solve|answer|fix|find))\b/i.test(sentence)) {
    patterns.push({
      text: sentence,
      kind: 'circular',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
    });
  }

  // Non-answer: acknowledges multiple options without committing
  if (
    /\bthere are (?:many|several|various|multiple|different)\b/i.test(sentence) &&
    !/\bbut (?:I|we) recommend\b/i.test(sentence) &&
    !/\bthe best (?:option|approach|way)\b/i.test(sentence)
  ) {
    patterns.push({
      text: sentence,
      kind: 'non-answer',
      startOffset: sentenceOffset,
      endOffset: sentenceOffset + sentence.length,
    });
  }

  // Additional hedge patterns from options
  if (additionalHedges) {
    for (const pattern of additionalHedges) {
      const match = pattern.exec(sentence);
      if (match) {
        patterns.push({
          text: match[0],
          kind: 'hedge',
          startOffset: sentenceOffset + (match.index ?? 0),
          endOffset: sentenceOffset + (match.index ?? 0) + match[0].length,
        });
      }
    }
  }

  return patterns;
}

// ═══ SENTENCE SCORING ════════════════════════════════════════════════════════════

/**
 * Score a sentence for actionability.
 *
 * The score is based on:
 * - Number and quality of actionable elements (+)
 * - Number of filler patterns (-)
 * - Length (very short sentences are less likely to be actionable)
 */
export function scoreSentence(
  sentence: string,
  actionableElements: ActionableElement[],
  fillerPatterns: FillerPattern[],
  responseType: ResponseType,
): number {
  if (sentence.trim().length === 0) return 0;

  const weights = RESPONSE_TYPE_WEIGHTS[responseType];

  // Base score from actionable elements
  let actionScore = 0;
  if (actionableElements.length > 0) {
    // Take the highest specificity element as the primary signal
    const maxSpecificity = Math.max(...actionableElements.map((e) => e.specificity));
    // Diminishing returns for multiple elements
    const countBonus = Math.min(0.2, (actionableElements.length - 1) * 0.05);
    actionScore = maxSpecificity + countBonus;
  }

  // Penalty from filler
  let fillerPenalty = 0;
  for (const filler of fillerPatterns) {
    switch (filler.kind) {
      case 'restatement':
        fillerPenalty += 0.4;
        break;
      case 'circular':
        fillerPenalty += 0.5;
        break;
      case 'non-answer':
        fillerPenalty += 0.35;
        break;
      case 'platitude':
        fillerPenalty += 0.3;
        break;
      case 'hedge':
        fillerPenalty += 0.2;
        break;
      case 'generic-advice':
        fillerPenalty += 0.25;
        break;
      case 'weasel-word':
        fillerPenalty += 0.15;
        break;
    }
  }
  fillerPenalty = Math.min(0.8, fillerPenalty); // Cap penalty

  // Compute weighted score based on response type
  const hasImperative = actionableElements.some((e) => e.kind === 'imperative' || e.kind === 'command' || e.kind === 'step');
  const hasSpecificity = actionableElements.some((e) => e.kind === 'file-reference' || e.kind === 'specific-value' || e.kind === 'code-snippet');
  const hasExample = actionableElements.some((e) => e.kind === 'example' || e.kind === 'code-snippet');

  const imperativeContrib = hasImperative ? weights.imperative : 0;
  const specificityContrib = hasSpecificity ? weights.specificity : 0;
  const exampleContrib = hasExample ? weights.examples : 0;

  // Combine: base action score weighted by type priorities
  const typeWeightedScore = actionScore > 0
    ? 0.4 * actionScore + 0.6 * (imperativeContrib + specificityContrib + exampleContrib)
    : 0;

  // Final score: positive signal minus penalties, clamped to [0, 1]
  const raw = typeWeightedScore - fillerPenalty;
  return Math.max(0, Math.min(1, raw));
}

// ═══ MAIN ANALYSIS ═══════════════════════════════════════════════════════════════

/**
 * Analyze the actionability of an agent's output.
 *
 * @param output - The agent's output text
 * @param options - Configuration for the analysis
 * @returns Full actionability analysis result
 */
export function analyzeActionability(
  output: string,
  options: ActionabilityOptions = {},
): ActionabilityResult {
  const minScore = options.minScore ?? 0.4;
  const minActionableRatio = options.minActionableRatio ?? 0.3;
  const taskText = options.taskText;

  // Handle empty output
  if (!output || output.trim().length === 0) {
    return {
      score: 0,
      detectedResponseType: options.responseType ?? 'general',
      sentences: [],
      actionableElements: [],
      fillerPatterns: [],
      actionableRatio: 0,
      fillerRatio: 0,
      specificityScore: 0,
      summary: 'Output is empty — nothing to act on.',
      pass: false,
      confidence: 1.0,
    };
  }

  // Detect response type from task (or use provided)
  const responseType = options.responseType ?? (taskText ? detectResponseType(taskText) : 'general');

  // Split into sentences
  const rawSentences = splitIntoSentences(output);

  // Analyze each sentence
  const sentences: SentenceAnalysis[] = [];
  const allActionableElements: ActionableElement[] = [];
  const allFillerPatterns: FillerPattern[] = [];

  for (const raw of rawSentences) {
    const actionableElements = extractActionableElements(
      raw.text,
      raw.startOffset,
      options.additionalSpecificityMarkers,
    );
    const fillerPatterns = detectFiller(
      raw.text,
      raw.startOffset,
      taskText,
      options.additionalHedges,
    );

    const score = scoreSentence(raw.text, actionableElements, fillerPatterns, responseType);

    sentences.push({
      text: raw.text,
      startOffset: raw.startOffset,
      endOffset: raw.endOffset,
      score,
      actionableElements,
      fillerPatterns,
      isActionable: score >= 0.3,
    });

    allActionableElements.push(...actionableElements);
    allFillerPatterns.push(...fillerPatterns);
  }

  // Compute aggregate metrics
  const actionableSentences = sentences.filter((s) => s.isActionable);
  const fillerSentences = sentences.filter((s) => s.fillerPatterns.length > 0 && !s.isActionable);
  const actionableRatio = sentences.length > 0 ? actionableSentences.length / sentences.length : 0;
  const fillerRatio = sentences.length > 0 ? fillerSentences.length / sentences.length : 0;

  // Specificity score: average specificity of all actionable elements
  const specificityScore = allActionableElements.length > 0
    ? allActionableElements.reduce((sum, e) => sum + e.specificity, 0) / allActionableElements.length
    : 0;

  // Overall score combines multiple signals
  const avgSentenceScore = sentences.length > 0
    ? sentences.reduce((sum, s) => sum + s.score, 0) / sentences.length
    : 0;

  const overallScore = Math.max(0, Math.min(1,
    0.4 * avgSentenceScore +
    0.3 * actionableRatio +
    0.2 * specificityScore +
    0.1 * (1 - fillerRatio),
  ));

  // Confidence: higher when we have clear signal (many sentences, clear patterns)
  const confidence = Math.min(1.0, 0.5 + sentences.length * 0.05 + allActionableElements.length * 0.02);

  // Generate summary
  const summary = generateSummary(overallScore, actionableRatio, fillerRatio, specificityScore, responseType, allActionableElements, allFillerPatterns);

  return {
    score: overallScore,
    detectedResponseType: responseType,
    sentences,
    actionableElements: allActionableElements,
    fillerPatterns: allFillerPatterns,
    actionableRatio,
    fillerRatio,
    specificityScore,
    summary,
    pass: overallScore >= minScore && actionableRatio >= minActionableRatio,
    confidence,
  };
}

/**
 * Generate a human-readable summary of the actionability analysis.
 */
function generateSummary(
  score: number,
  actionableRatio: number,
  fillerRatio: number,
  specificityScore: number,
  responseType: ResponseType,
  actionableElements: ActionableElement[],
  fillerPatterns: FillerPattern[],
): string {
  const parts: string[] = [];

  parts.push(`Actionability: ${(score * 100).toFixed(0)}% (response type: ${responseType})`);

  if (actionableRatio > 0.5) {
    parts.push(`${(actionableRatio * 100).toFixed(0)}% of sentences are actionable.`);
  } else if (actionableRatio < 0.2) {
    parts.push(`Only ${(actionableRatio * 100).toFixed(0)}% of sentences are actionable — mostly filler.`);
  }

  if (fillerRatio > 0.4) {
    const fillerKinds = new Set(fillerPatterns.map((f) => f.kind));
    parts.push(`High filler ratio (${(fillerRatio * 100).toFixed(0)}%): ${[...fillerKinds].join(', ')}.`);
  }

  if (specificityScore > 0.7) {
    parts.push('References are highly specific (files, code, values).');
  } else if (specificityScore < 0.3 && actionableElements.length > 0) {
    parts.push('References lack specificity — vague pointers rather than concrete details.');
  }

  // Type-specific observations
  const elementKinds = new Set(actionableElements.map((e) => e.kind));
  if (responseType === 'code-review' && !elementKinds.has('file-reference')) {
    parts.push('Code review lacks file/line references.');
  }
  if (responseType === 'how-to' && !elementKinds.has('step') && !elementKinds.has('imperative')) {
    parts.push('How-to lacks numbered steps or clear instructions.');
  }
  if (responseType === 'fix' && !elementKinds.has('code-snippet') && !elementKinds.has('command')) {
    parts.push('Fix suggestion lacks code or commands to implement.');
  }

  return parts.join(' ');
}

// ═══ RUBRIC ═════════════════════════════════════════════════════════════════════

/**
 * Built-in rubric for Tier 3 actionability judging.
 * Used when heuristic scoring is ambiguous (confidence < 0.6).
 */
export const ACTIONABILITY_RUBRIC: Rubric = buildRubric('Actionability')
  .describe(
    'Evaluates whether an agent\'s output provides concrete, actionable information ' +
    'that a human can use to make a decision or take a next step. ' +
    'The judge evaluates ONLY the output artifact — not the agent\'s intent or reasoning.',
  )
  .passAt(0.55)
  .confidenceAt(0.6)
  .criterion('specificity', 'Does the output reference specific files, functions, values, or resources?')
    .weight(0.35)
    .level(1, 'No specifics', 'Only vague references: "the file", "the function", "a value"')
    .level(2, 'Some specifics', 'A few concrete names, but mostly vague')
    .level(3, 'Mostly specific', 'Most references are to named files, functions, or values')
    .level(4, 'Highly specific', 'Consistently names files, lines, functions, config keys, versions')
    .level(5, 'Precise', 'Every reference is exact — full paths, line numbers, code snippets')
    .done()
  .criterion('directness', 'Does the output provide clear directions or is it hedged/equivocating?')
    .weight(0.3)
    .level(1, 'All filler', 'Entirely hedged/vague: "you might consider", "it depends"')
    .level(2, 'Mostly hedged', 'Some direction mixed with heavy hedging')
    .level(3, 'Balanced', 'Clear direction given but with some unnecessary caveats')
    .level(4, 'Direct', 'Clear recommendations with minimal hedging')
    .level(5, 'Decisive', 'Unambiguous instructions — human can act immediately')
    .done()
  .criterion('next-steps', 'Does the output give the human a clear next action to take?')
    .weight(0.2)
    .level(1, 'No next step', 'Output ends without any suggested action')
    .level(2, 'Vague next step', '"You should look into this" without specifics')
    .level(3, 'General next step', 'Suggests an action but missing details on how')
    .level(4, 'Clear next step', 'States what to do next with enough detail to start')
    .level(5, 'Complete next steps', 'Full step-by-step plan, ready to execute')
    .done()
  .criterion('contextual-fit', 'Is the output tailored to the specific task, or is it generic advice?')
    .weight(0.15)
    .level(1, 'Generic', 'Could apply to any project/task — not tailored')
    .level(2, 'Somewhat tailored', 'Mentions the task topic but advice is generic')
    .level(3, 'Moderately tailored', 'References task-specific details in parts')
    .level(4, 'Well-tailored', 'Clearly written for this specific task/context')
    .level(5, 'Perfectly fitted', 'Every suggestion is grounded in the specific context provided')
    .done()
  .build();

// ═══ ASSERTION FACTORIES ════════════════════════════════════════════════════════

/**
 * Assert that the output is actionable — a human can take a concrete next step from it.
 *
 * Uses Tier 2 heuristic analysis (sentence-level signal extraction).
 *
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toBeActionable(options: ActionabilityOptions = {}): Assertion {
  return {
    name: '[Tier 2] output is actionable',
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        return {
          status: result.pass ? 'pass' : 'fail',
          name: '[Tier 2] output is actionable',
          message: result.pass ? undefined : `Actionability score ${(result.score * 100).toFixed(0)}% below threshold`,
          expected: `score >= ${((options.minScore ?? 0.4) * 100).toFixed(0)}%, actionable ratio >= ${((options.minActionableRatio ?? 0.3) * 100).toFixed(0)}%`,
          actual: `score = ${(result.score * 100).toFixed(0)}%, actionable ratio = ${(result.actionableRatio * 100).toFixed(0)}%`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 2] output is actionable',
          message: `Actionability check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output has minimal filler content.
 *
 * @param maxFillerRatio - Maximum allowed filler ratio (0–1). Default: 0.4
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toHaveMinimalFiller(
  maxFillerRatio = 0.4,
  options: ActionabilityOptions = {},
): Assertion {
  return {
    name: `[Tier 2] filler ratio <= ${(maxFillerRatio * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        const pass = result.fillerRatio <= maxFillerRatio;
        const fillerKinds = [...new Set(result.fillerPatterns.map((f) => f.kind))];

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 2] filler ratio <= ${(maxFillerRatio * 100).toFixed(0)}%`,
          message: pass ? undefined : `Filler ratio ${(result.fillerRatio * 100).toFixed(0)}% exceeds ${(maxFillerRatio * 100).toFixed(0)}%`,
          expected: `<= ${(maxFillerRatio * 100).toFixed(0)}%`,
          actual: `${(result.fillerRatio * 100).toFixed(0)}% (${result.fillerPatterns.length} patterns: ${fillerKinds.join(', ')})`,
          evidence: result.fillerPatterns.slice(0, 5).map((f) => `[${f.kind}] "${f.text.slice(0, 60)}"`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 2] filler ratio <= ${(maxFillerRatio * 100).toFixed(0)}%`,
          message: `Filler check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output achieves a minimum specificity score.
 *
 * Specificity measures how concrete the references are — files, code, values vs. vague pointers.
 *
 * @param minSpecificity - Minimum specificity score (0–1). Default: 0.5
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toBeSpecific(
  minSpecificity = 0.5,
  options: ActionabilityOptions = {},
): Assertion {
  return {
    name: `[Tier 2] specificity >= ${(minSpecificity * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        const pass = result.specificityScore >= minSpecificity;

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 2] specificity >= ${(minSpecificity * 100).toFixed(0)}%`,
          message: pass ? undefined : `Specificity ${(result.specificityScore * 100).toFixed(0)}% below ${(minSpecificity * 100).toFixed(0)}%`,
          expected: `>= ${(minSpecificity * 100).toFixed(0)}%`,
          actual: `${(result.specificityScore * 100).toFixed(0)}% (${result.actionableElements.length} actionable elements)`,
          evidence: result.actionableElements.slice(0, 5).map((e) => `[${e.kind}] "${e.text.slice(0, 60)}"`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 2] specificity >= ${(minSpecificity * 100).toFixed(0)}%`,
          message: `Specificity check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output meets actionability standards using a judge with the ACTIONABILITY_RUBRIC.
 *
 * Use this when Tier 2 heuristics produce ambiguous results (confidence < 0.6).
 *
 * @param backend - The judge backend (LLM or rule-based)
 * @param options - Judge options
 * @tier 3 — Shared-Substrate Judgment
 */
export function toPassActionabilityJudge(
  backend: JudgeBackend,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, ACTIONABILITY_RUBRIC, options);

  return {
    name: '[Tier 3] judge: actionability',
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const status = result.verdict === 'pass' ? 'pass'
          : result.verdict === 'needs-human-review' ? 'skip'
          : 'fail';

        const criteriaDetails = result.criterionScores
          .map((cs) => `${cs.criterionId}: ${cs.normalizedScore.toFixed(2)} (${cs.confidence})`)
          .join(', ');

        return {
          status,
          name: '[Tier 3] judge: actionability',
          message: status === 'pass'
            ? undefined
            : result.verdict === 'needs-human-review'
              ? `Judge confidence too low — needs human review`
              : `Actionability judge: fail (score=${result.overallScore.toFixed(2)})`,
          expected: `pass (>= ${options?.passThreshold ?? ACTIONABILITY_RUBRIC.passThreshold ?? 0.55})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)}, confidence=${result.confidenceValue.toFixed(2)})`,
          evidence: `Criteria: ${criteriaDetails}\nSummary: ${result.summary}`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 3] judge: actionability',
          message: `Judge evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output has a minimum actionability score.
 *
 * @param minScore - Minimum actionability score (0–1). Default: 0.4
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toHaveActionabilityAbove(
  minScore = 0.4,
  options: ActionabilityOptions = {},
): Assertion {
  return {
    name: `[Tier 2] actionability score >= ${(minScore * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        const pass = result.score >= minScore;

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 2] actionability score >= ${(minScore * 100).toFixed(0)}%`,
          message: pass ? undefined : `Score ${(result.score * 100).toFixed(0)}% below threshold ${(minScore * 100).toFixed(0)}%`,
          expected: `>= ${(minScore * 100).toFixed(0)}%`,
          actual: `${(result.score * 100).toFixed(0)}%`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 2] actionability score >= ${(minScore * 100).toFixed(0)}%`,
          message: `Score check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}