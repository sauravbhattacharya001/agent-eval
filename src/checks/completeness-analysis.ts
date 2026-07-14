/**
 * Completeness Checker — deterministic policy engine (Tier 1)
 *
 * The `checkCompleteness` entry point the assertions build on: it runs
 * `analyzeContent` and then applies the empty/stub/length/substance/structure
 * policy to produce a `CompletenessResult` (all violations).
 *
 * The pattern tables and pure text-analysis primitives live in their own seams
 * and are re-exported here so the engine keeps a single `./completeness-analysis.js`
 * import path:
 * - `./completeness-patterns.js` — stub / filler / truncation tables
 * - `./completeness-metrics.js`  — counting helpers + analyzeContent / detectStub
 *
 * All checks are deterministic — pure text analysis, no AI, no IO. The
 * assertion factories that wrap this engine live in the public barrel
 * (./completeness.js).
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type {
  CompletenessOptions,
  CompletenessViolation,
  CompletenessResult,
} from './completeness-types.js';
import { DEFAULT_FILLER_PHRASES } from './completeness-patterns.js';
import {
  analyzeContent,
  detectStub,
  checkBalancedBrackets,
  findConsecutiveDuplicates,
} from './completeness-metrics.js';

// Re-export the analysis primitives so the engine's import path stays stable.
export { analyzeContent, detectStub } from './completeness-metrics.js';

/**
 * Run a full completeness check on output.
 */
