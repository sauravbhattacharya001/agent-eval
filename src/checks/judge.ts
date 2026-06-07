/**
 * Judge Framework — Tier 3 Shared-Substrate Judgment
 *
 * A structured rubric system for model-as-judge evaluation. This is the LAST
 * resort in the eval hierarchy — only used when Tier 1 (deterministic) and
 * Tier 2 (heuristic) checks cannot answer the question.
 *
 * Key design principles:
 * - Every judgment uses a structured rubric — no open-ended "is this good?"
 * - The judge evaluates ARTIFACTS only, never internal reasoning traces
 * - Confidence labeling: uncertain results become "needs-human-review" not pass/fail
 * - The judge task must be EASIER than the original task (grading < creating)
 * - Model-as-judge is a SIGNAL, not a verdict
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** A single criterion in a rubric. */
export interface RubricCriterion {
  /** Short identifier for this criterion (e.g. "clarity", "accuracy"). */
  id: string;
  /** Human-readable description of what this criterion measures. */
  description: string;
  /** Weight of this criterion in the overall score (0–1). Weights are normalized. */
  weight?: number;
  /**
   * Scoring levels with concrete anchors.
   * Each level maps a numeric score to a description of what that score means.
   * Must have at least 2 levels. Scores need not be contiguous.
   */
  levels: ScoringLevel[];
}

/** A scoring level within a criterion. */
export interface ScoringLevel {
  /** Numeric score for this level (e.g. 1, 2, 3, 4, 5). */
  score: number;
  /** What this score means — a concrete anchor, not vague ("excellent"). */
  label: string;
  /** Detailed description with examples of what output at this level looks like. */
  description: string;
}

/** A complete rubric for judging agent output. */
export interface Rubric {
  /** Name of this rubric (e.g. "Code Review Quality"). */
  name: string;
  /** What this rubric evaluates — guides the judge. */
  description: string;
  /** The criteria to evaluate against. Must have at least one. */
  criteria: RubricCriterion[];
  /**
   * Overall pass threshold (0–1). A weighted average at or above this passes.
   * Default: 0.6
   */
  passThreshold?: number;
  /**
   * Minimum confidence required to issue a pass/fail verdict.
   * Below this, result is "needs-human-review". Default: 0.7
   */
  confidenceThreshold?: number;
}

/** Confidence level of a judgment. */
export type JudgeConfidence = 'high' | 'medium' | 'low';

/** Score for a single criterion from the judge. */
export interface CriterionScore {
  /** Criterion ID being scored. */
  criterionId: string;
  /** The numeric score assigned. */
  score: number;
  /** Maximum possible score for this criterion. */
  maxScore: number;
  /** Normalized score (0–1). */
  normalizedScore: number;
  /** Judge's explanation for why this score was given. */
  reasoning: string;
  /** Specific evidence from the output that supports the score. */
  evidence: string[];
  /** Confidence in this particular score. */
  confidence: JudgeConfidence;
}

/** Verdict from the judge: pass, fail, or needs review. */
export type JudgeVerdict = 'pass' | 'fail' | 'needs-human-review';

/** Complete result of a judge evaluation. */
export interface JudgeResult {
  /** Rubric used for evaluation. */
  rubricName: string;
  /** Overall verdict: pass, fail, or needs-human-review. */
  verdict: JudgeVerdict;
  /** Weighted average score (0–1). */
  overallScore: number;
  /** Per-criterion scores. */
  criterionScores: CriterionScore[];
  /** Overall confidence in the judgment. */
  confidence: JudgeConfidence;
  /** Numeric confidence value (0–1). */
  confidenceValue: number;
  /** Summary explanation of the overall judgment. */
  summary: string;
  /** Specific improvement suggestions. */
  suggestions: string[];
  /** Evaluation duration in milliseconds. */
  durationMs: number;
}

