/**
 * Tier 2 relevance / task-grounding for one CI run.
 *
 * This is the seam that catches the failure neither completeness nor staleness
 * can see: an output that is well-formed *and* superficially actionable yet
 * about the **wrong thing**. The canonical case is a project guidance file
 * ("use pnpm", "prefer named exports") posted verbatim instead of a review of
 * the diff (#1302): it is long and structured (passes completeness) and littered
 * with paths, inline code, and directive words (passes staleness), but it shares
 * almost no salient vocabulary with the prompt it was asked to address.
 *
 * The reference point is the **prompt** - which the evaluated agent did not write
 * - so a fluent-but-off-task dump cannot forge coverage. No model-as-judge,
 * offline, reproducible.
 *
 * Split out of `ci-run.ts` along its internal seam; `ci-run.ts` re-exports the
 * public entry point ({@link analyzeTaskGrounding}) so the package surface is
 * unchanged.
 *
 * @tier 2 - Heuristic (no AI, reproducible, offline)
 * @module
 */

import {
  DEFAULT_RELEVANCE_MIN_PROMPT_TERMS,
  round4,
  type CiCheckResult,
  type CiCheckStatus,
  type TaskGroundingResult,
} from './ci-run-types.js';

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/**
 * Stopwords removed before computing prompt/output term overlap for the
 * relevance check. These carry no task identity ("the", "please", "should"), so
 * counting them would let any fluent English text score as "grounded". Kept
 * deliberately broad - including review/PR filler ("review", "check", "verify",
 * "pull", "request", "code", "change") - so coverage is driven by the prompt's
 * *substantive* nouns (the files, symbols, and concepts it actually names), not
 * the boilerplate scaffolding every prompt shares.
 */
const RELEVANCE_STOPWORDS: ReadonlySet<string> = new Set([
  // articles / pronouns / conjunctions / prepositions
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'this', 'that', 'these', 'those', 'it', 'its', 'and',
  'or', 'if', 'so', 'than', 'too', 'very', 'just', 'then', 'here', 'there',
  'all', 'any', 'some', 'your', 'you', 'we', 'our', 'us', 'i', 'me', 'my',
  'they', 'them', 'their', 'he', 'she', 'his', 'her', 'not', 'no', 'about',
  'over', 'out', 'up', 'down', 'off', 'each', 'both', 'more', 'most', 'other',
  'such', 'own', 'same', 'while', 'when', 'where', 'who', 'whom', 'which',
  'what', 'how', 'why', 'also', 'been', 'were', 'into', 'onto', 'upon',
  // generic task / review verbs and scaffolding that every prompt shares
  'please', 'make', 'sure', 'use', 'used', 'using', 'set', 'run', 'review',
  'check', 'verify', 'ensure', 'flag', 'look', 'looks', 'add', 'added',
  'change', 'changes', 'changed', 'fix', 'fixed', 'update', 'updated', 'pull',
  'request', 'pr', 'code', 'implementation', 'implement', 'following', 'any',
  'new', 'good', 'overall', 'note', 'notes', 'consider', 'need', 'needs',
]);

// ─── TOKENIZATION ────────────────────────────────────────────────────────────────

/**
 * Tokenize a piece of text into distinct **salient** terms for grounding, keyed
 * by a fold so morphological variants match. Returns a `Map<foldKey, original>`:
 * the key is a lightly-normalized form (single trailing `-s` stripped for longer
 * words, so "endpoints" and "endpoint" share a key) used only for *matching*; the
 * value is the first original surface form seen, used for *display* (so evidence
 * reads "redis", not the folded "redi"). Lower-cased, punctuation-stripped,
 * stopwords ({@link RELEVANCE_STOPWORDS}) and short/numeric tokens dropped. A
 * concept repeated ten times maps to one entry - coverage is about *which*
 * topics are touched, not how often. Pure and deterministic.
 */
function salientTermMap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const raw = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/);
  for (const tok of raw) {
    if (tok.length < 3) continue;
    if (/^\d+$/.test(tok)) continue; // bare numbers carry no topic identity
    if (RELEVANCE_STOPWORDS.has(tok)) continue;
    // Fold a single trailing plural -s (longer words only, never -ss) into a
    // match KEY so "endpoints" grounds "endpoint"; keep the original surface form
    // for display. The key may look clipped ("redis" -> "redi"); that is fine
    // because both sides fold identically, and only the original is ever shown.
    const key = tok.length > 4 && tok.endsWith('s') && !tok.endsWith('ss') ? tok.slice(0, -1) : tok;
    if (RELEVANCE_STOPWORDS.has(key)) continue;
    if (!out.has(key)) out.set(key, tok);
  }
  return out;
}

// ─── ANALYSIS ──────────────────────────────────────────────────────────────────────

/**
 * Measure how much of the **prompt's** salient vocabulary the output engages
 * with. This is the Tier-2 grounding signal: a genuine review of a specific diff
 * reuses the task's nouns (the files, symbols, and concepts it was asked about),
 * so it covers most of the prompt's terms; boilerplate posted verbatim instead
 * of a review (the #1302 mode) covers almost none. The reference point is the
 * prompt - which the evaluated agent did not write - so it cannot be forged by a
 * fluent-but-off-task dump.
 *
 * `promptCoverage` is normalized by *prompt* terms, not output length, so a short
 * on-topic answer is not penalized for brevity - only for failing to mention
 * what was asked. When the prompt is too thin to ground against (fewer than
 * `minPromptTerms` salient terms), `promptCoverage`/`jaccard` are `NaN` and
 * `promptTooThin` is set, so the caller can `skip` rather than guess.
 *
 * @param prompt - The task the agent was given.
 * @param output - The agent's output.
 * @param minPromptTerms - Minimum salient prompt terms required to ground.
 */
