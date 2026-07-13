/**
 * Actionability Judge — Tier 2+3 "Can a human act on this, or is it filler?"
 *
 * This module evaluates whether an agent's output provides concrete,
 * actionable information that a human can use to make a decision or take
 * a step forward. It catches common failure modes:
 *
 * - Vague platitudes ("consider best practices", "ensure quality")
 * - Hedge-heavy non-answers ("it depends", "there are many approaches")
 * - Restating the question without answering it
 * - Generic advice unanchored to the specific task/context
 * - Missing concrete details (no paths, no code, no steps, no examples)
 *
 * Architecture:
 * - Tier 2 (heuristic): Sentence-level signal extraction — imperative verbs,
 *   specificity markers, hedge detection, concreteness scoring
 * - Tier 3 (judge): Structured rubric evaluation for subjective actionability
 *   when heuristics are insufficient
 *
 * Key design decision: Actionability is task-type-dependent. A code review
 * needs specific file/line references; a summary needs key facts; a how-to
 * needs numbered steps. The module classifies the expected response type
 * and applies type-appropriate scoring.
 *
 * This file is the **public barrel** for the actionability check. The whole
 * surface is composed from single-responsibility seams and re-exported here so
 * the public surface stays a single `./actionability.js` import path:
 * - `./actionability-types.js`      — the type vocabulary (elements, fillers, results)
 * - `./actionability-patterns.js`   — regex tables + response-type classifier
 * - `./actionability-extraction.js` — sentence splitting + signal/filler extraction
 * - `./actionability-scoring.js`    — per-sentence + overall scoring engine
 * - `./actionability-rubric.js`     — the built-in Tier-3 `ACTIONABILITY_RUBRIC`
 * - `./actionability-assertions.js` — the Tier-2/Tier-3 assertion factories
 *
 * @tier mixed (2+3)
 * @module
 */

// ─── TYPE RE-EXPORTS ──────────────────────────────────────────────────────────
// The actionability type vocabulary lives in ./actionability-types.js;
// re-export it here so consumers keep a single `./actionability.js` import path.
export type {
  ResponseType,
  ActionableElement,
  ActionableKind,
  FillerPattern,
  FillerKind,
  SentenceAnalysis,
  ActionabilityOptions,
  ActionabilityResult,
} from './actionability-types.js';

// ─── PATTERN / CLASSIFICATION RE-EXPORTS ─────────────────────────────────────────
// The regex tables are module-internal; only the task→type classifier is public.
export { detectResponseType } from './actionability-patterns.js';

// ─── EXTRACTION RE-EXPORTS ───────────────────────────────────────────────────────
// The Tier-2 heuristic pass: sentence segmentation + signal/filler extraction.
export {
  splitIntoSentences,
  extractActionableElements,
  detectFiller,
} from './actionability-extraction.js';

// ─── SCORING RE-EXPORTS ──────────────────────────────────────────────────────────
// Per-sentence scoring + the top-level analyzer that ties the pass together.
export {
  scoreSentence,
  analyzeActionability,
} from './actionability-scoring.js';

// ─── RUBRIC RE-EXPORT ────────────────────────────────────────────────────────────
// The built-in Tier-3 rubric, used when heuristic scoring is ambiguous.
export { ACTIONABILITY_RUBRIC } from './actionability-rubric.js';

// ─── ASSERTION FACTORY RE-EXPORTS ────────────────────────────────────────────────
// The Tier-2/Tier-3 assertion factories that compose the heuristic pass (and,
// for the judge factory, the Tier-3 framework) into runner-usable assertions.
export {
  toBeActionable,
  toHaveMinimalFiller,
  toBeSpecific,
  toPassActionabilityJudge,
  toHaveActionabilityAbove,
} from './actionability-assertions.js';
