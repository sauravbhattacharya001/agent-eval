/**
 * Tests for the Relevance module (Tier 2 — Heuristic).
 * Tests TF-IDF vectorization, cosine similarity, topic extraction,
 * and assertion factories.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeRelevance,
  cosineSimilarity,
  vectorize,
  extractTopics,
  topicOverlap,
  toBeRelevantTo,
  toNotDriftFrom,
  toHaveTopicOverlap,
  toBeOnTopic,
} from '../src/checks/relevance.js';

// ─── COSINE SIMILARITY ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const vec = new Map([['hello', 0.5], ['world', 0.3]]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for completely disjoint vectors', () => {
    const vecA = new Map([['hello', 0.5], ['world', 0.3]]);
    const vecB = new Map([['foo', 0.5], ['bar', 0.3]]);
    expect(cosineSimilarity(vecA, vecB)).toBe(0);
  });

  it('returns value between 0 and 1 for partially overlapping vectors', () => {
    const vecA = new Map([['hello', 0.5], ['world', 0.3], ['test', 0.2]]);
    const vecB = new Map([['hello', 0.4], ['foo', 0.3], ['test', 0.1]]);
    const sim = cosineSimilarity(vecA, vecB);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('returns 0 for empty vectors', () => {
    const empty = new Map<string, number>();
    const vec = new Map([['hello', 0.5]]);
    expect(cosineSimilarity(empty, vec)).toBe(0);
    expect(cosineSimilarity(vec, empty)).toBe(0);
    expect(cosineSimilarity(empty, empty)).toBe(0);
  });

  it('is symmetric', () => {
    const vecA = new Map([['a', 0.3], ['b', 0.7], ['c', 0.1]]);
    const vecB = new Map([['b', 0.5], ['c', 0.4], ['d', 0.2]]);
    expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(cosineSimilarity(vecB, vecA), 10);
  });
});

// ─── VECTORIZE ──────────────────────────────────────────────────────────────────

describe('vectorize', () => {
  it('produces a non-empty vector for meaningful text', () => {
    const vec = vectorize('TypeScript testing framework', ['TypeScript testing framework']);
    expect(vec.size).toBeGreaterThan(0);
  });

  it('produces different vectors for different texts', () => {
    const corpus = ['dogs are great pets', 'quantum physics experiments'];
    const vec1 = vectorize('dogs are great pets', corpus);
    const vec2 = vectorize('quantum physics experiments', corpus);

    const terms1 = new Set(vec1.keys());
    const terms2 = new Set(vec2.keys());
    const intersection = [...terms1].filter((t) => terms2.has(t));
    expect(intersection.length).toBeLessThan(Math.max(terms1.size, terms2.size));
  });

  it('respects useBigrams=false option', () => {
    const withBigrams = vectorize('hello world test', ['hello world test'], { useBigrams: true });
    const noBigrams = vectorize('hello world test', ['hello world test'], { useBigrams: false });
    expect(withBigrams.size).toBeGreaterThanOrEqual(noBigrams.size);
  });

  it('filters stopwords', () => {
    const vec = vectorize('the cat is on the mat', ['the cat is on the mat']);
    expect(vec.has('the')).toBe(false);
    expect(vec.has('is')).toBe(false);
    expect(vec.has('on')).toBe(false);
  });

  it('handles empty text', () => {
    const vec = vectorize('', ['some corpus text']);
    expect(vec.size).toBe(0);
  });
});

// ─── ANALYZE RELEVANCE ──────────────────────────────────────────────────────────

describe('analyzeRelevance', () => {
  it('returns high score for identical texts', () => {
    const text = 'Set up ESLint for a TypeScript project with strict rules';
    const result = analyzeRelevance(text, text);
    expect(result.score).toBeCloseTo(1.0, 1);
    expect(result.relevant).toBe(true);
  });

  it('returns high score for semantically related texts', () => {
    const task = 'Write a TypeScript function that reverses a string';
    const output = `Here's a TypeScript function that reverses a string:
\`\`\`typescript
function reverseString(str: string): string {
  return str.split('').reverse().join('');
}
\`\`\`
This function takes a string parameter and returns the reversed version.`;

    const result = analyzeRelevance(task, output);
    expect(result.score).toBeGreaterThan(0.2);
    expect(result.relevant).toBe(true);
  });

  it('returns low score for unrelated texts', () => {
    const task = 'Explain how to configure Docker containers for production';
    const output = 'The French Revolution began in 1789 and lasted until 1799. ' +
      'It was a period of radical political and societal change in France. ' +
      'The absolute monarchy was replaced by a republic.';

    const result = analyzeRelevance(task, output);
    expect(result.score).toBeLessThan(0.3);
    expect(result.relevant).toBe(false);
  });

  it('identifies shared terms between task and output', () => {
    const task = 'Configure ESLint with TypeScript parser';
    const output = 'To configure ESLint with the TypeScript parser, install @typescript-eslint/parser';

    const result = analyzeRelevance(task, output);
    expect(result.sharedTerms.length).toBeGreaterThan(0);
    const sharedTermNames = result.sharedTerms.map((t) => t.term);
    expect(sharedTermNames.some((t) => t.includes('eslint') || t.includes('typescript'))).toBe(true);
  });

  it('identifies missing terms from task not in output', () => {
    const task = 'Set up ESLint and Prettier for TypeScript with husky pre-commit hooks';
    const output = 'Install ESLint for your project. Run npm install eslint.';

    const result = analyzeRelevance(task, output);
    const missingNames = result.missingTerms.map((t) => t.term);
    expect(missingNames.some((t) =>
      t.includes('prettier') || t.includes('husky') || t.includes('pre') || t.includes('commit'),
    )).toBe(true);
  });

  it('handles empty task gracefully', () => {
    const result = analyzeRelevance('', 'Some output text');
    expect(result.score).toBe(0);
    expect(result.relevant).toBe(false);
  });

  it('handles empty output gracefully', () => {
    const result = analyzeRelevance('Some task', '');
    expect(result.score).toBe(0);
    expect(result.relevant).toBe(false);
  });

  it('respects custom threshold', () => {
    const task = 'TypeScript configuration';
    const output = 'JavaScript is a dynamic programming language used on the web';

    const lowThreshold = analyzeRelevance(task, output, { threshold: 0.05 });
    const highThreshold = analyzeRelevance(task, output, { threshold: 0.9 });

    expect(lowThreshold.score).toBe(highThreshold.score);
    if (lowThreshold.score >= 0.05) {
      expect(lowThreshold.relevant).toBe(true);
    }
    expect(highThreshold.relevant).toBe(false);
  });

  it('provides section-level scores for multi-section output', () => {
    const task = 'Explain React hooks';
    const output = `# Introduction to React Hooks

React hooks allow you to use state in functional components.

# History of JavaScript

JavaScript was created by Brendan Eich in 1995 at Netscape.

# Using useState

The useState hook returns a state variable and a setter function.`;

    const result = analyzeRelevance(task, output);
    expect(result.sectionScores).toBeDefined();
    expect(result.sectionScores!.length).toBeGreaterThan(1);

    const hooksSection = result.sectionScores!.find((s) =>
      s.heading.toLowerCase().includes('hook') || s.heading.toLowerCase().includes('react'),
    );
    const historySection = result.sectionScores!.find((s) =>
      s.heading.toLowerCase().includes('history') || s.heading.toLowerCase().includes('javascript'),
    );

    if (hooksSection && historySection) {
      expect(hooksSection.score).toBeGreaterThan(historySection.score);
    }
  });

  it('uses extra stopwords when provided', () => {
    const task = 'function implementation details';
    const output = 'function implementation details with extra stuff';

    const without = analyzeRelevance(task, output, { extraStopwords: [] });
    const withExtra = analyzeRelevance(task, output, { extraStopwords: ['function', 'implementation'] });

    expect(without.score).not.toBe(withExtra.score);
  });

  it('stemming handles word variations', () => {
    const task = 'running tests and testing frameworks';
    const output = 'The test runner runs all test suites using the framework';

    const withStemming = analyzeRelevance(task, output, { useStemming: true });
    const noStemming = analyzeRelevance(task, output, { useStemming: false });

    expect(withStemming.score).toBeGreaterThanOrEqual(noStemming.score);
  });
});

// ─── EXTRACT TOPICS ─────────────────────────────────────────────────────────────

describe('extractTopics', () => {
  it('extracts meaningful topics from text', () => {
    const text = 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. ' +
      'TypeScript adds optional static types, classes, and interfaces.';
    const topics = extractTopics(text);

    expect(topics.length).toBeGreaterThan(0);
    const topicTerms = topics.map((t) => t.term);
    expect(topicTerms.some((t) => t.includes('typescript'))).toBe(true);
    expect(topicTerms.some((t) => t.includes('javascript'))).toBe(true);
  });

  it('returns empty for empty text', () => {
    const topics = extractTopics('');
    expect(topics).toEqual([]);
  });

  it('returns empty for stopword-only text', () => {
    const topics = extractTopics('the is a an for to of in');
    expect(topics).toEqual([]);
  });

  it('respects maxTopics limit', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron';
    const topics = extractTopics(text, { maxTopics: 3 });
    expect(topics.length).toBeLessThanOrEqual(3);
  });

  it('normalizes weights to 0-1 range', () => {
    const text = 'machine learning algorithms for natural language processing and deep learning';
    const topics = extractTopics(text);

    for (const topic of topics) {
      expect(topic.weight).toBeGreaterThanOrEqual(0);
      expect(topic.weight).toBeLessThanOrEqual(1);
    }
    if (topics.length > 0) {
      expect(topics[0]!.weight).toBeCloseTo(1.0, 5);
    }
  });

  it('includes bigrams when enabled', () => {
    const text = 'machine learning is a subset of artificial intelligence';
    const withBigrams = extractTopics(text, { includeBigrams: true });
    const noBigrams = extractTopics(text, { includeBigrams: false });

    const bigramTopics = withBigrams.filter((t) => t.term.includes(' '));
    const noBigramTopics = noBigrams.filter((t) => t.term.includes(' '));

    expect(bigramTopics.length).toBeGreaterThan(0);
    expect(noBigramTopics.length).toBe(0);
  });

  it('tracks frequency correctly', () => {
    const text = 'testing testing testing code quality code';
    const topics = extractTopics(text);

    const testingTopic = topics.find((t) => t.term === 'testing');
    const codeTopic = topics.find((t) => t.term === 'code');

    if (testingTopic && codeTopic) {
      expect(testingTopic.frequency).toBe(3);
      expect(codeTopic.frequency).toBe(2);
    }
  });

  it('boosts bigrams over unigrams', () => {
    const text = 'machine learning machine learning machine learning data science';
    const topics = extractTopics(text, { includeBigrams: true });

    const mlBigram = topics.find((t) => t.term === 'machine learning');
    const mlUnigram = topics.find((t) => t.term === 'machine');

    if (mlBigram && mlUnigram) {
      const bigramIdx = topics.indexOf(mlBigram);
      const unigramIdx = topics.indexOf(mlUnigram);
      expect(bigramIdx).toBeLessThan(unigramIdx);
    }
  });
});

// ─── TOPIC OVERLAP ──────────────────────────────────────────────────────────────

describe('topicOverlap', () => {
  it('returns 1.0 for identical texts', () => {
    const text = 'TypeScript testing framework evaluation assertions';
    const overlap = topicOverlap(text, text);
    expect(overlap).toBeCloseTo(1.0, 1);
  });

  it('returns high overlap for related texts', () => {
    const text1 = 'TypeScript testing with assertions and evaluation';
    const text2 = 'Writing TypeScript tests using assertion libraries for evaluation purposes';
    const overlap = topicOverlap(text1, text2);
    expect(overlap).toBeGreaterThan(0.2);
  });

  it('returns low overlap for unrelated texts', () => {
    const text1 = 'Docker container orchestration with Kubernetes';
    const text2 = 'Ancient Roman history and the fall of the empire';
    const overlap = topicOverlap(text1, text2);
    expect(overlap).toBeLessThan(0.2);
  });

  it('returns 0 for empty text1', () => {
    const overlap = topicOverlap('', 'some text');
    expect(overlap).toBe(0);
  });

  it('is not necessarily symmetric', () => {
    const text1 = 'TypeScript types';
    const text2 = 'TypeScript types interfaces generics enums modules decorators';
    const overlap12 = topicOverlap(text1, text2);
    const overlap21 = topicOverlap(text2, text1);
    expect(overlap12).toBeGreaterThanOrEqual(0);
    expect(overlap21).toBeGreaterThanOrEqual(0);
  });
});

// ─── ASSERTION: toBeRelevantTo ───────────────────────────────────────────────────

describe('toBeRelevantTo', () => {
  it('passes for relevant output', () => {
    const assertion = toBeRelevantTo('Write a function to reverse a string in TypeScript');
    const result = assertion.evaluate(
      'Here is a TypeScript function that reverses a string: function reverse(s: string): string { return s.split("").reverse().join(""); }',
    );
    expect(result.status).toBe('pass');
  });

  it('fails for completely unrelated output', () => {
    const assertion = toBeRelevantTo('Explain Docker container networking');
    const result = assertion.evaluate(
      'The Great Wall of China was built over many centuries. It stretches thousands of miles across northern China.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toBeDefined();
    expect(result.evidence).toBeDefined();
  });

  it('uses context.prompt when no task string is provided', () => {
    const assertion = toBeRelevantTo();
    const result = assertion.evaluate(
      'ESLint configuration for TypeScript projects requires the @typescript-eslint/parser',
      { prompt: 'How to set up ESLint for TypeScript' },
    );
    expect(result.status).toBe('pass');
  });

  it('returns error when no task is available', () => {
    const assertion = toBeRelevantTo();
    const result = assertion.evaluate('Some output');
    expect(result.status).toBe('error');
    expect(result.message).toContain('No task/prompt provided');
  });

  it('respects custom threshold', () => {
    const task = 'TypeScript project setup';
    const output = 'JavaScript was created in 1995 for web browsers';

    const strict = toBeRelevantTo({ task, threshold: 0.9 });
    const strictResult = strict.evaluate(output);
    expect(strictResult.status).toBe('fail');
  });

  it('provides evidence with shared terms on pass', () => {
    const assertion = toBeRelevantTo('React hooks useState useEffect');
    const result = assertion.evaluate(
      'The useState hook in React lets you add state to functional components. ' +
      'The useEffect hook handles side effects.',
    );
    expect(result.status).toBe('pass');
    expect(result.evidence).toBeDefined();
    expect(result.evidence).toContain('Score:');
  });

  it('provides evidence with missing terms on fail', () => {
    const assertion = toBeRelevantTo('Kubernetes pod orchestration and service mesh');
    const result = assertion.evaluate('The weather today is sunny with mild temperatures.');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Missing task terms');
  });
});

// ─── ASSERTION: toNotDriftFrom ──────────────────────────────────────────────────

describe('toNotDriftFrom', () => {
  it('passes for on-topic output', () => {
    const assertion = toNotDriftFrom('Explain how to use Git branches');
    const result = assertion.evaluate(
      'Git branches allow you to work on different features simultaneously. ' +
      'Use git checkout -b to create a new branch. Merge branches with git merge.',
    );
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('On-topic');
  });

  it('fails for drifted output', () => {
    const assertion = toNotDriftFrom('Explain database indexing strategies');
    const result = assertion.evaluate(
      'Cooking pasta requires boiling water first. Add salt for flavor. ' +
      'Al dente means the pasta is firm to the bite.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('drifted');
  });

  it('uses lower default threshold than toBeRelevantTo', () => {
    const drift = toNotDriftFrom('TypeScript types');
    const relevance = toBeRelevantTo('TypeScript types');

    expect(drift.name).toContain('0.15');
    expect(relevance.name).toContain('0.2');
  });

  it('provides drift-specific evidence', () => {
    const assertion = toNotDriftFrom('Configure PostgreSQL database replication');
    const result = assertion.evaluate(
      'Python is a versatile programming language. It supports multiple paradigms.',
    );
    expect(result.status).toBe('fail');
    expect(result.evidence).toBeDefined();
    expect(
      result.evidence!.includes('Task topics not addressed') ||
      result.evidence!.includes('Off-topic content'),
    ).toBe(true);
  });

  it('uses context.prompt as fallback', () => {
    const assertion = toNotDriftFrom();
    const result = assertion.evaluate(
      'React components use JSX syntax for rendering UI elements',
      { prompt: 'Explain React components and JSX' },
    );
    expect(result.status).toBe('pass');
  });

  it('returns error when no task available', () => {
    const assertion = toNotDriftFrom();
    const result = assertion.evaluate('Any output');
    expect(result.status).toBe('error');
  });
});

// ─── ASSERTION: toHaveTopicOverlap ──────────────────────────────────────────────

describe('toHaveTopicOverlap', () => {
  it('passes when task topics are covered', () => {
    const assertion = toHaveTopicOverlap('TypeScript generics interfaces types');
    const result = assertion.evaluate(
      'TypeScript generics allow you to write reusable code with type safety. ' +
      'Interfaces define the shape of objects. Types can be unions or intersections.',
    );
    expect(result.status).toBe('pass');
  });

  it('fails when task topics are not covered', () => {
    const assertion = toHaveTopicOverlap('Kubernetes deployment scaling pods');
    const result = assertion.evaluate(
      'The history of ancient Greece spans many centuries of philosophical development.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('topic coverage');
  });

  it('respects custom minOverlap', () => {
    const task = 'React hooks state management context';
    const output = 'React hooks like useState provide local state management';

    const lenient = toHaveTopicOverlap({ task, minOverlap: 0.1 });
    const strict = toHaveTopicOverlap({ task, minOverlap: 0.95 });

    const lenientResult = lenient.evaluate(output);
    const strictResult = strict.evaluate(output);

    expect(lenientResult.status).toBe('pass');
    expect(strictResult.status).toBe('fail');
  });

  it('provides evidence with missing topics on failure', () => {
    const assertion = toHaveTopicOverlap('Docker containers images volumes networks');
    const result = assertion.evaluate('Simple text about nothing related.');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Missing topics');
  });

  it('uses context.prompt when no task provided', () => {
    const assertion = toHaveTopicOverlap();
    const result = assertion.evaluate(
      'ESLint rules help maintain consistent code style',
      { prompt: 'ESLint rules and configuration' },
    );
    expect(result.status).toBe('pass');
  });

  it('returns error when no task available', () => {
    const assertion = toHaveTopicOverlap();
    const result = assertion.evaluate('Any output');
    expect(result.status).toBe('error');
  });
});

// ─── ASSERTION: toBeOnTopic ─────────────────────────────────────────────────────

describe('toBeOnTopic', () => {
  it('passes for on-topic output using combined scoring', () => {
    const assertion = toBeOnTopic('Explain async/await patterns in TypeScript');
    const result = assertion.evaluate(
      'TypeScript supports async/await for handling asynchronous operations. ' +
      'An async function returns a Promise. The await keyword pauses execution until the Promise resolves. ' +
      'Error handling uses try/catch blocks around await expressions.',
    );
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('Combined score');
  });

  it('fails for off-topic output', () => {
    const assertion = toBeOnTopic('Machine learning model training');
    const result = assertion.evaluate(
      'The best recipe for chocolate cake involves melting butter with cocoa powder. ' +
      'Mix in sugar and eggs, then add flour and baking soda.',
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('off-topic');
  });

  it('uses combined cosine + topic overlap scoring', () => {
    const assertion = toBeOnTopic('Node.js event loop');
    const result = assertion.evaluate(
      'The Node.js event loop processes callbacks from I/O operations. ' +
      'It cycles through phases: timers, pending, idle, poll, check, close.',
    );
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('cosine');
    expect(result.evidence).toContain('topic overlap');
  });

  it('uses context.prompt as fallback', () => {
    const assertion = toBeOnTopic();
    const result = assertion.evaluate(
      'Git rebase rewrites commit history by replaying changes',
      { prompt: 'Git rebase workflow' },
    );
    expect(result.status).toBe('pass');
  });

  it('returns error when no task available', () => {
    const assertion = toBeOnTopic();
    const result = assertion.evaluate('Text');
    expect(result.status).toBe('error');
  });

  it('respects custom threshold', () => {
    const task = 'Database query optimization';
    const output = 'SQL queries can be optimized with proper indexing and query planning';

    const lenient = toBeOnTopic({ task, threshold: 0.05 });
    const strict = toBeOnTopic({ task, threshold: 0.95 });

    expect(lenient.evaluate(output).status).toBe('pass');
    expect(strict.evaluate(output).status).toBe('fail');
  });
});

// ─── EDGE CASES ─────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles very short texts', () => {
    const result = analyzeRelevance('test', 'test');
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles texts with only stopwords', () => {
    const result = analyzeRelevance('the is a an', 'to of in for');
    expect(result.score).toBe(0);
  });

  it('handles texts with special characters', () => {
    const result = analyzeRelevance(
      'Configure @typescript-eslint/parser v5.0.0',
      'Install @typescript-eslint/parser version 5.0.0 or higher',
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles very long output', () => {
    const task = 'Explain TypeScript generics';
    const output = 'TypeScript generics provide type safety. '.repeat(500);
    const result = analyzeRelevance(task, output);
    expect(result.score).toBeGreaterThan(0);
    expect(result.relevant).toBe(true);
  });

  it('handles unicode text gracefully', () => {
    const result = analyzeRelevance(
      'JavaScript testing',
      'TypeScript testing',
    );
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles numeric content', () => {
    const result = analyzeRelevance(
      'HTTP status codes 200 404 500',
      'Common status codes include 200 for success, 404 for not found, and 500 for server error',
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles code blocks in output', () => {
    const task = 'Write a sorting algorithm';
    const output = `Here is a bubble sort implementation:
\`\`\`typescript
function bubbleSort(arr: number[]): number[] {
  const sorted = [...arr];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < sorted.length - i - 1; j++) {
      if (sorted[j] > sorted[j + 1]) {
        [sorted[j], sorted[j + 1]] = [sorted[j + 1], sorted[j]];
      }
    }
  }
  return sorted;
}
\`\`\`
This sorting algorithm compares adjacent elements and swaps them if needed.`;

    const result = analyzeRelevance(task, output);
    expect(result.score).toBeGreaterThan(0);
  });
});

// ─── PERFORMANCE ────────────────────────────────────────────────────────────────

describe('performance', () => {
  it('analyzes relevance in under 50ms for typical inputs', () => {
    const task = 'Set up a CI/CD pipeline with GitHub Actions for a TypeScript project';
    const output = 'Create a .github/workflows/ci.yml file that runs on push. ' +
      'Define jobs for linting, testing, and building. Use actions/checkout and actions/setup-node. ' +
      'Cache node_modules with actions/cache for faster builds.';

    const start = performance.now();
    analyzeRelevance(task, output);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it('handles large outputs without excessive time', () => {
    const task = 'Explain microservices architecture';
    const output = 'Microservices break applications into small services. '.repeat(200) +
      'Each service handles one business domain. '.repeat(200);

    const start = performance.now();
    analyzeRelevance(task, output);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it('extractTopics is fast for typical text', () => {
    const text = 'TypeScript is a language for application-scale JavaScript development. ' +
      'TypeScript adds optional types, classes, and modules to JavaScript. ' +
      'TypeScript supports tools for large-scale JavaScript applications.';

    const start = performance.now();
    extractTopics(text);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(20);
  });
});
