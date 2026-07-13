/**
 * Timeout/Staleness Detector - output-text abandonment detection.
 *
 * The text-only half of the staleness engine: scans a finished output string
 * for abandonment/stall signals (built-in + custom patterns, mid-sentence
 * truncation, embedded TODO markers, unbalanced code, stall patterns). It never
 * touches the run timeline - only the output text it is handed - so it stays a
 * pure, deterministic Tier-1 check.
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { AbandonmentOptions, StalenessIssue } from './staleness-types.js';
import { ABANDONMENT_PATTERNS, STALL_PATTERNS, detectUnbalancedCode } from './staleness-patterns.js';

/**
 * Detect abandonment markers in the output text.
 */
export function detectAbandonment(output: string, options: AbandonmentOptions = {}): StalenessIssue[] {
  const {
    customPatterns = [],
    checkIncompleteSentence = true,
    checkTodoMarkers = true,
    checkUnbalancedCode = true,
    minLengthForCheck = 10,
  } = options;

  if (output.length < minLengthForCheck) return [];

  const issues: StalenessIssue[] = [];
  const trimmed = output.trimEnd();

  // Check built-in abandonment patterns
  for (const { pattern, label } of ABANDONMENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      issues.push({
        kind: 'abandoned',
        severity: 'warning',
        message: `Output shows abandonment signal: ${label}`,
        evidence: `Matched pattern at end of output: "${trimmed.slice(-80)}"`,
      });
    }
  }

  // Check custom patterns
  for (const pattern of customPatterns) {
    if (pattern.test(trimmed)) {
      issues.push({
        kind: 'abandoned',
        severity: 'warning',
        message: `Output matches custom abandonment pattern: ${pattern.source}`,
        evidence: `Pattern: ${pattern.toString()}`,
      });
    }
  }

  // Check for incomplete sentence at the end
  if (checkIncompleteSentence) {
    // Get last non-empty line
    const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
    const lastLineRaw = lines[lines.length - 1];
    const lastLine = lastLineRaw ? lastLineRaw.trim() : '';
    if (lastLine.length > 0) {
      // Skip if it's a code block, heading, list marker, etc.
      const isStructural = /^[#>|`\-*\d]/.test(lastLine) || /^[\[\(]/.test(lastLine);
      if (!isStructural && lastLine.length > 15) {
        // Sentence should end with punctuation
        const endsWithPunctuation = /[.!?;:)\]"'`]$/.test(lastLine);
        if (!endsWithPunctuation) {
          issues.push({
            kind: 'abandoned',
            severity: 'warning',
            message: 'Output ends mid-sentence (no terminal punctuation)',
            evidence: `Last line: "${lastLine.slice(-60)}"`,
          });
        }
      }
    }
  }

  // Check for TODO markers embedded in the text
  if (checkTodoMarkers) {
    const todoPattern = /\b(?:TODO|FIXME|PLACEHOLDER|TBD|XXX|HACK)\b/gi;
    const matches = trimmed.match(todoPattern);
    if (matches && matches.length > 0) {
      issues.push({
        kind: 'abandoned',
        severity: 'warning',
        message: `Output contains ${matches.length} TODO/placeholder marker(s)`,
        evidence: `Found: ${[...new Set(matches)].join(', ')}`,
      });
    }
  }

  // Check for unbalanced code constructs
  if (checkUnbalancedCode) {
    const unbalanced = detectUnbalancedCode(trimmed);
    if (unbalanced) {
      issues.push({
        kind: 'abandoned',
        severity: 'error',
        message: `Output has unbalanced code: ${unbalanced}`,
        evidence: `Detected in output text (truncation mid-code)`,
      });
    }
  }

  // Check stall patterns
  for (const { pattern, label } of STALL_PATTERNS) {
    if (pattern.test(trimmed)) {
      issues.push({
        kind: 'no_progress',
        severity: 'warning',
        message: `Output shows stall signal: ${label}`,
        evidence: `Matched stall pattern in output`,
      });
    }
  }

  return issues;
}