/** Options for running a judge evaluation. */
export interface JudgeOptions {
  /** Override the rubric's pass threshold. */
  passThreshold?: number;
  /** Override the rubric's confidence threshold. */
  confidenceThreshold?: number;
  /** Maximum number of retry attempts if parsing fails. Default: 2 */
  maxRetries?: number;
  /** Request that the judge explain its reasoning step by step. Default: true */
  chainOfThought?: boolean;
}

/**
 * Judge backend interface.
 *
 * Implementations provide the actual evaluation logic — either via an LLM call,
 * rule-based scoring, or human-in-the-loop.
 */
export interface JudgeBackend {
  /** Backend identifier. */
  readonly name: string;
  /**
   * Evaluate output against a rubric.
   * Returns raw criterion scores and reasoning — the framework handles
   * verdict determination and confidence labeling.
   */
  evaluate(
    output: string,
    rubric: Rubric,
    context: JudgeContext,
  ): Promise<RawJudgeResponse>;
}

/** Context passed to the judge backend. */
export interface JudgeContext {
  /** The original task/prompt given to the agent. */
  task: string;
  /** Reference materials the agent was given. */
  references?: string[];
  /** Additional artifacts: diffs, logs, side-effects, etc. */
  artifacts?: Record<string, string>;
  /** Whether to request chain-of-thought reasoning. */
  chainOfThought: boolean;
}

/** Raw response from a judge backend, before framework processing. */
export interface RawJudgeResponse {
  /** Per-criterion assessments. */
  scores: RawCriterionScore[];
  /** Overall summary from the judge. */
  summary: string;
  /** Improvement suggestions from the judge. */
  suggestions: string[];
}

/** Raw score for a single criterion from the backend. */
export interface RawCriterionScore {
  /** Criterion ID. */
  criterionId: string;
  /** Assigned score. */
  score: number;
  /** Judge's reasoning. */
  reasoning: string;
  /** Evidence quotes from the output. */
  evidence: string[];
  /** Self-reported confidence (0–1). */
  confidence: number;
}

// ─── RUBRIC VALIDATION ─────────────────────────────────────────────────────────

/** Rubric validation error. */
export interface RubricValidationError {
  /** Path to the invalid field. */
  path: string;
  /** Description of the problem. */
  message: string;
}

/**
 * Validate a rubric definition. Returns errors if invalid.
 */
export function validateRubric(rubric: Rubric): RubricValidationError[] {
  const errors: RubricValidationError[] = [];

  if (!rubric.name || rubric.name.trim().length === 0) {
    errors.push({ path: 'name', message: 'Rubric name is required' });
  }
  if (!rubric.description || rubric.description.trim().length === 0) {
    errors.push({ path: 'description', message: 'Rubric description is required' });
  }
  if (!rubric.criteria || rubric.criteria.length === 0) {
    errors.push({ path: 'criteria', message: 'Rubric must have at least one criterion' });
  }

  if (rubric.passThreshold !== undefined) {
    if (rubric.passThreshold < 0 || rubric.passThreshold > 1) {
      errors.push({
        path: 'passThreshold',
        message: `passThreshold must be 0–1, got ${rubric.passThreshold}`,
      });
    }
  }

  if (rubric.confidenceThreshold !== undefined) {
    if (rubric.confidenceThreshold < 0 || rubric.confidenceThreshold > 1) {
      errors.push({
        path: 'confidenceThreshold',
        message: `confidenceThreshold must be 0–1, got ${rubric.confidenceThreshold}`,
      });
    }
  }

  const criterionIds = new Set<string>();
  for (let i = 0; i < (rubric.criteria?.length ?? 0); i++) {
    const criterion = rubric.criteria[i] as RubricCriterion | undefined;
    if (!criterion) continue;
    const prefix = `criteria[${i}]`;

    if (!criterion.id || criterion.id.trim().length === 0) {
      errors.push({ path: `${prefix}.id`, message: 'Criterion id is required' });
    } else if (criterionIds.has(criterion.id)) {
      errors.push({ path: `${prefix}.id`, message: `Duplicate criterion id: "${criterion.id}"` });
    } else {
      criterionIds.add(criterion.id);
    }

    if (!criterion.description || criterion.description.trim().length === 0) {
      errors.push({ path: `${prefix}.description`, message: 'Criterion description is required' });
    }

    if (criterion.weight !== undefined && (criterion.weight < 0 || criterion.weight > 1)) {
      errors.push({
        path: `${prefix}.weight`,
        message: `Weight must be 0–1, got ${criterion.weight}`,
      });
    }

    if (!criterion.levels || criterion.levels.length < 2) {
      errors.push({
        path: `${prefix}.levels`,
        message: 'Criterion must have at least 2 scoring levels',
      });
    } else {
      const scores = new Set<number>();
      for (let j = 0; j < criterion.levels.length; j++) {
        const level = criterion.levels[j] as ScoringLevel | undefined;
        if (!level) continue;
        const levelPrefix = `${prefix}.levels[${j}]`;

        if (typeof level.score !== 'number' || !isFinite(level.score)) {
          errors.push({ path: `${levelPrefix}.score`, message: 'Level score must be a finite number' });
        } else if (scores.has(level.score)) {
          errors.push({ path: `${levelPrefix}.score`, message: `Duplicate score: ${level.score}` });
        } else {
          scores.add(level.score);
        }

        if (!level.label || level.label.trim().length === 0) {
          errors.push({ path: `${levelPrefix}.label`, message: 'Level label is required' });
        }
        if (!level.description || level.description.trim().length === 0) {
          errors.push({ path: `${levelPrefix}.description`, message: 'Level description is required' });
        }
      }
    }
  }

  return errors;
}

