/**
 * Seam-integrity tests for the Completeness Checker split.
 *
 * `completeness-analysis.ts` was decomposed into three seams:
 *   - completeness-patterns.ts  (stub / filler / truncation tables)
 *   - completeness-metrics.ts   (counting helpers + analyzeContent / detectStub)
 *   - completeness-analysis.ts  (checkCompleteness policy engine + re-exports)
 *
 * These tests pin the split so a future refactor can't silently break the
 * import paths the public barrel and existing tests depend on.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STUB_PATTERNS,
  DEFAULT_FILLER_PHRASES,
  TRUNCATION_MARKERS,
} from '../src/checks/completeness-patterns.js';
import {
  analyzeContent as analyzeFromMetrics,
  detectStub as detectStubFromMetrics,
  detectTruncation,
  countWords,
  countSentences,
  countParagraphs,
  uniqueWordRatio,
  checkBalancedBrackets,
  findConsecutiveDuplicates,
} from '../src/checks/completeness-metrics.js';
import {
  analyzeContent,
  detectStub,
  checkCompleteness,
} from '../src/checks/completeness-analysis.js';

describe('completeness-patterns seam', () => {
  it('exports non-empty pattern tables', () => {
    expect(DEFAULT_STUB_PATTERNS.length).toBeGreaterThan(0);
    expect(DEFAULT_FILLER_PHRASES.length).toBeGreaterThan(0);
    expect(TRUNCATION_MARKERS.length).toBeGreaterThan(0);
  });
});

describe('completeness-metrics seam', () => {
  it('counting helpers behave deterministically', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countSentences('Hi there. How are you?')).toBe(2);
    expect(countParagraphs('a\n\nb\n\nc')).toBe(3);
    expect(uniqueWordRatio('a a b')).toBeCloseTo(2 / 3, 5);
  });

  it('detects truncation and stubs via pattern tables', () => {
    expect(detectTruncation('some text [truncated]')).toBe(true);
    expect(detectTruncation('a complete sentence.')).toBe(false);
    expect(detectStubFromMetrics('TODO: fill this in')).toBe(true);
  });

  it('checks bracket balance and duplicate runs', () => {
    expect(checkBalancedBrackets('(a[b]{c})').balanced).toBe(true);
    expect(checkBalancedBrackets('(a[b)').balanced).toBe(false);
    expect(findConsecutiveDuplicates('x\nx\nx').maxRun).toBe(3);
  });
});

describe('completeness-analysis re-export stability', () => {
  it('re-exports the same function identities from the metrics seam', () => {
    expect(analyzeContent).toBe(analyzeFromMetrics);
    expect(detectStub).toBe(detectStubFromMetrics);
  });

  it('checkCompleteness still runs end-to-end over the seams', () => {
    const r = checkCompleteness('This is a genuinely substantive and complete sentence.');
    expect(r.complete).toBe(true);
    expect(r.metrics.wordCount).toBeGreaterThan(0);
  });
});
