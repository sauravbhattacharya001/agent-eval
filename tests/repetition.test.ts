/**
 * Tests for the Repetition/Loop Detection module (Tier 2 — Heuristic).
 * Tests sentence repetition, loop detection, n-gram saturation, and assertion factories.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeRepetition,
  detectLoops,
  analyzeNgramSaturation,
  analyzeFullRepetition,
  splitSentences,
  splitParagraphs,
  splitLines,
  segmentSimilarity,
  toNotRepeat,
  toNotLoop,
  toNotBeSaturated,
  toNotBeRepetitive,
  toNotExceedRepetitions,
} from '../src/checks/repetition.js';

// ─── UTILITY FUNCTIONS ──────────────────────────────────────────────────────────

describe('splitSentences', () => {
  it('splits on sentence-ending punctuation', () => {
    const result = splitSentences('Hello world. How are you? Great!');
    expect(result).toEqual(['Hello world.', 'How are you?', 'Great!']);
  });

  it('handles single sentence', () => {
    expect(splitSentences('Just one sentence.')).toEqual(['Just one sentence.']);
  });

  it('handles empty input', () => {
    expect(splitSentences('')).toEqual([]);
  });

  it('handles text without punctuation', () => {
    expect(splitSentences('no punctuation here')).toEqual(['no punctuation here']);
  });

  it('handles multiple spaces between sentences', () => {
    const result = splitSentences('First sentence.   Second sentence.');
    expect(result).toEqual(['First sentence.', 'Second sentence.']);
  });
});

describe('splitParagraphs', () => {
  it('splits on double newlines', () => {
    const text = 'First paragraph.\n\nSecond paragraph.';
    expect(splitParagraphs(text)).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('handles single paragraph', () => {
    expect(splitParagraphs('Just one paragraph')).toEqual(['Just one paragraph']);
  });

  it('handles empty input', () => {
    expect(splitParagraphs('')).toEqual([]);
  });

  it('ignores single newlines', () => {
    const text = 'Line one\nLine two';
    expect(splitParagraphs(text)).toEqual(['Line one\nLine two']);
  });

  it('handles multiple blank lines', () => {
    const text = 'Para one.\n\n\n\nPara two.';
    expect(splitParagraphs(text)).toEqual(['Para one.', 'Para two.']);
  });
});

describe('splitLines', () => {
  it('splits on newlines and filters empty', () => {
    const text = 'Line 1\nLine 2\n\nLine 3';
    expect(splitLines(text)).toEqual(['Line 1', 'Line 2', 'Line 3']);
  });

  it('handles single line', () => {
    expect(splitLines('single')).toEqual(['single']);
  });

  it('handles empty input', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('trims whitespace from lines', () => {
    const text = '  spaced  \n  lines  ';
    expect(splitLines(text)).toEqual(['spaced', 'lines']);
  });
});

describe('segmentSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(segmentSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(segmentSimilarity('hello world', 'foo bar baz')).toBe(0);
  });

  it('returns value between 0 and 1 for partial overlap', () => {
    const sim = segmentSimilarity('hello world test', 'hello world foo');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('returns 0 for empty strings', () => {
    expect(segmentSimilarity('', 'hello')).toBe(0);
    expect(segmentSimilarity('hello', '')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'the quick brown fox';
    const b = 'the slow brown dog';
    expect(segmentSimilarity(a, b)).toBeCloseTo(segmentSimilarity(b, a), 10);
  });
});

// ─── ANALYZE REPETITION ─────────────────────────────────────────────────────────

describe('analyzeRepetition', () => {
  it('returns no repetition for unique content', () => {
    const text = 'The first sentence is unique. The second adds new information. The third is different still.';
    const result = analyzeRepetition(text);
    expect(result.hasRepetition).toBe(false);
    expect(result.score).toBe(0);
    expect(result.instances).toHaveLength(0);
  });

  it('detects exact sentence repetition', () => {
    const text = 'This is a repeated sentence that appears multiple times. This is a repeated sentence that appears multiple times. Something else in between here.';
    const result = analyzeRepetition(text);
    expect(result.hasRepetition).toBe(true);
    expect(result.instances.length).toBeGreaterThan(0);
    expect(result.instances[0]!.kind).toBe('exact');
    expect(result.instances[0]!.count).toBe(2);
  });

  it('detects near-duplicate sentences', () => {
    const text = 'The system is working correctly and everything is fine. The system is working properly and everything is fine. Some other content here to differentiate things.';
    const result = analyzeRepetition(text, { similarityThreshold: 0.7 });
    expect(result.hasRepetition).toBe(true);
    expect(result.instances.some((i) => i.kind === 'near-duplicate' || i.kind === 'exact')).toBe(true);
  });

  it('respects minRepetitions option', () => {
    const text = 'This repeats twice in the document. This repeats twice in the document. Other content here too.';
    const result2 = analyzeRepetition(text, { minRepetitions: 2 });
    expect(result2.hasRepetition).toBe(true);

    const result3 = analyzeRepetition(text, { minRepetitions: 3 });
    expect(result3.hasRepetition).toBe(false);
  });

  it('respects minSegmentLength option', () => {
    const text = 'Short. Short. This is a longer sentence that qualifies.';
    const resultStrict = analyzeRepetition(text, { minSegmentLength: 10 });
    expect(resultStrict.hasRepetition).toBe(false);

    const resultRelaxed = analyzeRepetition(text, { minSegmentLength: 3 });
    expect(resultRelaxed.hasRepetition).toBe(true);
  });

  it('handles empty input', () => {
    const result = analyzeRepetition('');
    expect(result.hasRepetition).toBe(false);
    expect(result.score).toBe(0);
    expect(result.uniqueSegments).toBe(0);
    expect(result.totalSegments).toBe(0);
  });

  it('handles whitespace-only input', () => {
    const result = analyzeRepetition('   \n\n   ');
    expect(result.hasRepetition).toBe(false);
  });

  it('calculates repetitionRatio correctly', () => {
    const repeated = 'This sentence repeats many times in the text.';
    const text = `${repeated} ${repeated} ${repeated} Something different here.`;
    const result = analyzeRepetition(text);
    expect(result.repetitionRatio).toBeGreaterThan(0);
    expect(result.repetitionRatio).toBeLessThanOrEqual(1);
  });

  it('sorts instances by count descending', () => {
    const a = 'First repeated segment that appears often.';
    const b = 'Second repeated segment that is common.';
    const text = `${a} ${a} ${a} ${b} ${b} Other content.`;
    const result = analyzeRepetition(text);
    if (result.instances.length >= 2) {
      expect(result.instances[0]!.count).toBeGreaterThanOrEqual(result.instances[1]!.count);
    }
  });

  it('respects case sensitivity setting', () => {
    const text = 'Hello World Test Sentence. hello world test sentence. Something else here.';
    const caseInsensitive = analyzeRepetition(text, { ignoreCase: true });
    const caseSensitive = analyzeRepetition(text, { ignoreCase: false });
    expect(caseInsensitive.hasRepetition).toBe(true);
    expect(caseSensitive.hasRepetition).toBe(false);
  });

  it('normalizes whitespace by default', () => {
    const text = 'Repeated  sentence   with   extra  spaces. Repeated sentence with extra spaces. Other text here.';
    const result = analyzeRepetition(text);
    expect(result.hasRepetition).toBe(true);
  });

  it('handles very repetitive content with high score', () => {
    const segment = 'The agent is stuck repeating this output.';
    const text = Array(10).fill(segment).join(' ');
    const result = analyzeRepetition(text);
    expect(result.hasRepetition).toBe(true);
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.instances[0]!.count).toBe(10);
  });

  it('tracks unique vs total segments', () => {
    const text = 'Unique one here today. Repeated segment is right here. Repeated segment is right here. Unique two here today.';
    const result = analyzeRepetition(text, { minSegmentLength: 10 });
    expect(result.totalSegments).toBe(4);
    expect(result.uniqueSegments).toBeLessThanOrEqual(result.totalSegments);
  });

  // Long-text branch: for text > 2000 chars with > 3 paragraphs, segments are
  // split by PARAGRAPH (not sentence). Guards the `text.length > 2000` selector.
  it('splits long multi-paragraph text by paragraph, not sentence', () => {
    const rep =
      'Alpha paragraph. ' +
      'This distinct block discusses topic alpha at length and is reused verbatim. '.repeat(4);
    const uniq = (i: number): string =>
      `Paragraph ${i}: ` +
      `unique content variant ${i} number ${i} ${'y'.repeat(30)}. `.repeat(4);
    const text = [rep, rep, rep, uniq(1), uniq(2), uniq(3), uniq(4)].join('\n\n');

    // Preconditions that route into the paragraph branch.
    expect(text.length).toBeGreaterThan(2000);
    expect(text.split(/\n\s*\n/).filter((p) => p.trim()).length).toBeGreaterThan(3);

    const result = analyzeRepetition(text);
    // 7 paragraphs → 7 segments (paragraph split). A sentence split would yield
    // far more than 7, so this pins that the paragraph branch was taken.
    expect(result.totalSegments).toBe(7);
    expect(result.hasRepetition).toBe(true);
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]!.count).toBe(3);
    expect(result.instances[0]!.kind).toBe('exact');
  });

  // Long text (> 2000 chars) but <= 3 paragraphs falls back to sentence split.
  it('falls back to sentence split for long text with few paragraphs', () => {
    const rep = 'This exact sentence is deliberately repeated to be detected. ';
    const text = rep.repeat(3) + 'Filler sentence number here. '.repeat(70);

    expect(text.length).toBeGreaterThan(2000);
    expect(text.split(/\n\s*\n/).filter((p) => p.trim()).length).toBeLessThanOrEqual(3);

    const result = analyzeRepetition(text);
    // Sentence split yields many segments (far more than a paragraph split's 1).
    expect(result.totalSegments).toBeGreaterThan(3);
    expect(result.hasRepetition).toBe(true);
  });
});

// ─── DETECT LOOPS ───────────────────────────────────────────────────────────────

describe('detectLoops', () => {
  it('detects simple single-line loops', () => {
    const text = [
      'Step 1: Check the file',
      'Step 2: Update the config',
      'Step 1: Check the file',
      'Step 2: Update the config',
      'Step 1: Check the file',
      'Step 2: Update the config',
    ].join('\n');
    const result = detectLoops(text);
    expect(result.hasLoop).toBe(true);
    expect(result.loops.length).toBeGreaterThan(0);
  });

  it('detects multi-segment cycles', () => {
    const text = [
      'Running tests...',
      'Tests failed with error X',
      'Fixing error X in module Y',
      'Running tests...',
      'Tests failed with error X',
      'Fixing error X in module Y',
      'Running tests...',
      'Tests failed with error X',
      'Fixing error X in module Y',
    ].join('\n');
    const result = detectLoops(text);
    expect(result.hasLoop).toBe(true);
    expect(result.longestLoop).toBeDefined();
    expect(result.longestLoop!.cycleLength).toBe(3);
    expect(result.longestLoop!.repetitions).toBe(3);
  });

  it('returns no loops for non-repeating content', () => {
    const text = [
      'Step 1: Initialize project',
      'Step 2: Install dependencies',
      'Step 3: Configure TypeScript',
      'Step 4: Write first test',
      'Step 5: Run test suite',
    ].join('\n');
    const result = detectLoops(text);
    expect(result.hasLoop).toBe(false);
    expect(result.loops).toHaveLength(0);
  });

  it('handles empty input', () => {
    const result = detectLoops('');
    expect(result.hasLoop).toBe(false);
    expect(result.loopRatio).toBe(0);
  });

  it('respects minCycleRepetitions option', () => {
    const text = [
      'A line that repeats exactly',
      'B another unique line here',
      'A line that repeats exactly',
      'B another unique line here',
    ].join('\n');

    const result2 = detectLoops(text, { minCycleRepetitions: 2 });
    expect(result2.hasLoop).toBe(true);

    const result3 = detectLoops(text, { minCycleRepetitions: 3 });
    expect(result3.hasLoop).toBe(false);
  });

  it('calculates loopRatio correctly', () => {
    const text = [
      'Unique start line here',
      'Loop element A right here',
      'Loop element B right here',
      'Loop element A right here',
      'Loop element B right here',
      'Unique end line here now',
    ].join('\n');
    const result = detectLoops(text);
    if (result.hasLoop) {
      expect(result.loopRatio).toBeGreaterThan(0);
      expect(result.loopRatio).toBeLessThanOrEqual(1);
    }
  });

  it('detects near-duplicate loops (not just exact)', () => {
    const text = [
      'Running the full test suite now for validation',
      'All verification tests passed successfully here',
      'Running the full test suite again for validation',
      'All verification tests passed successfully here',
    ].join('\n');
    const result = detectLoops(text, { similarityThreshold: 0.6 });
    expect(result.hasLoop).toBe(true);
  });

  it('respects minCycleLength option', () => {
    const text = [
      'Same line repeated here',
      'Same line repeated here',
      'Same line repeated here',
    ].join('\n');
    const resultMin1 = detectLoops(text, { minCycleLength: 1 });
    expect(resultMin1.hasLoop).toBe(true);

    const resultMin2 = detectLoops(text, { minCycleLength: 2 });
    expect(resultMin2.hasLoop).toBe(false);
  });

  it('identifies the longest loop correctly', () => {
    const text = [
      'A repeating line here',
      'A repeating line here',
      'A repeating line here',
      'X cycle one element',
      'Y cycle two element',
      'X cycle one element',
      'Y cycle two element',
    ].join('\n');
    const result = detectLoops(text);
    expect(result.hasLoop).toBe(true);
    if (result.longestLoop) {
      expect(result.longestLoop.repetitions).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─── N-GRAM SATURATION ──────────────────────────────────────────────────────────

describe('analyzeNgramSaturation', () => {
  it('detects saturated text (same phrases over and over)', () => {
    const text = 'the quick brown fox jumped over the lazy dog. ' +
      'the quick brown fox ran past the lazy dog. ' +
      'the quick brown fox leaped over the lazy dog. ' +
      'the quick brown fox hopped over the lazy dog.';
    const result = analyzeNgramSaturation(text, { ngramSize: 3 });
    expect(result.saturated).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.dominantNgrams.length).toBeGreaterThan(0);
  });

  it('returns not saturated for diverse text', () => {
    const text = 'TypeScript is a strongly typed programming language. ' +
      'Python focuses on readability and simplicity. ' +
      'Rust ensures memory safety without garbage collection. ' +
      'Go was designed for concurrent programming tasks.';
    const result = analyzeNgramSaturation(text, { ngramSize: 3 });
    expect(result.saturated).toBe(false);
  });

  it('handles empty input', () => {
    const result = analyzeNgramSaturation('');
    expect(result.saturated).toBe(false);
    expect(result.score).toBe(0);
    expect(result.uniqueNgrams).toBe(0);
  });

  it('respects ngramSize option', () => {
    const text = 'word word word word word word word word';
    const bigrams = analyzeNgramSaturation(text, { ngramSize: 2 });
    const trigrams = analyzeNgramSaturation(text, { ngramSize: 3 });
    // Both should show saturation for repeated word
    expect(bigrams.totalNgrams).toBeGreaterThan(0);
    expect(trigrams.totalNgrams).toBeGreaterThan(0);
  });

  it('respects saturationThreshold', () => {
    const text = 'hello world test. hello world example. hello world again.';
    const strict = analyzeNgramSaturation(text, { saturationThreshold: 0.1 });
    const relaxed = analyzeNgramSaturation(text, { saturationThreshold: 0.9 });
    if (strict.score >= 0.1) {
      expect(strict.saturated).toBe(true);
    }
    if (relaxed.score < 0.9) {
      expect(relaxed.saturated).toBe(false);
    }
  });

  it('reports dominant n-grams correctly', () => {
    const text = 'the same phrase appears the same phrase appears the same phrase appears again and again';
    const result = analyzeNgramSaturation(text, { ngramSize: 3 });
    if (result.dominantNgrams.length > 0) {
      expect(result.dominantNgrams[0]!.count).toBeGreaterThan(1);
      expect(result.dominantNgrams[0]!.fraction).toBeGreaterThan(0);
      expect(result.dominantNgrams[0]!.fraction).toBeLessThanOrEqual(1);
    }
  });

  it('counts unique and total n-grams', () => {
    const text = 'one two three four five six seven eight nine ten';
    const result = analyzeNgramSaturation(text, { ngramSize: 2 });
    expect(result.totalNgrams).toBe(9);
    expect(result.uniqueNgrams).toBe(9);
  });

  it('only reports n-grams appearing more than once', () => {
    const text = 'unique words everywhere no repetition at all in this text';
    const result = analyzeNgramSaturation(text, { ngramSize: 3 });
    for (const ngram of result.dominantNgrams) {
      expect(ngram.count).toBeGreaterThan(1);
    }
  });
});

// ─── FULL REPETITION ANALYSIS ───────────────────────────────────────────────────

describe('analyzeFullRepetition', () => {
  it('returns clean result for non-repetitive text', () => {
    const text = 'First unique paragraph with its own content.\n\n' +
      'Second paragraph discussing different topics entirely.\n\n' +
      'Third paragraph with novel information and ideas.';
    const result = analyzeFullRepetition(text);
    expect(result.isRepetitive).toBe(false);
    expect(result.overallScore).toBeLessThan(0.3);
  });

  it('flags highly repetitive text', () => {
    const segment = 'The agent keeps saying the same thing over and over.';
    const text = Array(8).fill(segment).join(' ');
    const result = analyzeFullRepetition(text);
    expect(result.isRepetitive).toBe(true);
    expect(result.overallScore).toBeGreaterThan(0.3);
  });

  it('combines all detection methods', () => {
    const text = [
      'Step 1: Run the build command',
      'Step 2: Check for errors now',
      'Step 1: Run the build command',
      'Step 2: Check for errors now',
      'Step 1: Run the build command',
      'Step 2: Check for errors now',
    ].join('\n');
    const result = analyzeFullRepetition(text);
    expect(result.repetition).toBeDefined();
    expect(result.loops).toBeDefined();
    expect(result.ngramSaturation).toBeDefined();
  });

  it('provides human-readable summary', () => {
    const segment = 'This is a sentence that the agent keeps repeating throughout.';
    const text = `${segment} ${segment} ${segment} ${segment}`;
    const result = analyzeFullRepetition(text);
    expect(result.summary.length).toBeGreaterThan(0);
    if (result.isRepetitive) {
      expect(result.summary).not.toBe('No significant repetition detected');
    }
  });

  it('respects threshold option', () => {
    const segment = 'Moderately repetitive content appears here.';
    const text = `${segment} ${segment} Something else entirely different.`;
    const relaxed = analyzeFullRepetition(text, { threshold: 0.9 });
    expect(relaxed.isRepetitive).toBe(false);
  });

  it('handles empty text', () => {
    const result = analyzeFullRepetition('');
    expect(result.isRepetitive).toBe(false);
    expect(result.overallScore).toBe(0);
    expect(result.summary).toBe('No significant repetition detected');
  });
});

// ─── ASSERTION: toNotRepeat ─────────────────────────────────────────────────────

describe('toNotRepeat', () => {
  it('passes for unique content', () => {
    const assertion = toNotRepeat();
    const result = assertion.evaluate(
      'First unique thought here. Second different idea entirely. Third novel concept introduced.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails for heavily repeated content', () => {
    const segment = 'This sentence is said again and again by the agent.';
    const text = Array(6).fill(segment).join(' ');
    const assertion = toNotRepeat();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('repetition');
  });

  it('respects maxScore option', () => {
    const segment = 'A moderately repeated sentence here.';
    const text = `${segment} ${segment} Other stuff here.`;
    const relaxed = toNotRepeat({ maxScore: 0.99 });
    expect(relaxed.evaluate(text).status).toBe('pass');
  });

  it('includes evidence in result', () => {
    const assertion = toNotRepeat();
    const result = assertion.evaluate('Unique content. More unique content. All different thoughts.');
    expect(result.evidence).toBeDefined();
    expect(result.evidence!.length).toBeGreaterThan(0);
  });

  it('reports duration', () => {
    const assertion = toNotRepeat();
    const result = assertion.evaluate('Some test text here for timing.');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── ASSERTION: toNotLoop ───────────────────────────────────────────────────────

describe('toNotLoop', () => {
  it('passes for non-looping content', () => {
    const text = [
      'Step 1: Initialize the project structure',
      'Step 2: Install required dependencies',
      'Step 3: Configure the build system',
      'Step 4: Write the first module now',
    ].join('\n');
    const assertion = toNotLoop();
    expect(assertion.evaluate(text).status).toBe('pass');
  });

  it('fails for looping content', () => {
    const text = [
      'Attempting to fix the error now',
      'Error: cannot find module X',
      'Attempting to fix the error now',
      'Error: cannot find module X',
      'Attempting to fix the error now',
      'Error: cannot find module X',
    ].join('\n');
    const assertion = toNotLoop();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('loop');
  });

  it('respects maxLoopRatio option', () => {
    const text = [
      'Unique start content here',
      'Unique line two here now',
      'A small repeated element here',
      'A small repeated element here',
      'Unique ending content here now',
    ].join('\n');
    const relaxed = toNotLoop({ maxLoopRatio: 0.9 });
    expect(relaxed.evaluate(text).status).toBe('pass');
  });

  it('provides evidence about the longest loop', () => {
    const text = [
      'Build started running now ok',
      'Build failed with error msg',
      'Build started running now ok',
      'Build failed with error msg',
      'Build started running now ok',
      'Build failed with error msg',
    ].join('\n');
    const assertion = toNotLoop();
    const result = assertion.evaluate(text);
    if (result.status === 'fail') {
      expect(result.evidence).toBeDefined();
      expect(result.evidence!.length).toBeGreaterThan(0);
    }
  });

  it('handles minor loops within tolerance', () => {
    const text = [
      'First line unique here ok',
      'Second line unique here ok',
      'Repeated line content element',
      'Repeated line content element',
      'Third unique line here ok',
      'Fourth unique line here ok',
      'Fifth unique line here ok',
    ].join('\n');
    const assertion = toNotLoop({ maxLoopRatio: 0.5 });
    expect(assertion.evaluate(text).status).toBe('pass');
  });
});

// ─── ASSERTION: toNotBeSaturated ────────────────────────────────────────────────

describe('toNotBeSaturated', () => {
  it('passes for diverse content', () => {
    const text = 'TypeScript enables strong typing for projects. Python emphasizes readability above all. ' +
      'Rust guarantees memory safety by design. Go simplifies concurrency patterns.';
    const assertion = toNotBeSaturated();
    expect(assertion.evaluate(text).status).toBe('pass');
  });

  it('fails for phrase-saturated content', () => {
    const text = 'the system works well and the system works great and the system works fine ' +
      'because the system works well and the system works correctly and the system works properly';
    const assertion = toNotBeSaturated({ ngramSize: 2, saturationThreshold: 0.15 });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('repeated phrases');
  });

  it('includes dominant n-gram in evidence', () => {
    const text = 'foo bar baz foo bar baz foo bar baz foo bar baz foo bar baz';
    const assertion = toNotBeSaturated({ ngramSize: 3, saturationThreshold: 0.1 });
    const result = assertion.evaluate(text);
    if (result.status === 'fail') {
      expect(result.evidence).toBeDefined();
    }
  });

  it('respects saturationThreshold', () => {
    const text = 'some repeated phrase here. some repeated phrase there. other content here.';
    const relaxed = toNotBeSaturated({ saturationThreshold: 0.95 });
    expect(relaxed.evaluate(text).status).toBe('pass');
  });
});

// ─── ASSERTION: toNotBeRepetitive ───────────────────────────────────────────────

describe('toNotBeRepetitive', () => {
  it('passes for novel content', () => {
    const text = 'Machine learning models require training data for accuracy. ' +
      'Neural networks have multiple layers of computation. ' +
      'Gradient descent optimizes the loss function iteratively. ' +
      'Regularization prevents overfitting in complex models.';
    const assertion = toNotBeRepetitive();
    expect(assertion.evaluate(text).status).toBe('pass');
  });

  it('fails for highly repetitive content', () => {
    const segment = 'The agent is repeating the same analysis output.';
    const lines = Array(6).fill(segment);
    const text = lines.join('\n');
    const assertion = toNotBeRepetitive();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.evidence).toBeDefined();
  });

  it('provides combined score in evidence', () => {
    const assertion = toNotBeRepetitive();
    const result = assertion.evaluate('All unique text with varied vocabulary and different sentence structures here.');
    expect(result.evidence).toContain('score');
  });

  it('respects threshold option', () => {
    const segment = 'A sentence that repeats a few times.';
    const text = `${segment} ${segment} Other content here entirely different.`;
    const relaxed = toNotBeRepetitive({ threshold: 0.95 });
    expect(relaxed.evaluate(text).status).toBe('pass');
  });
});

// ─── ASSERTION: toNotExceedRepetitions ──────────────────────────────────────────

describe('toNotExceedRepetitions', () => {
  it('passes when no segment exceeds the limit', () => {
    const text = 'First unique thought here today. Second unique thought here today. Third unique thought here today.';
    const assertion = toNotExceedRepetitions(3);
    expect(assertion.evaluate(text).status).toBe('pass');
  });

  it('fails when a segment exceeds the limit', () => {
    const segment = 'This exact sentence repeats too many times.';
    const text = Array(5).fill(segment).join(' ');
    const assertion = toNotExceedRepetitions(3);
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('repeats');
  });

  it('passes when repetitions are at the limit', () => {
    const segment = 'This segment appears exactly three times.';
    const text = `${segment} ${segment} ${segment} Other content here.`;
    const assertion = toNotExceedRepetitions(3);
    expect(assertion.evaluate(text).status).toBe('pass');
  });

  it('uses default maxRepetitions of 3', () => {
    const segment = 'Default threshold sentence here now today.';
    const text = Array(4).fill(segment).join(' ');
    const assertion = toNotExceedRepetitions();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
  });

  it('provides details about the worst offender', () => {
    const segment = 'This keeps getting repeated many many times.';
    const text = Array(7).fill(segment).join(' ');
    const assertion = toNotExceedRepetitions(2);
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.actual).toContain('7');
  });

  it('handles content with no repetition', () => {
    const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota kappa.'
    const assertion = toNotExceedRepetitions(2);
    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
    expect(result.evidence).toBeDefined();
  });
});