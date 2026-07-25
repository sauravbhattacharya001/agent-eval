/**
 * Judge Framework — Built-in Rubric Library (Tier 3 Shared-Substrate Judgment)
 *
 * The `BUILTIN_RUBRICS` starter library: ready-made rubrics for common
 * evaluation scenarios. Split out of `judge-rubric.ts` so the starter content
 * (pure data factories) is independent of the rubric validator and the fluent
 * builder. Re-exported from `judge-rubric.ts` for a stable import surface.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type { Rubric } from './judge-types.js';

/**
 * Built-in rubrics for common evaluation scenarios.
 * These serve as examples and starting points for custom rubrics.
 */
export const BUILTIN_RUBRICS = {
  /**
   * Code review quality rubric.
   * Evaluates whether a code review is actionable, accurate, and complete.
   */
  codeReview: (): Rubric => ({
    name: 'Code Review Quality',
    description: 'Evaluates the quality of an AI-generated code review',
    passThreshold: 0.6,
    confidenceThreshold: 0.7,
    criteria: [
      {
        id: 'actionability',
        description: 'Are suggestions specific and actionable?',
        weight: 0.4,
        levels: [
          { score: 1, label: 'Vague', description: 'Only generic praise or criticism with no specific actions' },
          { score: 2, label: 'Weak', description: 'Some directional suggestions but no concrete code changes' },
          { score: 3, label: 'Partial', description: 'Mix of vague and specific suggestions' },
          { score: 4, label: 'Good', description: 'Most suggestions include specific changes or clear next steps' },
          { score: 5, label: 'Excellent', description: 'All suggestions include specific code changes, line references, or concrete next steps' },
        ],
      },
      {
        id: 'accuracy',
        description: 'Are identified issues real bugs or false positives?',
        weight: 0.4,
        levels: [
          { score: 1, label: 'Fabricated', description: 'Most flagged issues are false positives or hallucinated' },
          { score: 2, label: 'Unreliable', description: 'Many false positives mixed with some real issues' },
          { score: 3, label: 'Mixed', description: 'Some real issues found, but also notable false positives' },
          { score: 4, label: 'Reliable', description: 'Most issues are real, with rare false positives' },
          { score: 5, label: 'Precise', description: 'All flagged issues are real, with correct explanations' },
        ],
      },
      {
        id: 'completeness',
        description: 'Does the review cover all important aspects of the changes?',
        weight: 0.2,
        levels: [
          { score: 1, label: 'Superficial', description: 'Only comments on trivial aspects (formatting, naming)' },
          { score: 2, label: 'Narrow', description: 'Covers one dimension but misses important concerns' },
          { score: 3, label: 'Partial', description: 'Covers several aspects but has notable blind spots' },
          { score: 4, label: 'Thorough', description: 'Covers logic, security, performance, and style' },
          { score: 5, label: 'Comprehensive', description: 'Covers all dimensions plus edge cases, testing, and maintenance' },
        ],
      },
    ],
  }),

  /**
   * Task completion rubric.
   * Evaluates whether an agent fully completed its assigned task.
   */
  taskCompletion: (): Rubric => ({
    name: 'Task Completion Quality',
    description: 'Evaluates whether the agent completed its assigned task fully and correctly',
    passThreshold: 0.6,
    confidenceThreshold: 0.7,
    criteria: [
      {
        id: 'relevance',
        description: 'Does the output address the actual task?',
        weight: 0.3,
        levels: [
          { score: 1, label: 'Off-topic', description: 'Output is about a different topic entirely' },
          { score: 3, label: 'Related', description: 'Output is in the right domain but doesn\'t address the specific task' },
          { score: 5, label: 'On-target', description: 'Output directly addresses the task requirements' },
        ],
      },
      {
        id: 'completeness',
        description: 'Are all parts of the task addressed?',
        weight: 0.3,
        levels: [
          { score: 1, label: 'Stub', description: 'Output is a placeholder or barely started' },
          { score: 3, label: 'Partial', description: 'Some task requirements addressed, others missing' },
          { score: 5, label: 'Complete', description: 'All task requirements addressed with appropriate depth' },
        ],
      },
      {
        id: 'quality',
        description: 'Is the output well-structured and clear?',
        weight: 0.2,
        levels: [
          { score: 1, label: 'Poor', description: 'Disorganized, hard to follow, contains errors' },
          { score: 3, label: 'Adequate', description: 'Readable and mostly correct, but could be clearer' },
          { score: 5, label: 'High', description: 'Well-organized, clear, accurate, and professional' },
        ],
      },
      {
        id: 'depth',
        description: 'Does the output show appropriate depth of engagement?',
        weight: 0.2,
        levels: [
          { score: 1, label: 'Shallow', description: 'Generic surface-level response anyone could give' },
          { score: 3, label: 'Adequate', description: 'Shows engagement with the specifics but doesn\'t go deep' },
          { score: 5, label: 'Deep', description: 'Shows thorough understanding and addresses nuances' },
        ],
      },
    ],
  }),
} as const;
