/**
 * Tier 1 staleness / no-op detection for one CI run.
 *
 * This is the seam that answers the failure {@link checkCompleteness} cannot
 * see: a run that responded - on-topic, at length, well-formed - but emitted
 * **nothing a human can act on**. It is the open-issue cluster directly (a
 * review that sits stale with no actionable output, a check abandoned mid-task,
 * or a prior comment reposted verbatim). Every signal is artifact
 * pattern-counting or timestamp math; none asks "is this *good*?" - only "are
 * concrete artifacts *present*?", which keeps it Tier 1 (deterministic,
 * forgery-resistant) rather than model-as-judge.
 *
 * Split out of `ci-run.ts` along its internal seam; `ci-run.ts` re-exports the
 * public entry points ({@link analyzeActionability}, {@link analyzeCiStaleness})
 * so the package surface is unchanged.
 *
 * @tier 1 - Deterministic (no AI, reproducible, offline)
 * @module
 */

import { detectParroting } from '../checks/diff.js';
import {
  analyzeStaleness,
  detectAbandonment,
  formatDuration,
  type RunTimeline,
  type StalenessResult,
} from '../checks/staleness.js';

import {
  DEFAULT_REPOST_THRESHOLD,
  DEFAULT_TRIVIAL_OUTPUT_CHARS,
  round4,
  type ActionableArtifacts,
  type CiCheckResult,
  type CiCheckStatus,
  type EvaluateCiRunOptions,
  type StalenessAnalysis,
} from './ci-run-types.js';

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/**
 * Phrases that, when they dominate a short output, mark it as a pure
 * acknowledgement with no substantive review attached ("LGTM", "looks good to
 * me", "no changes needed"). Matched case-insensitively against the whole
 * (trimmed, collapsed) output; only decisive when the output is also short and
 * carries no concrete artifacts, so a long review that merely *contains* "looks
 * good" is not penalized.
 */
const ACKNOWLEDGEMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^(?:lgtm|looks good(?: to me)?|ship it|approved?|\+1|👍)\b/i, label: 'bare approval' },
  { pattern: /\bno (?:changes?|issues?|concerns?|comments?|problems?) (?:needed|found|here)\b/i, label: 'no-findings ack' },
  { pattern: /\b(?:all|everything) (?:looks? )?good\b/i, label: 'everything-good ack' },
  { pattern: /\bnothing (?:to add|to change|stands out)\b/i, label: 'nothing-to-add ack' },
];

/**
 * Patterns that count as **concrete actionable artifacts** - evidence a human
 * can act on. Presence-counted, never quality-judged. Each distinct *kind* that
 * fires contributes at most once to the artifact count (so one long code block
 * doesn't outweigh a file ref + a line number + a directive). This is the
 * opposite signal to {@link ACKNOWLEDGEMENT_PATTERNS}: an output rich in these is
 * not stale even if terse; an output with none is a no-op even if verbose.
 */
