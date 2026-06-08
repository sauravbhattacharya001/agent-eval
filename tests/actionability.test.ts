/**
 * Tests for the Actionability Judge module.
 *
 * Tests cover:
 * - Response type detection (code-review, how-to, fix, summary, decision, explanation, general)
 * - Sentence splitting (plain text, code blocks, headings, bullet points)
 * - Actionable element extraction (imperative, code, files, commands, URLs, steps, values, decisions, examples)
 * - Filler detection (hedges, platitudes, weasel words, restatements, generic advice, circular, non-answers)
 * - Sentence scoring (positive signals, penalties, response-type weighting)
 * - Full actionability analysis (actionable output, filler output, mixed, empty, code-heavy)
 * - Assertion factories (toBeActionable, toHaveMinimalFiller, toBeSpecific, toPassActionabilityJudge, toHaveActionabilityAbove)
 * - ACTIONABILITY_RUBRIC structure validation
 */

import { describe, it, expect } from 'vitest';
import {
  detectResponseType,
  splitIntoSentences,
  extractActionableElements,
  detectFiller,
  scoreSentence,
  analyzeActionability,
  ACTIONABILITY_RUBRIC,
  toBeActionable,
  toHaveMinimalFiller,
  toBeSpecific,
  toPassActionabilityJudge,
  toHaveActionabilityAbove,
} from '../src/checks/actionability.js';
import type {
  ActionableElement,
  FillerPattern,
} from '../src/checks/actionability.js';
import type { JudgeBackend, RawJudgeResponse, Rubric, JudgeContext } from '../src/checks/judge.js';
import { validateRubric } from '../src/checks/judge.js';

// ═══ HELPERS ═════════════════════════════════════════════════════════════════════

function makeJudgeBackend(scores: Record<string, number>, confidence = 0.8): JudgeBackend {
  return {
    name: 'mock-actionability-judge',
    async evaluate(_output: string, rubric: Rubric, _context: JudgeContext): Promise<RawJudgeResponse> {
      return {
        scores: rubric.criteria.map((c) => ({
          criterionId: c.id,
          score: scores[c.id] ?? 3,
          reasoning: `Mock score for ${c.id}`,
          evidence: ['mock evidence'],
          confidence,
        })),
        summary: 'Mock actionability judge evaluation',
        suggestions: ['be more specific'],
      };
    },
  };
}

// ═══ RESPONSE TYPE DETECTION ═════════════════════════════════════════════════════

describe('detectResponseType', () => {
  it('detects code review tasks', () => {
    expect(detectResponseType('Review this PR for potential issues')).toBe('code-review');
    expect(detectResponseType('Please review the code changes in this pull request')).toBe('code-review');
    expect(detectResponseType('Check the diff and give feedback')).toBe('code-review');
  });

  it('detects how-to tasks', () => {
    expect(detectResponseType('How to set up ESLint for TypeScript')).toBe('how-to');
    expect(detectResponseType('Steps to configure Docker for production')).toBe('how-to');
    expect(detectResponseType('Guide me through installing PostgreSQL')).toBe('how-to');
  });

  it('detects fix tasks', () => {
    expect(detectResponseType('Fix the login bug causing crashes')).toBe('fix');
    expect(detectResponseType('Resolve the memory leak in the worker')).toBe('fix');
    expect(detectResponseType('Debug why tests are failing on CI')).toBe('fix');
  });

  it('detects summary tasks', () => {
    expect(detectResponseType('Summarize the changes in this release')).toBe('summary');
    expect(detectResponseType('Give me a brief overview of the architecture')).toBe('summary');
    expect(detectResponseType('TLDR of the discussion')).toBe('summary');
  });

  it('detects decision tasks', () => {
    expect(detectResponseType('Should I use React or Vue for this project?')).toBe('decision');
    expect(detectResponseType('Compare PostgreSQL vs MongoDB for our use case')).toBe('decision');
    expect(detectResponseType('Which testing framework do you recommend?')).toBe('decision');
  });

  it('detects explanation tasks', () => {
    expect(detectResponseType('Explain how async/await works in JavaScript')).toBe('explanation');
    expect(detectResponseType('What is dependency injection?')).toBe('explanation');
    expect(detectResponseType('Why does React re-render components?')).toBe('explanation');
  });

  it('falls back to general for ambiguous tasks', () => {
    expect(detectResponseType('Hello')).toBe('general');
    expect(detectResponseType('Do the thing')).toBe('general');
    expect(detectResponseType('Process the data')).toBe('general');
  });
});

