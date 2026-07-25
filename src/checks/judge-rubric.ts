/**
 * Judge Framework — Rubric Authoring (Tier 3 Shared-Substrate Judgment)
 *
 * Everything for defining and validating a rubric: the structural validator
 * (`validateRubric`) and the fluent `buildRubric` builder pair
 * (`RubricBuilder` / `CriterionBuilder`). The `BUILTIN_RUBRICS` starter library
 * lives in `judge-rubric-builtins.ts` and is re-exported here for a stable
 * import surface. Split out of `judge.ts` so rubric authoring is independent of
 * the scoring engine and the LLM prompt/transport seams.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type { Rubric, RubricCriterion, RubricValidationError, ScoringLevel } from './judge-types.js';

// Re-export the built-in rubric library for a stable import surface.
export { BUILTIN_RUBRICS } from './judge-rubric-builtins.js';

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
