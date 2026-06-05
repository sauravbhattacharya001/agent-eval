/**
 * Example eval spec — testing output format compliance.
 *
 * Demonstrates Tier 1 (deterministic) checks:
 * - JSON schema validation
 * - Required sections in markdown
 * - Length constraints
 * - Structural expectations
 *
 * Run with:
 *   agent-eval run examples/
 */

import { defineEval, LocalProvider, toBeValidJson, toContain, toMatch, toHaveMinLength, toHaveMaxLength, toStartWith, custom } from '../src/index.js';

const mockOutputs: Record<string, string> = {
  'Generate a project summary in JSON format with title, description, and tags array': JSON.stringify(
    {
      title: 'agent-eval',
      description: 'A TypeScript framework for evaluating AI agent outputs',
      tags: ['testing', 'ai', 'evaluation', 'typescript'],
    },
    null,
    2,
  ),

  'Write a code review in markdown with sections: Summary, Issues Found, Suggestions': `# Code Review

## Summary

The pull request adds a new caching layer to the API gateway. The implementation correctly handles cache invalidation and TTL-based expiry.

## Issues Found

1. **Memory leak in cache eviction** (line 45): The \`WeakRef\` cleanup callback is never unregistered, leading to accumulation of dead callbacks over time.
2. **Missing error handling** (line 78): The \`fetch\` call inside the cache-miss path has no \`try/catch\`, so network errors will crash the middleware.
3. **Race condition** (lines 92-97): Concurrent requests for the same uncached key will all trigger fetches simultaneously. Consider a "single-flight" pattern.

## Suggestions

- Add a \`maxSize\` config option to prevent unbounded cache growth
- Consider using \`Map\` instead of plain object for O(1) deletion
- Add unit tests for the eviction timer edge cases
- Document the cache key format in a JSDoc comment
`,

  'Respond with exactly: OK': 'OK',
};

export default defineEval({
  name: 'Output format compliance',
  provider: new LocalProvider({ outputs: mockOutputs }),

  specs: [
    {
      name: 'JSON output has correct structure',
      prompt: 'Generate a project summary in JSON format with title, description, and tags array',
      assertions: [
        toBeValidJson(),
        custom('has required fields', (output) => {
          const obj = JSON.parse(output) as Record<string, unknown>;
          const missing: string[] = [];
          if (!('title' in obj)) missing.push('title');
          if (!('description' in obj)) missing.push('description');
          if (!('tags' in obj)) missing.push('tags');
          if (missing.length > 0) {
            return { pass: false, message: `Missing required fields: ${missing.join(', ')}` };
          }
          return { pass: true };
        }),
        custom('tags is a non-empty array', (output) => {
          const obj = JSON.parse(output) as { tags?: unknown };
          if (!Array.isArray(obj.tags)) {
            return { pass: false, message: 'tags should be an array' };
          }
          if (obj.tags.length === 0) {
            return { pass: false, message: 'tags array should not be empty' };
          }
          return { pass: true };
        }),
      ],
    },
    {
      name: 'markdown review has required sections',
      prompt: 'Write a code review in markdown with sections: Summary, Issues Found, Suggestions',
      assertions: [
        toContain('## Summary'),
        toContain('## Issues Found'),
        toContain('## Suggestions'),
        toHaveMinLength(200),
        toMatch(/^\d+\./m), // has numbered items
        custom('issues are actionable (reference line numbers)', (output) => {
          // Tier 1: check that issues reference specific locations
          const issuesSection = output.split('## Issues Found')[1]?.split('##')[0] ?? '';
          const hasLineRefs = /line\s+\d+/i.test(issuesSection);
          return {
            pass: hasLineRefs,
            message: 'Issues should reference specific line numbers to be actionable',
          };
        }),
        custom('suggestions are concrete', (output) => {
          const sugSection = output.split('## Suggestions')[1] ?? '';
          const bulletCount = (sugSection.match(/^[-*]\s+/gm) ?? []).length;
          return {
            pass: bulletCount >= 2,
            message: `Expected at least 2 concrete suggestions, found ${bulletCount}`,
          };
        }),
      ],
    },
    {
      name: 'exact response matches expectation',
      prompt: 'Respond with exactly: OK',
      assertions: [
        toStartWith('OK'),
        toHaveMaxLength(10),
      ],
    },
  ],
});
