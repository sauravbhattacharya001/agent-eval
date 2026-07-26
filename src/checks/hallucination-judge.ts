/**
 * Hallucination check — Tier 3 (model-as-judge) verification.
 *
 * The optional, shared-substrate half of the hallucination judge: when a
 * Tier-1/Tier-2 pass leaves a claim ambiguous (partially-grounded or
 * unverifiable) AND the caller opted into Tier 3, this module asks a judge
 * backend to grade the claim against the reference materials using a
 * human-calibrated grounding rubric.
 *
 * Independence note: the judge only ever sees the CLAIM plus the reference
 * MATERIALS and the best-matching passage — never the agent's internal
 * reasoning — and its verdict is a downgrade-only signal (it can mark a claim
 * `unverifiable` on low confidence) layered on top of the Tier-1/2 result.
 *
 * Split out of `hallucination-verification.ts` (no behaviour change) so the
 * deterministic Tier-1/2 grounding engine stays free of judge/rubric wiring.
 * Re-exported through `./hallucination-verification.js` so the seam import
 * path (`HALLUCINATION_RUBRIC`) is unchanged for consumers.
 *
 * @tier 3
 * @module
 */

import type { JudgeBackend, Rubric } from './judge.js';
import { buildRubric, JudgeEvaluator } from './judge.js';
import type {
  ClaimStatus,
  ClaimVerification,
  ExtractedClaim,
} from './hallucination-types.js';

/** Built-in rubric for hallucination verification. */
export const HALLUCINATION_RUBRIC: Rubric = buildRubric('Hallucination Verification')
  .describe('Evaluate whether a specific claim is grounded in provided reference materials.')
  .criterion('grounding', 'Is the claim supported by the reference materials?')
    .weight(0.6)
    .level(1, 'Contradicted', 'The reference directly contradicts this claim')
    .level(2, 'Ungrounded', 'No relevant information in references supports this claim')
    .level(3, 'Partially grounded', 'Some aspects are supported but claim extends beyond')
    .level(4, 'Mostly grounded', 'The core assertion is supported with minor gaps')
    .level(5, 'Fully grounded', 'The claim is directly and completely supported by references')
    .done()
  .criterion('specificity', 'How specific and verifiable is this claim?')
    .weight(0.2)
    .level(1, 'Vague', 'Too vague to verify meaningfully')
    .level(3, 'Moderate', 'Makes some specific assertions')
    .level(5, 'Highly specific', 'Makes precise, verifiable assertions')
    .done()
  .criterion('severity', 'If hallucinated, how harmful would this be?')
    .weight(0.2)
    .level(1, 'Critical', 'Would cause significant harm if believed')
    .level(3, 'Moderate', 'Could mislead but unlikely to cause direct harm')
    .level(5, 'Low', 'Minor inaccuracy with minimal real-world impact')
    .done()
  .passAt(0.6)
  .confidenceAt(0.6)
  .build();

/** Use Tier 3 judge to verify an ambiguous claim. */
export async function verifyWithJudge(
  claim: ExtractedClaim,
  references: string[],
  tier2Result: ClaimVerification,
  backend: JudgeBackend,
): Promise<ClaimVerification> {
  const evaluator = new JudgeEvaluator(backend, HALLUCINATION_RUBRIC);

  const judgeInput = [
    `CLAIM TO VERIFY: "${claim.text}"`,
    `CLAIM TYPE: ${claim.kind}`,
    '',
    'REFERENCE MATERIALS:',
    ...references.map((r, i) => `--- Reference ${i + 1} ---\n${r.slice(0, 2000)}`),
    '',
    tier2Result.groundingEvidence
      ? `BEST MATCHING PASSAGE: "${tier2Result.groundingEvidence}"`
      : 'NO CLOSE MATCH FOUND IN REFERENCES',
  ].join('\n');

  try {
    const result = await evaluator.evaluate(judgeInput, {
      task: 'Verify whether this claim is grounded in the provided reference materials.',
      references,
    });

    const groundingScore = result.criterionScores.find((s) => s.criterionId === 'grounding');
    const normalizedGrounding = groundingScore?.normalizedScore ?? 0;

    let status: ClaimStatus;
    if (normalizedGrounding >= 0.8) status = 'grounded';
    else if (normalizedGrounding >= 0.5) status = 'partially-grounded';
    else if (normalizedGrounding <= 0.2) status = 'contradicted';
    else status = 'ungrounded';

    if (result.confidence === 'low') status = 'unverifiable';

    return {
      claim, status, verifiedBy: 'tier3-judge',
      confidence: result.confidenceValue,
      groundingEvidence: tier2Result.groundingEvidence,
      reason: result.summary,
    };
  } catch {
    return tier2Result;
  }
}
