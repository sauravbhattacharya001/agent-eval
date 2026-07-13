/**
 * Timeout/Staleness Detector - built-in pattern tables + code-balance helper.
 *
 * The static, content-agnostic building blocks used by the output-text
 * abandonment detector: the abandonment/stall pattern tables and the
 * bracket-balance scanner that flags truncated code. Pure and deterministic;
 * no timeline, filesystem, or network access.
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

/** Built-in patterns that indicate an abandoned or interrupted output. */
export const ABANDONMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\.\.\.$/, label: 'trailing ellipsis (incomplete thought)' },
  { pattern: /\[(?:TODO|FIXME|PLACEHOLDER|TBD|WIP)\]/i, label: 'TODO/placeholder marker' },
  { pattern: /(?:I'll|Let me|I will|I need to|I should|Next,? I)[\s\S]{0,30}$/, label: 'stated intent without follow-through' },
  { pattern: /```[\w]*\n[^`]*$/, label: 'unclosed code block' },
  { pattern: /<!--\s*[^>]*$/, label: 'unclosed HTML comment' },
  { pattern: /\n\s*[-*]\s*$/, label: 'empty list item at end' },
  { pattern: /(?:Step|Part|Section)\s+\d+[:.]\s*$/, label: 'empty section header at end' },
  { pattern: /\|\s*[-:]+\s*\|[\s\S]{0,5}$/, label: 'incomplete table' },
  { pattern: />\s*$/, label: 'empty blockquote at end' },
];

/** Patterns indicating a stalled/looping agent. */
export const STALL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:error|failed|retry).*(?:error|failed|retry).*(?:error|failed|retry)/is, label: 'repeated errors (possible retry loop)' },
  { pattern: /(.{50,})\1{2,}/s, label: 'repeated content block' },
];

/**
 * Detect unbalanced brackets/delimiters indicating code truncation.
 * Returns a description of the imbalance, or null if balanced.
 */
export function detectUnbalancedCode(text: string): string | null {
  // Only check within code blocks or code-like content
  const codeBlockRegex = /```[\w]*\n([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;
  const codeSegments: string[] = [];

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1] !== undefined) {
      codeSegments.push(match[1]);
    }
  }

  // If no code blocks, check the whole text only if it looks like code
  const textToCheck = codeSegments.length > 0
    ? codeSegments.join('\n')
    : (/[{}\[\]()]/.test(text) && /(?:function|class|const|let|var|if|for|while|import|export|def|fn)\b/.test(text) ? text : null);

  if (!textToCheck) return null;

  let braces = 0;
  let brackets = 0;
  let parens = 0;

  for (const ch of textToCheck) {
    switch (ch) {
      case '{': braces++; break;
      case '}': braces--; break;
      case '[': brackets++; break;
      case ']': brackets--; break;
      case '(': parens++; break;
      case ')': parens--; break;
    }
  }

  const issues: string[] = [];
  if (braces > 0) issues.push(`${braces} unclosed brace(s)`);
  if (braces < 0) issues.push(`${-braces} extra closing brace(s)`);
  if (brackets > 0) issues.push(`${brackets} unclosed bracket(s)`);
  if (brackets < 0) issues.push(`${-brackets} extra closing bracket(s)`);
  if (parens > 0) issues.push(`${parens} unclosed parenthesis(es)`);
  if (parens < 0) issues.push(`${-parens} extra closing parenthesis(es)`);

  return issues.length > 0 ? issues.join(', ') : null;
}