export function checkCompleteness(text: string, options?: CompletenessOptions): CompletenessResult {
  const metrics = analyzeContent(text);
  const violations: CompletenessViolation[] = [];
  const trimmed = text.trim();

  // ─── Empty check ────────────────────────────────────────────────────────────
  if (trimmed.length === 0) {
    violations.push({
      category: 'empty',
      message: 'Output is empty',
      severity: 'error',
    });
    return { complete: false, metrics, violations };
  }

  // ─── Stub detection ─────────────────────────────────────────────────────────
  if (detectStub(text, options?.substance?.stubPatterns)) {
    violations.push({
      category: 'substance',
      message: 'Output appears to be a stub or placeholder',
      severity: 'error',
    });
  }

  // ─── Length range checks ────────────────────────────────────────────────────
  const length = options?.length;
  if (length) {
    if (length.minChars !== undefined && metrics.charCount < length.minChars) {
      violations.push({
        category: 'length',
        message: `Character count ${metrics.charCount} below minimum ${length.minChars}`,
        severity: 'error',
      });
    }
    if (length.maxChars !== undefined && metrics.charCount > length.maxChars) {
      violations.push({
        category: 'length',
        message: `Character count ${metrics.charCount} exceeds maximum ${length.maxChars}`,
        severity: 'error',
      });
    }
    if (length.minWords !== undefined && metrics.wordCount < length.minWords) {
      violations.push({
        category: 'length',
        message: `Word count ${metrics.wordCount} below minimum ${length.minWords}`,
        severity: 'error',
      });
    }
    if (length.maxWords !== undefined && metrics.wordCount > length.maxWords) {
      violations.push({
        category: 'length',
        message: `Word count ${metrics.wordCount} exceeds maximum ${length.maxWords}`,
        severity: 'error',
      });
    }
    if (length.minLines !== undefined && metrics.lineCount < length.minLines) {
      violations.push({
        category: 'length',
        message: `Line count ${metrics.lineCount} below minimum ${length.minLines}`,
        severity: 'error',
      });
    }
    if (length.maxLines !== undefined && metrics.lineCount > length.maxLines) {
      violations.push({
        category: 'length',
        message: `Line count ${metrics.lineCount} exceeds maximum ${length.maxLines}`,
        severity: 'error',
      });
    }
    if (length.minSentences !== undefined && metrics.sentenceCount < length.minSentences) {
      violations.push({
        category: 'length',
        message: `Sentence count ${metrics.sentenceCount} below minimum ${length.minSentences}`,
        severity: 'error',
      });
    }
    if (length.maxSentences !== undefined && metrics.sentenceCount > length.maxSentences) {
      violations.push({
        category: 'length',
        message: `Sentence count ${metrics.sentenceCount} exceeds maximum ${length.maxSentences}`,
        severity: 'error',
      });
    }
    if (length.minParagraphs !== undefined && metrics.paragraphCount < length.minParagraphs) {
      violations.push({
        category: 'length',
        message: `Paragraph count ${metrics.paragraphCount} below minimum ${length.minParagraphs}`,
        severity: 'error',
      });
    }
    if (length.maxParagraphs !== undefined && metrics.paragraphCount > length.maxParagraphs) {
      violations.push({
        category: 'length',
        message: `Paragraph count ${metrics.paragraphCount} exceeds maximum ${length.maxParagraphs}`,
        severity: 'error',
      });
    }
  }

  // ─── Substance checks ──────────────────────────────────────────────────────
  const substance = options?.substance;
  const minUniqueRatio = substance?.minUniqueWordRatio ?? 0.3;
  const maxDupLines = substance?.maxConsecutiveDuplicateLines ?? 3;
  const minAvgWords = substance?.minAvgWordsPerSentence ?? 3;

  if (metrics.wordCount > 10 && metrics.uniqueWordRatio < minUniqueRatio) {
    violations.push({
      category: 'substance',
      message: `Unique word ratio ${metrics.uniqueWordRatio.toFixed(2)} below minimum ${minUniqueRatio} (excessive repetition)`,
      severity: 'warning',
    });
  }

  const { maxRun, line } = findConsecutiveDuplicates(text);
  if (maxRun > maxDupLines) {
    violations.push({
      category: 'substance',
      message: `${maxRun} consecutive duplicate lines detected: "${line.slice(0, 60)}${line.length > 60 ? '...' : ''}"`,
      severity: 'warning',
    });
  }

  if (metrics.sentenceCount > 2 && metrics.avgWordsPerSentence < minAvgWords) {
    violations.push({
      category: 'substance',
      message: `Average words per sentence (${metrics.avgWordsPerSentence.toFixed(1)}) below minimum ${minAvgWords}`,
      severity: 'warning',
    });
  }

  // Check for filler phrases
  const fillerPhrases = substance?.fillerPhrases ?? DEFAULT_FILLER_PHRASES;
  const lowerText = text.toLowerCase();
  const foundFillers = fillerPhrases.filter(phrase => lowerText.includes(phrase));
  if (foundFillers.length >= 3) {
    violations.push({
      category: 'substance',
      message: `High filler phrase density (${foundFillers.length} found): "${foundFillers.slice(0, 3).join('", "')}"`,
      severity: 'warning',
    });
  }

  // ─── Structural completeness ───────────────────────────────────────────────
  const structure = options?.structure;
  const checkBrackets = structure?.checkBalancedBrackets ?? true;
  const checkTrunc = structure?.checkTruncation ?? true;
  const checkEnding = structure?.checkIncompleteEnding ?? true;

  if (checkBrackets) {
    const bracketResult = checkBalancedBrackets(text);
    if (!bracketResult.balanced) {
      violations.push({
        category: 'structure',
        message: `Unbalanced brackets: ${bracketResult.details}`,
        severity: 'warning',
      });
    }
  }

  if (checkTrunc && metrics.isTruncated) {
    violations.push({
      category: 'truncation',
      message: 'Output appears truncated (ends with truncation marker)',
      severity: 'error',
    });
  }

  if (checkEnding) {
    // Check if the output ends mid-sentence (for prose output > 50 words)
    if (metrics.wordCount > 50) {
      const lastLine = trimmed.split('\n').filter(l => l.trim().length > 0).pop() ?? '';
      const endsWithPunct = /[.!?:;)\]}`"']$/.test(lastLine.trim());
      const isListItem = /^[-*•]\s/.test(lastLine.trim()) || /^\d+[.)]\s/.test(lastLine.trim());
      const isHeading = /^#{1,6}\s/.test(lastLine.trim());
      const isCodeBlock = /^```/.test(lastLine.trim());

      if (!endsWithPunct && !isListItem && !isHeading && !isCodeBlock) {
        violations.push({
          category: 'truncation',
          message: 'Output may be incomplete (last line does not end with sentence-ending punctuation)',
          severity: 'warning',
        });
      }
    }
  }

  // Required patterns
  if (structure?.requiredPatterns) {
    const missing = structure.requiredPatterns.filter(p => !p.test(text));
    if (missing.length > 0) {
      violations.push({
        category: 'structure',
        message: `Missing ${missing.length} required content pattern(s)`,
        severity: 'error',
      });
    }
  }

  // Forbidden patterns
  if (structure?.forbiddenPatterns) {
    const found = structure.forbiddenPatterns.filter(p => p.test(text));
    if (found.length > 0) {
      violations.push({
        category: 'structure',
        message: `Found ${found.length} forbidden content pattern(s)`,
        severity: 'error',
      });
    }
  }

  // Determine overall completeness
  const hasErrors = violations.some(v => v.severity === 'error');
  return { complete: !hasErrors, metrics, violations };
}