// ─── RUBRIC BUILDER ─────────────────────────────────────────────────────────────

/**
 * Fluent builder for creating rubrics.
 *
 * @example
 * ```ts
 * const rubric = buildRubric('Code Review Quality')
 *   .describe('Evaluates the quality of AI-generated code reviews')
 *   .passAt(0.7)
 *   .criterion('actionability', 'Are suggestions specific and actionable?')
 *     .level(1, 'None', 'No actionable suggestions — only generic praise or criticism')
 *     .level(3, 'Partial', 'Some suggestions are actionable, but most are vague')
 *     .level(5, 'Strong', 'Most suggestions include specific code changes or clear next steps')
 *     .weight(0.4)
 *     .done()
 *   .criterion('accuracy', 'Are identified issues real bugs or false positives?')
 *     .level(1, 'Fabricated', 'Most flagged issues are false positives or hallucinated')
 *     .level(3, 'Mixed', 'Some real issues found, but also false positives')
 *     .level(5, 'Precise', 'All flagged issues are real, with correct explanations')
 *     .weight(0.6)
 *     .done()
 *   .build();
 * ```
 */
export function buildRubric(name: string): RubricBuilder {
  return new RubricBuilder(name);
}

/** Builder state for constructing a rubric. */
export class RubricBuilder {
  private _name: string;
  private _description = '';
  private _criteria: RubricCriterion[] = [];
  private _passThreshold?: number;
  private _confidenceThreshold?: number;

  constructor(name: string) {
    this._name = name;
  }

  /** Set the rubric description. */
  describe(description: string): this {
    this._description = description;
    return this;
  }

  /** Set the pass threshold (0–1). */
  passAt(threshold: number): this {
    this._passThreshold = threshold;
    return this;
  }

  /** Set the confidence threshold (0–1). */
  confidenceAt(threshold: number): this {
    this._confidenceThreshold = threshold;
    return this;
  }

  /** Start building a new criterion. Returns a CriterionBuilder. */
  criterion(id: string, description: string): CriterionBuilder {
    return new CriterionBuilder(this, id, description);
  }

  /** @internal Add a completed criterion. */
  _addCriterion(criterion: RubricCriterion): void {
    this._criteria.push(criterion);
  }

  /** Build and validate the rubric. Throws on validation errors. */
  build(): Rubric {
    const rubric: Rubric = {
      name: this._name,
      description: this._description,
      criteria: this._criteria,
      passThreshold: this._passThreshold,
      confidenceThreshold: this._confidenceThreshold,
    };

    const errors = validateRubric(rubric);
    if (errors.length > 0) {
      const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
      throw new Error(`Invalid rubric "${this._name}":\n${messages}`);
    }

    return rubric;
  }
}