const ACTIONABLE_ARTIFACT_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; label: string }> = [
  // A path-like token with a slash or a known source extension, optionally
  // backtick-quoted: src/auth/login.ts, `config.yml`, lib/index.js.
  {
    id: 'file-ref',
    pattern:
      /(?:^|[\s`(])[\w./-]*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp|cs|php|sql|sh|ya?ml|json|toml|md|css|scss|html)\b|(?:^|[\s`])[\w-]+\/[\w./-]+/m,
    label: 'file reference',
  },
  // Explicit line references: "line 42", "L42", "lines 10-20", ":42:".
  {
    id: 'line-ref',
    pattern: /\b(?:lines?|L)\s*\d+(?:\s*[--]\s*\d+)?\b|:\d+(?::\d+)?\b/i,
    label: 'line number',
  },
  // A fenced code block (a concrete suggested snippet/patch).
  { id: 'code-block', pattern: /```[\s\S]*?```/, label: 'code suggestion (fenced block)' },
  // An inline code span naming a concrete symbol/API/command: `INCR`,
  // `SET ... EX`, `useEffect`. Requires at least one code-ish character (a
  // non-space) so empty backticks don't count. A real review points at named
  // identifiers; pure prose rarely uses backticks at all.
  { id: 'inline-code', pattern: /`[^`\n]+`/, label: 'inline code reference' },
  // A diff/patch suggestion: a fenced/leading patch line (+/-) or unified-diff
  // syntax. NOT the bare word "diff" (which appears in prose like "review your
  // diff"); it must be actual patch syntax.
  { id: 'diff', pattern: /^[+-]{1,3}\s+\S|@@\s*-?\d+(?:,\d+)?\s*\+?\d*|\bgit diff\b|\bdiff --git\b/m, label: 'diff/patch' },
  // Actionable directive: a recommendation/imperative cue. Two ways to fire:
  //   (a) a strong recommendation word that is essentially never a noun in
  //       review prose (should, must, consider, recommend, suggest, please,
  //       need(s) to, ought to, instead of, refactor, rename, extract, replace,
  //       wrap in/with) - these signal "do X";
  //   (b) an imperative-form action verb at the START of a sentence or list item
  //       ("Use INCR", "Add a guard", "Remove the cast") - anchored so polysemous
  //       nouns mid-sentence ("the rate-limiting change", "the result set") do
  //       NOT match.
  {
    id: 'directive',
    pattern:
      /\b(?:should|must|consider|recommends?|recommended|suggests?|please|needs? to|ought to|instead of|refactor|rename|extract|replace|wrap (?:it |this |the )?(?:in|with))\b|(?:^|\n)\s*(?:[-*]|\d+[.)]\s)?\s*(?:use|add|remove|delete|move|fix|avoid|guard|handle|validate|rename|extract|replace|return|throw|set)\b|\b(?:use|call|add|pass|return|throw|wrap|replace|rename|set|import|export|await|guard|prefer)\s+(?:an?|the|a\s)?\s*`[^`\n]+`/im,
    label: 'actionable directive',
  },
  // Structured review findings: "Issue:", "Bug:", "Suggestion:", "nit:", numbered
  // or bulleted finding lists.
  {
    id: 'finding',
    pattern: /^\s*(?:[-*]|\d+[.)])\s+\S|(?:^|\n)\s*(?:issue|bug|suggestion|nit|warning|risk|concern|problem|note|todo)\s*[:\-]/im,
    label: 'structured finding',
  },
];

/** Total number of distinct artifact kinds the scanner can detect. */
export const ACTIONABLE_ARTIFACT_KIND_COUNT = ACTIONABLE_ARTIFACT_PATTERNS.length;

// ─── ANALYSIS ──────────────────────────────────────────────────────────────────────

/**
 * Scan an output for concrete actionable artifacts. Each artifact *kind* counts
 * at most once, so a single huge code block cannot masquerade as a thorough
 * review and one file ref + one directive + one finding beats one repeated
 * pattern. This is presence counting over artifacts, NOT a quality judgement:
 * the question is "is there anything here a human could act on?", never "is it
 * good?" - which keeps it Tier 1 (deterministic, forgery-resistant) rather than
 * model-as-judge.
 */
export function analyzeActionability(output: string): ActionableArtifacts {
  const text = output ?? '';
  const kinds: string[] = [];
  const labels: string[] = [];
  for (const { id, pattern, label } of ACTIONABLE_ARTIFACT_PATTERNS) {
    if (pattern.test(text)) {
      kinds.push(id);
      labels.push(label);
    }
  }
  return { kinds, labels, count: kinds.length };
}

/**
 * Detect a bare-acknowledgement output: a short response that is (essentially)
 * only an approval / no-findings note, with no concrete artifacts. The length
 * guard keeps a long, substantive review that merely contains the words "looks
 * good" from being mislabeled - the acknowledgement must *be* the output, not
 * appear in it.
 */
