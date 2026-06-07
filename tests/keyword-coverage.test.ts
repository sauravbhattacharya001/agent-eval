/**
 * Tests for the Keyword Coverage Scoring module (Tier 2 — Heuristic).
 * Tests key-term extraction, coverage scoring, topic gap analysis, and assertion factories.
 */

import { describe, it, expect } from 'vitest';
import {
  extractKeyTerms,
  scoreKeywordCoverage,
  identifyTopicGaps,
  toCoverKeyTopics,
  toHaveNoTopicGaps,
  toMeetKeywordScore,
  toHaveBalancedCoverage,
  toAddressTask,
} from '../src/checks/keyword-coverage.js';

// ─── KEY-TERM EXTRACTION ────────────────────────────────────────────────────────

describe('extractKeyTerms', () => {
  it('extracts meaningful terms from a task description', () => {
    const task = 'Set up ESLint for a TypeScript project with Prettier integration';
    const terms = extractKeyTerms(task);

    expect(terms.length).toBeGreaterThan(0);
    const termStrings = terms.map((t) => t.term);
    expect(termStrings).toContain('eslint');
    expect(termStrings).toContain('typescript');
    expect(termStrings).toContain('prettier');
  });

  it('returns terms sorted by weight descending', () => {
    const task = 'Implement a Redis caching layer with TTL support for the user authentication service';
    const terms = extractKeyTerms(task);

    for (let i = 1; i < terms.length; i++) {
      expect(terms[i]!.weight).toBeLessThanOrEqual(terms[i - 1]!.weight);
    }
  });

  it('normalizes top weight to 1.0', () => {
    const task = 'Configure Docker containers for microservice deployment';
    const terms = extractKeyTerms(task);

    expect(terms.length).toBeGreaterThan(0);
    expect(terms[0]!.weight).toBe(1);
  });

  it('respects maxKeywords option', () => {
    const task = 'Build a complete REST API with authentication, rate limiting, caching, logging, monitoring, error handling, and documentation';
    const terms = extractKeyTerms(task, { maxKeywords: 5 });

    expect(terms.length).toBeLessThanOrEqual(5);
  });

  it('filters stopwords from results', () => {
    const task = 'Write a function that takes the input and returns the output';
    const terms = extractKeyTerms(task);
    const termStrings = terms.map((t) => t.term);

    expect(termStrings).not.toContain('the');
    expect(termStrings).not.toContain('and');
    expect(termStrings).not.toContain('that');
  });

  it('handles empty input', () => {
    expect(extractKeyTerms('')).toEqual([]);
    expect(extractKeyTerms('   ')).toEqual([]);
  });

  it('includes additional keywords if specified', () => {
    const task = 'Set up CI/CD pipeline';
    const terms = extractKeyTerms(task, { additionalKeywords: ['github-actions', 'yaml'] });
    const termStrings = terms.map((t) => t.term);

    expect(termStrings).toContain('github-actions');
    expect(termStrings).toContain('yaml');
  });

  it('extracts bigrams when enabled', () => {
    const task = 'Implement rate limiting for the REST API';
    const terms = extractKeyTerms(task, { useBigrams: true });
    const termStrings = terms.map((t) => t.term);

    const bigrams = termStrings.filter((t) => t.includes(' '));
    expect(bigrams.length).toBeGreaterThan(0);
  });

  it('skips bigrams when disabled', () => {
    const task = 'Implement rate limiting for the REST API';
    const terms = extractKeyTerms(task, { useBigrams: false });
    const termStrings = terms.map((t) => t.term);

    const bigrams = termStrings.filter((t) => t.includes(' '));
    expect(bigrams).toEqual([]);
  });

  it('provides stemmed forms', () => {
    const task = 'Configure authentication and authorization settings';
    const terms = extractKeyTerms(task, { useStemming: true });

    for (const term of terms) {
      expect(term.stemmedForm).toBeDefined();
      expect(term.stemmedForm.length).toBeGreaterThan(0);
    }
  });

  it('filters by minimum keyword length', () => {
    const task = 'A to B for C in D with E via REST API endpoints';
    const terms = extractKeyTerms(task, { minKeywordLength: 4 });
    const termStrings = terms.map((t) => t.term);

    for (const term of termStrings) {
      if (!term.includes(' ')) {
        expect(term.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('deduplicates by stemmed form', () => {
    const task = 'authentication authenticate authenticating authenticated auth';
    const terms = extractKeyTerms(task, { useStemming: true });

    const stemmedForms = terms.map((t) => t.stemmedForm);
    const uniqueStemmed = new Set(stemmedForms);
    expect(stemmedForms.length).toBe(uniqueStemmed.size);
  });

  it('respects custom stopwords', () => {
    const task = 'Configure kubernetes pods with redis caching';
    const terms = extractKeyTerms(task, { extraStopwords: ['kubernetes', 'redis'] });
    const termStrings = terms.map((t) => t.term);

    expect(termStrings).not.toContain('kubernetes');
    expect(termStrings).not.toContain('redis');
  });
});

// ─── COVERAGE SCORING ───────────────────────────────────────────────────────────

describe('scoreKeywordCoverage', () => {
  it('scores high coverage when all keywords are present', () => {
    const task = 'Set up ESLint for TypeScript with Prettier';
    const output = 'Here is how to configure ESLint for your TypeScript project with Prettier integration. First install eslint and prettier packages.';

    const result = scoreKeywordCoverage(task, output);
    expect(result.score).toBeGreaterThan(0.7);
    expect(result.passing).toBe(true);
    expect(result.coveredCount).toBeGreaterThan(0);
  });

  it('scores low coverage for completely unrelated output', () => {
    const task = 'Configure Docker containers for microservice deployment';
    const output = 'The weather today is sunny with temperatures around 72 degrees. We expect clear skies through the evening.';

    const result = scoreKeywordCoverage(task, output);
    expect(result.score).toBeLessThan(0.3);
    expect(result.passing).toBe(false);
  });

  it('handles empty task', () => {
    const result = scoreKeywordCoverage('', 'some output');
    expect(result.score).toBe(0);
    expect(result.totalKeywords).toBe(0);
  });

  it('handles empty output', () => {
    const result = scoreKeywordCoverage('implement caching', '');
    expect(result.score).toBe(0);
    expect(result.passing).toBe(false);
  });

  it('reports correct covered/missed counts', () => {
    const task = 'Implement Redis caching with TTL support';
    const output = 'We will use Redis as our caching solution. Each entry will have an expiration time.';

    const result = scoreKeywordCoverage(task, output);
    expect(result.totalKeywords).toBeGreaterThan(0);
    expect(result.coveredCount + result.missedCount).toBe(result.totalKeywords);
  });

  it('respects minCoverage threshold', () => {
    const task = 'Implement Redis caching with TTL support';
    const output = 'We will use Redis as our caching solution with TTL-based expiration for each entry.';

    const highThreshold = scoreKeywordCoverage(task, output, { minCoverage: 0.99 });
    const lowThreshold = scoreKeywordCoverage(task, output, { minCoverage: 0.1 });

    expect(highThreshold.passing).toBe(false);
    expect(lowThreshold.passing).toBe(true);
  });

  it('uses weighted scoring by default', () => {
    const task = 'Implement authentication with JWT tokens and password hashing';
    const output = 'Authentication is the process of verifying identity. We use JWT for tokens.';

    const result = scoreKeywordCoverage(task, output);
    expect(result.weightedScore).toBeDefined();
    expect(result.unweightedScore).toBeDefined();
    expect(typeof result.weightedScore).toBe('number');
    expect(typeof result.unweightedScore).toBe('number');
  });

  it('marks individual keywords as covered or not', () => {
    const task = 'Configure logging and monitoring for production';
    const output = 'Set up structured logging with Winston. Configure log levels and rotation.';

    const result = scoreKeywordCoverage(task, output);
    const coveredKws = result.keywords.filter((k) => k.covered);
    const missedKws = result.keywords.filter((k) => !k.covered);

    expect(coveredKws.length).toBeGreaterThan(0);
    expect(missedKws.length).toBeGreaterThan(0);
  });

  it('provides matchedAs for covered keywords', () => {
    const task = 'Implement authentication service';
    const output = 'The authentication module validates user credentials.';

    const result = scoreKeywordCoverage(task, output);
    const covered = result.keywords.filter((k) => k.covered);

    for (const kw of covered) {
      expect(kw.matchedAs).toBeDefined();
    }
  });

  it('matches via stemming (e.g. configure/configuration)', () => {
    const task = 'Configure the application settings';
    const output = 'Application configuration is done through environment variables.';

    const result = scoreKeywordCoverage(task, output, { useStemming: true });
    const appKw = result.keywords.find((k) => k.term === 'application');
    if (appKw) {
      expect(appKw.covered).toBe(true);
    }
  });

  it('returns section coverage for multi-section output', () => {
    const task = 'Set up authentication and authorization';
    const output = `# Authentication
Here is how to set up user authentication with JWT tokens.

# Authorization
Role-based access control ensures proper authorization of requests.

# Conclusion
That covers the basics.`;

    const result = scoreKeywordCoverage(task, output);
    if (result.sectionCoverage) {
      expect(result.sectionCoverage.length).toBeGreaterThan(1);
      for (const section of result.sectionCoverage) {
        expect(section.heading).toBeDefined();
        expect(section.coverage).toBeGreaterThanOrEqual(0);
        expect(section.coverage).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not return sectionCoverage for single-section output', () => {
    const task = 'Explain Docker basics';
    const output = 'Docker is a containerization platform that packages applications.';

    const result = scoreKeywordCoverage(task, output);
    expect(result.sectionCoverage).toBeUndefined();
  });

  it('uses unweighted scoring when configured', () => {
    const task = 'Set up ESLint TypeScript Prettier';
    const output = 'Install eslint and typescript packages for your project.';

    const weighted = scoreKeywordCoverage(task, output, { useWeightedScoring: true });
    const unweighted = scoreKeywordCoverage(task, output, { useWeightedScoring: false });

    expect(unweighted.score).toBe(unweighted.unweightedScore);
    expect(weighted.score).toBe(weighted.weightedScore);
  });
});

// ─── TOPIC GAP ANALYSIS ─────────────────────────────────────────────────────────

describe('identifyTopicGaps', () => {
  it('identifies gaps for missed important topics', () => {
    const task = 'Implement authentication, authorization, and rate limiting for the REST API';
    const output = 'Authentication is implemented using JWT tokens. Users can log in and receive a token.';

    const result = identifyTopicGaps(task, output);
    expect(result.gapCount).toBeGreaterThan(0);
    const gapTerms = result.gaps.map((g) => g.term);
    expect(gapTerms.some((t) => t.includes('rate') || t.includes('limit') || t.includes('authorization'))).toBe(true);
  });

  it('returns no gaps when all important topics are covered', () => {
    const task = 'Set up ESLint for TypeScript';
    const output = 'Install ESLint and configure it for TypeScript projects. Use the @typescript-eslint/parser with eslint and typescript plugins.';

    // With a high minGapImportance, only the highest-weighted gaps should be flagged
    // The output covers eslint and typescript directly, so no critical gaps
    const result = identifyTopicGaps(task, output, { minGapImportance: 0.95 });
    expect(result.gapCount).toBe(0);
    expect(result.severity).toBe('none');
  });

  it('assigns high severity when top-weighted topics are missed', () => {
    const task = 'Deploy application to Kubernetes with Helm charts';
    const output = 'The application is a simple web server that responds to HTTP requests.';

    const result = identifyTopicGaps(task, output);
    expect(['high', 'medium']).toContain(result.severity);
  });

  it('provides context for each gap', () => {
    const task = 'Configure database migrations with schema versioning';
    const output = 'The database stores user records.';

    const result = identifyTopicGaps(task, output);
    for (const gap of result.gaps) {
      expect(gap.context).toBeDefined();
      expect(gap.context.length).toBeGreaterThan(0);
    }
  });

  it('respects minGapImportance threshold', () => {
    const task = 'Implement caching with Redis and TTL expiration for the session store';
    const output = 'Redis is used as the caching backend.';

    const strict = identifyTopicGaps(task, output, { minGapImportance: 0.1 });
    const lenient = identifyTopicGaps(task, output, { minGapImportance: 0.9 });

    expect(strict.gapCount).toBeGreaterThanOrEqual(lenient.gapCount);
  });

  it('limits gaps to maxGaps', () => {
    const task = 'Implement authentication authorization caching logging monitoring error-handling rate-limiting load-balancing service-discovery circuit-breaking';
    const output = 'The system is deployed.';

    const result = identifyTopicGaps(task, output, { maxGaps: 3 });
    expect(result.gapCount).toBeLessThanOrEqual(3);
  });

  it('sorts gaps by importance descending', () => {
    const task = 'Deploy Kubernetes cluster with Helm, Istio service mesh, and Prometheus monitoring';
    const output = 'The system is running on a single server.';

    const result = identifyTopicGaps(task, output);
    for (let i = 1; i < result.gaps.length; i++) {
      expect(result.gaps[i]!.importance).toBeLessThanOrEqual(result.gaps[i - 1]!.importance);
    }
  });
});

// ─── ASSERTION: toCoverKeyTopics ────────────────────────────────────────────────

describe('toCoverKeyTopics', () => {
  it('passes when output covers key topics', () => {
    const assertion = toCoverKeyTopics('Set up ESLint for TypeScript with Prettier');
    const output = 'To configure ESLint for TypeScript with Prettier, first install the packages: eslint, @typescript-eslint/parser, and prettier.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('Coverage');
  });

  it('fails when output misses key topics', () => {
    const assertion = toCoverKeyTopics('Implement Redis caching with TTL support');
    const output = 'Here is how to set up a basic web server using Express.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('key topics');
  });

  it('uses context.prompt when no task string provided', () => {
    const assertion = toCoverKeyTopics({ minCoverage: 0.3 });
    const output = 'Docker containers provide isolation and portability for containerized applications. Containerization packages apps with their dependencies.';
    const context = { prompt: 'Explain Docker containerization basics' };

    const result = assertion.evaluate(output, context);
    expect(result.status).toBe('pass');
  });

  it('returns error when no task available', () => {
    const assertion = toCoverKeyTopics();
    const result = assertion.evaluate('some output');
    expect(result.status).toBe('error');
  });

  it('respects custom minCoverage', () => {
    const assertion = toCoverKeyTopics({ task: 'Implement caching with Redis', minCoverage: 0.95 });
    const output = 'Caching is important for performance.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
  });

  it('has descriptive name with threshold', () => {
    const assertion = toCoverKeyTopics({ minCoverage: 0.7 });
    expect(assertion.name).toContain('70%');
  });

  it('includes durationMs in result', () => {
    const assertion = toCoverKeyTopics('Test task description here');
    const result = assertion.evaluate('test output text here');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── ASSERTION: toHaveNoTopicGaps ───────────────────────────────────────────────

describe('toHaveNoTopicGaps', () => {
  it('passes when no important topics are missed', () => {
    const assertion = toHaveNoTopicGaps('Configure ESLint TypeScript');
    const output = 'ESLint is configured for TypeScript using @typescript-eslint/parser.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('fails when critical topics are missed', () => {
    const assertion = toHaveNoTopicGaps('Deploy to Kubernetes with Helm and Istio');
    const output = 'The application is deployed on a virtual machine.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('topic');
  });

  it('uses context.prompt as fallback', () => {
    const assertion = toHaveNoTopicGaps({ minGapImportance: 0.8 });
    const context = { prompt: 'Set up Docker compose' };
    const output = 'Docker compose defines multi-container applications in a docker-compose YAML file.';

    const result = assertion.evaluate(output, context);
    expect(result.status).toBe('pass');
  });

  it('returns error without task', () => {
    const assertion = toHaveNoTopicGaps();
    const result = assertion.evaluate('output');
    expect(result.status).toBe('error');
  });

  it('reports severity in failure message', () => {
    const assertion = toHaveNoTopicGaps('Implement Kubernetes Helm Istio Prometheus');
    const output = 'The cat sat on the mat.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/severity/);
  });
});

// ─── ASSERTION: toMeetKeywordScore ──────────────────────────────────────────────

describe('toMeetKeywordScore', () => {
  it('passes when keyword score meets threshold', () => {
    const assertion = toMeetKeywordScore({
      task: 'Configure ESLint for TypeScript',
      additionalKeywords: ['eslint', 'typescript'],
      minCoverage: 0.5,
    });
    const output = 'Install ESLint and configure it for TypeScript files.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('fails when keyword score is below threshold', () => {
    const assertion = toMeetKeywordScore({
      task: 'Implement Redis caching TTL',
      minCoverage: 0.8,
    });
    const output = 'The weather is nice today.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
  });

  it('accepts keyword array shorthand', () => {
    const assertion = toMeetKeywordScore(['docker', 'kubernetes', 'helm']);
    const output = 'Deploy with Docker containers and Kubernetes clusters using Helm charts for orchestration.';
    // The prompt needs to contain the same keywords so they extract as important
    const context = { prompt: 'docker kubernetes helm deployment' };

    const result = assertion.evaluate(output, context);
    expect(result.status).toBe('pass');
  });

  it('returns error when no task or keywords', () => {
    const assertion = toMeetKeywordScore({ minCoverage: 0.5 });
    const result = assertion.evaluate('output');
    expect(result.status).toBe('error');
  });

  it('includes score info in evidence on pass', () => {
    const assertion = toMeetKeywordScore({
      task: 'Set up testing framework',
      minCoverage: 0.3,
    });
    const output = 'Testing is configured with Vitest framework.';

    const result = assertion.evaluate(output);
    if (result.status === 'pass') {
      expect(result.evidence).toContain('Weighted');
    }
  });
});

// ─── ASSERTION: toHaveBalancedCoverage ──────────────────────────────────────────

describe('toHaveBalancedCoverage', () => {
  it('passes when all sections contribute to task', () => {
    const assertion = toHaveBalancedCoverage('Set up authentication and authorization');
    const output = `# Authentication
Set up user authentication with JWT tokens and session management.

# Authorization
Implement role-based access control for authorization of API endpoints.`;

    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('fails when a section has zero task coverage', () => {
    const assertion = toHaveBalancedCoverage({
      task: 'Implement caching with Redis and TTL',
      minSectionCoverage: 0.1,
    });
    const output = `# Redis Caching
Configure Redis for caching with TTL support.

# Weather Report
Today is sunny with clear skies and warm temperatures. The forecast shows no rain this week.`;

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Weather Report');
  });

  it('passes for single-section output', () => {
    const assertion = toHaveBalancedCoverage('Configure Docker');
    const output = 'Docker is configured using a Dockerfile and docker-compose.yml.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('single section');
  });

  it('uses context.prompt as fallback', () => {
    const assertion = toHaveBalancedCoverage();
    const context = { prompt: 'Set up CI/CD pipeline' };
    const output = 'CI/CD pipeline is configured with GitHub Actions.';

    const result = assertion.evaluate(output, context);
    expect(result.status).toBe('pass');
  });

  it('returns error without task', () => {
    const assertion = toHaveBalancedCoverage();
    const result = assertion.evaluate('output');
    expect(result.status).toBe('error');
  });
});

// ─── ASSERTION: toAddressTask ───────────────────────────────────────────────────

describe('toAddressTask', () => {
  it('passes when output addresses the task with good coverage and no gaps', () => {
    const assertion = toAddressTask({ task: 'Configure ESLint for TypeScript', minCoverage: 0.3, minGapImportance: 0.95 });
    const output = 'To configure ESLint for TypeScript, install @typescript-eslint/parser and eslint. Create an .eslintrc.json file with TypeScript configuration rules.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('Coverage');
  });

  it('fails when output is completely unrelated', () => {
    const assertion = toAddressTask('Deploy Kubernetes cluster with Helm charts');
    const output = 'The recipe calls for 2 cups of flour, 1 egg, and a pinch of salt.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
  });

  it('fails when coverage is low', () => {
    const assertion = toAddressTask({
      task: 'Implement Redis caching with TTL and eviction policies',
      minCoverage: 0.8,
    });
    const output = 'Redis is a database.';

    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
  });

  it('uses context.prompt as fallback', () => {
    const assertion = toAddressTask({ minCoverage: 0.2, minGapImportance: 0.95 });
    const context = { prompt: 'Explain Docker containers' };
    const output = 'Docker containers are lightweight, isolated environments for running applications. Containers share the host kernel and package an application with its dependencies.';

    const result = assertion.evaluate(output, context);
    expect(result.status).toBe('pass');
  });

  it('returns error without task', () => {
    const assertion = toAddressTask();
    const result = assertion.evaluate('output');
    expect(result.status).toBe('error');
  });
});

// ─── EDGE CASES ─────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles very short tasks', () => {
    const result = scoreKeywordCoverage('test', 'This is a test output.');
    expect(result).toBeDefined();
    expect(typeof result.score).toBe('number');
  });

  it('handles very long outputs', () => {
    const task = 'Explain Docker containerization';
    const output = 'Docker '.repeat(10000) + 'containerization is the process of packaging applications.';

    const result = scoreKeywordCoverage(task, output);
    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles special characters in task', () => {
    const task = 'Configure @typescript-eslint/parser with .eslintrc.json';
    const output = 'Use @typescript-eslint/parser in your .eslintrc.json configuration file.';

    const result = scoreKeywordCoverage(task, output);
    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThan(0);
  });

  it('handles unicode text', () => {
    const task = 'Set up internationalization (i18n) support';
    const output = 'Internationalization support is added with i18n configuration.';

    const result = scoreKeywordCoverage(task, output);
    expect(result).toBeDefined();
  });

  it('handles task with only stopwords', () => {
    const task = 'the a an is are was were';
    const result = scoreKeywordCoverage(task, 'some output');
    expect(result.totalKeywords).toBe(0);
    expect(result.score).toBe(1);
  });

  it('handles output that is a single word', () => {
    const task = 'Explain Docker and Kubernetes orchestration';
    const output = 'Docker';

    const result = scoreKeywordCoverage(task, output);
    expect(result.coveredCount).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });

  it('case insensitivity works correctly', () => {
    const task = 'Configure ESLINT for TYPESCRIPT';
    const output = 'eslint is configured for typescript projects';

    const result = scoreKeywordCoverage(task, output);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('proximity matching for bigrams works', () => {
    const task = 'rate limiting implementation';
    const output = 'The rate of requests is controlled by the limiting middleware in our implementation.';

    const result = scoreKeywordCoverage(task, output);
    expect(result.score).toBeGreaterThan(0);
  });
});

// ─── REAL-WORLD SCENARIOS ───────────────────────────────────────────────────────

describe('real-world scenarios', () => {
  it('PR review coverage: detects when review misses key areas', () => {
    const task = 'Review changes to authentication module, database migrations, and API routes';
    const output = 'The authentication changes look good. JWT validation is properly implemented with correct token expiration handling.';

    const result = scoreKeywordCoverage(task, output);
    // Should note that database migrations and API routes were missed
    const missed = result.keywords.filter((k) => !k.covered);
    expect(missed.some((k) => k.term.includes('database') || k.term.includes('migration') || k.term.includes('route'))).toBe(true);
  });

  it('code generation: validates output covers task requirements', () => {
    const task = 'Write a function that validates email addresses using regex and returns boolean';
    const output = `function validateEmail(email: string): boolean {
  const regex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return regex.test(email);
}`;

    const result = scoreKeywordCoverage(task, output);
    // Code output covers key terms: function, validates/validate, email, regex, boolean, returns
    expect(result.score).toBeGreaterThan(0.1);
    expect(result.coveredCount).toBeGreaterThan(0);
  });

  it('documentation task: comprehensive vs incomplete', () => {
    const task = 'Document the API endpoints including authentication, request format, response codes, and examples';

    const good = 'The API uses bearer token authentication. Requests must be JSON formatted. Success returns 200, errors return 4xx/5xx. Example: GET /users returns user list.';
    const bad = 'The API has several endpoints that you can call.';

    const goodScore = scoreKeywordCoverage(task, good);
    const badScore = scoreKeywordCoverage(task, bad);

    expect(goodScore.score).toBeGreaterThan(badScore.score);
  });

  it('agent eval scenario: detects stale run without actionable output', () => {
    const task = 'Review this pull request for code quality, security vulnerabilities, and test coverage';
    const output = 'I have reviewed the pull request. It looks fine overall.';

    const result = scoreKeywordCoverage(task, output);
    // Vague output should miss specific task terms
    expect(result.score).toBeLessThan(0.7);
  });
});
