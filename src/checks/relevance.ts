/**
 * Embedding-based Relevance — Tier 2 Heuristic Check
 *
 * Measures semantic relevance between a task prompt and agent output using
 * lightweight text vectorization techniques (TF-IDF + cosine similarity).
 * No LLM calls required — works entirely offline.
 *
 * Techniques used:
 * - TF-IDF term weighting (term frequency × inverse document frequency)
 * - N-gram extraction (unigrams + bigrams) for capturing phrase-level meaning
 * - Cosine similarity between weighted term vectors
 * - Topic extraction via keyword frequency analysis
 * - Section-level relevance scoring for long outputs
 *
 * @tier 2 — Lightweight Heuristic (no AI, high signal)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Configuration for relevance analysis. */
export interface RelevanceOptions {
  /** Minimum cosine similarity threshold to pass (0–1). Default: 0.2 */
  threshold?: number;
  /** Whether to include bigrams in vectorization. Default: true */
  useBigrams?: boolean;
  /** Custom stopwords to add beyond the built-in set. */
  extraStopwords?: string[];
  /** Whether to apply stemming (Porter-like suffix stripping). Default: true */
  useStemming?: boolean;
  /** Minimum term frequency in a document to be included. Default: 1 */
  minTermFrequency?: number;
  /** Maximum portion of documents a term can appear in (IDF filter). Default: 0.95 */
  maxDocumentFrequency?: number;
}

/** Result of relevance analysis between two texts. */
export interface RelevanceResult {
  /** Cosine similarity score (0–1). */
  score: number;
  /** Whether the score meets the threshold. */
  relevant: boolean;
  /** The threshold used for the check. */
  threshold: number;
  /** Top shared terms contributing to similarity. */
  sharedTerms: ScoredTerm[];
  /** Terms present in task but missing from output. */
  missingTerms: ScoredTerm[];
  /** Terms in output that are unrelated to the task. */
  extraTerms: ScoredTerm[];
  /** Section-level scores (if output has multiple sections). */
  sectionScores?: SectionRelevance[];
}

/** A term with its weight/importance score. */
export interface ScoredTerm {
  /** The term or bigram. */
  term: string;
  /** TF-IDF weight or contribution to similarity. */
  weight: number;
}

/** Relevance score for a specific section of the output. */
export interface SectionRelevance {
  /** Section heading or identifier. */
  heading: string;
  /** Relevance score for this section (0–1). */
  score: number;
  /** Starting character index in output. */
  startIndex: number;
}

/** Configuration for topic extraction. */
export interface TopicExtractionOptions {
  /** Maximum number of topics to extract. Default: 10 */
  maxTopics?: number;
  /** Minimum weight threshold for a topic. Default: 0.01 */
  minWeight?: number;
  /** Whether to include bigrams as topic candidates. Default: true */
  includeBigrams?: boolean;
}

/** An extracted topic with its weight. */
export interface ExtractedTopic {
  /** The topic term or phrase. */
  term: string;
  /** Normalized importance weight (0–1). */
  weight: number;
  /** Number of occurrences in the text. */
  frequency: number;
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
  'also', 'am', 'an', 'any', 'anything', 'up', 'down', 'much',
  'don', 't', 's', 'll', 've', 're', 'd', 'm', 'etc', 'e', 'g',
]);

// ─── STEMMING ───────────────────────────────────────────────────────────────────

/**
 * Lightweight Porter-like stemmer.
 * Strips common English suffixes to normalize word forms.
 * Not as thorough as a full Porter stemmer but sufficient for relevance scoring.
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
  } else if (result.endsWith('ing') && result.length > 5) {
    result = result.slice(0, -3);
    // Handle doubling: running -> runn -> run
    if (result.length > 2 && result[result.length - 1] === result[result.length - 2]) {
      result = result.slice(0, -1);
    }
  } else if (result.endsWith('tion') || result.endsWith('sion')) {
    result = result.slice(0, -3) + 'e';
  } else if (result.endsWith('ment') && result.length > 5) {
    result = result.slice(0, -4);
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
 * Tokenize text into normalized terms.
 * - Lowercases
 * - Removes punctuation and special characters
 * - Splits on whitespace and hyphens
 * - Filters out stopwords and very short tokens
 * - Optionally applies stemming
 */
function tokenize(
  text: string,
  options: { stopwords?: Set<string>; useStemming?: boolean } = {},
): string[] {
  const { stopwords = STOPWORDS, useStemming = true } = options;

  // Normalize: lowercase, replace non-alpha with spaces
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ').filter((w) => {
    if (w.length < 2) return false;
    if (stopwords.has(w)) return false;
    // Filter pure numbers unless they look meaningful (4+ digits like years)
    if (/^\d+$/.test(w) && w.length < 4) return false;
    return true;
  });

  if (useStemming) {
    return words.map(stem);
  }
  return words;
}