/** Builder for a single rubric criterion. */
export class CriterionBuilder {
  private _parent: RubricBuilder;
  private _id: string;
  private _description: string;
  private _levels: ScoringLevel[] = [];
  private _weight?: number;

  constructor(parent: RubricBuilder, id: string, description: string) {
    this._parent = parent;
    this._id = id;
    this._description = description;
  }

  /** Add a scoring level with concrete anchor. */
  level(score: number, label: string, description: string): this {
    this._levels.push({ score, label, description });
    return this;
  }

  /** Set the weight of this criterion (0–1). */
  weight(w: number): this {
    this._weight = w;
    return this;
  }

  /** Finish this criterion and return to the rubric builder. */
  done(): RubricBuilder {
    this._parent._addCriterion({
      id: this._id,
      description: this._description,
      levels: this._levels,
      weight: this._weight,
    });
    return this._parent;
  }
}

// ─── SCORING ENGINE ─────────────────────────────────────────────────────────────

/**
 * Compute the overall score and verdict from raw judge responses.
 *
 * This is the core scoring logic, separated from the judge backend
 * so it can be tested deterministically.
 */
export function computeVerdict(
  rawResponse: RawJudgeResponse,
  rubric: Rubric,
  options?: JudgeOptions,
): JudgeResult {
  const startTime = performance.now();
  const passThreshold = options?.passThreshold ?? rubric.passThreshold ?? 0.6;
  const confidenceThreshold = options?.confidenceThreshold ?? rubric.confidenceThreshold ?? 0.7;

  // Normalize criterion weights
  const weights = normalizeCriterionWeights(rubric.criteria);

  // Process each criterion score
  const criterionScores: CriterionScore[] = [];
  let weightedScoreSum = 0;
  let weightedConfidenceSum = 0;
  let totalWeight = 0;

  for (const criterion of rubric.criteria) {
    const raw = rawResponse.scores.find((s) => s.criterionId === criterion.id);
    const weight = weights.get(criterion.id) ?? 0;

    if (!raw) {
      // Missing score — treat as low-confidence zero
      criterionScores.push({
        criterionId: criterion.id,
        score: 0,
        maxScore: getMaxScore(criterion),
        normalizedScore: 0,
        reasoning: 'No score provided by judge',
        evidence: [],
        confidence: 'low',
      });
      totalWeight += weight;
      continue;
    }

    const maxScore = getMaxScore(criterion);
    const minScore = getMinScore(criterion);
    const range = maxScore - minScore;
    const clampedScore = Math.max(minScore, Math.min(maxScore, raw.score));
    const normalizedScore = range > 0 ? (clampedScore - minScore) / range : 0;

    const confidence = classifyConfidence(raw.confidence);

    criterionScores.push({
      criterionId: criterion.id,
      score: clampedScore,
      maxScore,
      normalizedScore,
      reasoning: raw.reasoning,
      evidence: raw.evidence,
      confidence,
    });

    weightedScoreSum += normalizedScore * weight;
    weightedConfidenceSum += raw.confidence * weight;
    totalWeight += weight;
  }

  // Compute overall score and confidence
  const overallScore = totalWeight > 0 ? weightedScoreSum / totalWeight : 0;
  const overallConfidenceValue = totalWeight > 0 ? weightedConfidenceSum / totalWeight : 0;
  const overallConfidence = classifyConfidence(overallConfidenceValue);

  // Determine verdict
  let verdict: JudgeVerdict;
  if (overallConfidenceValue < confidenceThreshold) {
    verdict = 'needs-human-review';
  } else if (overallScore >= passThreshold) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }

  return {
    rubricName: rubric.name,
    verdict,
    overallScore,
    criterionScores,
    confidence: overallConfidence,
    confidenceValue: overallConfidenceValue,
    summary: rawResponse.summary,
    suggestions: rawResponse.suggestions,
    durationMs: performance.now() - startTime,
  };
}

