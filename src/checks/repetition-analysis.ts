/**
 * Repetition/Loop Detection - combined analysis orchestrator.
 *
 * `analyzeFullRepetition` fuses the three primitive detectors
 * (`analyzeRepetition`, `detectLoops`, `analyzeNgramSaturation`) into a single
 * weighted report suitable for eval assertions. No AI calls, no IO.
 *
 * The three primitive detectors live in `./repetition-detectors.js`; the shared
 * text primitives (normalize/split/similarity/n-gram) live in
 * `./repetition-text.js`; the assertion factories that wrap these detectors live
 * in `./repetition.js`. This module re-exports the detectors and the shared text
 * primitives that are part of the public surface so the `./repetition.js` barrel
 * can continue to source them all from a single `./repetition-analysis.js`
 * import path.
 *
 * @tier 2 - Heuristic (no AI, detects behavioral patterns)
 * @module
 */

import type {
  FullRepetitionOptions,
  FullRepetitionResult,
} from './repetition-types.js';
import {
  analyzeRepetition,
  detectLoops,
  analyzeNgramSaturation,
} from './repetition-detectors.js';
import {
  splitSentences,
  splitParagraphs,
  splitLines,
  segmentSimilarity,
} from './repetition-text.js';

// Re-export the primitive detectors and the shared text primitives that are part
// of the public surface so the `./repetition.js` barrel can continue to source
// them from here.
export { analyzeRepetition, detectLoops, analyzeNgramSaturation };
export { splitSentences, splitParagraphs, splitLines, segmentSimilarity };

// ---- COMBINED ANALYSIS ----

/**
 * Run full repetition analysis combining all detection methods.
 * Returns a comprehensive report suitable for eval assertions.
 */
export function analyzeFullRepetition(
  text: string,
  options: FullRepetitionOptions = {},
): FullRepetitionResult {
  const { threshold = 0.3 } = options;

  const repetition = analyzeRepetition(text, options.repetition);
  const loops = detectLoops(text, options.loops);
  const ngramSaturation = analyzeNgramSaturation(text, options.ngramSaturation);

  // Combined score: weighted average of all signals
  // Loops are strongest signal, then repetition, then saturation
  const overallScore = Math.min(1,
    repetition.score * 0.35 +
    loops.loopRatio * 0.4 +
    ngramSaturation.score * 0.25,
  );

  const isRepetitive = overallScore >= threshold;

  // Build summary
  const summaryParts: string[] = [];
  if (repetition.hasRepetition) {
    const topRep = repetition.instances[0];
    summaryParts.push(
      `Found ${repetition.instances.length} repeated segment(s) ` +
      `(worst: ${topRep?.count ?? 0}x "${topRep?.text.slice(0, 50) ?? ''}...")`,
    );
  }
  if (loops.hasLoop) {
    summaryParts.push(
      `Detected ${loops.loops.length} loop pattern(s) ` +
      `(longest: ${loops.longestLoop?.repetitions ?? 0} repetitions of ${loops.longestLoop?.cycleLength ?? 0}-segment cycle)`,
    );
  }
  if (ngramSaturation.saturated) {
    const topNgram = ngramSaturation.dominantNgrams[0];
    summaryParts.push(
      `N-gram saturation detected (top phrase "${topNgram?.ngram ?? ''}" appears ${topNgram?.count ?? 0} times)`,
    );
  }

  const summary = summaryParts.length > 0
    ? summaryParts.join('. ')
    : 'No significant repetition detected';

  return {
    isRepetitive,
    overallScore,
    repetition,
    loops,
    ngramSaturation,
    summary,
  };
}
