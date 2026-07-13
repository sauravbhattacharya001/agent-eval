/**
 * Actionability Rubric — the built-in Tier-3 rubric for actionability judging.
 *
 * Split out of `./actionability.ts` (the public barrel) with **no behavior
 * change**: the `ACTIONABILITY_RUBRIC` definition was moved here verbatim so it
 * can be shared by both the barrel and the assertion factories
 * (`./actionability-assertions.ts`) without a circular import. The barrel
 * re-exports it, so consumers keep a single `./actionability.js` import path.
 *
 * @tier 3 — Shared-Substrate Judgment
 * @module
 */

import type { Rubric } from './judge.js';
import { buildRubric } from './judge.js';

/**
 * Built-in rubric for Tier 3 actionability judging.
 * Used when heuristic scoring is ambiguous (confidence < 0.6).
 */
export const ACTIONABILITY_RUBRIC: Rubric = buildRubric('Actionability')
  .describe(
    'Evaluates whether an agent\'s output provides concrete, actionable information ' +
    'that a human can use to make a decision or take a next step. ' +
    'The judge evaluates ONLY the output artifact — not the agent\'s intent or reasoning.',
  )
  .passAt(0.55)
  .confidenceAt(0.6)
  .criterion('specificity', 'Does the output reference specific files, functions, values, or resources?')
    .weight(0.35)
    .level(1, 'No specifics', 'Only vague references: "the file", "the function", "a value"')
    .level(2, 'Some specifics', 'A few concrete names, but mostly vague')
    .level(3, 'Mostly specific', 'Most references are to named files, functions, or values')
    .level(4, 'Highly specific', 'Consistently names files, lines, functions, config keys, versions')
    .level(5, 'Precise', 'Every reference is exact — full paths, line numbers, code snippets')
    .done()
  .criterion('directness', 'Does the output provide clear directions or is it hedged/equivocating?')
    .weight(0.3)
    .level(1, 'All filler', 'Entirely hedged/vague: "you might consider", "it depends"')
    .level(2, 'Mostly hedged', 'Some direction mixed with heavy hedging')
    .level(3, 'Balanced', 'Clear direction given but with some unnecessary caveats')
    .level(4, 'Direct', 'Clear recommendations with minimal hedging')
    .level(5, 'Decisive', 'Unambiguous instructions — human can act immediately')
    .done()
  .criterion('next-steps', 'Does the output give the human a clear next action to take?')
    .weight(0.2)
    .level(1, 'No next step', 'Output ends without any suggested action')
    .level(2, 'Vague next step', '"You should look into this" without specifics')
    .level(3, 'General next step', 'Suggests an action but missing details on how')
    .level(4, 'Clear next step', 'States what to do next with enough detail to start')
    .level(5, 'Complete next steps', 'Full step-by-step plan, ready to execute')
    .done()
  .criterion('contextual-fit', 'Is the output tailored to the specific task, or is it generic advice?')
    .weight(0.15)
    .level(1, 'Generic', 'Could apply to any project/task — not tailored')
    .level(2, 'Somewhat tailored', 'Mentions the task topic but advice is generic')
    .level(3, 'Moderately tailored', 'References task-specific details in parts')
    .level(4, 'Well-tailored', 'Clearly written for this specific task/context')
    .level(5, 'Perfectly fitted', 'Every suggestion is grounded in the specific context provided')
    .done()
  .build();