/**
 * Normalize criterion weights so they sum to 1.
 * Criteria without explicit weights share the remaining weight equally.
 */
export function normalizeCriterionWeights(criteria: RubricCriterion[]): Map<string, number> {
  const result = new Map<string, number>();
  if (criteria.length === 0) return result;

  let explicitWeightSum = 0;
  let unweightedCount = 0;

  for (const c of criteria) {
    if (c.weight !== undefined) {
      explicitWeightSum += c.weight;
    } else {
      unweightedCount++;
    }
  }

  // If all weights are explicit, normalize them
  if (unweightedCount === 0) {
    const factor = explicitWeightSum > 0 ? 1 / explicitWeightSum : 1 / criteria.length;
    for (const c of criteria) {
      result.set(c.id, (c.weight ?? 0) * factor);
    }
    return result;
  }

  // Distribute remaining weight among unweighted criteria
  const remaining = Math.max(0, 1 - explicitWeightSum);
  const equalShare = remaining / unweightedCount;

  for (const c of criteria) {
    result.set(c.id, c.weight ?? equalShare);
  }

  // Final normalization in case explicit weights exceed 1
  const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
  if (total > 0 && Math.abs(total - 1) > 0.001) {
    const factor = 1 / total;
    for (const [id, w] of result) {
      result.set(id, w * factor);
    }
  }

  return result;
}

/** Get the maximum score from a criterion's levels. */
export function getMaxScore(criterion: RubricCriterion): number {
  if (criterion.levels.length === 0) return 0;
  return Math.max(...criterion.levels.map((l) => l.score));
}

/** Get the minimum score from a criterion's levels. */
export function getMinScore(criterion: RubricCriterion): number {
  if (criterion.levels.length === 0) return 0;
  return Math.min(...criterion.levels.map((l) => l.score));
}

/** Classify a numeric confidence value into a label. */
export function classifyConfidence(value: number): JudgeConfidence {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}

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

/** Parse error from judge response. */
export interface JudgeParseError {
  /** What went wrong. */
  message: string;
  /** The raw response text that failed to parse. */
  rawResponse: string;
}

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

// ─── RULE-BASED JUDGE BACKEND ───────────────────────────────────────────────────

/**
 * A scoring function for rule-based judging.
 * Returns a score, reasoning, and evidence for a single criterion.
 */
export type ScoringFunction = (
  output: string,
  criterion: RubricCriterion,
  context: JudgeContext,
) => RawCriterionScore;

/**
 * Rule-based judge backend — no LLM required.
 *
 * Uses programmatic scoring functions for each criterion.
 * Ideal for deterministic aspects of Tier 3 evaluation that don't need
 * an LLM but still use the rubric framework for structured scoring.
 */
export class RuleBasedJudge implements JudgeBackend {
  readonly name = 'rule-based';
  private scoringFunctions: Map<string, ScoringFunction>;

  constructor(scoringFunctions: Record<string, ScoringFunction>) {
    this.scoringFunctions = new Map(Object.entries(scoringFunctions));
  }

  async evaluate(
    output: string,
    rubric: Rubric,
    context: JudgeContext,
  ): Promise<RawJudgeResponse> {
    const scores: RawCriterionScore[] = [];

    for (const criterion of rubric.criteria) {
      const fn = this.scoringFunctions.get(criterion.id);
      if (fn) {
        scores.push(fn(output, criterion, context));
      } else {
        // No scoring function — mark as low confidence
        scores.push({
          criterionId: criterion.id,
          score: getMinScore(criterion),
          reasoning: `No scoring function registered for criterion "${criterion.id}"`,
          evidence: [],
          confidence: 0,
        });
      }
    }

    return {
      scores,
      summary: 'Rule-based evaluation complete',
      suggestions: [],
    };
  }
}

// ─── JUDGE EVALUATOR ────────────────────────────────────────────────────────────

