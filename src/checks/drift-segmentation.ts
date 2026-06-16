/**
 * Drift task-decomposition & output-segmentation primitives — Tier 3 support.
 *
 * The drift judge (see ./drift.ts) works in two structural passes before any
 * scoring happens:
 *
 *   1. **Task decomposition** — break the assigned task into concrete
 *      `TaskRequirement`s (action + subject + confidence). This is what lets the
 *      judge tell "fix the login bug" (action=fix) from "explain the login bug"
 *      (action=explain) — superficially the same subject, a different ask.
 *   2. **Output segmentation** — split the agent's output into coherent
 *      `OutputSegment`s (heading blocks / topic-shifted paragraphs) so coverage
 *      and tangents can be reasoned about per-section instead of as one blob.
 *
 * Both passes are pure, deterministic string analysis with no dependency on the
 * drift detection/scoring logic, so they live here to keep ./drift.ts focused on
 * the drift reasoning itself. The two structural types these passes produce
 * (`TaskRequirement`, `OutputSegment`) are co-located with them and re-exported
 * from ./drift.ts so the public surface is unchanged.
 *
 * @tier 3 — structural support for the drift judge (no judge call here)
 * @module
 */

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