// ═══ SENTENCE SPLITTING ══════════════════════════════════════════════════════════

describe('splitIntoSentences', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoSentences('')).toEqual([]);
    expect(splitIntoSentences('   ')).toEqual([]);
  });

  it('splits on sentence-ending punctuation', () => {
    const sentences = splitIntoSentences('First sentence. Second sentence. Third.');
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences[0]!.text).toContain('First');
  });

  it('splits on newlines', () => {
    const sentences = splitIntoSentences('Line one\nLine two\nLine three');
    expect(sentences.length).toBe(3);
    expect(sentences[0]!.text).toContain('Line one');
    expect(sentences[2]!.text).toContain('Line three');
  });

  it('preserves code blocks as single sentences', () => {
    const input = 'Before.\n```typescript\nconst x = 1;\nconst y = 2;\n```\nAfter.';
    const sentences = splitIntoSentences(input);
    const codeBlock = sentences.find((s) => s.text.includes('```'));
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.text).toContain('const x = 1');
    expect(codeBlock!.text).toContain('const y = 2');
  });

  it('tracks offsets correctly', () => {
    const input = 'Hello world. Goodbye world.';
    const sentences = splitIntoSentences(input);
    expect(sentences[0]!.startOffset).toBe(0);
  });
});

// ═══ ACTIONABLE ELEMENT EXTRACTION ═══════════════════════════════════════════════