export function analyzeTaskGrounding(
  prompt: string,
  output: string,
  minPromptTerms = DEFAULT_RELEVANCE_MIN_PROMPT_TERMS,
): TaskGroundingResult {
  const promptMap = salientTermMap(prompt);
  const outputMap = salientTermMap(output);
  // Display the original surface forms ("redis", not the folded "redi").
  const promptTerms = [...promptMap.values()];

  if (promptMap.size < minPromptTerms) {
    return {
      promptCoverage: Number.NaN,
      jaccard: Number.NaN,
      promptTerms,
      matchedTerms: [],
      missingTerms: promptTerms,
      promptTooThin: true,
    };
  }

  // Match on the fold KEY so morphological variants align; report the prompt's
  // original surface form for each bucket.
  const matchedTerms: string[] = [];
  const missingTerms: string[] = [];
  for (const [key, original] of promptMap) {
    if (outputMap.has(key)) matchedTerms.push(original);
    else missingTerms.push(original);
  }

  const promptCoverage = matchedTerms.length / promptMap.size;
  const unionKeys = new Set([...promptMap.keys(), ...outputMap.keys()]);
  const jaccard = unionKeys.size === 0 ? 0 : matchedTerms.length / unionKeys.size;

  return {
    promptCoverage: round4(promptCoverage),
    jaccard: round4(jaccard),
    promptTerms,
    matchedTerms,
    missingTerms,
    promptTooThin: false,
  };
}

// ─── SCORING ───────────────────────────────────────────────────────────────────────

/**
 * Score the Tier 2 relevance / task-grounding check into a single-run result.
 * This is the signal completeness and staleness both miss: an output can be
 * well-formed *and* full of actionable-looking artifacts yet be about the wrong
 * thing entirely - a project guidance file ("use pnpm", "prefer named exports")
 * posted verbatim instead of a review of the actual diff. It reads as complete
 * (long, structured) and even as actionable (it contains file paths, inline
 * code, and directive words), so only a *reference-aware* check - one that
 * compares the output against the prompt the agent was given - can catch it.
 *
 * Verdict:
 *   - **skip** if there is no prompt or the prompt is too thin to ground against
 *     (the check contributes nothing rather than guessing).
 *   - **fail** if a *substantive* output (>= `minOutputChars`) covers less than
 *     `minRelevance` of the prompt's salient vocabulary - it ignored the task.
 *   - **warn** if a *short* output covers less than `minRelevance` (a terse,
 *     possibly-on-topic answer that names few prompt terms - weak grounding, but
 *     not the verbose-off-task parroting failure).
 *   - **pass** otherwise (the output engages with what was asked).
 *
 * The score is the prompt-coverage fraction itself (clamped), so it is a smooth
 * signal usable in a trend rather than a bare boolean.
 */
export function scoreRelevance(
  grounding: TaskGroundingResult,
  output: string,
  minRelevance: number,
  minOutputChars: number,
): CiCheckResult {
  // No prompt to ground against -> the check abstains (skip, score N/A).
  if (grounding.promptTooThin || !Number.isFinite(grounding.promptCoverage)) {
    return {
      check: 'relevance',
      tier: 2,
      score: Number.NaN,
      status: 'skip',
      summary: 'no gradable prompt to ground against (prompt too thin)',
      detail: { promptTerms: grounding.promptTerms.length, skipped: true },
    };
  }

  const coverage = grounding.promptCoverage;
  const substantive = output.trim().length >= minOutputChars;
  const grounded = coverage >= minRelevance;

  let status: CiCheckStatus;
  if (grounded) {
    status = 'pass';
  } else if (substantive) {
    // Long output, little overlap with the task = the parroting failure mode.
    status = 'fail';
  } else {
    // Short and weakly grounded: flag softly, don't hard-fail a terse answer.
    status = 'warn';
  }

  const pct = (coverage * 100).toFixed(0);
  const missingPreview = grounding.missingTerms.slice(0, 6).join(', ');
  const summary =
    status === 'pass'
      ? `on-task: covers ${pct}% of the prompt's topics (${grounding.matchedTerms.length}/${grounding.promptTerms.length})`
      : status === 'fail'
        ? `off-task: only ${pct}% of the prompt's topics addressed (${grounding.matchedTerms.length}/${grounding.promptTerms.length}); ignores ${missingPreview}`
        : `weak grounding: short output covers only ${pct}% of the prompt's topics`;

  return {
    check: 'relevance',
    tier: 2,
    score: round4(Math.max(0, Math.min(1, coverage))),
    status,
    summary,
    detail: {
      promptCoverage: round4(coverage),
      jaccard: Number.isFinite(grounding.jaccard) ? round4(grounding.jaccard) : 'n/a',
      matched: grounding.matchedTerms.length,
      promptTerms: grounding.promptTerms.length,
      substantive,
    },
  };
}
