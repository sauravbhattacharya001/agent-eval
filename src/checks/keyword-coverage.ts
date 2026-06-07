/**
 * Keyword Coverage Scoring — Tier 2 Heuristic Check
 *
 * Automatically extracts key topics from a task prompt and scores how well
 * the agent's output covers them. Unlike Tier 1 constraint validation (which
 * checks explicit keyword lists), this module infers what should be mentioned
 * based on the task itself.
 *
 * Techniques used:
 * - Automatic key-term extraction from task text via TF-IDF weighting
 * - Weighted coverage scoring (more important terms count more)
 * - Stemming-based fuzzy matching (e.g. "configure" matches "configuration")
 * - Domain-aware grouping of related terms
 * - Section-level coverage analysis (where in the output was each topic addressed?)
 * - Gap identification (which important topics were completely missed?)
 *
 * @tier 2 — Heuristic (no AI, automatic topic extraction)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Configuration for keyword coverage scoring. */
export interface KeywordCoverageScoringOptions {
  /** Minimum coverage score (0–1) to pass. Default: 0.5 */
  minCoverage?: number;
  /** Maximum number of keywords to extract from task. Default: 15 */
  maxKeywords?: number;
  /** Minimum weight threshold for extracted keywords. Default: 0.05 */
  minKeywordWeight?: number;
  /** Whether to apply stemming for fuzzy matching. Default: true */
  useStemming?: boolean;
  /** Whether to include bigrams in key-term extraction. Default: true */
  useBigrams?: boolean;
  /** Custom stopwords to add beyond the built-in set. */
  extraStopwords?: string[];
  /** Additional keywords to inject (these will also be checked). */
  additionalKeywords?: string[];
  /** Whether to use weighted scoring (weight by importance). Default: true */
  useWeightedScoring?: boolean;
  /** Minimum keyword length in characters. Default: 3 */
  minKeywordLength?: number;
}

/** A keyword extracted from the task with its importance weight. */
export interface ExtractedKeyword {
  /** The keyword or bigram (original unstemmed form). */
  term: string;
  /** Normalized importance weight (0–1, highest = 1). */
  weight: number;
  /** The stemmed form used for matching. */
  stemmedForm: string;
  /** Whether this was found in the output. */
  covered: boolean;
  /** The matched text in the output (if covered). */
  matchedAs?: string;
  /** Character offset where first match was found (if covered). */
  matchOffset?: number;
}

/** Result of keyword coverage scoring. */
export interface KeywordCoverageScore {
  /** Overall coverage score (0–1). */
  score: number;
  /** Whether coverage meets the minimum threshold. */
  passing: boolean;
  /** The threshold used. */
  threshold: number;
  /** Total keywords extracted from task. */
  totalKeywords: number;
  /** Number of keywords found in output. */
  coveredCount: number;
  /** Number of keywords missed in output. */
  missedCount: number;
  /** Detailed per-keyword results, sorted by weight descending. */
  keywords: ExtractedKeyword[];
  /** Coverage broken down by output section (if output has sections). */
  sectionCoverage?: SectionCoverageResult[];
  /** Weighted score (accounts for keyword importance). */
  weightedScore: number;
  /** Unweighted score (simple ratio of found/total). */
  unweightedScore: number;
}

/** Coverage result for a single section of the output. */
export interface SectionCoverageResult {
  /** Section heading or identifier. */
  heading: string;
  /** Starting character offset. */
  startOffset: number;
  /** Keywords covered in this section. */
  keywordsCovered: string[];
  /** Coverage ratio for this section. */
  coverage: number;
}

/** Options for the topic gap analysis. */
export interface TopicGapOptions {
  /** The task text to extract expected topics from. */
  task?: string;
  /** Minimum importance for a gap to be flagged. Default: 0.3 */
  minGapImportance?: number;
  /** Maximum gaps to report. Default: 10 */
  maxGaps?: number;
}

