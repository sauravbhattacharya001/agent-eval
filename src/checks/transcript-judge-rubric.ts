/**
 * transcript-judge-rubric.ts — the default offline fleet-quality rubric.
 *
 * Split out of `transcript-judge.ts` along the rubric-definition seam (no
 * behavior change).
 *
 * @tier 3 — shared-substrate judgment support, fenced off from the gate.
 */

import { buildRubric, type Rubric } from './judge.js';

/**
 * A conservative, general-purpose rubric for offline second-opinion on agent
 * output. `confidenceAt(0.7)` means anything the judge isn't ≥70% sure of
 * collapses to `needs-human-review` rather than a pass/fail.
 *
 * `execution_integrity` is weighted highest and deliberately dominates: a run the
 * harness recorded as timeout / abandon / error must not score "pass" just
 * because its final message reads as polished. This closes the "looks done vs.
 * is done" gap calibration exposed (a $3 timeout scored pass on output polish).
 */
export function defaultFleetRubric(): Rubric {
  return buildRubric('fleet-offline-quality')
    .describe(
      'Offline second-opinion on agent output quality. SIGNAL ONLY — never a gate verdict. ' +
      'Treat artifacts.execution_record as authoritative ground truth about whether the run ' +
      'actually completed; a recorded timeout/abandon/error means the run did NOT succeed, ' +
      'no matter how finished the deliverable looks.',
    )
    .confidenceAt(0.7)
    .criterion('execution_integrity', 'Per artifacts.execution_record, did the run actually complete successfully (vs. timeout / abandon / error / never-finished)?')
      .level(0, 'failed', 'Recorded outcome shows the run failed, timed out, was abandoned, or never finished.')
      .level(1, 'incomplete', 'Recorded outcome is ambiguous or shows the run only partially completed.')
      .level(2, 'completed', 'Recorded outcome confirms the run completed successfully.')
      .weight(0.45)
      .done()
    .criterion('task_fulfilment', 'Does the output actually address the stated task?')
      .level(0, 'unrelated', 'Output does not address the task at all.')
      .level(1, 'partial', 'Addresses some of the task but leaves clear gaps.')
      .level(2, 'complete', 'Fully and directly addresses the stated task.')
      .weight(0.3)
      .done()
    .criterion('coherence', 'Is the output internally consistent and well-formed?')
      .level(0, 'broken', 'Contradictory, malformed, or unusable.')
      .level(1, 'rough', 'Usable but with notable inconsistencies.')
      .level(2, 'clean', 'Coherent, consistent, well-formed.')
      .weight(0.1)
      .done()
    .criterion('artifact_support', 'Do the actions/artifacts support the claimed output?')
      .level(0, 'unsupported', 'Output is not backed by the recorded actions.')
      .level(1, 'weak', 'Partially supported by the actions taken.')
      .level(2, 'supported', 'Clearly supported by the recorded actions.')
      .weight(0.15)
      .done()
    .build();
}
