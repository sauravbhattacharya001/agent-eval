/**
 * Drift Judge — Tier 3 "Did output address the task or go off-topic?"
 *
 * This module detects when an agent's output drifts from its assigned task.
 * Unlike the Tier 2 relevance module (TF-IDF cosine similarity), this judge
 * understands SEMANTIC drift — when output is superficially related to the topic
 * but doesn't actually address what was asked.
 *
 * Examples of drift that Tier 2 might miss:
 * - Task: "Fix the login bug" → Output: long essay about auth best practices (same domain, wrong action)
 * - Task: "Review this PR" → Output: rewrites the code instead of reviewing it
 * - Task: "Explain error X" → Output: explains errors Y and Z (related but wrong)
 * - Task: "Add tests for module A" → Output: refactors module A without adding tests
 *
 * Architecture:
 * 1. Task decomposition — break task into concrete requirements (what + action + scope)
 * 2. Output segmentation — identify distinct sections/topics in the output
 * 3. Requirement coverage — map which requirements are addressed vs. ignored
 * 4. Tangent detection — identify output sections that address NO requirements
 * 5. Confidence scoring — certainty of the drift/no-drift verdict
 *
 * @tier 3 — Shared-Substrate Judgment (uses judge when heuristics are ambiguous)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  JudgeBackend,
  Rubric,
  JudgeResult,
  JudgeOptions,
} from './judge.js';
import {
  buildRubric,
  JudgeEvaluator,
} from './judge.js';
// The TF-IDF cosine relevance scorer drift uses for requirement coverage lives
// in a sibling module so this file stays focused on drift logic. It is an
// internal helper (not re-exported); see ./drift-relevance.ts for the full
// note on why it mirrors the removed relevance scorer's numeric path.
import { relevanceScore } from './drift-relevance.js';

// ═══ TYPES ═══════════════════════════════════════════════════════════════════════

/** A concrete requirement extracted from the task. */
export interface TaskRequirement {
  /** Short description of what the task requires. */
  description: string;
  /** The action being requested (e.g. "fix", "review", "explain", "add"). */
  action: string;
  /** The subject/target of the action (e.g. "login bug", "PR #42"). */
  subject: string;
  /** Extraction confidence (0–1). */
  confidence: number;
}

/** A distinct segment (topic cluster) identified in the output. */
export interface OutputSegment {
  /** Text content of this segment. */
  text: string;
  /** Heading or topic label for this segment. */
  label: string;
  /** Starting character index in the full output. */
  startIndex: number;
  /** Ending character index in the full output. */
  endIndex: number;
  /** Which requirements this segment addresses (by index). Empty = tangent. */
  addressesRequirements: number[];
  /** Relevance score of this segment to the overall task (0–1). */
  relevanceScore: number;
}

/** Classification of a drift issue. */
export type DriftKind =
  | 'off-topic'          // Output is about a completely different subject
  | 'wrong-action'       // Right subject, wrong action (review→rewrite, explain→fix)
  | 'scope-creep'        // Addresses the task but also adds unrequested work
  | 'partial-address'    // Only addresses part of the task, ignores the rest
  | 'tangential'         // Related to the domain but doesn't address the task
  | 'task-substitution'; // Answers a DIFFERENT but related question

/** A specific drift issue found in the output. */
export interface DriftIssue {
  /** What kind of drift was detected. */
  kind: DriftKind;
  /** Human-readable description of the drift. */
  description: string;
  /** Severity of this drift (0–1). 1 = completely off-topic. */
  severity: number;
  /** Evidence from the output supporting this finding. */
  evidence: string[];
  /** Which segment(s) exhibit this drift (by index). */
  segmentIndices: number[];
  /** Which requirements are missed due to this drift. */
  missedRequirements: number[];
}

/** Options for drift analysis. */
export interface DriftAnalysisOptions {
  /** Minimum relevance score for a segment to "address" a requirement. Default: 0.15 */
  relevanceThreshold?: number;
  /** Minimum proportion of requirements addressed to pass. Default: 0.6 */
  coverageThreshold?: number;
  /** Maximum proportion of output that can be tangential. Default: 0.4 */
  maxTangentRatio?: number;
  /** Whether to use judge backend for ambiguous cases. Default: false (rule-based only) */
  useJudge?: boolean;
  /** Judge backend to use for Tier 3 evaluation. */
  judgeBackend?: JudgeBackend;
  /** Judge options (thresholds, retries). */
  judgeOptions?: JudgeOptions;
  /** Custom action verbs to recognize in task decomposition. */
  extraActionVerbs?: string[];
}