/**
 * Main judge evaluator — combines a backend with rubric + verdict computation.
 *
 * Usage:
 * ```ts
 * const judge = new JudgeEvaluator(backend, rubric);
 * const result = await judge.evaluate(output, { task: 'Review this PR' });
 * // result.verdict → 'pass' | 'fail' | 'needs-human-review'
 * ```
 */
export class JudgeEvaluator {
  private backend: JudgeBackend;
  private rubric: Rubric;
  private options: JudgeOptions;

  constructor(backend: JudgeBackend, rubric: Rubric, options?: JudgeOptions) {
    const errors = validateRubric(rubric);
    if (errors.length > 0) {
      const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
      throw new Error(`Invalid rubric "${rubric.name}":\n${messages}`);
    }

    this.backend = backend;
    this.rubric = rubric;
    this.options = options ?? {};
  }

  /** Evaluate output and return a structured verdict. */
  async evaluate(
    output: string,
    context: Omit<JudgeContext, 'chainOfThought'>,
  ): Promise<JudgeResult> {
    const fullContext: JudgeContext = {
      ...context,
      chainOfThought: this.options.chainOfThought ?? true,
    };

    const rawResponse = await this.backend.evaluate(output, this.rubric, fullContext);
    return computeVerdict(rawResponse, this.rubric, this.options);
  }

  /** Get the rubric being used. */
  getRubric(): Rubric {
    return this.rubric;
  }

  /** Get the backend name. */
  getBackendName(): string {
    return this.backend.name;
  }
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Create an assertion that evaluates output using a judge with a rubric.
 *
 * This is a Tier 3 assertion — it uses model-as-judge (or rule-based judge)
 * to evaluate subjective quality aspects.
 *
 * @param backend - The judge backend to use
 * @param rubric - The rubric to evaluate against
 * @param options - Judge options (thresholds, etc.)
 */
export function toPassJudge(
  backend: JudgeBackend,
  rubric: Rubric,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric, options);

  return {
    name: `[Tier 3] judge: ${rubric.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const status = result.verdict === 'pass' ? 'pass'
          : result.verdict === 'needs-human-review' ? 'skip'
          : 'fail';

        const criteriaDetails = result.criterionScores
          .map((cs) => `${cs.criterionId}: ${cs.normalizedScore.toFixed(2)} (${cs.confidence})`)
          .join(', ');

        return {
          status,
          name: `[Tier 3] judge: ${rubric.name}`,
          message: status === 'pass'
            ? undefined
            : result.verdict === 'needs-human-review'
              ? `Judge confidence too low (${result.confidenceValue.toFixed(2)}) — needs human review`
              : `Judge verdict: fail (score=${result.overallScore.toFixed(2)}, threshold=${options?.passThreshold ?? rubric.passThreshold ?? 0.6})`,
          expected: `pass (>= ${options?.passThreshold ?? rubric.passThreshold ?? 0.6})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)}, confidence=${result.confidenceValue.toFixed(2)})`,
          evidence: `Criteria: ${criteriaDetails}\nSummary: ${result.summary}`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] judge: ${rubric.name}`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that checks a specific criterion score.
 *
 * @param backend - The judge backend to use
 * @param rubric - The rubric containing the criterion
 * @param criterionId - The criterion to check
 * @param minNormalizedScore - Minimum normalized score (0–1) to pass. Default: 0.6
 */
