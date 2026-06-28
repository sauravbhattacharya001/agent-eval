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
 * @tier 3 — shared-substrate judgment, fenced off from the gate.
 */

import {
  JudgeEvaluator,
  buildRubric,
  type Rubric,
  type JudgeBackend,
  type JudgeResult,
} from './judge.js';

// ─── Transcript parsing ──────────────────────────────────────────────────────

/** The sections AgentLens emits, parsed out of a transcript-contract@v1 doc. */
export interface ParsedTranscript {
  title: string;
  task: string;
  actionsTaken: string;       // reasoning lines already stripped
  keyOutputs: string;
  outcome: string;
  errors: string;
  duration: string;
  /** True if any `(decision) ...` reasoning lines were removed. */
  reasoningStripped: boolean;
}

/** Section headers, exactly as produced by AgentLens transcript.py. */
const SECTIONS = [
  'Task',
  'Actions Taken',
  'Key Outputs',
  'Outcome',
  'Errors & Retries',
  'Duration',
] as const;

/**
 * Remove the agent's self-narration. AgentLens writes decision/reasoning as
 * lines like `3. (decision) <reasoning>` inside `## Actions Taken`. These are
 * CLAIMS and must never reach the judge.
 */
function stripReasoning(actions: string): { text: string; stripped: boolean } {
  const lines = actions.split('\n');
  const kept = lines.filter((l) => !/^\s*\d+\.\s*\(decision\)/i.test(l));
  return { text: kept.join('\n').trim(), stripped: kept.length !== lines.length };
}

/**
 * Parse a transcript-contract@v1 markdown document into its sections.
 * Tolerant of missing sections (an errored run may omit Key Outputs, etc.).
 */
export function parseTranscript(markdown: string): ParsedTranscript {
  const titleMatch = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch?.[1]?.trim() ?? '(untitled run)';

  const out: Record<string, string> = {};
  for (const name of SECTIONS) {
    // Capture from "## <name>" to the next "## " or end of doc.
    // NOTE: JS regex has no \Z; use a greedy body anchored by a lookahead that
    // matches either the next "## " heading OR end-of-string ($ with no 'm').
    const esc = name.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');
    const re = new RegExp(`^##\\s+${esc}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|(?![\\s\\S]))`, 'm');
    const m = markdown.match(re);
    out[name] = (m?.[1] ?? '').trim();
  }

  const stripped = stripReasoning(out['Actions Taken'] ?? '');

  return {
    title,
    task: out['Task'] ?? '',
    actionsTaken: stripped.text,
    keyOutputs: out['Key Outputs'] ?? '',
    outcome: out['Outcome'] ?? '',
    errors: out['Errors & Retries'] ?? '',
    duration: out['Duration'] ?? '',
    reasoningStripped: stripped.stripped,
  };
}

// ─── Transcript → JudgeContext projection ────────────────────────────────────

/** What the judge is allowed to see, projected from a transcript. */
export interface JudgeProjection {
  /** The artifact being judged: the agent's deliverable. */
  output: string;
  /** Context minus chainOfThought (JudgeEvaluator adds that). */
  context: { task: string; artifacts: Record<string, string> };
}

/**
 * Build the judge's input from a parsed transcript — OBJECTIVE EVIDENCE ONLY.
 *
 *   output    <- ## Key Outputs   (the deliverable being judged)
 *   task      <- ## Task
 *   artifacts <- ## Actions Taken (reasoning stripped) + ## Errors & Retries
 *                + ## Outcome (the RECORDED execution record — status/duration/
 *                  abandon markers; objective telemetry, NOT the agent's words)
 *
 * Why ## Outcome IS passed (as an artifact, not as `output`):
 *   Calibration showed the judge gets snowed by a polished-but-false final
 *   message — it scored runs that timed out after burning $3 as "pass" because
 *   the deliverable *looked* finished. The recorded outcome (timeout / abandon /
 *   error status) is harness telemetry, not self-narration, so the judge SHOULD
 *   see it. It is routed to `artifacts.execution_record` (evidence) — never into
 *   `output`/`task` — so the judge still forms its own quality opinion rather
 *   than parroting a verdict. The `execution_integrity` rubric criterion makes
 *   the judge weigh it.
 *
 * The agent's `(decision)` reasoning is still stripped — self-narration never
 * reaches the judge.
 */
export function projectForJudge(parsed: ParsedTranscript): JudgeProjection {
  const artifacts: Record<string, string> = {};
  if (parsed.actionsTaken) artifacts['actions_taken'] = parsed.actionsTaken;
  if (parsed.errors) artifacts['errors_and_retries'] = parsed.errors;
  // Recorded execution telemetry (status/duration/abandon) as objective evidence.
  const execRecord = [parsed.outcome, parsed.duration].filter((s) => s && s.trim()).join('\n');
  if (execRecord.trim()) artifacts['execution_record'] = execRecord.trim();

  return {
    output: parsed.keyOutputs || '(no output recorded)',
    context: {
      task: parsed.task || '(no task recorded)',
      artifacts,
    },
  };
}

// ─── Token cap (the real cost constraint) ────────────────────────────────────

/** ~4 chars/token heuristic; deliberately conservative. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export interface TokenCapOptions {
  /** Max input tokens to send to the judge per session. Default 8000. */
  maxInputTokens?: number;
}

/**
 * Enforce a per-session input budget. The fleet has at least one ~19.3M-token
 * monster; without this, an offline pass could cost tens of dollars on a single
 * session. We truncate the largest artifact first, keeping head+tail (where the
 * signal usually lives), and record that truncation happened.
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

// ─── Default rubric (general agent-output quality) ───────────────────────────

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