describe('extractActionableElements', () => {
  it('detects imperative verbs at start', () => {
    const elements = extractActionableElements('Run npm install to set up dependencies', 0);
    const imperatives = elements.filter((e) => e.kind === 'imperative');
    expect(imperatives.length).toBeGreaterThan(0);
  });

  it('detects code snippets', () => {
    const elements = extractActionableElements('Use `const x = 5` in your code', 0);
    const code = elements.filter((e) => e.kind === 'code-snippet');
    expect(code.length).toBeGreaterThan(0);
    expect(code[0]!.text).toContain('const x = 5');
  });

  it('detects file references', () => {
    const elements = extractActionableElements('Edit src/config/database.ts to fix the issue', 0);
    const files = elements.filter((e) => e.kind === 'file-reference');
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!.text).toContain('src/config/database.ts');
  });

  it('detects shell commands', () => {
    const elements = extractActionableElements('Execute npm run build to compile', 0);
    const commands = elements.filter((e) => e.kind === 'command');
    expect(commands.length).toBeGreaterThan(0);
  });

  it('detects URLs', () => {
    const elements = extractActionableElements('See https://docs.example.com/guide for details', 0);
    const urls = elements.filter((e) => e.kind === 'url-reference');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]!.text).toContain('https://docs.example.com');
  });

  it('detects numbered steps', () => {
    const elements = extractActionableElements('1. Install the package first', 0);
    const steps = elements.filter((e) => e.kind === 'step');
    expect(steps.length).toBeGreaterThan(0);
  });

  it('detects specific values', () => {
    const elements = extractActionableElements('Set the timeout to 30s for production', 0);
    const values = elements.filter((e) => e.kind === 'specific-value');
    expect(values.length).toBeGreaterThan(0);
  });

  it('detects decision points', () => {
    const elements = extractActionableElements('If you need faster builds, then you should use esbuild', 0);
    const decisions = elements.filter((e) => e.kind === 'decision-point');
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('detects examples', () => {
    const elements = extractActionableElements('For example, you can use a Map instead of an object for dynamic keys', 0);
    const examples = elements.filter((e) => e.kind === 'example');
    expect(examples.length).toBeGreaterThan(0);
  });

  it('returns empty for plain text without signals', () => {
    const elements = extractActionableElements('This is interesting to think about', 0);
    expect(elements.length).toBe(0);
  });

  it('detects multiple elements in one sentence', () => {
    const elements = extractActionableElements('Run `npm install express` in src/app.ts to add the dependency', 0);
    expect(elements.length).toBeGreaterThan(1);
    const kinds = new Set(elements.map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('respects additional specificity markers', () => {
    const elements = extractActionableElements(
      'The config needs FOO_BAR setting',
      0,
      [/\bFOO_BAR\b/],
    );
    expect(elements.length).toBeGreaterThan(0);
  });
});

// ═══ FILLER DETECTION ════════════════════════════════════════════════════════════

describe('detectFiller', () => {
  it('detects hedge patterns', () => {
    const patterns = detectFiller('You might want to consider using TypeScript', 0);
    const hedges = patterns.filter((p) => p.kind === 'hedge');
    expect(hedges.length).toBeGreaterThan(0);
  });

  it('detects platitudes', () => {
    const patterns = detectFiller('Make sure to follow best practices when writing code', 0);
    const platitudes = patterns.filter((p) => p.kind === 'platitude');
    expect(platitudes.length).toBeGreaterThan(0);
  });

  it('detects weasel words', () => {
    const patterns = detectFiller('Many developers prefer this approach', 0);
    const weasels = patterns.filter((p) => p.kind === 'weasel-word');
    expect(weasels.length).toBeGreaterThan(0);
  });

  it('detects restatement of task', () => {
    const patterns = detectFiller(
      'To set up ESLint for a TypeScript project you need to configure ESLint for TypeScript',
      0,
      'How to set up ESLint for a TypeScript project',
    );
    const restatements = patterns.filter((p) => p.kind === 'restatement');
    expect(restatements.length).toBeGreaterThan(0);
  });

  it('detects generic advice', () => {
    const patterns = detectFiller('Always test your code before deploying', 0);
    const generic = patterns.filter((p) => p.kind === 'generic-advice');
    expect(generic.length).toBeGreaterThan(0);
  });

  it('detects circular reasoning', () => {
    const patterns = detectFiller('The solution is to solve the underlying problem', 0);
    const circular = patterns.filter((p) => p.kind === 'circular');
    expect(circular.length).toBeGreaterThan(0);
  });

  it('detects non-answers', () => {
    const patterns = detectFiller('There are many different approaches you could take', 0);
    const nonAnswers = patterns.filter((p) => p.kind === 'non-answer');
    expect(nonAnswers.length).toBeGreaterThan(0);
  });

  it('returns empty for concrete actionable text', () => {
    const patterns = detectFiller('Run npm install express@4.18.2', 0);
    expect(patterns.length).toBe(0);
  });

  it('does not flag non-answers that include recommendations', () => {
    const patterns = detectFiller('There are many approaches but I recommend using Express', 0);
    const nonAnswers = patterns.filter((p) => p.kind === 'non-answer');
    expect(nonAnswers.length).toBe(0);
  });

  it('respects additional hedge patterns', () => {
    const patterns = detectFiller('We should probably maybe use it', 0, undefined, [/\bprobably maybe\b/]);
    const hedges = patterns.filter((p) => p.kind === 'hedge');
    expect(hedges.length).toBeGreaterThan(0);
  });
});

// ═══ SENTENCE SCORING ════════════════════════════════════════════════════════════

describe('scoreSentence', () => {
  it('returns 0 for empty sentence', () => {
    expect(scoreSentence('', [], [], 'general')).toBe(0);
    expect(scoreSentence('  ', [], [], 'general')).toBe(0);
  });

  it('returns 0 for text with no signals', () => {
    const score = scoreSentence('This is an interesting thought', [], [], 'general');
    expect(score).toBe(0);
  });

  it('scores positively for actionable elements', () => {
    const elements: ActionableElement[] = [{
      text: 'npm install',
      kind: 'command',
      startOffset: 0,
      endOffset: 11,
      specificity: 0.9,
    }];
    const score = scoreSentence('Run npm install', elements, [], 'how-to');
    expect(score).toBeGreaterThan(0.3);
  });

  it('applies penalty for filler patterns (clamps to 0)', () => {
    const filler: FillerPattern[] = [{
      text: 'you might want to consider',
      kind: 'hedge',
      startOffset: 0,
      endOffset: 26,
    }];
    const score = scoreSentence('You might want to consider this', [], filler, 'general');
    expect(score).toBe(0); // clamped to 0 minimum
  });

  it('balances action and filler', () => {
    const elements: ActionableElement[] = [{
      text: 'npm install',
      kind: 'command',
      startOffset: 0,
      endOffset: 11,
      specificity: 0.9,
    }];
    const filler: FillerPattern[] = [{
      text: 'might',
      kind: 'hedge',
      startOffset: 15,
      endOffset: 20,
    }];
    const score = scoreSentence('Run npm install, you might need it', elements, filler, 'general');
    expect(score).toBeGreaterThan(0); // action wins over mild hedge
  });

  it('rewards multiple actionable elements with diminishing returns', () => {
    const singleElement: ActionableElement[] = [{
      text: 'npm install',
      kind: 'command',
      startOffset: 0,
      endOffset: 11,
      specificity: 0.9,
    }];
    const multiElements: ActionableElement[] = [
      { text: 'npm install', kind: 'command', startOffset: 0, endOffset: 11, specificity: 0.9 },
      { text: 'src/app.ts', kind: 'file-reference', startOffset: 15, endOffset: 25, specificity: 0.85 },
    ];
    const singleScore = scoreSentence('Run npm install', singleElement, [], 'how-to');
    const multiScore = scoreSentence('Run npm install in src/app.ts', multiElements, [], 'how-to');
    expect(multiScore).toBeGreaterThan(singleScore);
  });

  it('caps filler penalty at 0.8', () => {
    const filler: FillerPattern[] = [
      { text: 'a', kind: 'hedge', startOffset: 0, endOffset: 1 },
      { text: 'b', kind: 'platitude', startOffset: 2, endOffset: 3 },
      { text: 'c', kind: 'circular', startOffset: 4, endOffset: 5 },
      { text: 'd', kind: 'non-answer', startOffset: 6, endOffset: 7 },
      { text: 'e', kind: 'restatement', startOffset: 8, endOffset: 9 },
    ];
    const score = scoreSentence('Total filler sentence with everything bad', [], filler, 'general');
    expect(score).toBeGreaterThanOrEqual(-0.8); // capped
  });
});

// ═══ FULL ACTIONABILITY ANALYSIS ═════════════════════════════════════════════════

describe('analyzeActionability', () => {
  it('returns score 0 for empty output', () => {
    const result = analyzeActionability('');
    expect(result.score).toBe(0);
    expect(result.pass).toBe(false);
    expect(result.sentences).toEqual([]);
    expect(result.confidence).toBe(1.0);
  });

  it('scores highly actionable output high', () => {
    const output = [
      '1. Run `npm install express` to add the dependency',
      '2. Create `src/server.ts` with the following content:',
      '```typescript',
      "import express from 'express';",
      'const app = express();',
      'app.listen(3000);',
      '```',
      '3. Update `package.json` to add a start script: `"start": "ts-node src/server.ts"`',
      '4. Run `npm start` and verify the server responds on http://localhost:3000',
    ].join('\n');
    const result = analyzeActionability(output, { responseType: 'how-to' });
    expect(result.score).toBeGreaterThan(0.4);
    expect(result.actionableElements.length).toBeGreaterThan(3);
    expect(result.actionableRatio).toBeGreaterThan(0.3);
    expect(result.pass).toBe(true);
  });

  it('scores filler-heavy output low', () => {
    const output = [
      'There are many different approaches you could take here.',
      'You might want to consider looking into various options.',
      'It depends on your specific situation and requirements.',
      'Many developers prefer different methods.',
      'It is important to follow best practices.',
      'You could consider using appropriate tools.',
      'Generally it is recommended to test thoroughly.',
      'Remember to always document your code properly.',
    ].join('\n');
    const result = analyzeActionability(output);
    expect(result.score).toBeLessThan(0.3);
    expect(result.fillerPatterns.length).toBeGreaterThan(3);
    expect(result.fillerRatio).toBeGreaterThan(0.4);
    expect(result.pass).toBe(false);
  });

  it('handles mixed content reasonably', () => {
    const output = [
      'You might want to consider using a caching strategy.',
      '',
      '1. Install Redis: `npm install redis`',
      '2. Create a cache wrapper in `src/cache.ts`',
      '3. Set TTL to 300s for API responses',
    ].join('\n');
    const result = analyzeActionability(output, { responseType: 'how-to' });
    expect(result.actionableElements.length).toBeGreaterThan(0);
    expect(result.fillerPatterns.length).toBeGreaterThan(0);
  });

  it('detects response type from task text', () => {
    const result = analyzeActionability(
      'Run npm test to verify',
      { taskText: 'How do I set up testing?' },
    );
    expect(result.detectedResponseType).toBe('how-to');
  });

  it('uses provided response type over detection', () => {
    const result = analyzeActionability(
      'Run npm test',
      { taskText: 'How do I set up testing?', responseType: 'fix' },
    );
    expect(result.detectedResponseType).toBe('fix');
  });

  it('calculates specificity score from elements', () => {
    const result = analyzeActionability(
      'Edit src/config.ts and set timeout to 30s. Run npm run build.',
    );
    expect(result.specificityScore).toBeGreaterThan(0);
  });

  it('returns confidence based on amount of evidence', () => {
    const shortResult = analyzeActionability('Do it.');
    const longResult = analyzeActionability(
      [
        'Run npm install.',
        'Create src/index.ts.',
        'Set port to 3000.',
        'Run npm start.',
        'Check logs.',
        'Edit config.yaml.',
        'Deploy to staging.',
        'Verify health.',
        'Update docs.',
        'Push to main.',
      ].join('\n'),
    );
    expect(longResult.confidence).toBeGreaterThan(shortResult.confidence);
  });

  it('generates meaningful summary', () => {
    const result = analyzeActionability(
      'Run `npm install express@4.18.2` to add it.\nEdit src/app.ts to import it.',
      { responseType: 'how-to' },
    );
    expect(result.summary).toContain('Actionability');
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it('applies task text for restatement detection', () => {
    const task = 'Explain how to configure ESLint with TypeScript in your project';
    const output = 'You want to configure ESLint with TypeScript in your project, so here is how to configure ESLint with TypeScript.';
    const result = analyzeActionability(output, { taskText: task });
    const restatements = result.fillerPatterns.filter((f) => f.kind === 'restatement');
    expect(restatements.length).toBeGreaterThan(0);
  });

  it('scores code-heavy output well for code review type', () => {
    const output = [
      'In `src/auth/login.ts` at line 42, the password comparison is vulnerable:',
      '',
      '```typescript',
      '// Before (vulnerable)',
      'if (password === storedHash) { }',
      '',
      '// After (constant-time)',
      "import { timingSafeEqual } from 'crypto';",
      'if (timingSafeEqual(Buffer.from(password), Buffer.from(storedHash))) { }',
      '```',
      '',
      'Also check `src/auth/session.ts` for JWT expiry issues.',
    ].join('\n');
    const result = analyzeActionability(output, { responseType: 'code-review' });
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.actionableElements.some((e) => e.kind === 'file-reference')).toBe(true);
    expect(result.actionableElements.some((e) => e.kind === 'code-snippet')).toBe(true);
  });
});

// ═══ ASSERTION FACTORIES ═════════════════════════════════════════════════════════

describe('toBeActionable', () => {
  it('passes for actionable output', async () => {
    const assertion = toBeActionable();
    const result = await assertion.evaluate(
      '1. Run `npm install`\n2. Edit `src/index.ts`\n3. Set port to 8080\n4. Run `npm start`',
      { prompt: 'How to set up the server', references: [] },
    );
    expect(result.status).toBe('pass');
    expect(result.name).toBe('[Tier 2] output is actionable');
  });

  it('fails for filler output', async () => {
    const assertion = toBeActionable();
    const result = await assertion.evaluate(
      'You might want to consider various approaches. It depends on your situation. There are many different methods available.',
    );
    expect(result.status).toBe('fail');
    expect(result.evidence).toBeDefined();
  });

  it('uses context prompt as task text', async () => {
    const assertion = toBeActionable();
    const result = await assertion.evaluate(
      'Run npm install express',
      { prompt: 'How to add Express', references: [] },
    );
    expect(result.status).toBe('pass');
  });

  it('respects custom thresholds', async () => {
    const assertion = toBeActionable({ minScore: 0.9, minActionableRatio: 0.9 });
    const result = await assertion.evaluate('Run npm install. Also consider options.');
    expect(result.status).toBe('fail');
  });
});

describe('toHaveMinimalFiller', () => {
  it('passes when filler ratio is below threshold', async () => {
    const assertion = toHaveMinimalFiller(0.5);
    const result = await assertion.evaluate(
      '1. Run npm install\n2. Edit src/app.ts\n3. Set port to 3000',
    );
    expect(result.status).toBe('pass');
  });

  it('fails when filler ratio exceeds threshold', async () => {
    const assertion = toHaveMinimalFiller(0.2);
    const result = await assertion.evaluate(
      'You might want to consider this. It depends on your needs. There are many ways. Make sure to follow best practices. Generally it is recommended.',
    );
    expect(result.status).toBe('fail');
    expect(result.actual).toContain('%');
  });

  it('includes filler kind breakdown in evidence', async () => {
    const assertion = toHaveMinimalFiller(0.1);
    const result = await assertion.evaluate(
      'You might want to consider options. There are many approaches.',
    );
    if (result.status === 'fail') {
      expect(result.evidence).toBeDefined();
    }
  });
});

describe('toBeSpecific', () => {
  it('passes for specific output with file refs and code', async () => {
    const assertion = toBeSpecific(0.5);
    const result = await assertion.evaluate(
      'Edit `src/config/database.ts` and change the connection string to `postgres://localhost:5432/mydb`.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails for vague output', async () => {
    const assertion = toBeSpecific(0.5);
    const result = await assertion.evaluate(
      'You should change the configuration file to use the correct settings.',
    );
    expect(result.status).toBe('fail');
  });

  it('handles output with no actionable elements', async () => {
    const assertion = toBeSpecific(0.5);
    const result = await assertion.evaluate('This is fine I think.');
    expect(result.status).toBe('fail');
    expect(result.actual).toContain('0%');
  });
});

describe('toPassActionabilityJudge', () => {
  it('passes with high judge scores', async () => {
    const backend = makeJudgeBackend({
      'specificity': 5,
      'directness': 4,
      'next-steps': 4,
      'contextual-fit': 4,
    });
    const assertion = toPassActionabilityJudge(backend);
    const result = await assertion.evaluate('Run npm install in src/', {
      prompt: 'Set up the project',
      references: [],
    });
    expect(result.status).toBe('pass');
  });

  it('fails with low judge scores', async () => {
    const backend = makeJudgeBackend({
      'specificity': 1,
      'directness': 1,
      'next-steps': 1,
      'contextual-fit': 1,
    });
    const assertion = toPassActionabilityJudge(backend);
    const result = await assertion.evaluate('Maybe consider things.', {
      prompt: 'Fix the bug',
      references: [],
    });
    expect(result.status).toBe('fail');
  });

  it('returns skip for low confidence', async () => {
    const backend = makeJudgeBackend({
      'specificity': 3,
      'directness': 3,
      'next-steps': 3,
      'contextual-fit': 3,
    }, 0.3);
    const assertion = toPassActionabilityJudge(backend);
    const result = await assertion.evaluate('Do the thing.', {
      prompt: 'Fix it',
      references: [],
    });
    expect(result.status).toBe('skip');
  });
});

describe('toHaveActionabilityAbove', () => {
  it('passes when score meets threshold', async () => {
    const assertion = toHaveActionabilityAbove(0.3);
    const result = await assertion.evaluate(
      'Run `npm install`.\nCreate `src/index.ts`.\nSet port to 3000.',
      { prompt: 'Set up server', references: [] },
    );
    expect(result.status).toBe('pass');
  });

  it('fails when score is below threshold', async () => {
    const assertion = toHaveActionabilityAbove(0.8);
    const result = await assertion.evaluate('Consider the options.');
    expect(result.status).toBe('fail');
    expect(result.expected).toContain('80%');
  });
});

// ═══ RUBRIC VALIDATION ═══════════════════════════════════════════════════════════

describe('ACTIONABILITY_RUBRIC', () => {
  it('passes rubric validation', () => {
    const errors = validateRubric(ACTIONABILITY_RUBRIC);
    expect(errors).toEqual([]);
  });

  it('has exactly 4 criteria', () => {
    expect(ACTIONABILITY_RUBRIC.criteria.length).toBe(4);
  });

  it('has expected criterion ids', () => {
    const ids = ACTIONABILITY_RUBRIC.criteria.map((c) => c.id);
    expect(ids).toContain('specificity');
    expect(ids).toContain('directness');
    expect(ids).toContain('next-steps');
    expect(ids).toContain('contextual-fit');
  });

  it('has valid pass threshold', () => {
    expect(ACTIONABILITY_RUBRIC.passThreshold).toBe(0.55);
  });

  it('all criteria have 5 levels', () => {
    for (const criterion of ACTIONABILITY_RUBRIC.criteria) {
      expect(criterion.levels.length).toBe(5);
    }
  });

  it('all criteria have positive weights', () => {
    for (const criterion of ACTIONABILITY_RUBRIC.criteria) {
      expect(criterion.weight).toBeGreaterThan(0);
    }
  });

  it('weights sum to approximately 1', () => {
    const sum = ACTIONABILITY_RUBRIC.criteria.reduce((s, c) => s + (c.weight ?? 0), 0);
    expect(sum).toBeCloseTo(1.0, 1);
  });

  it('has name and description', () => {
    expect(ACTIONABILITY_RUBRIC.name).toBe('Actionability');
    expect(ACTIONABILITY_RUBRIC.description.length).toBeGreaterThan(20);
  });
});