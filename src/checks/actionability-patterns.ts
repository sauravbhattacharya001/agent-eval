/**
 * Actionability — pattern tables & response-type classification
 *
 * The regex vocabulary that drives heuristic actionability scoring (hedge /
 * platitude / weasel tables, the actionable-signal patterns) plus the
 * task→`ResponseType` classifier and its per-type scoring weights. Extracted
 * from `actionability.ts` so the (large, self-contained) pattern tables and
 * the classification seam live apart from extraction and scoring. The patterns
 * are module-internal; only `detectResponseType` is part of the public surface
 * (re-exported from `./actionability.js`).
 *
 * @tier 2 — Heuristic
 * @module
 */

import type { ResponseType } from './actionability-types.js';

// ═══ CONSTANTS ═══════════════════════════════════════════════════════════════════

/** Words/phrases that signal hedging — lack of commitment to a recommendation. */
export const HEDGE_PATTERNS: readonly RegExp[] = [
  /\b(?:might|could|may|perhaps|possibly|potentially)\s+(?:want to|consider|look into|try)\b/i,
  /\b(?:it depends|depends on (?:your|the) (?:situation|context|needs|requirements))\b/i,
  /\bthere are (?:many|several|various|numerous|different) (?:ways|approaches|options|methods)\b/i,
  /\byou (?:might|could|may) (?:want to|wish to)\b/i,
  /\b(?:generally|typically|usually|often|sometimes) (?:it's|it is) (?:recommended|advised|suggested)\b/i,
  /\b(?:in some cases|in certain situations|under certain circumstances)\b/i,
  /\bone (?:approach|option|way|method) (?:would be|could be|is) to\b/i,
];

/** Platitudes — empty advice that sounds wise but provides no direction. */
export const PLATITUDE_PATTERNS: readonly RegExp[] = [
  /\b(?:ensure|make sure) (?:you follow|to follow) best practices\b/i,
  /\b(?:maintain|ensure) (?:code )?quality\b/i,
  /\btest (?:your code )?thoroughly\b/i,
  /\b(?:keep|maintain) (?:your |the )?code (?:clean|readable|maintainable)\b/i,
  /\b(?:always|remember to) (?:document|comment) (?:your )?code\b/i,
  /\b(?:follow|adhere to|stick to) (?:the )?(?:SOLID|DRY|KISS|YAGNI) (?:principle|pattern)s?\b/i,
  /\b(?:consider|think about) (?:the )?(?:edge cases|error handling|performance)\b/i,
  /\buse (?:appropriate|proper|correct|suitable) (?:tools|methods|techniques)\b/i,
  /\b(?:it is|it's) important to\b/i,
];

/** Weasel words — vague quantifiers that avoid specifics. */
export const WEASEL_PATTERNS: readonly RegExp[] = [
  /\b(?:some|many|various|numerous|several|a number of) (?:people|developers|teams|users|experts)\b/i,
  /\b(?:some|many|various|numerous|several) (?:ways|approaches|methods|options|tools|frameworks)\b/i,
  /\b(?:significant|substantial|considerable|notable)\b/i,
  /\bresearch (?:shows|suggests|indicates)\b/i,
  /\b(?:it is|it's) (?:well-known|widely accepted|generally agreed)\b/i,
];

/** Patterns that signal concrete, specific actionable content. */
export const IMPERATIVE_PATTERN = /^(?:run|execute|install|create|add|remove|delete|move|copy|rename|update|change|set|configure|enable|disable|open|close|start|stop|build|deploy|push|pull|merge|commit|checkout|navigate|click|type|enter|import|export|replace|modify|use|apply|initialize|call|invoke|write|read|check|verify|test|debug|log|print|throw|catch|return|define|declare|implement|extend|override|refactor|extract|inline|split|join|wrap|unwrap)\b/i;

export const CODE_SNIPPET_PATTERN = /```[\s\S]*?```|`[^`]+`/;

export const FILE_REFERENCE_PATTERN = /(?:(?:\.\/|\.\.\/|\/|[A-Z]:\\|~\/)[^\s,;)]+|(?:src|lib|test|config|dist|build|node_modules)\/[^\s,;)]+|\b[\w-]+\.(?:ts|js|tsx|jsx|py|rs|go|java|json|yaml|yml|toml|md|html|css|sql|sh|bash|zsh)\b)/;

export const COMMAND_PATTERN = /(?:npm|npx|yarn|pnpm|pip|cargo|go|dotnet|mvn|gradle|make|docker|kubectl|git|apt|brew|choco|curl|wget)\s+\S+/;

export const URL_PATTERN = /https?:\/\/[^\s)>]+/;

export const STEP_PATTERN = /^(?:\d+[\.\)]\s|step\s+\d+)/im;

export const SPECIFIC_VALUE_PATTERN = /(?:\b(?:port|version|timeout|limit|max|min|size|count|length|width|height|depth|level|priority|threshold|interval|delay|retries?)\s*(?:=|:|\bis\b)\s*\d+|\b\d+(?:\.\d+)?(?:ms|s|m|h|px|rem|em|%|MB|GB|KB)\b|`[A-Z_][A-Z0-9_]*`|\b0x[0-9a-f]+\b)/i;

// ═══ RESPONSE TYPE DETECTION ═════════════════════════════════════════════════════

/**
 * Infer the expected response type from the task/prompt.
 *
 * @param task - The original task given to the agent
 * @returns The most likely response type
 */
export function detectResponseType(task: string): ResponseType {
  const lower = task.toLowerCase();

  // Code review patterns
  if (/\b(?:review|pr|pull request|code review|diff|changes?)\b/.test(lower) &&
      /\b(?:review|check|look at|feedback|comments?)\b/.test(lower)) {
    return 'code-review';
  }

  // How-to patterns
  if (/\b(?:how (?:to|do|can)|steps? to|guide|tutorial|walkthrough|set ?up|configure|install)\b/.test(lower)) {
    return 'how-to';
  }

  // Fix patterns
  if (/\b(?:fix|resolve|debug|troubleshoot|repair|patch|solve|workaround)\b/.test(lower)) {
    return 'fix';
  }

  // Summary patterns
  if (/\b(?:summarize|summary|tldr|overview|brief|digest|recap)\b/.test(lower)) {
    return 'summary';
  }

  // Decision patterns
  if (/\b(?:which|should i|compare|trade-?offs?|pros? and cons?|recommend|choose|pick|select|decision)\b/.test(lower)) {
    return 'decision';
  }

  // Explanation patterns
  if (/\b(?:explain|what (?:is|are)|why (?:does|is|are)|describe|clarify|elaborate)\b/.test(lower)) {
    return 'explanation';
  }

  return 'general';
}

/**
 * Response type weights — what matters most for each type.
 */
export const RESPONSE_TYPE_WEIGHTS: Record<ResponseType, {
  imperative: number;
  specificity: number;
  examples: number;
  completeness: number;
}> = {
  'code-review': { imperative: 0.3, specificity: 0.4, examples: 0.2, completeness: 0.1 },
  'how-to':      { imperative: 0.4, specificity: 0.2, examples: 0.2, completeness: 0.2 },
  'explanation': { imperative: 0.1, specificity: 0.3, examples: 0.4, completeness: 0.2 },
  'fix':         { imperative: 0.3, specificity: 0.3, examples: 0.3, completeness: 0.1 },
  'summary':     { imperative: 0.1, specificity: 0.4, examples: 0.2, completeness: 0.3 },
  'decision':    { imperative: 0.2, specificity: 0.3, examples: 0.2, completeness: 0.3 },
  'general':     { imperative: 0.25, specificity: 0.3, examples: 0.25, completeness: 0.2 },
};
