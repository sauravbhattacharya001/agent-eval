/**
 * Drift detection — the pattern-matching pass of the drift judge.
 *
 * Once a task has been decomposed into {@link TaskRequirement}s and the output
 * has been split into {@link OutputSegment}s (both done in
 * `./drift-segmentation.ts`), this module answers the concrete questions that
 * follow:
 *
 * 1. Which requirements does each segment actually address?
 *    → {@link mapRequirementsToSegments} (TF-IDF subject match + action match)
 * 2. What specific drift patterns are present?
 *    → {@link detectDriftIssues} (off-topic, wrong-action, partial-address,
 *      scope-creep, tangential, task-substitution)
 *
 * It is the middle layer of the drift pipeline: it consumes the structural
 * passes' output and produces {@link DriftIssue}s, but it does NOT orchestrate
 * the analysis, compute the overall score, or invoke the Tier 3 judge — that
 * stays in `./drift.ts`. Keeping it here lets `drift.ts` read as drift
 * orchestration + scoring + rubric + assertions only.
 *
 * The drift result/option types ({@link DriftIssue}, {@link DriftKind},
 * {@link DriftAnalysisOptions}) are defined in `./drift.ts` and imported here
 * type-only, so there is no runtime import cycle: `drift.ts` imports the
 * functions below at runtime, and this module only references `drift.ts` in
 * erased type positions. `drift.ts` re-exports {@link mapRequirementsToSegments}
 * and {@link detectDriftIssues} so the public surface is byte-identical.
 *
 * @tier 3 — Shared-Substrate Judgment (heuristic component; no LLM call here)
 * @module
 */

import type { TaskRequirement, OutputSegment } from './drift-segmentation.js';
// Drift result/option types live with the analysis orchestration in ./drift.ts.
// Imported type-only here so there is no runtime cycle (see module note above).
import type { DriftIssue, DriftAnalysisOptions } from './drift-types.js';
// The TF-IDF cosine relevance scorer (internal helper) — see ./drift-relevance.ts.
import { relevanceScore } from './drift-relevance.js';

// ═══ CONSTANTS ══════════════════════════════════════════════════════════════════

/** Patterns that often indicate scope creep or tangential content. */
const SCOPE_CREEP_MARKERS = [
  /additionally,?\s+(?:i|we)\s+(?:also|went ahead|decided to|thought)/i,
  /while\s+(?:i|we)\s+(?:was|were)\s+at\s+it/i,
  /(?:i|we)\s+(?:also|additionally)\s+(?:noticed|found|fixed|updated|refactored)/i,
  /bonus[:\s]/i,
  /(?:as a |)side\s+(?:note|effect)/i,
  /unrelated\s+(?:to|but)/i,
  /(?:i|we)\s+took\s+the\s+(?:opportunity|liberty)\s+to/i,
  /not\s+(?:directly\s+)?related\s+(?:to|but)/i,
];