function detectAcknowledgementOnly(
  output: string,
  artifacts: ActionableArtifacts,
  trivialOutputChars: number,
): { isAck: boolean; label?: string } {
  const collapsed = output.replace(/\s+/g, ' ').trim();
  // Only short, artifact-free outputs are candidates for a pure ack.
  if (collapsed.length === 0 || collapsed.length > trivialOutputChars * 2 || artifacts.count > 0) {
    return { isAck: false };
  }
  for (const { pattern, label } of ACKNOWLEDGEMENT_PATTERNS) {
    if (pattern.test(collapsed)) return { isAck: true, label };
  }
  return { isAck: false };
}

/**
 * Run the full Tier 1 staleness / no-op analysis for one CI run: the artifact
 * scan, the acknowledgement-only check, output-text abandonment, and - when the
 * caller supplied them - verbatim-repost detection against a prior output and
 * timeline-based timeout/abandonment.
 */
export function analyzeCiStaleness(options: EvaluateCiRunOptions): StalenessAnalysis {
  const output = options.output ?? '';
  const trivialOutputChars = options.trivialOutputChars ?? DEFAULT_TRIVIAL_OUTPUT_CHARS;
  const repostThreshold = options.repostThreshold ?? DEFAULT_REPOST_THRESHOLD;

  const artifacts = analyzeActionability(output);
  const ack = detectAcknowledgementOnly(output, artifacts, trivialOutputChars);

  // Truncation / dangling-intent signals in the output text itself. We surface
  // only the *error*-severity ones (unbalanced code = real truncation) and the
  // "stated intent without follow-through" signal, which is the no-op tell.
  const abandonment = detectAbandonment(output, options.abandonmentOptions);

  // Verbatim repost of the prior comment (the #1302 "posts the same thing"
  // no-op). Only meaningful when a previous output was supplied.
  let isRepost = false;
  let repostSimilarity = Number.NaN;
  if (typeof options.previousOutput === 'string' && options.previousOutput.trim().length > 0) {
    const { isParroting, similarity } = detectParroting(output, options.previousOutput, {
      threshold: repostThreshold,
      ignoreWhitespace: true,
    });
    isRepost = isParroting;
    repostSimilarity = similarity;
  }

  // Timeline staleness (timeout / gaps / no end). Only when a timeline is given.
  let timeline: StalenessResult | undefined;
  if (options.timeline) {
    const fullTimeline: RunTimeline = {
      ...options.timeline,
      output: options.timeline.output ?? output,
    };
    timeline = analyzeStaleness(fullTimeline, {
      ...(options.abandonmentOptions ? { abandonment: options.abandonmentOptions } : {}),
    });
  }

  return {
    artifacts,
    isAcknowledgementOnly: ack.isAck,
    ...(ack.label ? { acknowledgement: ack.label } : {}),
    abandonment,
    isRepost,
    repostSimilarity,
    ...(timeline ? { timeline } : {}),
  };
}

// ─── SCORING ───────────────────────────────────────────────────────────────────────

/**
 * Score the Tier 1 staleness check into a single-run result. This is the no-op
 * detector: a run can pass completeness (non-empty, even substantive) and still
 * be a **stale no-op** - it emitted nothing actionable, reposted the prior
 * comment, abandoned mid-task, or timed out. Those are exactly the open-issue
 * failures a crash
 * check cannot see.
 *
 * Verdict precedence (worst wins):
 *   - **fail** if the timeline analysis found a hard error (timeout / no output),
 *     OR the output is a verbatim repost of the prior comment, OR the output is
 *     a bare acknowledgement, OR a non-trivial output (> `trivialOutputChars`)
 *     contains **zero** concrete actionable artifacts, OR the output text shows
 *     an error-severity abandonment signal (truncated mid-code).
 *   - **warn** if a trivially short output has zero artifacts, OR the artifact
 *     count is below `minActionableArtifacts` (thin but not empty), OR the
 *     timeline flagged a non-fatal staleness gap, OR there is a dangling-intent
 *     abandonment signal.
 *   - **pass** otherwise (enough actionable substance, no no-op signals).
 *
 * The score is a graded function of artifact richness minus penalties, so it is
 * meaningful in a trend rather than a bare boolean.
 */
