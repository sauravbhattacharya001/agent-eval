/**
 * transcript-judge.ts — The AgentLens → Tier-3 adapter ("B").
 *
 * This is the missing seam: it takes an AgentLens transcript (the
 * `transcript-contract@v1` markdown produced by `export_transcript()`) and
 * projects it into the narrow `JudgeContext` the Tier-3 judge consumes, then
 * runs the judge OFFLINE and returns a LABELED, NON-SCORING annotation.
 *
 * Doctrine enforced here (independence, not cost):
 *   - The judge sees ARTIFACTS ONLY. The `(decision) ...` reasoning lines that
 *     AgentLens writes inside `## Actions Taken` are STRIPPED before anything is
 *     handed to the judge. A model never grades another model's self-narration.
 *   - The result is a SIGNAL, never a verdict: every annotation is tagged
 *     `opinion, not evidence` and carries the judge's own confidence. It must
 *     never feed the real-time Tier-1+2 gate or move a score.
 *   - This runs OFFLINE only (batch, metered). It is not in any hot path.
 *
 * Structure: the parse/project, token-cap, and rubric seams live in sibling
 * modules (`transcript-judge-parse`, `-tokens`, `-rubric`); this file wires them
 * together and owns the adapter entry point. All names remain re-exported here
 * so consumers keep importing from `transcript-judge.js` unchanged.
 *
 * @tier 3 — shared-substrate judgment, fenced off from the gate.
 */

import {
  JudgeEvaluator,
  type Rubric,
  type JudgeBackend,
  type JudgeResult,
} from './judge.js';
import { parseTranscript, projectForJudge } from './transcript-judge-parse.js';
import { applyTokenCap, type TokenCapOptions } from './transcript-judge-tokens.js';
import { defaultFleetRubric } from './transcript-judge-rubric.js';

// Re-export the seam modules so existing importers of `transcript-judge.js`
// keep working unchanged (public surface preserved).
export {
  parseTranscript,
  projectForJudge,
  type ParsedTranscript,
  type JudgeProjection,
} from './transcript-judge-parse.js';
export {
  estimateTokens,
  applyTokenCap,
  type TokenCapOptions,
} from './transcript-judge-tokens.js';
export { defaultFleetRubric } from './transcript-judge-rubric.js';

// ─── The adapter entry point ─────────────────────────────────────────────────

/** A labeled, non-scoring annotation — the only thing this adapter emits. */
export interface JudgeAnnotation {
  /** Always set. Marks this as opinion, never gate evidence. */
  label: 'opinion, not evidence';
  /** Always 3. */
  tier: 3;
  /** Never blocking — fenced off from the real-time gate. */
  blocking: false;
  sessionTitle: string;
  result: JudgeResult;
  meta: {
    reasoningStripped: boolean;
    inputTruncated: boolean;
    inputTokens: number;
    skipped?: string;
  };
}

export interface JudgeTranscriptOptions extends TokenCapOptions {
  rubric?: Rubric;
}

/**
 * The seam. transcript (markdown) → offline Tier-3 annotation.
 *
 * @param markdown  a transcript-contract@v1 document from AgentLens
 * @param backend   any JudgeBackend (e.g. LLMJudgeBackend) — OFFLINE use only
 */
export async function judgeTranscript(
  markdown: string,
  backend: JudgeBackend,
  opts: JudgeTranscriptOptions = {},
): Promise<JudgeAnnotation> {
  const parsed = parseTranscript(markdown);
  const projection = projectForJudge(parsed);
  const capped = applyTokenCap(projection, opts);

  const rubric = opts.rubric ?? defaultFleetRubric();
  const evaluator = new JudgeEvaluator(backend, rubric);

  const result = await evaluator.evaluate(capped.projection.output, {
    task: capped.projection.context.task,
    artifacts: capped.projection.context.artifacts,
  });

  return {
    label: 'opinion, not evidence',
    tier: 3,
    blocking: false,
    sessionTitle: parsed.title,
    result,
    meta: {
      reasoningStripped: parsed.reasoningStripped,
      inputTruncated: capped.truncated,
      inputTokens: capped.inputTokens,
    },
  };
}