/** Task substitution indicators — output answering a different question. */
const SUBSTITUTION_MARKERS = [
  /(?:instead|rather),?\s+(?:i|we|let me)\s+(?:will|shall|'ll)\s+/i,
  /a\s+better\s+(?:approach|question|way)\s+(?:would be|is)/i,
  /(?:i|we)\s+think\s+(?:the real|what you actually|the better)\s+/i,
  /let\s+me\s+(?:rephrase|reframe|address)\s+(?:this|that)\s+differently/i,
];

// ═══ REQUIREMENT-SEGMENT MAPPING ════════════════════════════════════════════════

/**
 * Map which requirements each segment addresses.
 * Uses TF-IDF relevance scoring between requirement subjects and segment text.
 */
export function mapRequirementsToSegments(
  requirements: TaskRequirement[],
  segments: OutputSegment[],
  threshold = 0.15,
): OutputSegment[] {
  if (requirements.length === 0 || segments.length === 0) return segments;

  const result: OutputSegment[] = [];

  for (const segment of segments) {
    const addresses: number[] = [];
    let maxScore = 0;

    for (let i = 0; i < requirements.length; i++) {
      const req = requirements[i] as TaskRequirement;
      // Check both subject match AND action match
      const subjectScore = relevanceScore(req.subject, segment.text);
      const actionRelevance = checkActionMatch(req.action, segment.text);
      const combinedScore = subjectScore * 0.7 + actionRelevance * 0.3;

      if (combinedScore >= threshold) {
        addresses.push(i);
      }
      maxScore = Math.max(maxScore, combinedScore);
    }

    result.push({
      ...segment,
      addressesRequirements: addresses,
      relevanceScore: maxScore,
    });
  }

  return result;
}

/**
 * Check if a segment's text matches the action verb (or synonyms) from a requirement.
 * Returns 0–1 score.
 */
function checkActionMatch(action: string, text: string): number {
  const lower = text.toLowerCase();

  // Action synonym groups
  const synonyms: Record<string, string[]> = {
    fix: ['fix', 'fixed', 'repair', 'resolve', 'patch', 'correct', 'bug'],
    review: ['review', 'reviewed', 'feedback', 'comment', 'suggestion', 'critique'],
    explain: ['explain', 'explained', 'description', 'because', 'reason', 'means'],
    add: ['add', 'added', 'create', 'created', 'new', 'implement', 'implemented'],
    remove: ['remove', 'removed', 'delete', 'deleted', 'drop', 'dropped'],
    test: ['test', 'tested', 'assert', 'expect', 'spec', 'verify'],
    update: ['update', 'updated', 'change', 'changed', 'modify', 'modified'],
    refactor: ['refactor', 'refactored', 'restructure', 'reorganize', 'clean'],
    document: ['document', 'documented', 'docs', 'readme', 'guide', 'jsdoc'],
    deploy: ['deploy', 'deployed', 'release', 'publish', 'ship'],
    debug: ['debug', 'debugged', 'investigate', 'trace', 'diagnose'],
    optimize: ['optimize', 'optimized', 'performance', 'faster', 'efficient'],
    migrate: ['migrate', 'migrated', 'migration', 'upgrade', 'transition'],
    configure: ['configure', 'configured', 'config', 'setup', 'settings'],
  };

  const actionSynonyms = synonyms[action] ?? [action];

  // Count how many synonyms appear in the text
  let matches = 0;
  for (const syn of actionSynonyms) {
    if (lower.includes(syn)) matches++;
  }

  return Math.min(1, matches / Math.max(2, actionSynonyms.length * 0.3));
}

// ═══ DRIFT DETECTION ════════════════════════════════════════════════════════════

/**
 * Detect specific drift patterns in the output.
 */
export function detectDriftIssues(
  task: string,
  requirements: TaskRequirement[],
  segments: OutputSegment[],
  output: string,
  options?: DriftAnalysisOptions,
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const coverageThreshold = options?.coverageThreshold ?? 0.6;
  const maxTangentRatio = options?.maxTangentRatio ?? 0.4;

  // 1. Check for completely off-topic output
  const overallScore = relevanceScore(task, output);
  if (overallScore < 0.05) {
    issues.push({
      kind: 'off-topic',
      description: 'Output appears completely unrelated to the task',
      severity: 1.0,
      evidence: [
        `Task: "${task.slice(0, 100)}"`,
        `Relevance score: ${overallScore.toFixed(3)}`,
        `No shared topic terms between task and output`,
      ],
      segmentIndices: segments.map((_, i) => i),
      missedRequirements: requirements.map((_, i) => i),
    });
    return issues; // No point continuing — it's totally off-topic
  }

  // 2. Check for wrong-action drift
  for (let i = 0; i < requirements.length; i++) {
    const req = requirements[i] as TaskRequirement;
    const addressedBy = segments.filter((s) => s.addressesRequirements.includes(i));
    if (addressedBy.length === 0) continue;

    // Check if the subject is discussed but the action is wrong
    for (const seg of addressedBy) {
      const subjectScore = relevanceScore(req.subject, seg.text);
      const actionScore = checkActionMatch(req.action, seg.text);

      if (subjectScore > 0.2 && actionScore < 0.15) {
        issues.push({
          kind: 'wrong-action',
          description: `Output discusses "${req.subject}" but does not ${req.action} it`,
          severity: 0.6,
          evidence: [
            `Required action: "${req.action}"`,
            `Subject relevance: ${subjectScore.toFixed(2)}`,
            `Action match: ${actionScore.toFixed(2)}`,
            `Segment: "${seg.label}"`,
          ],
          segmentIndices: [segments.indexOf(seg)],
          missedRequirements: [i],
        });
      }
    }
  }

  // 3. Check for partial-address (requirements not covered)
  const coveredRequirements = new Set<number>();
  for (const seg of segments) {
    for (const idx of seg.addressesRequirements) {
      coveredRequirements.add(idx);
    }
  }
  const uncovered = requirements
    .map((_, i) => i)
    .filter((i) => !coveredRequirements.has(i));

  if (uncovered.length > 0 && uncovered.length / requirements.length > (1 - coverageThreshold)) {
    issues.push({
      kind: 'partial-address',
      description: `Only ${coveredRequirements.size}/${requirements.length} requirements addressed`,
      severity: Math.min(1, uncovered.length / requirements.length),
      evidence: uncovered.map((i) => `Missed: "${(requirements[i] as TaskRequirement).description.slice(0, 80)}"`),
      segmentIndices: [],
      missedRequirements: uncovered,
    });
  }

  // 4. Check for scope creep
  const scopeCreepSegments: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as OutputSegment;
    for (const marker of SCOPE_CREEP_MARKERS) {
      if (marker.test(seg.text)) {
        scopeCreepSegments.push(i);
        break;
      }
    }
  }
  if (scopeCreepSegments.length > 0) {
    const creepText = scopeCreepSegments.map((i) => {
      const seg = segments[i] as OutputSegment;
      const match = SCOPE_CREEP_MARKERS.find((m) => m.test(seg.text));
      const matchResult = match?.exec(seg.text);
      return matchResult ? matchResult[0] : seg.label;
    });
    issues.push({
      kind: 'scope-creep',
      description: 'Output includes unrequested additional work',
      severity: 0.3,
      evidence: creepText.map((t) => `Indicator: "${t}"`),
      segmentIndices: scopeCreepSegments,
      missedRequirements: [],
    });
  }

  // 5. Check for tangential content (segments addressing no requirements)
  const tangentialSegments = segments
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => s.addressesRequirements.length === 0 && s.text.length > 50);
  const tangentChars = tangentialSegments.reduce((sum, s) => sum + s.text.length, 0);
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0);
  const tangentRatio = totalChars > 0 ? tangentChars / totalChars : 0;

  if (tangentRatio > maxTangentRatio && tangentialSegments.length > 0) {
    issues.push({
      kind: 'tangential',
      description: `${(tangentRatio * 100).toFixed(0)}% of output is tangential to the task`,
      severity: Math.min(1, tangentRatio),
      evidence: tangentialSegments.slice(0, 3).map((s) =>
        `Tangent: "${s.label}" (${s.text.length} chars)`,
      ),
      segmentIndices: tangentialSegments.map((s) => s.index),
      missedRequirements: [],
    });
  }

  // 6. Check for task substitution
  for (const marker of SUBSTITUTION_MARKERS) {
    if (marker.test(output)) {
      const match = marker.exec(output);
      issues.push({
        kind: 'task-substitution',
        description: 'Output appears to substitute the task with a different question/approach',
        severity: 0.7,
        evidence: [`Substitution indicator: "${match?.[0] ?? ''}"`, `Task: "${task.slice(0, 80)}"`],
        segmentIndices: [],
        missedRequirements: requirements.map((_, i) => i),
      });
      break; // One substitution flag is enough
    }
  }

  return issues;
}
