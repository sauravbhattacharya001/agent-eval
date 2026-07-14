/**
 * Completeness Checker — text-analysis metrics (Tier 1)
 *
 * The pure text-analysis helpers and the `analyzeContent` entry point that turns
 * raw output into a `ContentMetrics` snapshot, plus the stub/truncation
 * detectors that read from the pattern tables. Split out from the analysis
 * engine so the counting/detection primitives have one home and
 * `checkCompleteness` reads as policy over metrics.
 *
 * All functions are deterministic — pure text analysis, no AI, no IO.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { ContentMetrics } from './completeness-types.js';
import { DEFAULT_STUB_PATTERNS, TRUNCATION_MARKERS } from './completeness-patterns.js';

// ─── ANALYSIS FUNCTIONS ─────────────────────────────────────────────────────────

/**
 * Count sentences in text (heuristic: split on sentence-ending punctuation).
 */
export function countSentences(text: string): number {
  // Match sentence endings: period, exclamation, question mark
  // Avoid counting abbreviations (e.g., U.S.A., Dr., etc.)
  const cleaned = text
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\./gi, 'ABBR')
    .replace(/\d+\.\d+/g, 'NUM') // decimals
    .replace(/\.{2,}/g, 'ELLIPSIS'); // ellipsis
  const matches = cleaned.match(/[.!?]+(?:\s|$)/g);
  return matches ? matches.length : (text.trim().length > 0 ? 1 : 0);
}

/**
 * Count words in text.
 */
export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  return words.length;
}

/**
 * Count paragraphs (blocks separated by one or more blank lines).
 */
export function countParagraphs(text: string): number {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  return paragraphs.length;
}

/**
 * Calculate unique word ratio.
 */
export function uniqueWordRatio(text: string): number {
  const words = text.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

/**
 * Detect if output appears truncated.
 */
export function detectTruncation(text: string): boolean {
  const trimmed = text.trimEnd();
  return TRUNCATION_MARKERS.some(marker => marker.test(trimmed));
}

/**
 * Detect if output is a stub/placeholder.
 */
export function detectStub(text: string, extraPatterns?: RegExp[]): boolean {
  const trimmed = text.trim();

  // Very short output (< 20 chars) that isn't a deliberate short answer
  if (trimmed.length < 20 && !trimmed.match(/^(yes|no|true|false|\d+)$/i)) {
    return true;
  }

  // Check default patterns
  for (const pattern of DEFAULT_STUB_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Check extra patterns
  if (extraPatterns) {
    for (const pattern of extraPatterns) {
      if (pattern.test(trimmed)) return true;
    }
  }

  return false;
}

/**
 * Check for balanced brackets/braces/parentheses.
 */
export function checkBalancedBrackets(text: string): { balanced: boolean; details: string } {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    // Track string literals (skip bracket matching inside strings)
    if ((char === '"' || char === "'" || char === '`') && (i === 0 || text[i - 1] !== '\\')) {
      if (inString && char === stringChar) {
        inString = false;
      } else if (!inString) {
        inString = true;
        stringChar = char;
      }
      continue;
    }
    if (inString) continue;

    if (char in pairs) {
      stack.push(pairs[char] as string);
    } else if (char === ')' || char === ']' || char === '}') {
      if (stack.length === 0) {
        return { balanced: false, details: `Unexpected closing '${char}' at position ${i}` };
      }
      const expected = stack.pop();
      if (expected !== char) {
        return { balanced: false, details: `Expected '${expected}' but found '${char}' at position ${i}` };
      }
    }
  }

  if (stack.length > 0) {
    return { balanced: false, details: `Unclosed brackets: expected ${stack.reverse().map(c => `'${c}'`).join(', ')}` };
  }

  return { balanced: true, details: '' };
}

/**
 * Check for consecutive duplicate lines (looping detection).
 */
export function findConsecutiveDuplicates(text: string): { maxRun: number; line: string } {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let maxRun = 1;
  let maxLine = '';
  let currentRun = 1;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === lines[i - 1]) {
      currentRun++;
      if (currentRun > maxRun) {
        maxRun = currentRun;
        maxLine = lines[i] as string;
      }
    } else {
      currentRun = 1;
    }
  }

  return { maxRun, line: maxLine };
}

// ─── MAIN ANALYSIS ──────────────────────────────────────────────────────────────

/**
 * Analyze output for content metrics.
 */
export function analyzeContent(text: string): ContentMetrics {
  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  const words = countWords(text);
  const sentences = countSentences(text);

  return {
    charCount: text.length,
    wordCount: words,
    lineCount: lines.length,
    nonEmptyLineCount: nonEmptyLines.length,
    sentenceCount: sentences,
    paragraphCount: countParagraphs(text),
    uniqueWordRatio: uniqueWordRatio(text),
    avgWordsPerSentence: sentences > 0 ? words / sentences : 0,
    isTruncated: detectTruncation(text),
    isStub: detectStub(text),
  };
}
