/**
 * Drift relevance scorer — internal TF-IDF cosine helper for {@link ./drift.ts}.
 *
 * drift's requirement-coverage logic needs a single TF-IDF cosine relevance
 * score between a task/subject and a piece of output. This is a self-contained
 * port of the (now removed) relevance scorer's numeric path, using the same
 * defaults the drift call sites used (bigrams on, Porter-ish stemming on,
 * minTermFrequency 1, maxDocumentFrequency 0.95). It returns ONLY the cosine
 * score in [0, 1]; drift never consumed the pass/fail flag or term breakdowns.
 *
 * This module is an INTERNAL implementation detail of the drift check. It is not
 * part of the public API surface and is not re-exported from `src/checks/index.ts`
 * or `src/index.ts`. Only {@link relevanceScore} is exported, and only so that
 * `drift.ts` can consume it; the tokenizer/stemmer/TF helpers stay module-private
 * exactly as they were when inlined.
 *
 * @module
 * @internal
 */

/** Common English stopwords that carry little semantic meaning. */
const RELEVANCE_STOPWORDS = new Set([
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

/** Lightweight Porter-like suffix stripping (matches the removed scorer). */
function relevanceStem(word: string): string {
  if (word.length <= 3) return word;

  let result = word;

  if (result.endsWith('ies') && result.length > 4) {
    result = result.slice(0, -3) + 'y';
  } else if (result.endsWith('sses')) {
    result = result.slice(0, -2);
  } else if (result.endsWith('ness')) {
    result = result.slice(0, -4);
  } else if (result.endsWith('ing') && result.length > 5) {
    result = result.slice(0, -3);
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

/** Tokenize → normalize, drop stopwords/short tokens, stem. */
function relevanceTokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ').filter((w) => {
    if (w.length < 2) return false;
    if (RELEVANCE_STOPWORDS.has(w)) return false;
    if (/^\d+$/.test(w) && w.length < 4) return false;
    return true;
  });

  return words.map(relevanceStem);
}

/** Term frequency map normalized by document length. */
function relevanceTf(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  const total = tokens.length;
  if (total === 0) return freq;
  const tf = new Map<string, number>();
  for (const [term, count] of freq) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * Compute a TF-IDF cosine relevance score in [0, 1] between two texts.
 *
 * Replicates the removed relevance scorer's numeric path with its defaults:
 * unigrams + bigrams, stemming on, smoothed IDF over the two-document corpus,
 * and a maxDocumentFrequency of 0.95 (so terms shared by both documents are
 * dropped from the IDF map and fall back to an IDF weight of 1).
 *
 * @internal Consumed only by `drift.ts`; not part of the public API.
 */
export function relevanceScore(task: string, output: string): number {
  if (!task.trim() || !output.trim()) return 0;

  const taskTokens = relevanceTokenize(task);
  const outputTokens = relevanceTokenize(output);

  const extractBigrams = (tokens: string[]): string[] => {
    const bigrams: string[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return bigrams;
  };

  const taskAll = [...taskTokens, ...extractBigrams(taskTokens)];
  const outputAll = [...outputTokens, ...extractBigrams(outputTokens)];

  const taskTf = relevanceTf(taskAll);
  const outputTf = relevanceTf(outputAll);
  // minTermFrequency defaults to 1, so the low-frequency filter is a no-op.

  // Smoothed IDF across the two-document corpus: log((N + 1) / (df + 1)) + 1.
  const allDocs = [taskTf, outputTf];
  const docFreq = new Map<string, number>();
  for (const doc of allDocs) {
    for (const term of doc.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log((allDocs.length + 1) / (df + 1)) + 1);
  }

  // maxDocumentFrequency = 0.95: drop terms present in every document.
  const totalDocs = allDocs.length;
  for (const [term] of idf) {
    let df = 0;
    for (const doc of allDocs) {
      if (doc.has(term)) df++;
    }
    if (df / totalDocs > 0.95) {
      idf.delete(term);
    }
  }

  const toTfIdf = (tf: Map<string, number>): Map<string, number> => {
    const tfidf = new Map<string, number>();
    for (const [term, tfVal] of tf) {
      tfidf.set(term, tfVal * (idf.get(term) ?? 1));
    }
    return tfidf;
  };

  const taskVec = toTfIdf(taskTf);
  const outputVec = toTfIdf(outputTf);

  // Cosine similarity between the two TF-IDF vectors.
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, weightA] of taskVec) {
    const weightB = outputVec.get(term);
    if (weightB !== undefined) {
      dotProduct += weightA * weightB;
    }
    normA += weightA * weightA;
  }
  for (const [, weightB] of outputVec) {
    normB += weightB * weightB;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}