/** A topic gap — an important task keyword not covered in output. */
export interface TopicGap {
  /** The missed keyword/topic. */
  term: string;
  /** How important this topic is (0–1). */
  importance: number;
  /** Why this is considered important (context from the task). */
  context: string;
}

/** Result of a topic gap analysis. */
export interface TopicGapResult {
  /** Number of important gaps identified. */
  gapCount: number;
  /** The gaps, sorted by importance. */
  gaps: TopicGap[];
  /** Overall gap severity (high/medium/low/none). */
  severity: 'high' | 'medium' | 'low' | 'none';
}

// ─── STOPWORDS ──────────────────────────────────────────────────────────────────

/** Common English stopwords that carry little semantic meaning. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'although',
  'though', 'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me',
  'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'whose', 'about',
  'also', 'am', 'any', 'anything', 'up', 'down', 'much',
  'don', 't', 's', 'll', 've', 're', 'd', 'm', 'etc', 'e', 'g',
  'make', 'write', 'create', 'build', 'generate', 'provide', 'give',
  'explain', 'describe', 'show', 'tell', 'help', 'please', 'want',
  'like', 'using', 'use', 'include', 'including', 'based',
]);

// ─── STEMMING ───────────────────────────────────────────────────────────────────

/**
 * Lightweight Porter-like stemmer.
 * Strips common English suffixes to normalize word forms.
 */
function stem(word: string): string {
  if (word.length <= 3) return word;

  let result = word;

  // Step 1: Plural/verb forms
  if (result.endsWith('ies') && result.length > 4) {
    result = result.slice(0, -3) + 'y';
  } else if (result.endsWith('sses')) {
    result = result.slice(0, -2);
  } else if (result.endsWith('ness')) {
    result = result.slice(0, -4);
  } else if (result.endsWith('ation') && result.length > 6) {
    result = result.slice(0, -5) + 'e';
  } else if (result.endsWith('ment') && result.length > 5) {
    result = result.slice(0, -4);
  } else if (result.endsWith('ing') && result.length > 5) {
    result = result.slice(0, -3);
    if (result.length > 2 && result[result.length - 1] === result[result.length - 2]) {
      result = result.slice(0, -1);
    }
  } else if (result.endsWith('tion') || result.endsWith('sion')) {
    result = result.slice(0, -3) + 'e';
  } else if (result.endsWith('able') || result.endsWith('ible')) {
    result = result.slice(0, -4);
  } else if (result.endsWith('ful')) {
    result = result.slice(0, -3);
  } else if (result.endsWith('ous') || result.endsWith('ive')) {
    result = result.slice(0, -3);
  } else if (result.endsWith('ly') && result.length > 4) {
    result = result.slice(0, -2);
  } else if (result.endsWith('ed') && result.length > 4) {
    result = result.slice(0, -2);
    if (result.length > 2 && result[result.length - 1] === result[result.length - 2]) {
      result = result.slice(0, -1);
    }
  } else if (result.endsWith('er') && result.length > 4) {
    result = result.slice(0, -2);
  } else if (result.endsWith('es') && result.length > 4) {
    result = result.slice(0, -2);
  } else if (result.endsWith('s') && !result.endsWith('ss') && result.length > 3) {
    result = result.slice(0, -1);
  }

  return result;
}

// ─── TOKENIZATION ───────────────────────────────────────────────────────────────

/**
 * Tokenize text into words, removing punctuation and normalizing.
 */
function tokenize(text: string, stopwords: Set<string>, minLength: number): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => {
      if (w.length < minLength) return false;
      if (stopwords.has(w)) return false;
      if (/^\d+$/.test(w) && w.length < 4) return false;
      return true;
    });
}

/**
 * Extract bigrams from a token array.
 */
function extractBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const current = tokens[i] ?? '';
    const next = tokens[i + 1] ?? '';
    // Skip bigrams where both parts are very short
    if (current.length >= 3 || next.length >= 3) {
      bigrams.push(`${current} ${next}`);
    }
  }
  return bigrams;
}

