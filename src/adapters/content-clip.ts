/**
 * Shared content-truncation helpers for the trace-export adapters.
 *
 * Every adapter (OpenClaw, OTLP, LangSmith, AgentLens) builds a {@link
 * ../checks/staleness.RunTimeline} whose event `content` strings and derived
 * session `label` must be bounded so a fleet of timelines stays small. Each
 * adapter previously carried its own byte-identical copy of this `clip` helper
 * plus the two truncation limits; this module is their single home — the exact
 * sibling of {@link ./tool-signature.toolSig}, which is likewise shared by every
 * adapter.
 *
 * Keeping the limits here means the "how long is an event/label allowed to be"
 * policy is defined once and cannot drift between adapters.
 *
 * Pure and dependency-free: no IO, no throw.
 *
 * @module
 */

/** Max characters retained per event `content` (keeps timelines small). */
export const CONTENT_TRUNCATION = 500;

/** Max characters retained for a derived session label. */
export const LABEL_TRUNCATION = 120;

/**
 * Truncate a value to a printable, length-bounded string.
 *
 * `null`/`undefined` collapse to `''`. A string is used as-is; any other value is
 * `JSON.stringify`'d so structured event payloads (objects/arrays) render legibly.
 * When the result exceeds `max` characters it is hard-truncated and an ellipsis
 * (`…`) is appended.
 *
 * @param value  the raw content to clip (string or arbitrary structured value)
 * @param max    max characters to retain before truncating (default {@link CONTENT_TRUNCATION})
 */
export function clip(value: unknown, max = CONTENT_TRUNCATION): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
