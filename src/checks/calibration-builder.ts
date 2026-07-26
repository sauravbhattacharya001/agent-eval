/**
 * Judge Calibration System - Set Builder
 *
 * Fluent builder for assembling a calibration set of pre-scored examples with
 * known ground truth. The resulting {@link CalibrationSet} feeds the engine in
 * `./calibration-engine.js`. Re-exported through the public barrel
 * (`./calibration.js`) via `./calibration-analysis.js`.
 *
 * @tier 3 - Meta-evaluation (evaluates the evaluator)
 * @module
 */

import type { CalibrationExample, CalibrationSet } from './calibration-types.js';

// ─── CALIBRATION SET BUILDER ────────────────────────────────────────────────────

/**
 * Fluent builder for creating calibration sets.
 *
 * @example
 * ```ts
 * const calSet = buildCalibrationSet('Code Review Calibration', 'Code Review Quality')
 *   .example('Good review with specific fixes')
 *     .output('The auth module has a SQL injection vulnerability on line 42...')
 *     .task('Review this PR for security issues')
 *     .scores({ actionability: 4, accuracy: 5, completeness: 3 })
 *     .verdict('pass')
 *     .notes('Identifies real bug, gives specific fix')
 *     .done()
 *   .example('Vague review with no specifics')
 *     .output('Looks good overall. Maybe consider some edge cases.')
 *     .task('Review this PR for security issues')
 *     .scores({ actionability: 1, accuracy: 2, completeness: 1 })
 *     .verdict('fail')
 *     .notes('No specific issues identified, no actionable feedback')
 *     .done()
 *   .build();
 * ```
 */
export function buildCalibrationSet(name: string, rubricName: string): CalibrationSetBuilder {
  return new CalibrationSetBuilder(name, rubricName);
}

export class CalibrationSetBuilder {
  private _name: string;
  private _rubricName: string;
  private _examples: CalibrationExample[] = [];
  private _version = 1;

  constructor(name: string, rubricName: string) {
    this._name = name;
    this._rubricName = rubricName;
  }

  /** Start building a new calibration example. */
  example(name: string): CalibrationExampleBuilder {
    return new CalibrationExampleBuilder(this, name);
  }

  /** Set the version number. */
  version(v: number): this {
    this._version = v;
    return this;
  }

  /** @internal */
  _addExample(ex: CalibrationExample): void {
    this._examples.push(ex);
  }

  /** Build the calibration set. */
  build(): CalibrationSet {
    if (this._examples.length === 0) {
      throw new Error('Calibration set must have at least one example');
    }
    return {
      name: this._name,
      rubricName: this._rubricName,
      examples: this._examples,
      lastValidated: new Date().toISOString(),
      version: this._version,
    };
  }
}

export class CalibrationExampleBuilder {
  private _parent: CalibrationSetBuilder;
  private _name: string;
  private _output = '';
  private _task = '';
  private _references?: string[];
  private _expectedScores: Record<string, number> = {};
  private _expectedVerdict?: 'pass' | 'fail';
  private _notes?: string;

  constructor(parent: CalibrationSetBuilder, name: string) {
    this._parent = parent;
    this._name = name;
  }

  output(text: string): this { this._output = text; return this; }
  task(text: string): this { this._task = text; return this; }
  references(refs: string[]): this { this._references = refs; return this; }
  scores(scores: Record<string, number>): this { this._expectedScores = scores; return this; }
  verdict(v: 'pass' | 'fail'): this { this._expectedVerdict = v; return this; }
  notes(text: string): this { this._notes = text; return this; }

  /** Finish this example and return to the set builder. */
  done(): CalibrationSetBuilder {
    this._parent._addExample({
      name: this._name,
      output: this._output,
      task: this._task,
      references: this._references,
      expectedScores: this._expectedScores,
      expectedVerdict: this._expectedVerdict,
      notes: this._notes,
    });
    return this._parent;
  }
}