/**
 * Extract bigrams from a token array.
 */
function extractBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

// ─── TF-IDF VECTORIZATION ───────────────────────────────────────────────────────

/** A document's term frequency map. */
type TermVector = Map<string, number>;

/**
 * Compute term frequency for a document.
 * Returns a map of term -> frequency (normalized by document length).
 */
function computeTf(tokens: string[]): TermVector {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  // Normalize by total token count
  const total = tokens.length;
  if (total === 0) return freq;

  const tf = new Map<string, number>();
  for (const [term, count] of freq) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * Compute IDF (inverse document frequency) across a corpus.
 * IDF = log(N / df) where N is total docs and df is docs containing the term.
 */
function computeIdf(documents: TermVector[]): Map<string, number> {
  const docCount = documents.length;
  const docFreq = new Map<string, number>();

  for (const doc of documents) {
    for (const term of doc.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    // Smooth IDF to avoid division by zero and reduce extreme weights
    idf.set(term, Math.log((docCount + 1) / (df + 1)) + 1);
  }
  return idf;
}

/**
 * Compute TF-IDF vector for a document given IDF weights.
 */
function computeTfIdf(tf: TermVector, idf: Map<string, number>): TermVector {
  const tfidf = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = idf.get(term) ?? 1;
    tfidf.set(term, tfVal * idfVal);
  }
  return tfidf;
}

/**
 * Compute cosine similarity between two term vectors.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function cosineSimilarity(vecA: TermVector, vecB: TermVector): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // Compute dot product (only for terms in both vectors)
  for (const [term, weightA] of vecA) {
    const weightB = vecB.get(term);
    if (weightB !== undefined) {
      dotProduct += weightA * weightB;
    }
    normA += weightA * weightA;
  }

  for (const [, weightB] of vecB) {
    normB += weightB * weightB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// ─── RELEVANCE ANALYSIS ─────────────────────────────────────────────────────────

/**
 * Vectorize text into a TF-IDF term vector.
 * Can be used standalone for custom similarity computations.
 */
export function vectorize(
  text: string,
  corpus: string[],
  options: RelevanceOptions = {},
): TermVector {
  const { useBigrams = true, extraStopwords = [], useStemming = true } = options;

  const stopwords = new Set([...STOPWORDS, ...extraStopwords.map((w) => w.toLowerCase())]);
  const tokenOpts = { stopwords, useStemming };

  // Tokenize all documents (corpus + this text)
  const allDocs = corpus.map((doc) => {
    const tokens = tokenize(doc, tokenOpts);
    const allTokens = useBigrams ? [...tokens, ...extractBigrams(tokens)] : tokens;
    return computeTf(allTokens);
  });

  // Tokenize the target text
  const tokens = tokenize(text, tokenOpts);
  const allTokens = useBigrams ? [...tokens, ...extractBigrams(tokens)] : tokens;
  const targetTf = computeTf(allTokens);

  // Compute IDF across all documents including target
  const idf = computeIdf([...allDocs, targetTf]);

  // Return TF-IDF for the target
  return computeTfIdf(targetTf, idf);
}

/**
 * Analyze relevance between a task prompt and an output.
 * Core analysis function — returns detailed scoring with evidence.
 */
export function analyzeRelevance(
  task: string,
  output: string,
  options: RelevanceOptions = {},
): RelevanceResult {
  const {
    threshold = 0.2,
    useBigrams = true,
    extraStopwords = [],
    useStemming = true,
    minTermFrequency = 1,
    maxDocumentFrequency = 0.95,
  } = options;

  if (!task.trim() || !output.trim()) {
    return {
      score: 0,
      relevant: false,
      threshold,
      sharedTerms: [],
      missingTerms: [],
      extraTerms: [],
    };
  }

  const stopwords = new Set([...STOPWORDS, ...extraStopwords.map((w) => w.toLowerCase())]);
  const tokenOpts = { stopwords, useStemming };

  // Tokenize both
  const taskTokens = tokenize(task, tokenOpts);
  const outputTokens = tokenize(output, tokenOpts);

  const taskAll = useBigrams
    ? [...taskTokens, ...extractBigrams(taskTokens)]
    : taskTokens;
  const outputAll = useBigrams
    ? [...outputTokens, ...extractBigrams(outputTokens)]
    : outputTokens;

  // Compute TF for both
  const taskTf = computeTf(taskAll);
  const outputTf = computeTf(outputAll);

  // Filter by minimum term frequency
  if (minTermFrequency > 1) {
    const taskRawFreq = new Map<string, number>();
    for (const t of taskAll) taskRawFreq.set(t, (taskRawFreq.get(t) ?? 0) + 1);
    for (const [term, count] of taskRawFreq) {
      if (count < minTermFrequency) taskTf.delete(term);
    }

    const outputRawFreq = new Map<string, number>();
    for (const t of outputAll) outputRawFreq.set(t, (outputRawFreq.get(t) ?? 0) + 1);
    for (const [term, count] of outputRawFreq) {
      if (count < minTermFrequency) outputTf.delete(term);
    }
  }

  // Compute IDF across both documents
  const allDocs = [taskTf, outputTf];
  const idf = computeIdf(allDocs);

  // Filter by max document frequency
  if (maxDocumentFrequency < 1) {
    const totalDocs = allDocs.length;
    for (const [term] of idf) {
      let df = 0;
      for (const doc of allDocs) {
        if (doc.has(term)) df++;
      }
      if (df / totalDocs > maxDocumentFrequency) {
        idf.delete(term);
      }
    }
  }

  // Compute TF-IDF vectors
  const taskVec = computeTfIdf(taskTf, idf);
  const outputVec = computeTfIdf(outputTf, idf);

  // Cosine similarity
  const score = cosineSimilarity(taskVec, outputVec);

  // Find shared, missing, and extra terms
  const sharedTerms: ScoredTerm[] = [];
  const missingTerms: ScoredTerm[] = [];
  const extraTerms: ScoredTerm[] = [];

  for (const [term, weight] of taskVec) {
    if (outputVec.has(term)) {
      sharedTerms.push({ term, weight: weight * (outputVec.get(term) ?? 0) });
    } else {
      missingTerms.push({ term, weight });
    }
  }

  for (const [term, weight] of outputVec) {
    if (!taskVec.has(term)) {
      extraTerms.push({ term, weight });
    }
  }

  // Sort by weight descending
  sharedTerms.sort((a, b) => b.weight - a.weight);
  missingTerms.sort((a, b) => b.weight - a.weight);
  extraTerms.sort((a, b) => b.weight - a.weight);

  // Limit arrays to top 20
  const topShared = sharedTerms.slice(0, 20);
  const topMissing = missingTerms.slice(0, 20);
  const topExtra = extraTerms.slice(0, 20);

  // Section-level analysis
  const sectionScores = analyzeSections(task, output, options);

  return {
    score,
    relevant: score >= threshold,
    threshold,
    sharedTerms: topShared,
    missingTerms: topMissing,
    extraTerms: topExtra,
    sectionScores: sectionScores.length > 1 ? sectionScores : undefined,
  };
}

/**
 * Analyze relevance of individual sections in the output.
 * Splits output on markdown headings and scores each section.
 */
function analyzeSections(
  task: string,
  output: string,
  options: RelevanceOptions,
): SectionRelevance[] {
  // Split on markdown headings
  const sectionPattern = /^(#{1,6})\s+(.+)$/gm;
  const sections: { heading: string; content: string; startIndex: number }[] = [];

  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastHeading = '(preamble)';

  while ((match = sectionPattern.exec(output)) !== null) {
    if (lastIndex < match.index) {
      const content = output.slice(lastIndex, match.index).trim();
      if (content) {
        sections.push({ heading: lastHeading, content, startIndex: lastIndex });
      }
    }
    lastHeading = match[2] ?? '';
    lastIndex = match.index + match[0].length;
  }

  // Remaining content after last heading
  if (lastIndex < output.length) {
    const content = output.slice(lastIndex).trim();
    if (content) {
      sections.push({ heading: lastHeading, content, startIndex: lastIndex });
    }
  }

  if (sections.length <= 1) return [];

  // Score each section against the task
  return sections.map((section) => {
    const sectionResult = analyzeRelevance(task, section.content, {
      ...options,
      // Don't recurse into section analysis
    });
    return {
      heading: section.heading,
      score: sectionResult.score,
      startIndex: section.startIndex,
    };
  });
}

// ─── TOPIC EXTRACTION ───────────────────────────────────────────────────────────

/**
 * Extract key topics from a text based on TF-IDF weighting.
 * Returns the most important terms/phrases in the text.
 */
export function extractTopics(
  text: string,
  options: TopicExtractionOptions = {},
): ExtractedTopic[] {
  const { maxTopics = 10, minWeight = 0.01, includeBigrams = true } = options;

  if (!text.trim()) return [];

  const tokens = tokenize(text, { useStemming: false }); // Don't stem for readable topics
  const allTokens = includeBigrams ? [...tokens, ...extractBigrams(tokens)] : tokens;

  // Count raw frequencies
  const freq = new Map<string, number>();
  for (const token of allTokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  // Compute simple TF weighting (frequency / total)
  const total = allTokens.length;
  if (total === 0) return [];

  const topics: ExtractedTopic[] = [];
  for (const [term, count] of freq) {
    // Boost bigrams (they're more specific)
    const bigramBoost = term.includes(' ') ? 1.5 : 1.0;
    // Boost longer terms (more specific)
    const lengthBoost = Math.min(term.length / 5, 2.0);
    const weight = (count / total) * bigramBoost * lengthBoost;

    if (weight >= minWeight) {
      topics.push({ term, weight, frequency: count });
    }
  }

  // Sort by weight descending
  topics.sort((a, b) => b.weight - a.weight);

  // Normalize weights so the top one is 1.0
  const maxWeight = topics[0]?.weight ?? 1;
  for (const topic of topics) {
    topic.weight = topic.weight / maxWeight;
  }

  return topics.slice(0, maxTopics);
}

/**
 * Calculate topic overlap between two texts.
 * Returns the fraction of topics from text1 that appear in text2's topics.
 */
export function topicOverlap(
  text1: string,
  text2: string,
  options: TopicExtractionOptions = {},
): number {
  const topics1 = extractTopics(text1, { ...options, maxTopics: 20 });
  const topics2 = extractTopics(text2, { ...options, maxTopics: 40 });

  if (topics1.length === 0) return 0;

  const topic2Set = new Set(topics2.map((t) => t.term));
  let overlapping = 0;
  let totalWeight = 0;

  for (const topic of topics1) {
    totalWeight += topic.weight;
    if (topic2Set.has(topic.term)) {
      overlapping += topic.weight;
    }
  }

  return totalWeight > 0 ? overlapping / totalWeight : 0;
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that the output is relevant to the task prompt.
 * Uses TF-IDF cosine similarity to measure semantic overlap.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options with threshold.
 *   If a string, uses it as the task with default threshold (0.2).
 *   If options, uses context.prompt as the task.
 */
export function toBeRelevantTo(
  taskOrOptions?: string | (RelevanceOptions & { task?: string }),
): Assertion {
  const opts: RelevanceOptions & { task?: string } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const threshold = opts.threshold ?? 0.2;

  return {
    name: `relevant to task (threshold: ${threshold})`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `relevant to task (threshold: ${threshold})`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = analyzeRelevance(task, output, { ...opts, threshold });

      if (result.relevant) {
        return {
          status: 'pass',
          name: `relevant to task (threshold: ${threshold})`,
          evidence: `Score: ${result.score.toFixed(3)} (threshold: ${threshold}). ` +
            `Shared terms: ${result.sharedTerms.slice(0, 5).map((t) => t.term).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      const missing = result.missingTerms.slice(0, 5).map((t) => t.term).join(', ');
      const extra = result.extraTerms.slice(0, 5).map((t) => t.term).join(', ');

      return {
        status: 'fail',
        name: `relevant to task (threshold: ${threshold})`,
        message: `Output is not sufficiently relevant to the task`,
        expected: `relevance score >= ${threshold}`,
        actual: `score = ${result.score.toFixed(3)}`,
        evidence:
          `Missing task terms: ${missing || '(none)'}. ` +
          `Unrelated output terms: ${extra || '(none)'}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output does not drift from the task.
 * Inverse of relevance — fails when similarity is too LOW.
 * A stricter version of toBeRelevantTo with better error messaging around drift.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for drift detection.
 */
export function toNotDriftFrom(
  taskOrOptions?: string | (RelevanceOptions & { task?: string }),
): Assertion {
  const opts: RelevanceOptions & { task?: string } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const threshold = opts.threshold ?? 0.15;

  return {
    name: `no drift from task (threshold: ${threshold})`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `no drift from task (threshold: ${threshold})`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = analyzeRelevance(task, output, { ...opts, threshold });

      if (result.relevant) {
        return {
          status: 'pass',
          name: `no drift from task (threshold: ${threshold})`,
          evidence: `On-topic. Score: ${result.score.toFixed(3)}. ` +
            `Key shared terms: ${result.sharedTerms.slice(0, 5).map((t) => t.term).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      // Identify drift evidence
      const driftEvidence: string[] = [];
      if (result.missingTerms.length > 0) {
        driftEvidence.push(
          `Task topics not addressed: ${result.missingTerms.slice(0, 5).map((t) => t.term).join(', ')}`,
        );
      }
      if (result.extraTerms.length > 0) {
        driftEvidence.push(
          `Off-topic content: ${result.extraTerms.slice(0, 5).map((t) => t.term).join(', ')}`,
        );
      }
      if (result.sectionScores) {
        const lowSections = result.sectionScores
          .filter((s) => s.score < threshold)
          .map((s) => `"${s.heading}" (${s.score.toFixed(2)})`);
        if (lowSections.length > 0) {
          driftEvidence.push(`Low-relevance sections: ${lowSections.join(', ')}`);
        }
      }

      return {
        status: 'fail',
        name: `no drift from task (threshold: ${threshold})`,
        message: 'Output has drifted from the assigned task',
        expected: `relevance score >= ${threshold}`,
        actual: `score = ${result.score.toFixed(3)}`,
        evidence: driftEvidence.join('. ') || 'Output content does not match task topics',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output has sufficient topic overlap with the task.
 * Unlike cosine similarity, this checks how many task topics are covered.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options.
 */
export function toHaveTopicOverlap(
  taskOrOptions?: string | (TopicExtractionOptions & { task?: string; minOverlap?: number }),
): Assertion {
  const opts: TopicExtractionOptions & { task?: string; minOverlap?: number } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const minOverlap = opts.minOverlap ?? 0.4;

  return {
    name: `topic overlap >= ${minOverlap}`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `topic overlap >= ${minOverlap}`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const overlap = topicOverlap(task, output, opts);
      const pass = overlap >= minOverlap;

      if (pass) {
        const taskTopics = extractTopics(task, { ...opts, maxTopics: 5 });
        return {
          status: 'pass',
          name: `topic overlap >= ${minOverlap}`,
          evidence: `Topic overlap: ${(overlap * 100).toFixed(1)}%. ` +
            `Task topics covered: ${taskTopics.map((t) => t.term).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      const taskTopics = extractTopics(task, { ...opts, maxTopics: 10 });
      const outputTopics = extractTopics(output, { ...opts, maxTopics: 10 });
      const outputTerms = new Set(outputTopics.map((t) => t.term));
      const missed = taskTopics.filter((t) => !outputTerms.has(t.term));

      return {
        status: 'fail',
        name: `topic overlap >= ${minOverlap}`,
        message: `Insufficient topic coverage of the task`,
        expected: `topic overlap >= ${(minOverlap * 100).toFixed(0)}%`,
        actual: `${(overlap * 100).toFixed(1)}%`,
        evidence: `Missing topics: ${missed.slice(0, 5).map((t) => t.term).join(', ')}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output's top topics are closely aligned with the task.
 * Measures whether the MOST prominent topics in the output are task-related.
 *
 * @tier 2 — Heuristic
 * @param taskOrOptions - The task description, or options.
 */
export function toBeOnTopic(
  taskOrOptions?: string | (RelevanceOptions & TopicExtractionOptions & { task?: string }),
): Assertion {
  const opts: RelevanceOptions & TopicExtractionOptions & { task?: string } =
    typeof taskOrOptions === 'string'
      ? { task: taskOrOptions }
      : taskOrOptions ?? {};

  const threshold = opts.threshold ?? 0.2;

  return {
    name: `on-topic (combined relevance + topic check)`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const task = opts.task ?? context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `on-topic (combined relevance + topic check)`,
          message: 'No task/prompt provided — pass task string or provide EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      // Combine cosine similarity and topic overlap for a robust score
      const relevance = analyzeRelevance(task, output, { ...opts, threshold: 0 });
      const overlap = topicOverlap(task, output, opts);

      // Weighted combination: 60% cosine, 40% topic overlap
      const combinedScore = relevance.score * 0.6 + overlap * 0.4;
      const pass = combinedScore >= threshold;

      if (pass) {
        return {
          status: 'pass',
          name: `on-topic (combined relevance + topic check)`,
          evidence:
            `Combined score: ${combinedScore.toFixed(3)} ` +
            `(cosine: ${relevance.score.toFixed(3)}, topic overlap: ${(overlap * 100).toFixed(1)}%)`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `on-topic (combined relevance + topic check)`,
        message: 'Output is off-topic',
        expected: `combined score >= ${threshold}`,
        actual: `${combinedScore.toFixed(3)} (cosine: ${relevance.score.toFixed(3)}, overlap: ${(overlap * 100).toFixed(1)}%)`,
        evidence:
          `Missing terms: ${relevance.missingTerms.slice(0, 5).map((t) => t.term).join(', ')}. ` +
          `Off-topic content: ${relevance.extraTerms.slice(0, 5).map((t) => t.term).join(', ')}`,
        durationMs: performance.now() - start,
      };
    },
  };
}