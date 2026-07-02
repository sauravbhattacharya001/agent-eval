/**
 * Shared, deterministic tool-call signature: `name(inputDigest)`.
 *
 * Used by every adapter to populate `SessionMeta.toolCallSignatures`, which
 * feeds the tool-loop half of the loop-without-progress check (mode #3): the
 * same call fired N times is a thrash even when no prose repeats. The digest is
 * the canonicalized (key-sorted) arguments, whitespace-collapsed and hard
 * truncated, so "same call, same args" collides while genuinely different calls
 * stay distinct. Never throws.
 */
export function toolSig(name: unknown, args: unknown): string {
  const n = typeof name === 'string' && name.trim() ? name.trim() : 'tool';
  let digest = '';
  try {
    if (args !== undefined && args !== null && args !== '') {
      const canon =
        typeof args === 'object'
          ? JSON.stringify(args, Object.keys(args as object).sort())
          : JSON.stringify(args);
      digest = (canon ?? '').replace(/\s+/g, ' ').slice(0, 200);
    }
  } catch {
    digest = '';
  }
  return `${n}(${digest})`;
}
