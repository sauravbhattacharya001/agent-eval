/**
 * Repetition/Loop Detection - shared text primitives.
 *
 * The low-level, pure text helpers used by the repetition detectors:
 * normalization, segmentation (sentence/paragraph/line splitters), word-set
 * similarity (Jaccard), and word n-gram extraction. No AI calls, no IO, no
 * detector logic — just the reusable building blocks.
 *
 * These are consumed by `./repetition-analysis.js` (the detectors) and the
 * public splitters/`segmentSimilarity` are re-exported through the
 * `./repetition.js` barrel so the public surface stays a single import path.
 *
 * @tier 2 - Heuristic (no AI, pure text analysis)
 * @module
 */

// ─── NORMALIZATION UTILITIES ────────────────────────────────────────────────────

/**
 * Normalize text for comparison.
 */
export function normalize(
  text: string,
  options: { normalizeWhitespace?: boolean; ignoreCase?: boolean } = {},
): string {
  const { normalizeWhitespace = true, ignoreCase = true } = options;
  let result = text;
  if (ignoreCase) result = result.toLowerCase();
  if (normalizeWhitespace) result = result.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Split text into sentences (simple heuristic).
 * Splits on sentence-ending punctuation followed by whitespace.
 */
export function splitSentences(text: string): string[] {
  // Split on .!? followed by whitespace or end of string
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split text into paragraphs (double newline separated).
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split text into lines (single newline separated, ignoring empty).
 */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ─── SIMILARITY ─────────────────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two sets of words.
 * Returns value between 0 (no overlap) and 1 (identical).
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if two strings are similar above a threshold.
 */
export function areSimilar(a: string, b: string, threshold: number): boolean {
  // Fast path: exact match
  if (a === b) return true;
  // Fast path: length difference too large
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (lenRatio < threshold * 0.7) return false;
  return jaccardSimilarity(a, b) >= threshold;
}

/**
 * Compute similarity score between two strings (0–1).
 */
export function segmentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return jaccardSimilarity(a, b);
}

// ─── N-GRAM EXTRACTION ──────────────────────────────────────────────────────────

/**
 * Extract word n-grams from text.
 */
export function extractWordNgrams(text: string, n: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}
