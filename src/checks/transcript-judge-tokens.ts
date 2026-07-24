/**
 * transcript-judge-tokens.ts — per-session input token cap.
 *
 * Split out of `transcript-judge.ts` along the cost-control seam (no behavior
 * change). The fleet has at least one ~19.3M-token monster; without this cap an
 * offline pass could cost tens of dollars on a single session.
 *
 * @tier 3 — shared-substrate judgment support, fenced off from the gate.
 */

import type { JudgeProjection } from './transcript-judge-parse.js';

/** ~4 chars/token heuristic; deliberately conservative. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export interface TokenCapOptions {
  /** Max input tokens to send to the judge per session. Default 8000. */
  maxInputTokens?: number;
}

/**
 * Enforce a per-session input budget. We truncate the largest artifact first,
 * keeping head+tail (where the signal usually lives), and record that
 * truncation happened.
 */
export function applyTokenCap(
  proj: JudgeProjection,
  opts: TokenCapOptions = {},
): { projection: JudgeProjection; truncated: boolean; inputTokens: number } {
  const cap = opts.maxInputTokens ?? 8000;
  let truncated = false;

  const budgetFor = (s: string, max: number): string => {
    if (estimateTokens(s) <= max) return s;
    truncated = true;
    const keepChars = max * 4;
    const head = Math.floor(keepChars * 0.6);
    const tail = keepChars - head;
    return `${s.slice(0, head)}\n...[truncated ${estimateTokens(s) - max} tokens]...\n${s.slice(-tail)}`;
  };

  // Reserve ~40% for the task+output, cap each artifact with the rest.
  const reserve = Math.floor(cap * 0.4);
  const output = budgetFor(proj.output, reserve);
  const task = budgetFor(proj.context.task, Math.floor(cap * 0.1));

  const artifactBudget = cap - estimateTokens(output) - estimateTokens(task);
  const artKeys = Object.keys(proj.context.artifacts);
  const perArt = artKeys.length ? Math.floor(artifactBudget / artKeys.length) : 0;
  const artifacts: Record<string, string> = {};
  for (const k of artKeys) {
    artifacts[k] = budgetFor(proj.context.artifacts[k] ?? '', Math.max(perArt, 200));
  }

  let projection: JudgeProjection = { output, context: { task, artifacts } };
  let inputTokens =
    estimateTokens(output) +
    estimateTokens(task) +
    Object.values(artifacts).reduce((n, v) => n + estimateTokens(v), 0);

  // Final hard clamp: per-component budgeting + rounding/min-floors can let the
  // sum drift a few tokens over. Guarantee the contract (never exceed `cap`) by
  // trimming the largest artifact until the total fits.
  while (inputTokens > cap) {
    const keys = Object.keys(artifacts);
    if (keys.length === 0) break;
    const largest = keys.reduce((a, b) =>
      estimateTokens(artifacts[a] ?? '') >= estimateTokens(artifacts[b] ?? '') ? a : b,
    );
    const over = inputTokens - cap;
    const cur = artifacts[largest] ?? '';
    if (cur.length === 0) {
      // Drop an already-empty artifact so it can't be re-selected as `largest`
      // forever (loop progress). Reflect.deleteProperty is the lint-clean
      // equivalent of `delete` on a dynamically computed key.
      Reflect.deleteProperty(artifacts, largest);
      truncated = true;
    } else {
      const dropChars = Math.min(cur.length, over * 4 + 8);
      artifacts[largest] = cur.slice(0, Math.max(0, cur.length - dropChars));
      truncated = true;
    }
    projection = { output, context: { task, artifacts } };
    inputTokens =
      estimateTokens(output) +
      estimateTokens(task) +
      Object.values(artifacts).reduce((n, v) => n + estimateTokens(v), 0);
  }

  return { projection, truncated, inputTokens };
}
