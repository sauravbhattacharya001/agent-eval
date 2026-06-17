/**
 * Judge Framework — Rubric Authoring (Tier 3 Shared-Substrate Judgment)
 *
 * Everything for defining and validating a rubric: the structural validator
 * (`validateRubric`), the fluent `buildRubric` builder pair
 * (`RubricBuilder` / `CriterionBuilder`), and the `BUILTIN_RUBRICS` starter
 * library. Split out of `judge.ts` so rubric authoring is independent of the
 * scoring engine and the LLM prompt/transport seams.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type { Rubric, RubricCriterion, RubricValidationError, ScoringLevel } from './judge-types.js';

// ─── RUBRIC VALIDATION ─────────────────────────────────────────────────────────

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