/** Full result of drift analysis. */
export interface DriftAnalysisResult {
  /** Whether the output is on-task (no significant drift). */
  onTask: boolean;
  /** Overall drift score (0 = perfectly on-task, 1 = completely off-topic). */
  driftScore: number;
  /** Confidence in the analysis (0–1). */
  confidence: number;
  /** Whether the verdict is "needs-human-review" due to low confidence. */
  needsReview: boolean;
  /** Requirements extracted from the task. */
  requirements: TaskRequirement[];
  /** Segments identified in the output. */
  segments: OutputSegment[];
  /** Proportion of requirements addressed (0–1). */
  requirementCoverage: number;
  /** Proportion of output text that's tangential (0–1). */
  tangentRatio: number;
  /** Specific drift issues found. */
  issues: DriftIssue[];
  /** Summary explanation. */
  summary: string;
  /** Judge result (if Tier 3 was used). */
  judgeResult?: JudgeResult;
  /** Analysis duration in ms. */
  durationMs: number;
}

// ═══ CONSTANTS ══════════════════════════════════════════════════════════════════

/** Common action verbs found in tasks. */
const ACTION_VERBS = new Set([
  // Creation actions
  'add', 'create', 'build', 'implement', 'write', 'generate', 'make', 'develop',
  // Modification actions
  'fix', 'update', 'change', 'modify', 'refactor', 'improve', 'enhance', 'optimize',
  // Analysis actions
  'review', 'analyze', 'check', 'inspect', 'audit', 'evaluate', 'assess', 'investigate',
  // Explanation actions
  'explain', 'describe', 'document', 'summarize', 'clarify', 'outline',
  // Removal actions
  'remove', 'delete', 'deprecate', 'disable', 'drop',
  // Testing actions
  'test', 'verify', 'validate', 'confirm', 'ensure',
  // Other
  'migrate', 'deploy', 'configure', 'setup', 'install', 'debug', 'resolve',
]);

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

// ═══ TASK DECOMPOSITION ═════════════════════════════════════════════════════════

/**
 * Decompose a task string into concrete requirements.
 *
 * Extracts structured (action, subject) pairs from natural-language task descriptions.
 * Handles multiple requirements within one task (e.g. "Fix the bug and add tests").
 */
export function decomposeTask(
  task: string,
  extraVerbs?: string[],
): TaskRequirement[] {
  if (!task || task.trim().length === 0) return [];

  const allVerbs = new Set(ACTION_VERBS);
  if (extraVerbs) {
    for (const v of extraVerbs) allVerbs.add(v.toLowerCase());
  }

  const requirements: TaskRequirement[] = [];
  const normalized = task.replace(/\s+/g, ' ').trim();

  // Split on common conjunctions to find multiple requirements
  // Pass original task (preserving newlines) for list detection
  const clauses = splitTaskClauses(task.trim());

  for (const clause of clauses) {
    const req = extractRequirement(clause, allVerbs);
    if (req) {
      requirements.push(req);
    }
  }

  // If no structured requirements found, treat the whole task as one requirement
  if (requirements.length === 0) {
    requirements.push({
      description: normalized,
      action: 'address',
      subject: normalized.toLowerCase(),
      confidence: 0.5,
    });
  }

  return requirements;
}

/**
 * Split a task into separate clauses that might each be a requirement.
 */