export function toScoreOnCriterion(
  backend: JudgeBackend,
  rubric: Rubric,
  criterionId: string,
  minNormalizedScore = 0.6,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] criterion: ${criterionId} >= ${minNormalizedScore}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const criterionScore = result.criterionScores.find((cs) => cs.criterionId === criterionId);
        if (!criterionScore) {
          return {
            status: 'error',
            name: `[Tier 3] criterion: ${criterionId}`,
            message: `Criterion "${criterionId}" not found in judge results`,
            durationMs: performance.now() - start,
          };
        }

        if (criterionScore.confidence === 'low') {
          return {
            status: 'skip',
            name: `[Tier 3] criterion: ${criterionId}`,
            message: `Low confidence on criterion "${criterionId}" — needs human review`,
            evidence: criterionScore.reasoning,
            durationMs: performance.now() - start,
          };
        }

        const pass = criterionScore.normalizedScore >= minNormalizedScore;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] criterion: ${criterionId} >= ${minNormalizedScore}`,
          message: pass ? undefined : `Criterion "${criterionId}" scored ${criterionScore.normalizedScore.toFixed(2)}, below threshold ${minNormalizedScore}`,
          expected: `>= ${minNormalizedScore}`,
          actual: `${criterionScore.normalizedScore.toFixed(2)} (${criterionScore.confidence} confidence)`,
          evidence: criterionScore.reasoning,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] criterion: ${criterionId}`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that checks the judge's overall confidence.
 * If confidence is below the threshold, the assertion returns "needs-human-review" (skip).
 *
 * @param backend - The judge backend
 * @param rubric - The rubric to evaluate against
 * @param minConfidence - Minimum confidence value (0–1). Default: 0.7
 */
export function toHaveJudgeConfidence(
  backend: JudgeBackend,
  rubric: Rubric,
  minConfidence = 0.7,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] judge confidence >= ${minConfidence}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const pass = result.confidenceValue >= minConfidence;
        return {
          status: pass ? 'pass' : 'skip',
          name: `[Tier 3] judge confidence >= ${minConfidence}`,
          message: pass ? undefined : `Judge confidence ${result.confidenceValue.toFixed(2)} below threshold ${minConfidence} — needs human review`,
          expected: `confidence >= ${minConfidence}`,
          actual: `${result.confidenceValue.toFixed(2)} (${result.confidence})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] judge confidence >= ${minConfidence}`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that requires all criteria to meet minimum scores.
 *
 * @param backend - The judge backend
 * @param rubric - The rubric to evaluate against
 * @param minScores - Map of criterion ID → minimum normalized score
 */
export function toMeetAllCriteria(
  backend: JudgeBackend,
  rubric: Rubric,
  minScores: Record<string, number>,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] all criteria meet minimums`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const failures: string[] = [];
        const lowConfidence: string[] = [];

        for (const [criterionId, minScore] of Object.entries(minScores)) {
          const cs = result.criterionScores.find((s) => s.criterionId === criterionId);
          if (!cs) {
            failures.push(`"${criterionId}": not found in results`);
            continue;
          }
          if (cs.confidence === 'low') {
            lowConfidence.push(`"${criterionId}": low confidence`);
            continue;
          }
          if (cs.normalizedScore < minScore) {
            failures.push(`"${criterionId}": ${cs.normalizedScore.toFixed(2)} < ${minScore}`);
          }
        }

        if (lowConfidence.length > 0) {
          return {
            status: 'skip',
            name: `[Tier 3] all criteria meet minimums`,
            message: `Low confidence on: ${lowConfidence.join('; ')}`,
            evidence: result.summary,
            durationMs: performance.now() - start,
          };
        }

        const pass = failures.length === 0;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] all criteria meet minimums`,
          message: pass ? undefined : `Criteria below minimums: ${failures.join('; ')}`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] all criteria meet minimums`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that checks for the presence of improvement suggestions.
 * A judge that finds nothing to suggest may indicate shallow evaluation.
 *
 * @param backend - The judge backend
 * @param rubric - The rubric to evaluate against
 * @param minSuggestions - Minimum number of suggestions expected. Default: 1
 */
export function toHaveJudgeSuggestions(
  backend: JudgeBackend,
  rubric: Rubric,
  minSuggestions = 1,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] judge provides >= ${minSuggestions} suggestion(s)`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const count = result.suggestions.length;
        const pass = count >= minSuggestions;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] judge provides >= ${minSuggestions} suggestion(s)`,
          message: pass ? undefined : `Judge provided ${count} suggestion(s), expected >= ${minSuggestions}`,
          expected: `>= ${minSuggestions} suggestions`,
          actual: `${count} suggestions`,
          evidence: result.suggestions.join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] judge provides >= ${minSuggestions} suggestion(s)`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

// ─── BUILT-IN RUBRICS ───────────────────────────────────────────────────────────

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