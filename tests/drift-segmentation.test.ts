/**
 * Tests for the extracted drift task-decomposition & output-segmentation module.
 *
 * `decomposeTask` and `segmentOutput` are also exercised transitively through
 * the drift pipeline (see drift.test.ts, which imports them via the `./drift.js`
 * re-export). These tests pin the two structural passes' contract DIRECTLY
 * against `drift-segmentation.ts` — the home where they're defined — so the
 * extracted unit is protected on its own and the seam stays behavior-stable:
 *
 * - decomposeTask: action/subject extraction, multi-requirement splitting,
 *   list detection (bullet/number), extra verbs, noun-phrase fallback, and the
 *   confidence tiers (0.8 structured / 0.4 weak / 0.5 whole-task fallback).
 * - segmentOutput: heading splits, paragraph topic-shift splits, the
 *   single-segment fallback, and character-offset bookkeeping.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  decomposeTask,
  segmentOutput,
} from '../src/checks/drift-segmentation.js';
import type {
  TaskRequirement,
  OutputSegment,
} from '../src/checks/drift-segmentation.js';

describe('drift-segmentation: decomposeTask', () => {
  it('returns no requirements for empty or whitespace tasks', () => {
    expect(decomposeTask('')).toEqual([]);
    expect(decomposeTask('   ')).toEqual([]);
    expect(decomposeTask('\n\t  \n')).toEqual([]);
  });

  it('extracts a single (action, subject) requirement with high confidence', () => {
    const reqs = decomposeTask('Fix the login bug');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('fix');
    expect(reqs[0]?.subject).toContain('login bug');
    expect(reqs[0]?.confidence).toBe(0.8);
  });

  it('drops leading determiners/politeness words from the subject', () => {
    const reqs = decomposeTask('Please review the changes in this PR');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('review');
    // "the", "this" stripped; subject keeps the meaningful nouns
    expect(reqs[0]?.subject).toContain('changes');
    expect(reqs[0]?.subject).not.toContain('the ');
  });

  it('splits multiple requirements joined by "and"', () => {
    const reqs = decomposeTask('Fix the bug and add unit tests');
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    const actions = reqs.map((r) => r.action);
    expect(actions).toContain('fix');
    expect(actions).toContain('add');
  });

  it('splits semicolon-separated clauses', () => {
    const reqs = decomposeTask('Explain the error; fix if possible; update docs');
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    const actions = reqs.map((r) => r.action);
    expect(actions).toContain('explain');
    expect(actions).toContain('update');
  });

  it('detects a bullet list as separate requirements', () => {
    const task = '- Add input validation\n- Write tests for the parser\n- Update the README';
    const reqs = decomposeTask(task);
    expect(reqs).toHaveLength(3);
    expect(reqs.map((r) => r.action)).toEqual(
      expect.arrayContaining(['add', 'write', 'update']),
    );
  });

  it('detects a numbered list as separate requirements', () => {
    const task = '1. Refactor the auth module\n2. Document the public API';
    const reqs = decomposeTask(task);
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.action)).toEqual(
      expect.arrayContaining(['refactor', 'document']),
    );
  });

  it('recognizes a verb only in the first five words (imperative position)', () => {
    const reqs = decomposeTask('Deploy the service to production');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('deploy');
    expect(reqs[0]?.subject).toContain('service');
  });

  it('honors custom extra action verbs', () => {
    const reqs = decomposeTask('Frobulate the quantum field', ['frobulate']);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('frobulate');
    expect(reqs[0]?.confidence).toBe(0.8);
  });

  it('lower-cases custom extra verbs before matching', () => {
    const reqs = decomposeTask('Frobulate the field', ['FROBULATE']);
    expect(reqs[0]?.action).toBe('frobulate');
  });

  it('falls back to a low-confidence noun-phrase requirement when no verb is present', () => {
    const reqs = decomposeTask('ESLint configuration guide');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('address');
    expect(reqs[0]?.confidence).toBeLessThan(0.5);
    expect(reqs[0]?.subject).toContain('eslint configuration guide');
  });

  it('keeps the original clause text in the description for a noun-phrase fallback', () => {
    // extractRequirement returns description = the clause verbatim (only the
    // empty-requirements whole-task fallback normalizes whitespace), so a
    // verb-less phrase preserves its original spacing.
    const reqs = decomposeTask('the   widget    registry');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('address');
    expect(reqs[0]?.description).toBe('the   widget    registry');
  });

  it('falls back to a weak 0.4 requirement when a verb is present but the subject filters to empty', () => {
    // "Fix the" — the verb 'fix' is found, but the only remaining word 'the' is a
    // dropped determiner, so `subject` collapses to '' and extractRequirement takes
    // its `if (!subject)` arm: action is kept, confidence drops to 0.4, and subject
    // falls back to the whole (lower-cased) clause. This is a DIFFERENT 0.4 path from
    // the verb-less noun-phrase fallback above.
    const reqs = decomposeTask('Fix the');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('fix');
    expect(reqs[0]?.confidence).toBe(0.4);
    expect(reqs[0]?.subject).toBe('fix the');
  });

  it('keeps confidence 0.4 with an all-determiner subject even when a verb matched', () => {
    // 'Review the this that' — verb 'review' matched, but every following token is a
    // stripped determiner, so the subject empties and the weak fallback fires.
    const reqs = decomposeTask('Review the this that');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('review');
    expect(reqs[0]?.confidence).toBe(0.4);
    expect(reqs[0]?.subject).toBe('review the this that');
  });

  it('produces a TaskRequirement with all required fields', () => {
    const reqs: TaskRequirement[] = decomposeTask('Build the dashboard');
    const req = reqs[0];
    expect(req).toBeDefined();
    expect(typeof req?.description).toBe('string');
    expect(typeof req?.action).toBe('string');
    expect(typeof req?.subject).toBe('string');
    expect(typeof req?.confidence).toBe('number');
  });
});

describe('drift-segmentation: segmentOutput', () => {
  it('returns no segments for empty or whitespace output', () => {
    expect(segmentOutput('')).toEqual([]);
    expect(segmentOutput('   ')).toEqual([]);
    expect(segmentOutput('\n  \t\n')).toEqual([]);
  });

  it('returns a single segment for short unstructured output', () => {
    const segments = segmentOutput('This is a simple response with no headings.');
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('This is a simple response with no headings.');
    expect(segments[0]?.addressesRequirements).toEqual([]);
    expect(segments[0]?.relevanceScore).toBe(0);
  });

  it('splits on markdown headings', () => {
    // A leading heading has no preceding text to close, so the first block keeps
    // the default 'Introduction' label; the second heading closes it and labels
    // the following block.
    const output = [
      '# Summary',
      'We reviewed the change and it looks correct.',
      '',
      '## Details',
      'The parser now handles the empty-input edge case.',
    ].join('\n');
    const segments = segmentOutput(output);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.map((s) => s.label)).toContain('Details');
  });

  it('labels a block from its heading when preceding content exists', () => {
    const output = [
      'Some intro text that precedes the first real heading.',
      '## Findings',
      'Two issues worth calling out in the diff.',
    ].join('\n');
    const segments = segmentOutput(output);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.map((s) => s.label)).toContain('Findings');
  });

  it('splits on capitalized "Heading:" style section markers', () => {
    const output = [
      'Initial overview of the work performed here.',
      'Findings',
      'There are two issues worth calling out in the diff.',
    ].join('\n');
    const segments = segmentOutput(output);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.map((s) => s.label)).toContain('Findings');
  });

  it('records character offsets that stay within the output bounds', () => {
    const output = '# A\nfirst block of text here\n\n# B\nsecond block of text here';
    const segments = segmentOutput(output);
    for (const seg of segments) {
      expect(seg.startIndex).toBeGreaterThanOrEqual(0);
      expect(seg.endIndex).toBeGreaterThanOrEqual(seg.startIndex);
    }
  });

  it('splits a long output on a topic-shifted paragraph break', () => {
    const para1 = 'The authentication flow was reviewed in detail. '.repeat(8);
    const para2 = 'Separately, the billing invoice rendering pipeline uses cached templates. '.repeat(8);
    const output = `${para1}\n\n${para2}`;
    const segments = segmentOutput(output);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT split a long paragraph break when the topic stays the same', () => {
    const sentence = 'The authentication token refresh logic was reviewed and updated carefully. ';
    const output = `${sentence.repeat(6)}\n\n${sentence.repeat(6)}`;
    const segments = segmentOutput(output);
    // High lexical overlap across the break → treated as one continuous topic.
    expect(segments).toHaveLength(1);
  });

  it('truncates a derived paragraph-shift label longer than 50 characters', () => {
    // deriveLabel takes the first five words of the shifted paragraph's opening line.
    // When those five words together exceed 50 chars it is clipped to 50 + … so the
    // label stays compact. Existing tests only exercised short derived labels.
    const para1 = 'Alpha authentication flow reviewed thoroughly here now. '.repeat(8);
    const longHead =
      'Billingpipeline invoicerendering templatecaching subscriptionmanagement reconciliationengine now proceeds.';
    const para2 = longHead + ' ' + 'invoicerendering templatecaching separately entirely done. '.repeat(6);
    const segments = segmentOutput(`${para1}\n\n${para2}`);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const shifted = segments[segments.length - 1];
    expect(shifted?.label.length).toBe(51); // 50 chars + the single ellipsis char
    expect(shifted?.label.endsWith('\u2026')).toBe(true);
  });

  it('produces an OutputSegment with all required fields', () => {
    const segments: OutputSegment[] = segmentOutput('# Title\nsome content body');
    const seg = segments[0];
    expect(seg).toBeDefined();
    expect(typeof seg?.text).toBe('string');
    expect(typeof seg?.label).toBe('string');
    expect(typeof seg?.startIndex).toBe('number');
    expect(typeof seg?.endIndex).toBe('number');
    expect(Array.isArray(seg?.addressesRequirements)).toBe(true);
    expect(typeof seg?.relevanceScore).toBe('number');
  });
});
