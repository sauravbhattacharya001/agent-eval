/**
 * Seam tests for the Actionability check split.
 *
 * `actionability.ts` was split into four sibling seams — `actionability-types.ts`,
 * `actionability-patterns.ts`, `actionability-extraction.ts`, and
 * `actionability-scoring.ts` — with `actionability.ts` kept as the public barrel
 * (re-exporting everything) plus the Tier-3 wiring (`ACTIONABILITY_RUBRIC` and
 * the assertion factories).
 *
 * The behavioural suite in `actionability.test.ts` imports everything from
 * `actionability.js` and therefore only reaches the moved units transitively.
 * These tests pin the seam boundary itself:
 *   1. each unit is importable from its OWN new module, and
 *   2. `actionability.js` re-exports the *same function reference* (the barrel
 *      cannot silently diverge from the seam),
 * plus a few direct unit checks that exercise a seam through its own home — so a
 * future refactor that touches one seam can't quietly break another's contract.
 */

import { describe, it, expect } from 'vitest';

// Seam modules — imported directly from their new homes.
import {
  detectResponseType as detectResponseTypeSeam,
} from '../src/checks/actionability-patterns.js';
import {
  splitIntoSentences as splitIntoSentencesSeam,
  extractActionableElements as extractActionableElementsSeam,
  detectFiller as detectFillerSeam,
} from '../src/checks/actionability-extraction.js';
import {
  scoreSentence as scoreSentenceSeam,
  analyzeActionability as analyzeActionabilitySeam,
} from '../src/checks/actionability-scoring.js';

// Public barrel — what consumers import.
import {
  detectResponseType,
  splitIntoSentences,
  extractActionableElements,
  detectFiller,
  scoreSentence,
  analyzeActionability,
  type ActionableElement,
  type FillerPattern,
} from '../src/checks/actionability.js';

// ─── RE-EXPORT IDENTITY ──────────────────────────────────────────────────────────

describe('actionability.ts re-exports the same references as its seams', () => {
  it('pattern/classification seam (actionability-patterns.ts)', () => {
    expect(detectResponseType).toBe(detectResponseTypeSeam);
  });

  it('extraction seam (actionability-extraction.ts)', () => {
    expect(splitIntoSentences).toBe(splitIntoSentencesSeam);
    expect(extractActionableElements).toBe(extractActionableElementsSeam);
    expect(detectFiller).toBe(detectFillerSeam);
  });

  it('scoring seam (actionability-scoring.ts)', () => {
    expect(scoreSentence).toBe(scoreSentenceSeam);
    expect(analyzeActionability).toBe(analyzeActionabilitySeam);
  });
});

// ─── DIRECT UNIT CHECKS THROUGH EACH SEAM ────────────────────────────────────────

describe('patterns seam: detectResponseType classifies via task text', () => {
  it('detects code-review tasks', () => {
    expect(detectResponseTypeSeam('Please review this pull request and leave comments')).toBe('code-review');
  });

  it('detects how-to tasks', () => {
    expect(detectResponseTypeSeam('How to set up the dev environment')).toBe('how-to');
  });

  it('falls back to general when nothing matches', () => {
    expect(detectResponseTypeSeam('xyzzy plugh frobozz')).toBe('general');
  });
});

describe('extraction seam: segmentation + signal/filler extraction', () => {
  it('splitIntoSentences keeps a fenced code block as one atomic sentence', () => {
    const text = 'Run the build first.\n```sh\nnpm run build\n```\nThen check the output.';
    const sentences = splitIntoSentencesSeam(text);
    const codeBlock = sentences.find((s) => s.text.startsWith('```'));
    expect(codeBlock).toBeDefined();
    expect(codeBlock?.text).toContain('npm run build');
    // Offsets must point back into the original text.
    if (codeBlock) {
      expect(text.slice(codeBlock.startOffset, codeBlock.endOffset)).toContain('npm run build');
    }
  });

  it('extractActionableElements flags an imperative command sentence', () => {
    const elements: ActionableElement[] = extractActionableElementsSeam('Run `npm install` to fetch deps', 0);
    const kinds = new Set(elements.map((e) => e.kind));
    expect(kinds.has('imperative')).toBe(true);
    expect(kinds.has('code-snippet')).toBe(true);
  });

  it('detectFiller flags a hedge / non-answer', () => {
    const patterns: FillerPattern[] = detectFillerSeam('There are many ways to approach this problem', 0);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.kind === 'non-answer' || p.kind === 'hedge')).toBe(true);
  });
});

describe('scoring seam: scoreSentence + analyzeActionability', () => {
  it('scoreSentence rewards concrete elements over filler', () => {
    const actionable = extractActionableElementsSeam('Run `npm test` in the `src/` directory', 0);
    const concreteScore = scoreSentenceSeam('Run `npm test` in the `src/` directory', actionable, [], 'how-to');
    const fillerOnly = detectFillerSeam('It depends on your situation', 0);
    const vagueScore = scoreSentenceSeam('It depends on your situation', [], fillerOnly, 'how-to');
    expect(concreteScore).toBeGreaterThan(vagueScore);
  });

  it('analyzeActionability returns a confident empty-output verdict', () => {
    const result = analyzeActionabilitySeam('');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(1);
    expect(result.summary).toMatch(/empty/i);
  });

  it('analyzeActionability scores a concrete answer above a filler answer', () => {
    const concrete = analyzeActionabilitySeam(
      'Edit `src/index.ts` and add `export const x = 1`. Then run `npm run build` to verify.',
      { responseType: 'fix' },
    );
    const filler = analyzeActionabilitySeam(
      'It depends. There are many approaches. Consider best practices and ensure quality.',
      { responseType: 'fix' },
    );
    expect(concrete.score).toBeGreaterThan(filler.score);
  });
});
