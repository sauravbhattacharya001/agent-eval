/**
 * Judge Framework — Prompt & Response (Tier 3 Shared-Substrate Judgment)
 *
 * The LLM-facing seam: building the structured judge prompt from a rubric +
 * context (`buildJudgePrompt`), and parsing a raw LLM reply back into a
 * `RawJudgeResponse` (`parseJudgeResponse`), tolerating the usual quirks
 * (markdown code fences, leading/trailing prose) via `extractJson`. Split out
 * of `judge.ts` so prompt/transport concerns are isolated from scoring and
 * rubric authoring.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type {
  JudgeContext,
  JudgeParseError,
  RawCriterionScore,
  RawJudgeResponse,
  Rubric,
} from './judge-types.js';

// ─── PROMPT GENERATION ──────────────────────────────────────────────────────────

/**
 * Generate a structured prompt for an LLM judge.
 *
 * This encodes the rubric, the output being evaluated, and strict instructions
 * for the judge to follow. The prompt enforces:
 * - Structured JSON response format
 * - Concrete evidence citations
 * - Per-criterion scoring within defined levels
 * - Self-reported confidence
 */
export function buildJudgePrompt(
  output: string,
  rubric: Rubric,
  context: JudgeContext,
): string {
  const criteriaSection = rubric.criteria
    .map((c) => {
      const levelsText = c.levels
        .sort((a, b) => a.score - b.score)
        .map((l) => `    ${l.score} (${l.label}): ${l.description}`)
        .join('\n');
      return `  - ${c.id}: ${c.description}\n    Scoring levels:\n${levelsText}`;
    })
    .join('\n\n');

  const artifactsSection = context.artifacts
    ? Object.entries(context.artifacts)
        .map(([key, value]) => `### ${key}\n\`\`\`\n${value}\n\`\`\``)
        .join('\n\n')
    : '';

  const referencesSection = context.references?.length
    ? `## Reference Materials\n${context.references.map((r, i) => `### Reference ${i + 1}\n${r}`).join('\n\n')}`
    : '';

  const cotInstruction = context.chainOfThought
    ? `\nThink step by step. For each criterion:
1. Read the criterion description and scoring levels carefully
2. Find specific evidence in the output that maps to a scoring level
3. Assign the score that best matches the evidence
4. Rate your confidence (0.0–1.0) in this particular score
5. If you are unsure, lean toward a lower confidence rather than guessing\n`
    : '';

  return `You are evaluating an AI agent's output against a structured rubric.

## Rubric: ${rubric.name}
${rubric.description}

## Criteria
${criteriaSection}

## Task Given to the Agent
${context.task}

${referencesSection}
${artifactsSection ? `## Artifacts\n${artifactsSection}` : ''}

## Agent Output Being Evaluated
\`\`\`
${output}
\`\`\`

## Instructions

Evaluate the agent output above against EACH criterion in the rubric.
${cotInstruction}
IMPORTANT RULES:
- Score ONLY based on what is visible in the output and artifacts above.
- Do NOT consider what the agent might have been "thinking" — only judge observable artifacts.
- Each score must correspond to one of the defined scoring levels.
- Cite specific quotes or sections from the output as evidence.
- If the output does not provide enough information to judge a criterion, set confidence below 0.5.

Respond with ONLY a JSON object in this exact format:
{
  "scores": [
    {
      "criterionId": "<criterion id>",
      "score": <number matching a defined level>,
      "reasoning": "<why this score was chosen>",
      "evidence": ["<quote from output>", ...],
      "confidence": <0.0 to 1.0>
    }
  ],
  "summary": "<overall assessment in 1-2 sentences>",
  "suggestions": ["<specific improvement>", ...]
}`;
}

// ─── RESPONSE PARSING ───────────────────────────────────────────────────────────

/**
 * Parse a raw LLM response into a structured RawJudgeResponse.
 *
 * Handles common LLM response quirks:
 * - JSON wrapped in markdown code blocks
 * - Extra text before/after JSON
 * - Minor formatting issues
 */
export function parseJudgeResponse(
  responseText: string,
  rubric: Rubric,
): RawJudgeResponse | JudgeParseError {
  // Extract JSON from potential markdown code blocks
  const jsonStr = extractJson(responseText);
  if (!jsonStr) {
    return {
      message: 'Could not find JSON in judge response',
      rawResponse: responseText.slice(0, 500),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return {
      message: 'Judge response is not valid JSON',
      rawResponse: jsonStr.slice(0, 500),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      message: 'Judge response is not a JSON object',
      rawResponse: jsonStr.slice(0, 500),
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (!Array.isArray(obj.scores)) {
    return {
      message: 'Judge response missing "scores" array',
      rawResponse: jsonStr.slice(0, 500),
    };
  }

  // Parse scores with validation
  const validCriterionIds = new Set(rubric.criteria.map((c) => c.id));
  const scores: RawCriterionScore[] = [];

  for (const rawScore of obj.scores as unknown[]) {
    if (!rawScore || typeof rawScore !== 'object') continue;
    const s = rawScore as Record<string, unknown>;

    const criterionId = String(s.criterionId ?? '');
    if (!validCriterionIds.has(criterionId)) continue;

    const score = typeof s.score === 'number' ? s.score : 0;
    const reasoning = typeof s.reasoning === 'string' ? s.reasoning : '';
    const evidence = Array.isArray(s.evidence)
      ? (s.evidence as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    const confidence = typeof s.confidence === 'number'
      ? Math.max(0, Math.min(1, s.confidence))
      : 0.5;

    scores.push({ criterionId, score, reasoning, evidence, confidence });
  }

  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const suggestions = Array.isArray(obj.suggestions)
    ? (obj.suggestions as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  return { scores, summary, suggestions };
}

/**
 * Extract JSON from a string that may contain markdown code blocks or extra text.
 */
export function extractJson(text: string): string | null {
  // Try direct parse first
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // Find the matching closing brace/bracket
    const balanced = extractBalanced(trimmed);
    if (balanced) return balanced;
  }

  // Try extracting from markdown code blocks
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try finding JSON object anywhere in the text
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    const balanced = extractBalanced(text.slice(jsonStart));
    if (balanced) return balanced;
  }

  return null;
}

/**
 * Extract a balanced JSON structure (object or array) from the start of text.
 */
function extractBalanced(text: string): string | null {
  const open = text[0];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === open) depth++;
    if (char === close) depth--;

    if (depth === 0) {
      return text.slice(0, i + 1);
    }
  }

  return null;
}