export function scoreStaleness(
  analysis: StalenessAnalysis,
  output: string,
  minActionableArtifacts: number,
  trivialOutputChars: number,
): CiCheckResult {
  const { artifacts } = analysis;
  const isTrivialLength = output.trim().length <= trivialOutputChars;
  const errorAbandon = analysis.abandonment.filter((i) => i.severity === 'error');
  const intentAbandon = analysis.abandonment.filter(
    (i) => i.kind === 'no_progress' || /intent|incomplete|ellipsis|empty/i.test(i.message),
  );
  const timelineErrors = analysis.timeline?.issues.filter((i) => i.severity === 'error') ?? [];
  const timelineWarnings = analysis.timeline?.issues.filter((i) => i.severity === 'warning') ?? [];

  // Hard no-op conditions.
  const failReasons: string[] = [];
  if (timelineErrors.length > 0) {
    failReasons.push(`run ${timelineErrors.map((i) => i.kind).join('/')} (${formatDuration(analysis.timeline?.durationMs ?? Number.NaN)})`);
  }
  if (analysis.isRepost) {
    failReasons.push(`reposts prior comment verbatim (${(analysis.repostSimilarity * 100).toFixed(0)}% identical)`);
  }
  if (analysis.isAcknowledgementOnly) {
    failReasons.push(`bare acknowledgement only (${analysis.acknowledgement})`);
  }
  if (!isTrivialLength && artifacts.count === 0) {
    failReasons.push('no actionable content (no file refs, line numbers, code, directives, or findings)');
  }
  if (errorAbandon.length > 0) {
    failReasons.push(errorAbandon.map((i) => i.message).join('; '));
  }

  // Soft (warn) conditions.
  const warnReasons: string[] = [];
  if (isTrivialLength && artifacts.count === 0) {
    warnReasons.push('very short with no actionable content');
  }
  if (artifacts.count > 0 && artifacts.count < minActionableArtifacts) {
    warnReasons.push(`thin: only ${artifacts.count} actionable artifact kind(s) (expected ≥ ${minActionableArtifacts})`);
  }
  if (timelineWarnings.length > 0) {
    warnReasons.push(`timeline: ${timelineWarnings.map((i) => i.kind).join(', ')}`);
  }
  if (intentAbandon.length > 0) {
    warnReasons.push(intentAbandon.map((i) => i.message).join('; '));
  }

  let status: CiCheckStatus;
  if (failReasons.length > 0) {
    status = 'fail';
  } else if (warnReasons.length > 0) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  // Graded score: start from coverage of artifact kinds, then subtract penalties.
  const totalKinds = ACTIONABLE_ARTIFACT_PATTERNS.length;
  const richness = totalKinds > 0 ? artifacts.count / totalKinds : 0;
  let penalty = 0;
  if (failReasons.length > 0) penalty += 0.6;
  penalty += warnReasons.length * 0.12;
  if (analysis.isRepost) penalty += 0.4;
  const score = round4(Math.max(0, Math.min(1, richness * 0.7 + 0.3 - penalty)));

  const summary =
    status === 'pass'
      ? `actionable: ${artifacts.count} artifact kind(s) present (${artifacts.labels.join(', ')})`
      : status === 'fail'
        ? `no-op: ${failReasons.join('; ')}`
        : `low-substance: ${warnReasons.join('; ')}`;

  return {
    check: 'staleness',
    tier: 1,
    score,
    status,
    summary,
    detail: {
      artifactKinds: artifacts.count,
      artifacts: artifacts.kinds.join(',') || 'none',
      ackOnly: analysis.isAcknowledgementOnly,
      repost: analysis.isRepost,
      repostSimilarity: Number.isFinite(analysis.repostSimilarity) ? round4(analysis.repostSimilarity) : 'n/a',
      abandonErrors: errorAbandon.length,
      timelineErrors: timelineErrors.length,
      timelineWarnings: timelineWarnings.length,
    },
  };
}