// ─── KEY-TERM EXTRACTION ────────────────────────────────────────────────────────

/**
 * Extract key terms from a task/prompt text using frequency-based weighting.
 * Returns terms sorted by importance (highest first), normalized so top weight = 1.
 */
export function extractKeyTerms(
  task: string,
  options: KeywordCoverageScoringOptions = {},
): ExtractedKeyword[] {
  const {
    maxKeywords = 15,
    minKeywordWeight = 0.05,
    useStemming = true,
    useBigrams = true,
    extraStopwords = [],
    additionalKeywords = [],
    minKeywordLength = 3,
  } = options;

  if (!task.trim()) return [];

  const stopwords = new Set([...STOPWORDS, ...extraStopwords.map((w) => w.toLowerCase())]);

  // Tokenize without stemming first to preserve original forms
  const rawTokens = tokenize(task, stopwords, minKeywordLength);
  const rawBigrams = useBigrams ? extractBigrams(rawTokens) : [];

  // Count raw frequencies
  const freq = new Map<string, number>();
  for (const token of rawTokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  for (const bigram of rawBigrams) {
    freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
  }

  // Build stemmed lookup (stemmed form -> original terms)
  const stemmedToOriginal = new Map<string, string>();
  if (useStemming) {
    for (const token of rawTokens) {
      const stemmed = stem(token);
      // Keep the longest/most common original form
      if (!stemmedToOriginal.has(stemmed) || token.length > (stemmedToOriginal.get(stemmed)?.length ?? 0)) {
        stemmedToOriginal.set(stemmed, token);
      }
    }
  }

  // Score each term
  const totalTokens = rawTokens.length + rawBigrams.length;
  if (totalTokens === 0) return [];

  const scored: Array<{ term: string; weight: number; stemmedForm: string }> = [];

  for (const [term, count] of freq) {
    const isBigram = term.includes(' ');
    // Weight factors:
    // 1. Frequency boost
    const freqScore = count / totalTokens;
    // 2. Bigram boost (phrases are more specific)
    const bigramBoost = isBigram ? 2.0 : 1.0;
    // 3. Length boost (longer terms are more specific)
    const lengthBoost = Math.min(term.length / 6, 2.0);
    // 4. Position boost (terms appearing early in the task are often more important)
    const firstIndex = task.toLowerCase().indexOf(term.toLowerCase());
    const positionBoost = firstIndex >= 0 ? 1.0 + 0.5 * (1 - firstIndex / task.length) : 1.0;

    const weight = freqScore * bigramBoost * lengthBoost * positionBoost;
    const stemmedForm = useStemming && !isBigram ? stem(term) : term;

    scored.push({ term, weight, stemmedForm });
  }

  // Add any additional keywords
  for (const kw of additionalKeywords) {
    const normalized = kw.toLowerCase().trim();
    if (normalized && !scored.some((s) => s.term === normalized)) {
      const stemmedForm = useStemming ? stem(normalized) : normalized;
      scored.push({ term: normalized, weight: 0.5, stemmedForm });
    }
  }

  // Sort by weight descending
  scored.sort((a, b) => b.weight - a.weight);

  // Deduplicate by stemmed form (keep highest weight variant)
  const seenStemmed = new Set<string>();
  const deduped: typeof scored = [];
  for (const item of scored) {
    if (!seenStemmed.has(item.stemmedForm)) {
      seenStemmed.add(item.stemmedForm);
      deduped.push(item);
    }
  }

  // Normalize weights (top = 1.0)
  const maxWeight = deduped[0]?.weight ?? 1;
  const normalized = deduped.map((item) => ({
    ...item,
    weight: item.weight / maxWeight,
  }));

  // Filter by minimum weight and limit count
  const filtered = normalized.filter((item) => item.weight >= minKeywordWeight);
  const limited = filtered.slice(0, maxKeywords);

  // Convert to ExtractedKeyword format
  return limited.map((item) => ({
    term: item.term,
    weight: item.weight,
    stemmedForm: item.stemmedForm,
    covered: false,
  }));
}

// ─── COVERAGE SCORING ───────────────────────────────────────────────────────────

/**
 * Check if a keyword is present in the output text.
 * Uses stemming-based fuzzy matching when enabled.
 */
function findKeywordInOutput(
  keyword: ExtractedKeyword,
  output: string,
  outputTokens: string[],
  outputStemmed: Map<string, { original: string; offset: number }>,
  useStemming: boolean,
): { found: boolean; matchedAs?: string; matchOffset?: number } {
  const isBigram = keyword.term.includes(' ');
  const normalizedOutput = output.toLowerCase();

  // Direct substring match first (exact or near-exact)
  const directIndex = normalizedOutput.indexOf(keyword.term.toLowerCase());
  if (directIndex >= 0) {
    return { found: true, matchedAs: keyword.term, matchOffset: directIndex };
  }

  // For bigrams, check if both words appear within proximity
  if (isBigram) {
    const parts = keyword.term.split(' ');
    const part0 = (parts[0] ?? '').toLowerCase();
    const part1 = (parts[1] ?? '').toLowerCase();
    const idx0 = normalizedOutput.indexOf(part0);
    const idx1 = normalizedOutput.indexOf(part1);
    if (idx0 >= 0 && idx1 >= 0 && Math.abs(idx0 - idx1) < 100) {
      return { found: true, matchedAs: `${part0}...${part1}`, matchOffset: Math.min(idx0, idx1) };
    }
  }

  // Stemming-based match
  if (useStemming && !isBigram) {
    const stemmedKeyword = keyword.stemmedForm;
    const match = outputStemmed.get(stemmedKeyword);
    if (match) {
      return { found: true, matchedAs: match.original, matchOffset: match.offset };
    }
  }

  // Token-level check (handles word boundary issues)
  if (!isBigram) {
    const keywordLower = keyword.term.toLowerCase();
    for (const token of outputTokens) {
      if (token === keywordLower) {
        const offset = normalizedOutput.indexOf(token);
        return { found: true, matchedAs: token, matchOffset: offset >= 0 ? offset : undefined };
      }
    }
  }

  return { found: false };
}

/**
 * Score keyword coverage of a task's key terms in the output.
 * Core analysis function — returns detailed coverage results.
 */
export function scoreKeywordCoverage(
  task: string,
  output: string,
  options: KeywordCoverageScoringOptions = {},
): KeywordCoverageScore {
  const {
    minCoverage = 0.5,
    useStemming = true,
    useWeightedScoring = true,
    minKeywordLength = 3,
    extraStopwords = [],
  } = options;

  // Handle empty inputs
  if (!task.trim() || !output.trim()) {
    return {
      score: 0,
      passing: false,
      threshold: minCoverage,
      totalKeywords: 0,
      coveredCount: 0,
      missedCount: 0,
      keywords: [],
      weightedScore: 0,
      unweightedScore: 0,
    };
  }

  // Extract key terms from task
  const keywords = extractKeyTerms(task, options);

  if (keywords.length === 0) {
    return {
      score: 1,
      passing: true,
      threshold: minCoverage,
      totalKeywords: 0,
      coveredCount: 0,
      missedCount: 0,
      keywords: [],
      weightedScore: 1,
      unweightedScore: 1,
    };
  }

  // Prepare output for matching
  const stopwords = new Set([...STOPWORDS, ...extraStopwords.map((w) => w.toLowerCase())]);
  const outputTokens = tokenize(output, stopwords, minKeywordLength);

  // Build stemmed index of output tokens with their offsets
  const outputStemmed = new Map<string, { original: string; offset: number }>();
  if (useStemming) {
    const normalizedOutput = output.toLowerCase();
    for (const token of outputTokens) {
      const stemmed = stem(token);
      if (!outputStemmed.has(stemmed)) {
        const offset = normalizedOutput.indexOf(token);
        outputStemmed.set(stemmed, { original: token, offset: offset >= 0 ? offset : 0 });
      }
    }
  }

  // Score each keyword
  let coveredCount = 0;
  let weightedCovered = 0;
  let totalWeight = 0;

  for (const keyword of keywords) {
    totalWeight += keyword.weight;
    const result = findKeywordInOutput(keyword, output, outputTokens, outputStemmed, useStemming);
    keyword.covered = result.found;
    keyword.matchedAs = result.matchedAs;
    keyword.matchOffset = result.matchOffset;

    if (result.found) {
      coveredCount++;
      weightedCovered += keyword.weight;
    }
  }

  const unweightedScore = keywords.length > 0 ? coveredCount / keywords.length : 1;
  const weightedScore = totalWeight > 0 ? weightedCovered / totalWeight : 1;
  const score = useWeightedScoring ? weightedScore : unweightedScore;

  // Section-level analysis
  const sectionCoverage = analyzeSectionCoverage(output, keywords);

  return {
    score,
    passing: score >= minCoverage,
    threshold: minCoverage,
    totalKeywords: keywords.length,
    coveredCount,
    missedCount: keywords.length - coveredCount,
    keywords,
    sectionCoverage: sectionCoverage.length > 1 ? sectionCoverage : undefined,
    weightedScore,
    unweightedScore,
  };
}

/**
 * Analyze which keywords are covered in each section of the output.
 */
function analyzeSectionCoverage(
  output: string,
  keywords: ExtractedKeyword[],
): SectionCoverageResult[] {
  // Split on markdown headings
  const sectionPattern = /^(#{1,6})\s+(.+)$/gm;
  const sections: { heading: string; content: string; startOffset: number }[] = [];

  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastHeading = '(introduction)';

  while ((match = sectionPattern.exec(output)) !== null) {
    if (lastIndex < match.index) {
      const content = output.slice(lastIndex, match.index).trim();
      if (content) {
        sections.push({ heading: lastHeading, content, startOffset: lastIndex });
      }
    }
    lastHeading = match[2] ?? '';
    lastIndex = match.index + match[0].length;
  }

  // Remaining content after last heading
  if (lastIndex < output.length) {
    const content = output.slice(lastIndex).trim();
    if (content) {
      sections.push({ heading: lastHeading, content, startOffset: lastIndex });
    }
  }

  if (sections.length <= 1) return [];

  // Check which keywords appear in each section
  return sections.map((section) => {
    const sectionLower = section.content.toLowerCase();
    const covered: string[] = [];

    for (const kw of keywords) {
      if (kw.covered) {
        // Check if the keyword's match is within this section
        const kwLower = kw.term.toLowerCase();
        if (sectionLower.includes(kwLower)) {
          covered.push(kw.term);
        } else if (kw.matchedAs) {
          // Check the matched form
          if (sectionLower.includes(kw.matchedAs.toLowerCase())) {
            covered.push(kw.term);
          }
        }
      }
    }

    return {
      heading: section.heading,
      startOffset: section.startOffset,
      keywordsCovered: covered,
      coverage: keywords.length > 0 ? covered.length / keywords.length : 1,
    };
  });
}

// ─── TOPIC GAP ANALYSIS ─────────────────────────────────────────────────────────

/**
 * Identify important topic gaps — task keywords the output completely missed.
 * Useful for understanding WHY an output failed keyword coverage.
 */
export function identifyTopicGaps(
  task: string,
  output: string,
  options: TopicGapOptions & KeywordCoverageScoringOptions = {},
): TopicGapResult {
  const { minGapImportance = 0.3, maxGaps = 10 } = options;

  const score = scoreKeywordCoverage(task, output, options);

  // Find keywords that are important but not covered
  const gaps: TopicGap[] = [];
  for (const kw of score.keywords) {
    if (!kw.covered && kw.weight >= minGapImportance) {
      // Find context around this term in the original task
      const context = extractTermContext(task, kw.term);
      gaps.push({
        term: kw.term,
        importance: kw.weight,
        context,
      });
    }
  }

  // Sort by importance
  gaps.sort((a, b) => b.importance - a.importance);
  const limitedGaps = gaps.slice(0, maxGaps);

  // Determine severity
  let severity: TopicGapResult['severity'];
  if (limitedGaps.length === 0) {
    severity = 'none';
  } else if (limitedGaps.some((g) => g.importance >= 0.8)) {
    severity = 'high';
  } else if (limitedGaps.some((g) => g.importance >= 0.5)) {
    severity = 'medium';
  } else {
    severity = 'low';
  }

  return {
    gapCount: limitedGaps.length,
    gaps: limitedGaps,
    severity,
  };
}

/**
 * Extract the surrounding context of a term in the task text.
 * Returns up to ~80 chars around the first occurrence.
 */
function extractTermContext(task: string, term: string): string {
  const lower = task.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx < 0) return `Expected topic: "${term}"`;

  const contextRadius = 40;
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(task.length, idx + term.length + contextRadius);

  let context = task.slice(start, end).trim();
  if (start > 0) context = '...' + context;
  if (end < task.length) context = context + '...';

  return context;
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that the output covers the key topics from the task prompt.
 * Automatically extracts important keywords from the task and checks
 * whether the output addresses them.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options with minCoverage.
 *   If a string, uses it as the task with default threshold (0.5).
 *   If options, uses context.prompt as the task.
 */
export function toCoverKeyTopics(
  taskOrOptions?: string | (KeywordCoverageScoringOptions & { task?: string }),
): Assertion {
  const opts: KeywordCoverageScoringOptions & { task?: string } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const minCoverage = opts.minCoverage ?? 0.5;

  return {
    name: `covers key topics (min: ${(minCoverage * 100).toFixed(0)}%)`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `covers key topics (min: ${(minCoverage * 100).toFixed(0)}%)`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = scoreKeywordCoverage(task, output, { ...opts, minCoverage });

      if (result.passing) {
        const covered = result.keywords.filter((k) => k.covered).slice(0, 5);
        return {
          status: 'pass',
          name: `covers key topics (min: ${(minCoverage * 100).toFixed(0)}%)`,
          evidence:
            `Coverage: ${(result.score * 100).toFixed(1)}% ` +
            `(${result.coveredCount}/${result.totalKeywords} keywords). ` +
            `Covered: ${covered.map((k) => k.term).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      const missed = result.keywords.filter((k) => !k.covered).slice(0, 5);
      return {
        status: 'fail',
        name: `covers key topics (min: ${(minCoverage * 100).toFixed(0)}%)`,
        message: 'Output does not sufficiently cover the key topics from the task',
        expected: `keyword coverage >= ${(minCoverage * 100).toFixed(0)}%`,
        actual: `${(result.score * 100).toFixed(1)}% (${result.coveredCount}/${result.totalKeywords})`,
        evidence: `Missing topics: ${missed.map((k) => `"${k.term}" (importance: ${(k.weight * 100).toFixed(0)}%)`).join(', ')}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output has no critical topic gaps.
 * Flags when high-importance task topics are completely missing.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options.
 */
export function toHaveNoTopicGaps(
  taskOrOptions?: string | (TopicGapOptions & KeywordCoverageScoringOptions & { task?: string }),
): Assertion {
  const opts: TopicGapOptions & KeywordCoverageScoringOptions & { task?: string } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const minGapImportance = opts.minGapImportance ?? 0.3;

  return {
    name: `no critical topic gaps (importance >= ${(minGapImportance * 100).toFixed(0)}%)`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `no critical topic gaps (importance >= ${(minGapImportance * 100).toFixed(0)}%)`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = identifyTopicGaps(task, output, { ...opts, minGapImportance });

      if (result.severity === 'none') {
        return {
          status: 'pass',
          name: `no critical topic gaps (importance >= ${(minGapImportance * 100).toFixed(0)}%)`,
          evidence: 'All important task topics are covered in the output',
          durationMs: performance.now() - start,
        };
      }

      const topGaps = result.gaps.slice(0, 5);
      return {
        status: 'fail',
        name: `no critical topic gaps (importance >= ${(minGapImportance * 100).toFixed(0)}%)`,
        message: `${result.gapCount} important topic(s) not addressed (severity: ${result.severity})`,
        expected: 'all topics with importance >= threshold covered',
        actual: `${result.gapCount} gaps: ${topGaps.map((g) => `"${g.term}"`).join(', ')}`,
        evidence: topGaps.map((g) => `"${g.term}" (${(g.importance * 100).toFixed(0)}%): ${g.context}`).join('; '),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output meets a minimum weighted keyword score.
 * Unlike toCoverKeyTopics which uses automatic extraction defaults,
 * this allows injecting a custom keyword list for domain-specific checks.
 *
 * @tier 2 — Heuristic
 * @param keywords - Explicit keywords to check, or options.
 */
export function toMeetKeywordScore(
  keywordsOrOptions: string[] | (KeywordCoverageScoringOptions & { task?: string }),
): Assertion {
  const opts: KeywordCoverageScoringOptions & { task?: string } = Array.isArray(keywordsOrOptions)
    ? { additionalKeywords: keywordsOrOptions }
    : keywordsOrOptions;

  const minCoverage = opts.minCoverage ?? 0.6;

  return {
    name: `keyword score >= ${(minCoverage * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task && (!opts.additionalKeywords || opts.additionalKeywords.length === 0)) {
        return {
          status: 'error',
          name: `keyword score >= ${(minCoverage * 100).toFixed(0)}%`,
          message: 'No task/prompt or additionalKeywords provided',
          durationMs: performance.now() - start,
        };
      }

      const result = scoreKeywordCoverage(task, output, { ...opts, minCoverage });

      if (result.passing) {
        return {
          status: 'pass',
          name: `keyword score >= ${(minCoverage * 100).toFixed(0)}%`,
          evidence:
            `Weighted score: ${(result.weightedScore * 100).toFixed(1)}%, ` +
            `Unweighted: ${(result.unweightedScore * 100).toFixed(1)}% ` +
            `(${result.coveredCount}/${result.totalKeywords})`,
          durationMs: performance.now() - start,
        };
      }

      const missed = result.keywords.filter((k) => !k.covered).slice(0, 5);
      return {
        status: 'fail',
        name: `keyword score >= ${(minCoverage * 100).toFixed(0)}%`,
        message: 'Keyword coverage below threshold',
        expected: `weighted score >= ${(minCoverage * 100).toFixed(0)}%`,
        actual: `${(result.weightedScore * 100).toFixed(1)}%`,
        evidence: `Missing: ${missed.map((k) => k.term).join(', ')}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that all sections of a multi-section output contribute to task coverage.
 * Flags outputs where some sections are completely off-topic relative to the task.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options.
 */
export function toHaveBalancedCoverage(
  taskOrOptions?: string | (KeywordCoverageScoringOptions & { task?: string; minSectionCoverage?: number }),
): Assertion {
  const opts: KeywordCoverageScoringOptions & { task?: string; minSectionCoverage?: number } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const minSectionCoverage = opts.minSectionCoverage ?? 0.1;

  return {
    name: `balanced section coverage (min per section: ${(minSectionCoverage * 100).toFixed(0)}%)`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `balanced section coverage (min per section: ${(minSectionCoverage * 100).toFixed(0)}%)`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = scoreKeywordCoverage(task, output, opts);

      if (!result.sectionCoverage || result.sectionCoverage.length <= 1) {
        // Single section or no sections — pass by default (nothing to balance)
        return {
          status: 'pass',
          name: `balanced section coverage (min per section: ${(minSectionCoverage * 100).toFixed(0)}%)`,
          evidence: 'Output is a single section — balanced by default',
          durationMs: performance.now() - start,
        };
      }

      const lowSections = result.sectionCoverage.filter((s) => s.coverage < minSectionCoverage);

      if (lowSections.length === 0) {
        const avgCoverage =
          result.sectionCoverage.reduce((sum, s) => sum + s.coverage, 0) /
          result.sectionCoverage.length;
        return {
          status: 'pass',
          name: `balanced section coverage (min per section: ${(minSectionCoverage * 100).toFixed(0)}%)`,
          evidence:
            `All ${result.sectionCoverage.length} sections contribute to task coverage. ` +
            `Average section coverage: ${(avgCoverage * 100).toFixed(1)}%`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `balanced section coverage (min per section: ${(minSectionCoverage * 100).toFixed(0)}%)`,
        message: `${lowSections.length} section(s) have insufficient task coverage`,
        expected: `each section >= ${(minSectionCoverage * 100).toFixed(0)}% keyword coverage`,
        actual: `${lowSections.length}/${result.sectionCoverage.length} sections below threshold`,
        evidence: lowSections
          .map((s) => `"${s.heading}" (${(s.coverage * 100).toFixed(1)}%)`)
          .join(', '),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output covers key topics with combined weighted+gap analysis.
 * A comprehensive check combining coverage scoring with gap identification.
 * Stricter than toCoverKeyTopics alone — fails if either coverage is low
 * OR there are critical gaps in important topics.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options.
 */
export function toAddressTask(
  taskOrOptions?: string | (KeywordCoverageScoringOptions & TopicGapOptions & { task?: string }),
): Assertion {
  const opts: KeywordCoverageScoringOptions & TopicGapOptions & { task?: string } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const minCoverage = opts.minCoverage ?? 0.4;
  const minGapImportance = opts.minGapImportance ?? 0.5;

  return {
    name: `addresses task (coverage: ${(minCoverage * 100).toFixed(0)}%, no gaps >= ${(minGapImportance * 100).toFixed(0)}%)`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `addresses task (coverage: ${(minCoverage * 100).toFixed(0)}%, no gaps >= ${(minGapImportance * 100).toFixed(0)}%)`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const coverageResult = scoreKeywordCoverage(task, output, { ...opts, minCoverage });
      const gapResult = identifyTopicGaps(task, output, { ...opts, minGapImportance });

      const coveragePass = coverageResult.score >= minCoverage;
      const gapsPass = gapResult.severity === 'none' || gapResult.severity === 'low';
      const pass = coveragePass && gapsPass;

      if (pass) {
        const covered = coverageResult.keywords.filter((k) => k.covered).slice(0, 5);
        return {
          status: 'pass',
          name: `addresses task (coverage: ${(minCoverage * 100).toFixed(0)}%, no gaps >= ${(minGapImportance * 100).toFixed(0)}%)`,
          evidence:
            `Coverage: ${(coverageResult.score * 100).toFixed(1)}%. ` +
            `Gaps: ${gapResult.gapCount} (severity: ${gapResult.severity}). ` +
            `Key topics: ${covered.map((k) => k.term).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      const reasons: string[] = [];
      if (!coveragePass) {
        reasons.push(`Coverage too low: ${(coverageResult.score * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(0)}%`);
      }
      if (!gapsPass) {
        const topGaps = gapResult.gaps.slice(0, 3).map((g) => `"${g.term}"`).join(', ');
        reasons.push(`Critical gaps: ${topGaps} (severity: ${gapResult.severity})`);
      }

      return {
        status: 'fail',
        name: `addresses task (coverage: ${(minCoverage * 100).toFixed(0)}%, no gaps >= ${(minGapImportance * 100).toFixed(0)}%)`,
        message: 'Output does not adequately address the task',
        expected: `coverage >= ${(minCoverage * 100).toFixed(0)}% AND no critical gaps`,
        actual: reasons.join('; '),
        evidence: reasons.join('. '),
        durationMs: performance.now() - start,
      };
    },
  };
}