function splitTaskClauses(task: string): string[] {
  // First, check if the task is a structured list (bullet points or numbers)
  const lines = task.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // Detect list format: every line starts with a bullet or number
  const bulletPattern = /^[-*\u2022]\s+/;
  const numberPattern = /^\d+[.):]\s+/;
  const isBulletList = lines.length > 1 && lines.every((l) => bulletPattern.test(l));
  const isNumberList = lines.length > 1 && lines.every((l) => numberPattern.test(l));

  if (isBulletList) {
    return lines.map((l) => l.replace(bulletPattern, '').trim());
  }
  if (isNumberList) {
    return lines.map((l) => l.replace(numberPattern, '').trim());
  }

  // Otherwise, split on conjunctions and sentence boundaries
  const separators = /(?:\s+and\s+|\s+then\s+|\s+also\s+|;\s*|\.\s+(?=[A-Z]))/;
  const parts = task.split(separators).map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [task];
}

/**
 * Extract a structured requirement from a clause.
 */
function extractRequirement(
  clause: string,
  verbs: Set<string>,
): TaskRequirement | null {
  const words = clause.toLowerCase().split(/\s+/);

  // Find the first action verb
  let actionIndex = -1;
  let action = '';
  for (let i = 0; i < words.length && i < 5; i++) {
    const word = (words[i] ?? '').replace(/[^a-z]/g, '');
    if (verbs.has(word)) {
      actionIndex = i;
      action = word;
      break;
    }
  }

  if (actionIndex === -1) {
    // No explicit verb — check for imperative form (first word is a verb-like thing)
    const firstWord = (words[0] ?? '').replace(/[^a-z]/g, '');
    if (verbs.has(firstWord)) {
      action = firstWord;
      actionIndex = 0;
    } else {
      // Still no verb — this is a noun-phrase task (e.g. "ESLint setup guide")
      return {
        description: clause,
        action: 'address',
        subject: clause.toLowerCase(),
        confidence: 0.4,
      };
    }
  }

  // Subject is everything after the verb (simplified extraction)
  const subjectWords = words.slice(actionIndex + 1);
  const subject = subjectWords
    .filter((w) => !['the', 'a', 'an', 'this', 'that', 'these', 'those', 'please', 'can', 'you'].includes(w))
    .join(' ')
    .replace(/[^a-z0-9\s#@./\-_]/g, '')
    .trim();

  if (!subject) {
    return {
      description: clause,
      action,
      subject: clause.toLowerCase(),
      confidence: 0.4,
    };
  }

  return {
    description: clause,
    action,
    subject,
    confidence: 0.8,
  };
}

// ═══ OUTPUT SEGMENTATION ════════════════════════════════════════════════════════

/**
 * Segment output into distinct topic blocks.
 *
 * Uses structural markers (headings, blank lines, topic shifts) to split
 * the output into coherent segments for per-segment analysis.
 */
export function segmentOutput(output: string): OutputSegment[] {
  if (!output || output.trim().length === 0) return [];

  const segments: OutputSegment[] = [];
  const lines = output.split('\n');

  let currentText = '';
  let currentLabel = 'Introduction';
  let currentStart = 0;
  let charIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineStart = charIndex;

    // Check if this is a heading/section marker
    const headingMatch = /^#{1,6}\s+(.+)/.exec(line) ??
      /^([A-Z][A-Za-z\s]{3,}):?\s*$/.exec(line);

    if (headingMatch && currentText.trim().length > 0) {
      // Close current segment
      segments.push(buildSegment(currentText, currentLabel, currentStart));
      currentText = '';
      currentLabel = headingMatch[1]?.trim() ?? 'Section';
      currentStart = lineStart;
    } else if (
      line.trim() === '' &&
      currentText.trim().length > 200 &&
      i > 0 &&
      (lines[i - 1] ?? '').trim() !== ''
    ) {
      // Large paragraph break — potential topic shift
      const nextNonEmpty = lines.slice(i + 1).find((l) => l.trim().length > 0);
      if (nextNonEmpty && isTopicShift(currentText, nextNonEmpty)) {
        segments.push(buildSegment(currentText, currentLabel, currentStart));
        currentText = '';
        currentLabel = deriveLabel(nextNonEmpty);
        currentStart = charIndex + line.length + 1;
      } else {
        currentText += line + '\n';
      }
    } else {
      currentText += line + '\n';
    }

    charIndex += line.length + 1; // +1 for newline
  }

  // Add final segment
  if (currentText.trim().length > 0) {
    segments.push(buildSegment(currentText, currentLabel, currentStart));
  }

  // If no segments were created (short output with no structure), make one
  if (segments.length === 0 && output.trim().length > 0) {
    segments.push({
      text: output.trim(),
      label: 'Output',
      startIndex: 0,
      endIndex: output.length,
      addressesRequirements: [],
      relevanceScore: 0,
    });
  }

  return segments;
}

function buildSegment(text: string, label: string, startIndex: number): OutputSegment {
  return {
    text: text.trim(),
    label,
    startIndex,
    endIndex: startIndex + text.length,
    addressesRequirements: [],
    relevanceScore: 0,
  };
}

function isTopicShift(currentText: string, nextLine: string): boolean {
  const tail = currentText.trim().slice(-100).toLowerCase();
  const head = nextLine.trim().slice(0, 100).toLowerCase();

  const tailWords = new Set(tail.split(/\s+/).filter((w) => w.length > 3));
  const headWords = new Set(head.split(/\s+/).filter((w) => w.length > 3));
  if (tailWords.size === 0 || headWords.size === 0) return false;

  let overlap = 0;
  for (const w of headWords) {
    if (tailWords.has(w)) overlap++;
  }

  return overlap / Math.min(tailWords.size, headWords.size) < 0.2;
}

function deriveLabel(line: string): string {
  const trimmed = line.trim();
  const words = trimmed.split(/\s+/).slice(0, 5);
  const label = words.join(' ');
  return label.length > 50 ? label.slice(0, 50) + '\u2026' : label;
}

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

// ═══ MAIN ANALYSIS ══════════════════════════════════════════════════════════════

/**
 * Perform full drift analysis on agent output against its assigned task.
 *
 * This is the main entry point for the drift detection module. It:
 * 1. Decomposes the task into requirements
 * 2. Segments the output into topic blocks
 * 3. Maps requirements to segments
 * 4. Detects drift patterns
 * 5. Computes an overall drift score
 * 6. Optionally invokes a Tier 3 judge for ambiguous cases
 */
export async function analyzeDrift(
  task: string,
  output: string,
  options?: DriftAnalysisOptions,
): Promise<DriftAnalysisResult> {
  const startTime = performance.now();
  const relevanceThreshold = options?.relevanceThreshold ?? 0.15;
  const coverageThreshold = options?.coverageThreshold ?? 0.6;

  // Handle empty inputs
  if (!task || task.trim().length === 0) {
    return {
      onTask: true,
      driftScore: 0,
      confidence: 0.3,
      needsReview: true,
      requirements: [],
      segments: [],
      requirementCoverage: 0,
      tangentRatio: 0,
      issues: [],
      summary: 'Cannot analyze drift without a task — no task provided',
      durationMs: performance.now() - startTime,
    };
  }

  if (!output || output.trim().length === 0) {
    return {
      onTask: false,
      driftScore: 1,
      confidence: 0.9,
      needsReview: false,
      requirements: decomposeTask(task, options?.extraActionVerbs),
      segments: [],
      requirementCoverage: 0,
      tangentRatio: 1,
      issues: [{
        kind: 'off-topic',
        description: 'Empty output — agent produced nothing',
        severity: 1,
        evidence: ['Output is empty or whitespace-only'],
        segmentIndices: [],
        missedRequirements: [],
      }],
      summary: 'Output is empty — all requirements unaddressed',
      durationMs: performance.now() - startTime,
    };
  }

  // Step 1: Decompose task
  const requirements = decomposeTask(task, options?.extraActionVerbs);

  // Step 2: Segment output
  const rawSegments = segmentOutput(output);

  // Step 3: Map requirements to segments
  const segments = mapRequirementsToSegments(requirements, rawSegments, relevanceThreshold);

  // Step 4: Detect drift issues
  const issues = detectDriftIssues(task, requirements, segments, output, options);

  // Step 5: Compute coverage and tangent metrics
  const coveredRequirements = new Set<number>();
  for (const seg of segments) {
    for (const idx of seg.addressesRequirements) {
      coveredRequirements.add(idx);
    }
  }
  const requirementCoverage = requirements.length > 0
    ? coveredRequirements.size / requirements.length
    : 1;

  const tangentialChars = segments
    .filter((s) => s.addressesRequirements.length === 0)
    .reduce((sum, s) => sum + s.text.length, 0);
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0);
  const tangentRatio = totalChars > 0 ? tangentialChars / totalChars : 0;

  // Step 6: Compute overall drift score
  // Drift score combines: (1 - coverage), tangent ratio, and issue severity
  const issueWeight = issues.length > 0
    ? Math.max(...issues.map((i) => i.severity))
    : 0;
  const driftScore = Math.min(1, Math.max(0,
    (1 - requirementCoverage) * 0.4 +
    tangentRatio * 0.3 +
    issueWeight * 0.3,
  ));

  // Step 7: Determine confidence
  // Higher confidence when evidence is clear (very high or very low drift)
  let confidence: number;
  if (driftScore > 0.8 || driftScore < 0.2) {
    confidence = 0.85; // Clear cases
  } else if (issues.length > 0) {
    confidence = 0.65; // Some evidence but ambiguous
  } else {
    confidence = 0.5; // Very uncertain
  }

  // Boost confidence if requirements decomposition was solid
  const avgReqConfidence = requirements.length > 0
    ? requirements.reduce((sum, r) => sum + r.confidence, 0) / requirements.length
    : 0.5;
  confidence = confidence * 0.7 + avgReqConfidence * 0.3;

  const needsReview = confidence < 0.6;
  const onTask = driftScore < (coverageThreshold > 0.5 ? 1 - coverageThreshold : 0.4);

  // Step 8: Optionally invoke Tier 3 judge for ambiguous cases
  let judgeResult: JudgeResult | undefined;
  if (options?.useJudge && options.judgeBackend && needsReview) {
    const evaluator = new JudgeEvaluator(
      options.judgeBackend,
      DRIFT_RUBRIC,
      options.judgeOptions,
    );
    judgeResult = await evaluator.evaluate(output, {
      task,
      artifacts: {
        requirements: requirements.map((r) => `[${r.action}] ${r.subject}`).join('\n'),
        coverage: `${(requirementCoverage * 100).toFixed(0)}% requirements addressed`,
        issues: issues.map((i) => `${i.kind}: ${i.description}`).join('\n'),
      },
    });
  }

  // Build summary
  const summary = buildSummary(onTask, driftScore, requirements, requirementCoverage, issues, judgeResult);

  return {
    onTask,
    driftScore,
    confidence,
    needsReview,
    requirements,
    segments,
    requirementCoverage,
    tangentRatio,
    issues,
    summary,
    judgeResult,
    durationMs: performance.now() - startTime,
  };
}

