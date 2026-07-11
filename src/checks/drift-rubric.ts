/**
 * Built-in drift rubric — the human-calibrated Tier 3 rubric used by the drift
 * judge for ambiguous drift cases.
 *
 * This lives in its own leaf module (rather than inside ./drift.ts) so the rubric
 * — a static, self-contained artifact with no dependency on the drift engine — is
 * importable without pulling in the orchestrator, matching the pattern already
 * established for ./drift-types.ts. Re-exported from ./drift.ts so the public
 * surface (`./drift.js` and the barrel) is unchanged.
 *
 * @tier 3 — Shared-Substrate Judgment rubric
 * @module
 */

import type { Rubric } from './judge.js';
import { buildRubric } from './judge.js';

/**
 * Built-in rubric for the drift judge.
 * Used when Tier 3 evaluation is needed for ambiguous drift cases.
 */
export const DRIFT_RUBRIC: Rubric = buildRubric('Task Drift Assessment')
  .describe('Evaluates whether an agent\'s output stays on-task or drifts off-topic')
  .passAt(0.6)
  .confidenceAt(0.65)
  .criterion('task-address', 'Does the output directly address the assigned task?')
    .level(1, 'Off-topic', 'Output is about a completely different topic than the task')
    .level(2, 'Tangential', 'Output is in the same domain but does not address the specific task')
    .level(3, 'Partial', 'Output addresses some aspects of the task but misses key requirements')
    .level(4, 'Mostly on-task', 'Output addresses the main task with minor tangents')
    .level(5, 'Fully on-task', 'Output directly and completely addresses all task requirements')
    .weight(0.4)
    .done()
  .criterion('action-alignment', 'Does the output perform the requested ACTION (not just discuss the topic)?')
    .level(1, 'Wrong action', 'Output performs a completely different action (e.g. rewrites instead of reviews)')
    .level(2, 'Misaligned', 'Output partially performs the action but mostly does something else')
    .level(3, 'Mixed', 'Some of the requested action is performed alongside other actions')
    .level(4, 'Mostly aligned', 'The requested action is performed with minor deviations')
    .level(5, 'Perfectly aligned', 'Output performs exactly the requested action on the requested subject')
    .weight(0.35)
    .done()
  .criterion('focus', 'How focused is the output on the task vs. tangential content?')
    .level(1, 'Unfocused', 'Mostly tangential content with the task buried or absent')
    .level(2, 'Scattered', 'Significant tangential content distracting from the task')
    .level(3, 'Adequate', 'Some tangents but the task is the primary focus')
    .level(4, 'Focused', 'Minimal tangents, almost entirely about the task')
    .level(5, 'Laser-focused', 'Every part of the output is directly relevant to the task')
    .weight(0.25)
    .done()
  .build();
