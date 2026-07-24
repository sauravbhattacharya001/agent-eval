/**
 * transcript-judge-parse.ts — transcript parsing + JudgeContext projection.
 *
 * Split out of `transcript-judge.ts` along the parse/project seam (no behavior
 * change). Handles turning a `transcript-contract@v1` markdown document into its
 * sections (with the agent's self-narration stripped) and projecting the
 * OBJECTIVE-EVIDENCE-ONLY view the Tier-3 judge is allowed to see.
 *
 * @tier 3 — shared-substrate judgment support, fenced off from the gate.
 */

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