/**
 * Build a human-readable summary of the drift analysis.
 */
function buildSummary(
  onTask: boolean,
  driftScore: number,
  requirements: TaskRequirement[],
  coverage: number,
  issues: DriftIssue[],
  judgeResult?: JudgeResult,
): string {
  const parts: string[] = [];

  if (onTask) {
    parts.push(`Output is on-task (drift score: ${driftScore.toFixed(2)}).`);
  } else {
    parts.push(`Output has drifted from the task (drift score: ${driftScore.toFixed(2)}).`);
  }

  parts.push(`Addressed ${(coverage * 100).toFixed(0)}% of ${requirements.length} requirement(s).`);

  if (issues.length > 0) {
    const topIssues = issues
      .sort((a, b) => b.severity - a.severity)
      .slice(0, 3)
      .map((i) => `${i.kind} (severity: ${i.severity.toFixed(1)})`);
    parts.push(`Issues: ${topIssues.join(', ')}.`);
  }

  if (judgeResult) {
    parts.push(`Judge verdict: ${judgeResult.verdict} (score: ${judgeResult.overallScore.toFixed(2)}).`);
  }

  return parts.join(' ');
}

// ═══ BUILT-IN DRIFT RUBRIC ══════════════════════════════════════════════════════

/**
 * Built-in rubric for the drift judge.
 * Used when Tier 3 evaluation is needed for ambiguous drift cases.
 */
