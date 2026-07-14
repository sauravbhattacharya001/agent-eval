/**
 * Completeness Checker — pattern tables (Tier 1)
 *
 * The default regex/phrase tables the deterministic completeness engine matches
 * against: stub/placeholder patterns, low-substance filler phrases, and
 * truncation markers. Split out from the analysis engine so the pattern
 * vocabulary is one discoverable home and the engine reads as logic, not data.
 *
 * All tables are pure data — no AI, no IO.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

// ─── STUB PATTERNS ──────────────────────────────────────────────────────────────

/** Default patterns that indicate a stub or placeholder response. */
export const DEFAULT_STUB_PATTERNS: RegExp[] = [
  // Common placeholder texts
  /^TODO\b/i,
  /^\[?\s*placeholder\s*]?$/im,
  /^\[?\s*insert\s+.+\s+here\s*]?$/im,
  /^lorem ipsum/i,
  // Empty code/content markers
  /^```\s*\n\s*\n```$/m,
  /^\s*\/\/\s*TODO\s*$/m,
  /^\s*#\s*TODO\s*$/m,
  // "I don't know" / refusal stubs
  /^I (?:cannot|can't|am unable to|don't have enough)/i,
  /^I'm (?:sorry|unable|not able)/i,
  // Ellipsis-only
  /^\s*\.{3,}\s*$/m,
  // Just whitespace or dashes
  /^[\s\-_=]+$/,
];

/** Default filler phrases that suggest low-substance output. */
export const DEFAULT_FILLER_PHRASES: string[] = [
  'as an ai',
  'as a language model',
  'i hope this helps',
  'let me know if you need anything else',
  'feel free to ask',
  'is there anything else',
  'hope this is helpful',
  'happy to help',
  'does this make sense',
];

// ─── TRUNCATION MARKERS ─────────────────────────────────────────────────────────

/** Patterns that suggest output was truncated. */
export const TRUNCATION_MARKERS: RegExp[] = [
  // Explicit truncation indicators
  /\[\.{3}\]$/,
  /\[truncated\]/i,
  /\[continued\]/i,
  /\[output truncated\]/i,
  /\.{3}$/,
  // Cut-off mid-word (line ends with incomplete word pattern)
  /\w{3,}-$/m,
  // Unfinished list (ends with list marker and nothing else)
  /^\s*[-*]\s*$/m,
  /^\s*\d+\.\s*$/m,
];
