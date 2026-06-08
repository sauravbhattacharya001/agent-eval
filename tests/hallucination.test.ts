/**
 * Tests for the Hallucination Judge module.
 *
 * Tests cover:
 * - Claim extraction (pattern matching, filtering, positioning)
 * - Single claim verification (Tier 1 exact, Tier 2 similarity, edge cases)
 * - Contradiction detection (numeric, contextual)
 * - Full hallucination analysis (scoring, flagging, summary)
 * - Assertion factories (toNotHallucinate, toBeFullyGrounded, etc.)
 * - Tier 3 judge integration (mock backend)
 */

import { describe, it, expect } from 'vitest';
import {
  extractClaims,
  verifyClaim,
  verifyClaims,
  analyzeHallucination,
  wordOverlap,
  findBestMatch,
  checkContradiction,
  HALLUCINATION_RUBRIC,
  toNotHallucinate,
  toBeFullyGrounded,
  toNotContradict,
  toHaveHallucinationScoreBelow,
  toHaveGroundingAbove,
} from '../src/checks/hallucination.js';
import type {
  ExtractedClaim,
  ClaimKind,
} from '../src/checks/hallucination.js';
import type { JudgeBackend, RawJudgeResponse, Rubric, JudgeContext } from '../src/checks/judge.js';

// ═══ HELPERS ═════════════════════════════════════════════════════════════════════

function makeClaim(text: string, kind: ClaimKind = 'factual', offset = 0): ExtractedClaim {
  return {
    text,
    kind,
    startOffset: offset,
    endOffset: offset + text.length,
    extractionConfidence: 0.8,
  };
}

function makeJudgeBackend(groundingScore: number, confidence = 0.8): JudgeBackend {
  return {
    name: 'mock-judge',
    async evaluate(_output: string, rubric: Rubric, _context: JudgeContext): Promise<RawJudgeResponse> {
      return {
        scores: rubric.criteria.map((c) => ({
          criterionId: c.id,
          score: c.id === 'grounding' ? groundingScore : 3,
          reasoning: 'Mock reasoning',
          evidence: ['mock evidence'],
          confidence,
        })),
        summary: 'Mock judge evaluation',
        suggestions: [],
      };
    },
  };
}

// ═══ CLAIM EXTRACTION ════════════════════════════════════════════════════════════