export const DRIFT_RUBRIC: Rubric = buildRubric('Task Drift Assessment')
  .describe('Evaluates whether an agent\'s output stays on-task or drifts off-topic')
  .passAt(0.6)
  .confidenceAt(0.65)
  .criterion('task-address', 'Does the output directly address the assigned task?')
    .level(1, 'Off-topic', 'Output is about a completely different topic than the task')
    .level(2, 'Tangential', 'Output is in the same domain but does not address the specific task')
    .level(3, 'Partial', 'Output addresses some aspects of the task but misses key requirements')
    .level(4, 'Mostly on-task', 'Output addresses the main task with minor tangents')
    .level(5, 'Fully on-task', 'Output directly and completely addresses all task requirements')
    .weight(0.4)
    .done()
  .criterion('action-alignment', 'Does the output perform the requested ACTION (not just discuss the topic)?')
    .level(1, 'Wrong action', 'Output performs a completely different action (e.g. rewrites instead of reviews)')
    .level(2, 'Misaligned', 'Output partially performs the action but mostly does something else')
    .level(3, 'Mixed', 'Some of the requested action is performed alongside other actions')
    .level(4, 'Mostly aligned', 'The requested action is performed with minor deviations')
    .level(5, 'Perfectly aligned', 'Output performs exactly the requested action on the requested subject')
    .weight(0.35)
    .done()
  .criterion('focus', 'How focused is the output on the task vs. tangential content?')
    .level(1, 'Unfocused', 'Mostly tangential content with the task buried or absent')
    .level(2, 'Scattered', 'Significant tangential content distracting from the task')
    .level(3, 'Adequate', 'Some tangents but the task is the primary focus')
    .level(4, 'Focused', 'Minimal tangents, almost entirely about the task')
    .level(5, 'Laser-focused', 'Every part of the output is directly relevant to the task')
    .weight(0.25)
    .done()
  .build();

