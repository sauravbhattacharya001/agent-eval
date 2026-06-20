/**
 * Completeness Checker — deterministic analysis engine (Tier 1)
 *
 * The stub/filler/truncation pattern tables, the pure text-analysis helpers, and
 * the two engine entry points the assertions build on:
 * - analyzeContent(text)            → ContentMetrics
 * - checkCompleteness(text, opts)   → CompletenessResult (all violations)
 *
 * All checks are deterministic — pure text analysis, no AI, no IO. The
 * assertion factories that wrap this engine live in the public barrel
 * (./completeness.js).
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type {
  ContentMetrics,
  CompletenessOptions,
  CompletenessViolation,
  CompletenessResult,
} from './completeness-types.js';

// ─── STUB PATTERNS ──────────────────────────────────────────────────────────────

/** Default patterns that indicate a stub or placeholder response. */
const DEFAULT_STUB_PATTERNS: RegExp[] = [
  // Common placeholder texts
  /^TODO\b/i,
  /^\[?\s*placeholder\s*]?$/im,
  /^\[?\s*insert\s+.+\s+here\s*]?$/im,
  /^lorem ipsum/i,
  // Empty code/content markers
  /^```\s*\n\s*\n```$/m,
  /^\s*\/\/\s*TODO\s*$/m,
  /^\s*#\s*TODO\s*$/m,
  // "I don't know" / refusal stubs
  /^I (?:cannot|can't|am unable to|don't have enough)/i,
  /^I'm (?:sorry|unable|not able)/i,
  // Ellipsis-only
  /^\s*\.{3,}\s*$/m,
  // Just whitespace or dashes
  /^[\s\-_=]+$/,
];

/** Default filler phrases that suggest low-substance output. */
const DEFAULT_FILLER_PHRASES: string[] = [
  'as an ai',
  'as a language model',
  'i hope this helps',
  'let me know if you need anything else',
  'feel free to ask',
  'is there anything else',
  'hope this is helpful',
  'happy to help',
  'does this make sense',
];

// ─── TRUNCATION MARKERS ─────────────────────────────────────────────────────────

/** Patterns that suggest output was truncated. */
const TRUNCATION_MARKERS: RegExp[] = [
  // Explicit truncation indicators
  /\[\.{3}\]$/,
  /\[truncated\]/i,
  /\[continued\]/i,
  /\[output truncated\]/i,
  /\.{3}$/,
  // Cut-off mid-word (line ends with incomplete word pattern)
  /\w{3,}-$/m,
  // Unfinished list (ends with list marker and nothing else)
  /^\s*[-*]\s*$/m,
  /^\s*\d+\.\s*$/m,
];

// ─── ANALYSIS FUNCTIONS ─────────────────────────────────────────────────────────

/**
 * Count sentences in text (heuristic: split on sentence-ending punctuation).
 */
function countSentences(text: string): number {
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
function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  return words.length;
}

/**
 * Count paragraphs (blocks separated by one or more blank lines).
 */
function countParagraphs(text: string): number {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  return paragraphs.length;
}

/**
 * Calculate unique word ratio.
 */
function uniqueWordRatio(text: string): number {
  const words = text.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

/**
 * Detect if output appears truncated.
 */
function detectTruncation(text: string): boolean {
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
function checkBalancedBrackets(text: string): { balanced: boolean; details: string } {
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
function findConsecutiveDuplicates(text: string): { maxRun: number; line: string } {
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