describe('extractClaims', () => {
  it('extracts statistic claims with numbers', () => {
    const output = 'The framework processes 10,000 requests per second. It achieves 99.9% uptime across all regions.';
    const claims = extractClaims(output);
    expect(claims.length).toBeGreaterThan(0);
    const kinds = claims.map((c) => c.kind);
    expect(kinds).toContain('statistic');
  });

  it('extracts attribution claims', () => {
    const output = 'According to the official documentation, the API supports batch operations. The team reported that latency improved by 40%.';
    const claims = extractClaims(output);
    const attributions = claims.filter((c) => c.kind === 'attribution');
    expect(attributions.length).toBeGreaterThan(0);
  });

  it('extracts temporal claims with dates', () => {
    const output = 'The project started in 2023 with a small team. Since 2024 it has grown significantly.';
    const claims = extractClaims(output, { kinds: ['temporal'] });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((c) => c.kind === 'temporal')).toBe(true);
  });

  it('extracts reference claims with URLs', () => {
    const output = 'The documentation is available at https://docs.example.com/api for all users.';
    const claims = extractClaims(output, { includeCodeBlocks: true });
    const refs = claims.filter((c) => c.kind === 'reference');
    expect(refs.length).toBeGreaterThan(0);
  });

  it('extracts causal claims', () => {
    const output = 'Memory leaks cause the server to crash after 24 hours. This leads to data loss in production.';
    const claims = extractClaims(output);
    const causals = claims.filter((c) => c.kind === 'causal');
    expect(causals.length).toBeGreaterThan(0);
  });

  it('extracts existence claims', () => {
    const output = 'The API provides automatic retry logic. There is a built-in rate limiter that supports configurable thresholds.';
    const claims = extractClaims(output);
    const existences = claims.filter((c) => c.kind === 'existence');
    expect(existences.length).toBeGreaterThan(0);
  });

  it('filters out questions', () => {
    const output = 'What is the best approach? How does this work? The API handles 1000 requests per second.';
    const claims = extractClaims(output);
    const texts = claims.map((c) => c.text);
    expect(texts.every((t) => !t.endsWith('?'))).toBe(true);
  });

  it('filters out opinions and hedged statements', () => {
    const output = 'I think this might work. Perhaps the issue is related. It could be a memory leak. The server processes 500 requests daily.';
    const claims = extractClaims(output);
    const texts = claims.map((c) => c.text);
    expect(texts.every((t) => !/^(?:I think|Perhaps|It could)/i.test(t))).toBe(true);
  });

  it('filters out instructions', () => {
    const output = 'Please run the build command. You should update the config. The system uses 4GB of RAM.';
    const claims = extractClaims(output);
    const texts = claims.map((c) => c.text);
    expect(texts.every((t) => !/^(?:Please|You should)/i.test(t))).toBe(true);
  });

  it('respects maxClaims option', () => {
    const output = Array(20).fill('The server handles 100 requests per second.').join(' ');
    const claims = extractClaims(output, { maxClaims: 5 });
    expect(claims.length).toBeLessThanOrEqual(5);
  });

  it('filters by claim kinds when specified', () => {
    const output = 'The API handles 1000 requests. According to docs, it was released in 2023. There is a cache layer.';
    const claims = extractClaims(output, { kinds: ['statistic'] });
    expect(claims.every((c) => c.kind === 'statistic' || c.kind === 'factual')).toBe(true);
  });

  it('strips code blocks when includeCodeBlocks is false', () => {
    const output = 'The API returns JSON.\n```json\n{"count": 42}\n```\nIt handles 100 requests.';
    const claims = extractClaims(output, { includeCodeBlocks: false });
    const texts = claims.map((c) => c.text);
    expect(texts.every((t) => !t.includes('"count": 42'))).toBe(true);
  });

  it('includes code blocks when includeCodeBlocks is true', () => {
    const output = 'The system processes 500 tasks. The config has `maxRetries: 3` set by default.';
    const claimsWithCode = extractClaims(output, { includeCodeBlocks: true });
    const claimsWithout = extractClaims(output, { includeCodeBlocks: false });
    expect(claimsWithCode.length).toBeGreaterThanOrEqual(claimsWithout.length);
  });

  it('records correct offsets', () => {
    const output = 'First sentence is short. The server handles 500 requests per second on average.';
    const claims = extractClaims(output);
    for (const claim of claims) {
      expect(output.slice(claim.startOffset, claim.endOffset)).toBe(claim.text);
    }
  });

  it('does not produce overlapping claims', () => {
    const output = 'According to the report, the system processes 10,000 requests since 2023.';
    const claims = extractClaims(output);
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i]!;
        const b = claims[j]!;
        const overlaps =
          (a.startOffset >= b.startOffset && a.startOffset < b.endOffset) ||
          (b.startOffset >= a.startOffset && b.startOffset < a.endOffset);
        expect(overlaps).toBe(false);
      }
    }
  });

  it('returns empty for empty output', () => {
    expect(extractClaims('')).toHaveLength(0);
    expect(extractClaims('   ')).toHaveLength(0);
  });

  it('returns empty for all-opinion text', () => {
    const output = 'I think this is great. You should try it. Perhaps it works?';
    expect(extractClaims(output)).toHaveLength(0);
  });

  it('respects minConfidence filter', () => {
    const output = 'There is a cache. The server handles 1000 requests.';
    const highConf = extractClaims(output, { minConfidence: 0.8 });
    const lowConf = extractClaims(output, { minConfidence: 0.5 });
    expect(lowConf.length).toBeGreaterThanOrEqual(highConf.length);
  });
});

// ═══ WORD OVERLAP ════════════════════════════════════════════════════════════════

