/**
 * Actionability — sentence segmentation & signal extraction
 *
 * The heuristic (Tier 2) pass that turns raw output into structured signals:
 * code-block-aware sentence splitting, per-sentence actionable-element
 * extraction (imperatives, code, file/URL/command/value references, steps,
 * decision points, examples), and filler/hedge detection (platitudes, weasel
 * words, restatement, circular reasoning, non-answers). Extracted from
 * `actionability.ts`; the public functions are re-exported from
 * `./actionability.js` so the import path is unchanged.
 *
 * @tier 2 — Heuristic
 * @module
 */

import type {
  ActionableElement,
  FillerPattern,
} from './actionability-types.js';
import {
  HEDGE_PATTERNS,
  PLATITUDE_PATTERNS,
  WEASEL_PATTERNS,
  IMPERATIVE_PATTERN,
  CODE_SNIPPET_PATTERN,
  FILE_REFERENCE_PATTERN,
  COMMAND_PATTERN,
  URL_PATTERN,
  STEP_PATTERN,
  SPECIFIC_VALUE_PATTERN,
} from './actionability-patterns.js';

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