// ═══ ASSERTION FACTORIES ════════════════════════════════════════════════════════

/**
 * Create an assertion that checks for task drift using the full analysis pipeline.
 *
 * This is the primary drift assertion — it decomposes the task, segments the output,
 * maps requirements, and detects drift patterns.
 *
 * @param options - Drift analysis options (thresholds, judge config)
 * @tier 3 — Uses heuristics (Tier 1+2) and optionally model-as-judge (Tier 3)
 */
export function toNotDrift(options?: DriftAnalysisOptions): Assertion {
  const threshold = 1 - (options?.coverageThreshold ?? 0.6);

  return {
    name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] no task drift`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output, options);

      if (result.needsReview) {
        return {
          status: 'skip',
          name: `[Tier 3] no task drift`,
          message: `Low confidence (${result.confidence.toFixed(2)}) — needs human review`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      if (result.onTask) {
        return {
          status: 'pass',
          name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
        message: result.summary,
        expected: `drift score < ${threshold.toFixed(2)}`,
        actual: `drift score = ${result.driftScore.toFixed(2)}`,
        evidence: result.issues.map((i) => `${i.kind}: ${i.description}`).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that checks requirement coverage — what proportion
 * of the task's requirements are addressed in the output.
 *
 * @param minCoverage - Minimum proportion of requirements to address (0–1). Default: 0.6
 * @tier 3 — Multi-tier analysis (decomposition + relevance scoring)
 */
export function toAddressRequirements(minCoverage = 0.6): Assertion {
  return {
    name: `[Tier 3] addresses >= ${(minCoverage * 100).toFixed(0)}% of requirements`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] addresses requirements`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);
      const pass = result.requirementCoverage >= minCoverage;

      return {
        status: pass ? 'pass' : 'fail',
        name: `[Tier 3] addresses >= ${(minCoverage * 100).toFixed(0)}% of requirements`,
        message: pass ? undefined :
          `Only ${(result.requirementCoverage * 100).toFixed(0)}% of requirements addressed (need ${(minCoverage * 100).toFixed(0)}%)`,
        expected: `>= ${(minCoverage * 100).toFixed(0)}% coverage`,
        actual: `${(result.requirementCoverage * 100).toFixed(0)}% (${result.requirements.filter((_, i) =>
          result.segments.some((s) => s.addressesRequirements.includes(i)),
        ).length}/${result.requirements.length})`,
        evidence: result.requirements.map((r, i) => {
          const covered = result.segments.some((s) => s.addressesRequirements.includes(i));
          return `${covered ? '\u2713' : '\u2717'} [${r.action}] ${r.subject}`;
        }).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that checks the drift score is below a maximum.
 *
 * @param maxDrift - Maximum acceptable drift score (0–1). Default: 0.4
 * @tier 3 — Multi-tier analysis
 */
export function toHaveDriftBelow(maxDrift = 0.4): Assertion {
  return {
    name: `[Tier 3] drift score < ${maxDrift}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] drift score < ${maxDrift}`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);

      if (result.needsReview) {
        return {
          status: 'skip',
          name: `[Tier 3] drift score < ${maxDrift}`,
          message: `Low confidence (${result.confidence.toFixed(2)}) — needs human review`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      const pass = result.driftScore < maxDrift;
      return {
        status: pass ? 'pass' : 'fail',
        name: `[Tier 3] drift score < ${maxDrift}`,
        message: pass ? undefined : `Drift score ${result.driftScore.toFixed(2)} exceeds maximum ${maxDrift}`,
        expected: `< ${maxDrift}`,
        actual: `${result.driftScore.toFixed(2)}`,
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that detects specific drift patterns.
 * Fails if any issue of the specified kind(s) is found above the severity threshold.
 *
 * @param kinds - Drift kinds to check for (or all if omitted)
 * @param maxSeverity - Maximum severity before failing. Default: 0.5
 * @tier 3 — Pattern-based detection
 */
export function toNotExhibitDrift(
  kinds?: DriftKind[],
  maxSeverity = 0.5,
): Assertion {
  const kindsLabel = kinds ? kinds.join(', ') : 'any';

  return {
    name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] no ${kindsLabel} drift`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);

      // Filter issues to the requested kinds
      const relevant = kinds
        ? result.issues.filter((i) => kinds.includes(i.kind))
        : result.issues;
      const severe = relevant.filter((i) => i.severity >= maxSeverity);

      if (severe.length === 0) {
        return {
          status: 'pass',
          name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
          evidence: relevant.length === 0
            ? 'No drift issues detected'
            : `Minor issues below threshold: ${relevant.map((i) => i.kind).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
        message: `${severe.length} drift issue(s) above severity ${maxSeverity}`,
        evidence: severe.map((i) =>
          `${i.kind} (severity: ${i.severity.toFixed(2)}): ${i.description}`,
        ).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that uses the full Tier 3 judge for drift assessment.
 * This assertion always invokes the judge backend for maximum accuracy,
 * at the cost of requiring an LLM call.
 *
 * @param backend - Judge backend to use for evaluation
 * @param options - Judge options (thresholds, retries)
 * @tier 3 — Always invokes model-as-judge
 */
export function toPassDriftJudge(
  backend: JudgeBackend,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, DRIFT_RUBRIC, options);

  return {
    name: `[Tier 3] drift judge: ${DRIFT_RUBRIC.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] drift judge`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      try {
        // First run heuristic analysis for context
        const driftResult = await analyzeDrift(task, output);

        const result = await evaluator.evaluate(output, {
          task,
          artifacts: {
            'heuristic-analysis': `Drift score: ${driftResult.driftScore.toFixed(2)}, ` +
              `Coverage: ${(driftResult.requirementCoverage * 100).toFixed(0)}%, ` +
              `Issues: ${driftResult.issues.map((i) => i.kind).join(', ') || 'none'}`,
            'requirements': driftResult.requirements.map((r) => `[${r.action}] ${r.subject}`).join('\n'),
          },
        });

        const status = result.verdict === 'pass' ? 'pass'
          : result.verdict === 'needs-human-review' ? 'skip'
          : 'fail';

        return {
          status,
          name: `[Tier 3] drift judge: ${DRIFT_RUBRIC.name}`,
          message: status === 'pass' ? undefined :
            status === 'skip'
              ? `Judge confidence too low (${result.confidenceValue.toFixed(2)}) — needs human review`
              : `Judge verdict: fail (score=${result.overallScore.toFixed(2)})`,
          expected: `pass (>= ${options?.passThreshold ?? DRIFT_RUBRIC.passThreshold ?? 0.6})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] drift judge`,
          message: `Drift judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