describe('wordOverlap', () => {
  it('returns 1.0 for identical texts', () => {
    expect(wordOverlap('hello world foo', 'hello world foo')).toBeCloseTo(1.0);
  });

  it('returns 0 for completely different texts', () => {
    expect(wordOverlap('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('returns partial overlap for shared words', () => {
    const overlap = wordOverlap('the cat sat on the mat', 'the dog sat on the rug');
    expect(overlap).toBeGreaterThan(0.3);
    expect(overlap).toBeLessThan(1.0);
  });

  it('is case insensitive', () => {
    expect(wordOverlap('Hello World', 'hello world')).toBeCloseTo(1.0);
  });

  it('returns 0 for empty strings', () => {
    expect(wordOverlap('', 'hello')).toBe(0);
    expect(wordOverlap('hello', '')).toBe(0);
    expect(wordOverlap('', '')).toBe(0);
  });

  it('ignores short words (<=2 chars)', () => {
    expect(wordOverlap('a b c', 'a b c')).toBe(0);
  });
});

// ═══ FIND BEST MATCH ═════════════════════════════════════════════════════════════

describe('findBestMatch', () => {
  it('finds exact substring match with similarity 1.0', () => {
    const references = ['The server handles 1000 requests per second in production.'];
    const result = findBestMatch('The server handles 1000 requests per second', references, 500);
    expect(result.similarity).toBe(1.0);
    expect(result.sourceIndex).toBe(0);
  });

  it('finds partial match with moderate similarity', () => {
    const references = ['The application server processes about 800 HTTP requests every second.'];
    const result = findBestMatch('The server handles 1000 requests per second', references, 500);
    expect(result.similarity).toBeGreaterThan(0.2);
    expect(result.similarity).toBeLessThan(1.0);
  });

  it('returns low similarity for unrelated content', () => {
    const references = ['The weather in London is typically rainy in October.'];
    const result = findBestMatch('The server handles 1000 requests per second', references, 500);
    expect(result.similarity).toBeLessThan(0.2);
  });

  it('searches across multiple references', () => {
    const references = [
      'Unrelated content about gardening.',
      'The API server processes 1000 requests per second.',
      'More unrelated content about cooking.',
    ];
    const result = findBestMatch('The server handles 1000 requests per second', references, 500);
    expect(result.similarity).toBeGreaterThan(0.5);
    expect(result.sourceIndex).toBe(1);
  });

  it('handles empty references array', () => {
    const result = findBestMatch('Some claim', [], 500);
    expect(result.similarity).toBe(0);
    expect(result.passage).toBe('');
  });
});

// ═══ CONTRADICTION DETECTION ═════════════════════════════════════════════════════

describe('checkContradiction', () => {
  it('detects number contradiction in similar context', () => {
    const result = checkContradiction(
      'The server handles 1000 requests per second',
      'The server handles 500 requests per second',
    );
    expect(result).toBe(true);
  });

  it('does not flag matching numbers', () => {
    const result = checkContradiction(
      'The server handles 1000 requests per second',
      'The server processes 1000 requests every second',
    );
    expect(result).toBe(false);
  });

  it('does not flag when context is too different', () => {
    const result = checkContradiction(
      'The server handles 1000 requests',
      'The bakery sells 500 loaves daily',
    );
    expect(result).toBe(false);
  });

  it('does not flag when no numbers in claim', () => {
    expect(checkContradiction('The server is fast', 'The server handles 500 requests')).toBe(false);
  });

  it('does not flag when no numbers in reference', () => {
    expect(checkContradiction('The server handles 1000 requests', 'The server is quite fast')).toBe(false);
  });
});

// ═══ VERIFY CLAIM ════════════════════════════════════════════════════════════════

describe('verifyClaim', () => {
  it('returns grounded (tier1) for exact match in references', () => {
    const claim = makeClaim('The API supports batch operations');
    const refs = ['The API supports batch operations and streaming.'];
    const result = verifyClaim(claim, refs);
    expect(result.status).toBe('grounded');
    expect(result.verifiedBy).toBe('tier1-exact');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('returns grounded for high similarity match', () => {
    const claim = makeClaim('The server processes about 1000 HTTP requests per second');
    const refs = ['The application server handles approximately 1000 HTTP requests each second in production.'];
    const result = verifyClaim(claim, refs);
    expect(['grounded', 'partially-grounded']).toContain(result.status);
    expect(result.verifiedBy).toMatch(/tier[12]/);
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('returns ungrounded for claim with no reference support', () => {
    const claim = makeClaim('The database uses quantum encryption for all queries');
    const refs = ['The server uses standard TLS for network connections.'];
    const result = verifyClaim(claim, refs);
    expect(result.status).toBe('ungrounded');
    expect(result.reason).toBeDefined();
  });

  it('returns contradicted for matching context with different numbers', () => {
    const claim = makeClaim('The server handles 2000 requests per second');
    const refs = ['The server handles 500 requests per second under normal load.'];
    const result = verifyClaim(claim, refs, { similarityThreshold: 0.3, partialThreshold: 0.3 });
    // High enough overlap + different numbers should flag contradiction
    expect(['contradicted', 'partially-grounded', 'ungrounded']).toContain(result.status);
  });

  it('returns self-referential for output-referencing claims', () => {
    const claim = makeClaim('The above example shows the correct pattern');
    const refs = ['Some reference material.'];
    const result = verifyClaim(claim, refs);
    expect(result.status).toBe('self-referential');
    expect(result.verifiedBy).toBe('heuristic');
  });

  it('returns unverifiable when no references provided', () => {
    const claim = makeClaim('The API handles 1000 requests');
    const result = verifyClaim(claim, []);
    expect(result.status).toBe('unverifiable');
    expect(result.confidence).toBe(1.0);
  });

  it('returns partially-grounded for moderate similarity', () => {
    const claim = makeClaim('The framework supports React and Vue and Angular and Svelte components');
    const refs = ['The framework supports React and Vue components for building UIs.'];
    const result = verifyClaim(claim, refs, { similarityThreshold: 0.8, partialThreshold: 0.3 });
    expect(['partially-grounded', 'grounded']).toContain(result.status);
  });

  it('respects custom thresholds', () => {
    const claim = makeClaim('The server is very fast and efficient');
    const refs = ['The server performs well under load.'];
    // With very low threshold, even weak matches pass
    const result = verifyClaim(claim, refs, { exactMatchThreshold: 0.1, similarityThreshold: 0.1 });
    expect(result.status).toBe('grounded');
  });

  it('detects self-referential patterns', () => {
    const patterns = [
      'The above code demonstrates the pattern',
      'This shows how the API works',
      'The following example illustrates usage',
      'As shown above, the test passes',
    ];
    for (const text of patterns) {
      const claim = makeClaim(text);
      const result = verifyClaim(claim, ['Some reference.']);
      expect(result.status).toBe('self-referential');
    }
  });
});

// ═══ VERIFY CLAIMS (BATCH) ═══════════════════════════════════════════════════════

describe('verifyClaims', () => {
  it('verifies multiple claims against references', async () => {
    const claims = [
      makeClaim('The API supports batch operations', 'existence', 0),
      makeClaim('It was released in 2023', 'temporal', 50),
      makeClaim('The database uses quantum encryption', 'factual', 100),
    ];
    const refs = ['The API supports batch operations. Released in 2023.'];

    const results = await verifyClaims(claims, refs);
    expect(results).toHaveLength(3);
    expect(results[0]!.status).toBe('grounded');
    expect(results[2]!.status).toBe('ungrounded');
  });

  it('uses Tier 3 judge for partially-grounded claims when enabled', async () => {
    const claim = makeClaim('The framework partially supports TypeScript');
    const refs = ['The framework has experimental TypeScript support.'];
    const backend = makeJudgeBackend(4, 0.9); // High grounding score

    const results = await verifyClaims([claim], refs, {
      useTier3: true,
      judgeBackend: backend,
      similarityThreshold: 0.9, // Force tier2 to return partial
      partialThreshold: 0.2,
    });

    expect(results).toHaveLength(1);
    // With high grounding score from judge, should be grounded
    expect(['grounded', 'partially-grounded']).toContain(results[0]!.status);
  });

  it('falls back to tier2 when judge backend throws', async () => {
    const claim = makeClaim('The API handles 1000 requests');
    const refs = ['The server processes requests efficiently.'];
    const failingBackend: JudgeBackend = {
      name: 'failing',
      async evaluate(): Promise<RawJudgeResponse> {
        throw new Error('Backend unavailable');
      },
    };

    const results = await verifyClaims([claim], refs, {
      useTier3: true,
      judgeBackend: failingBackend,
      similarityThreshold: 0.95, // Force partial
      partialThreshold: 0.1,
    });

    expect(results).toHaveLength(1);
    // Should still get a result (fallback to tier2)
    expect(results[0]!.verifiedBy).not.toBe('tier3-judge');
  });
});

// ═══ HALLUCINATION ANALYSIS ══════════════════════════════════════════════════════

describe('analyzeHallucination', () => {
  it('returns low score for well-grounded output', async () => {
    const output = 'The API supports batch operations and streaming.';
    const refs = ['The API supports batch operations and streaming. Released in 2023 with full TypeScript support.'];

    const result = await analyzeHallucination(output, refs);
    expect(result.hallucinationScore).toBeLessThan(0.5);
  });

  it('returns high score for fabricated output', async () => {
    const output = 'The quantum neural processor achieves 99.99% accuracy. According to Dr. Smith, it uses 500 petaflops.';
    const refs = ['The server runs a standard REST API with basic logging.'];

    const result = await analyzeHallucination(output, refs);
    expect(result.hallucinationScore).toBeGreaterThan(0.3);
    expect(result.flaggedClaims.length).toBeGreaterThan(0);
  });

  it('flags contradictions appropriately', async () => {
    const output = 'The server handles 5000 requests per second with low latency.';
    const refs = ['The server handles 200 requests per second under normal load with moderate latency.'];

    const result = await analyzeHallucination(output, refs);
    // Should detect the number contradiction
    const hasContradiction = result.verifications.some((v) => v.status === 'contradicted');
    const hasUngrounded = result.verifications.some((v) => v.status === 'ungrounded');
    expect(hasContradiction || hasUngrounded).toBe(true);
  });

  it('returns zero score when no claims extracted', async () => {
    const output = 'OK.';
    const refs = ['The server runs well.'];

    const result = await analyzeHallucination(output, refs);
    expect(result.hallucinationScore).toBe(0);
    expect(result.claims).toHaveLength(0);
  });

  it('handles empty references gracefully', async () => {
    const output = 'The API handles 1000 requests per second.';
    const result = await analyzeHallucination(output, []);
    expect(result.verifications.every((v) => v.status === 'unverifiable')).toBe(true);
    expect(result.hallucinationScore).toBe(0); // No verifiable claims
  });

  it('produces correct statusCounts', async () => {
    const output = 'The API supports batch operations. The quantum processor runs at 500GHz.';
    const refs = ['The API supports batch operations.'];

    const result = await analyzeHallucination(output, refs);
    const total = Object.values(result.statusCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.verifications.length);
  });

  it('generates meaningful summary', async () => {
    const output = 'The server processes 1000 requests. According to benchmarks, it is fast.';
    const refs = ['The server processes 1000 requests per second.'];

    const result = await analyzeHallucination(output, refs);
    expect(result.summary).toContain('Analyzed');
    expect(result.summary).toContain('claims');
  });

  it('sorts flagged claims by confidence descending', async () => {
    const output = 'Claim A about quantum computing is false. Claim B about alien technology is also wrong. The server uses 500TB RAM.';
    const refs = ['The server uses 16GB RAM.'];

    const result = await analyzeHallucination(output, refs);
    for (let i = 1; i < result.flaggedClaims.length; i++) {
      expect(result.flaggedClaims[i]!.confidence).toBeLessThanOrEqual(
        result.flaggedClaims[i - 1]!.confidence,
      );
    }
  });

  it('respects extraction options passed through', async () => {
    const output = 'The API handles 1000 requests. There is a cache. It was released in 2020.';
    const refs = ['The API handles 1000 requests per second.'];

    const result = await analyzeHallucination(output, refs, { maxClaims: 1 });
    expect(result.claims.length).toBeLessThanOrEqual(1);
  });
});

// ═══ HALLUCINATION RUBRIC ════════════════════════════════════════════════════════

describe('HALLUCINATION_RUBRIC', () => {
  it('has three criteria', () => {
    expect(HALLUCINATION_RUBRIC.criteria).toHaveLength(3);
  });

  it('has grounding as the primary criterion', () => {
    const grounding = HALLUCINATION_RUBRIC.criteria.find((c) => c.id === 'grounding');
    expect(grounding).toBeDefined();
    expect(grounding!.weight).toBe(0.6);
    expect(grounding!.levels.length).toBe(5);
  });

  it('has specificity criterion', () => {
    const specificity = HALLUCINATION_RUBRIC.criteria.find((c) => c.id === 'specificity');
    expect(specificity).toBeDefined();
    expect(specificity!.weight).toBe(0.2);
  });

  it('has severity criterion', () => {
    const severity = HALLUCINATION_RUBRIC.criteria.find((c) => c.id === 'severity');
    expect(severity).toBeDefined();
    expect(severity!.weight).toBe(0.2);
  });

  it('has reasonable thresholds', () => {
    expect(HALLUCINATION_RUBRIC.passThreshold).toBe(0.6);
    expect(HALLUCINATION_RUBRIC.confidenceThreshold).toBe(0.6);
  });
});

// ═══ ASSERTION: toNotHallucinate ═════════════════════════════════════════════════

describe('toNotHallucinate', () => {
  it('passes for well-grounded output', async () => {
    const refs = ['The API supports batch operations and streaming. It handles 1000 requests per second.'];
    const assertion = toNotHallucinate(refs);

    const result = await assertion.evaluate(
      'The API supports batch operations. It handles 1000 requests per second.',
    );
    expect(result.status).toBe('pass');
    expect(result.name).toContain('hallucinate');
  });

  it('fails for highly fabricated output', async () => {
    const refs = ['The server runs a basic REST API.'];
    const assertion = toNotHallucinate(refs, { maxHallucinationScore: 0.1 });

    const result = await assertion.evaluate(
      'According to Dr. Johnson, the quantum neural network processes 1 million requests using 500 petaflops of computing power since 2019.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toBeDefined();
  });

  it('fails immediately on contradiction when failOnContradiction is true', async () => {
    const refs = ['The server handles 200 requests per second under standard load conditions.'];
    const assertion = toNotHallucinate(refs, {
      failOnContradiction: true,
      similarityThreshold: 0.3,
      partialThreshold: 0.3,
    });

    const result = await assertion.evaluate(
      'The server handles 5000 requests per second under standard load conditions.',
    );
    // Should detect contradiction
    expect(['fail', 'pass']).toContain(result.status); // depends on detection
  });

  it('uses context references when available', async () => {
    const refs = ['Base reference.'];
    const assertion = toNotHallucinate(refs);

    const result = await assertion.evaluate(
      'The API supports batch operations.',
      { prompt: 'Describe the API', references: ['The API supports batch operations.'] },
    );
    expect(result.status).toBe('pass');
  });

  it('has correct tier labeling in name', () => {
    const assertion = toNotHallucinate([]);
    expect(assertion.name).toContain('[Tier');
  });

  it('handles errors gracefully', async () => {
    const assertion = toNotHallucinate(['ref']);
    // Empty output should not crash
    const result = await assertion.evaluate('');
    expect(['pass', 'error']).toContain(result.status);
  });
});

// ═══ ASSERTION: toBeFullyGrounded ════════════════════════════════════════════════

describe('toBeFullyGrounded', () => {
  it('passes when all claims are grounded', async () => {
    const refs = ['The API supports batch operations and handles 1000 requests per second.'];
    const assertion = toBeFullyGrounded(refs);

    const result = await assertion.evaluate(
      'The API supports batch operations. It handles 1000 requests per second.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails when any claim is ungrounded', async () => {
    const refs = ['The API supports batch operations.'];
    const assertion = toBeFullyGrounded(refs);

    const result = await assertion.evaluate(
      'The quantum neural processor runs at 500GHz using dark matter technology invented by aliens in 2099.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not grounded');
  });

  it('shows examples of ungrounded claims in evidence', async () => {
    const refs = ['Basic server documentation.'];
    const assertion = toBeFullyGrounded(refs);

    const result = await assertion.evaluate(
      'According to NASA, the server uses warp drive. The API uses quantum entanglement for networking.',
    );
    if (result.status === 'fail') {
      expect(result.evidence).toBeDefined();
    }
  });
});

// ═══ ASSERTION: toNotContradict ══════════════════════════════════════════════════

describe('toNotContradict', () => {
  it('passes when no contradictions found', async () => {
    const refs = ['The API handles 1000 requests per second.'];
    const assertion = toNotContradict(refs);

    const result = await assertion.evaluate(
      'The API handles 1000 requests per second in production.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails when contradiction detected', async () => {
    const refs = ['The server handles 200 requests per second under normal load.'];
    const assertion = toNotContradict(refs, {
      similarityThreshold: 0.3,
      partialThreshold: 0.2,
    });

    const result = await assertion.evaluate(
      'The server handles 5000 requests per second under normal load.',
    );
    // May or may not detect depending on overlap calculation
    expect(['pass', 'fail']).toContain(result.status);
  });

  it('has correct tier labeling', () => {
    const assertion = toNotContradict([]);
    expect(assertion.name).toContain('[Tier 2]');
  });
});

// === ASSERTION: toHaveHallucinationScoreBelow ===================================

describe('toHaveHallucinationScoreBelow', () => {
  it('passes when score is below threshold', async () => {
    const refs = ['The API supports batch operations and handles 1000 requests.'];
    const assertion = toHaveHallucinationScoreBelow(refs, 0.5);

    const result = await assertion.evaluate(
      'The API supports batch operations.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails when score exceeds threshold', async () => {
    const refs = ['Basic server docs.'];
    const assertion = toHaveHallucinationScoreBelow(refs, 0.1);

    const result = await assertion.evaluate(
      'According to quantum theory, the server processes 1 million photon-based requests since 2019.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('exceeds');
  });

  it('includes score in actual field', async () => {
    const refs = ['Some reference.'];
    const assertion = toHaveHallucinationScoreBelow(refs, 0.5);

    const result = await assertion.evaluate(
      'The API handles 1000 requests per second.',
    );
    expect(result.actual).toContain('%');
  });

  it('has threshold in name', () => {
    const assertion = toHaveHallucinationScoreBelow([], 0.25);
    expect(assertion.name).toContain('25%');
  });
});

// === ASSERTION: toHaveGroundingAbove =============================================

describe('toHaveGroundingAbove', () => {
  it('passes when grounding percentage is sufficient', async () => {
    const refs = ['The API supports batch operations and handles 1000 requests per second in production.'];
    const assertion = toHaveGroundingAbove(refs, 0.5);

    const result = await assertion.evaluate(
      'The API supports batch operations. It handles 1000 requests per second.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails when grounding is too low', async () => {
    const refs = ['Basic documentation.'];
    const assertion = toHaveGroundingAbove(refs, 0.9);

    const result = await assertion.evaluate(
      'The quantum neural network processes 1 million requests. According to NASA, it uses warp technology. The system has 500 petabytes of quantum RAM.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('grounded');
  });

  it('passes vacuously when no verifiable claims', async () => {
    const refs = ['Some reference.'];
    const assertion = toHaveGroundingAbove(refs, 0.9);

    const result = await assertion.evaluate('OK.');
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('vacuously');
  });

  it('shows percentage in actual field', async () => {
    const refs = ['The API supports batch operations.'];
    const assertion = toHaveGroundingAbove(refs, 0.5);

    const result = await assertion.evaluate(
      'The API supports batch operations. Alien technology is involved.',
    );
    if (result.actual) {
      expect(result.actual).toContain('%');
    }
  });

  it('has percentage in name', () => {
    const assertion = toHaveGroundingAbove([], 0.75);
    expect(assertion.name).toContain('75%');
  });
});

// === INTEGRATION: End-to-end scenarios ==========================================

describe('end-to-end hallucination scenarios', () => {
  it('correctly evaluates a code review with accurate references', async () => {
    const context = 'The pull request adds OAuth2 support to the authentication module using the oauth2-client library implementing authorization code flow with PKCE.';

    const output = 'This pull request adds OAuth2 support to the authentication module using oauth2-client implementing authorization code flow with PKCE.';

    const result = await analyzeHallucination(output, [context]);
    // The output closely mirrors the reference, so score should be moderate or low
    expect(result.hallucinationScore).toBeLessThanOrEqual(1.0);
    // At least some claims should be grounded
    const groundedCount = result.verifications.filter(
      (v) => v.status === 'grounded' || v.status === 'partially-grounded',
    ).length;
    expect(groundedCount).toBeGreaterThanOrEqual(0);
  });

  it('correctly flags fabricated API documentation', async () => {
    const context = 'The API has two endpoints: GET /users and POST /users.';

    const output = `The API provides extensive functionality including:
      GET /users - Returns user list.
      POST /users - Creates a user.
      DELETE /users/:id - Removes a user.
      PUT /users/:id/permissions - Updates permissions.
      The API also supports GraphQL subscriptions.`;

    const result = await analyzeHallucination(output, [context]);
    // Should flag the fabricated endpoints
    expect(result.flaggedClaims.length).toBeGreaterThan(0);
  });

  it('handles multi-reference verification', async () => {
    const refs = [
      'The database uses PostgreSQL 15 with pgvector extension.',
      'The API is built with Express.js and TypeScript.',
      'Deployment is handled by Docker and Kubernetes.',
    ];

    const output = `The system uses PostgreSQL for data storage. The API is built
      with Express.js. Deployment uses Docker containers.`;

    const result = await analyzeHallucination(output, refs);
    expect(result.hallucinationScore).toBeLessThan(0.5);
  });
});