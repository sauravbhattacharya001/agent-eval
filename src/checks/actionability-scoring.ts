/**
 * Actionability — scoring engine
 *
 * Turns the extracted per-sentence signals into scores: a single-sentence
 * scorer weighted by response type, the top-level `analyzeActionability`
 * aggregator (per-sentence loop → ratios → overall score → confidence →
 * summary), and the internal human-readable summary builder. Extracted from
 * `actionability.ts` so the scoring math is isolated from the regex tables and
 * the Tier-3 judge wiring. Public functions are re-exported from
 * `./actionability.js`, so the import path is unchanged.
 *
 * @tier 2 — Heuristic
 * @module
 */

import type {
  ResponseType,
  ActionableElement,
  FillerPattern,
  SentenceAnalysis,
  ActionabilityOptions,
  ActionabilityResult,
} from './actionability-types.js';
import { detectResponseType, RESPONSE_TYPE_WEIGHTS } from './actionability-patterns.js';
import {
  splitIntoSentences,
  extractActionableElements,
  detectFiller,
} from './actionability-extraction.js';

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
