/**
 * Shared "split an export blob into candidate records" helper for the
 * trace-export adapters.
 *
 * Every export adapter accepts its source format in three interchangeable
 * envelopes and unwraps them the exact same way before it ever looks at a single
 * record:
 *
 *   1. a top-level **JSON array** of records — `[ {...}, {...} ]`
 *   2. a **single JSON object** — `{ ... }`
 *   3. **NDJSON** — one JSON value per line, blank lines skipped, malformed lines
 *      silently dropped (as `<tool> trace export` / `client.list_runs` emit)
 *
 * Each adapter previously carried a byte-identical copy of that dispatch: trim,
 * bail on empty, branch on `trimmed[0]` (`[` vs `{` vs NDJSON), and for NDJSON
 * split on `/\r?\n/`, trim each line, skip blanks, and `try { JSON.parse } catch`
 * the malformed ones. The ONLY per-adapter difference is which parsed values it
 * keeps — a shape predicate (`'session' in o`, `typeof o === 'object'`, …). This
 * module is the single home for that envelope dispatch when a caller keeps every
 * candidate (array element, single object, NDJSON line) via ONE uniform
 * predicate; the caller still owns that — genuinely source-specific — accept
 * predicate.
 *
 * The AgentLens adapter fits exactly: it filters every envelope through the same
 * `'session'|'events'` shape guard, so it delegates here. The OTLP and LangSmith
 * adapters keep their own inline dispatch on purpose — OTLP guards only its array
 * branch (its single-object / NDJSON branches push unconditionally), and
 * LangSmith unwraps bespoke `{ runs: [...] }` / `{ id }` single-object envelopes —
 * neither reduces to one uniform predicate without changing behaviour, so folding
 * them here is out of scope.
 *
 * It is the exact sibling of {@link ./runtime-floor.runtimeFloorFromActivity},
 * {@link ./content-clip.clip} and {@link ./tool-signature.toolSig}, which are
 * likewise shared by every adapter.
 *
 * Pure and dependency-free: no IO, no network. It never throws on NDJSON (bad
 * lines are skipped); a malformed array/single-object payload surfaces the native
 * `JSON.parse` error exactly as the inline code did, so that behaviour is
 * unchanged.
 *
 * @module
 */

/**
 * Parse an export blob into the list of records that satisfy `accept`.
 *
 * The blob may be a JSON array of records, a single JSON object, or NDJSON (one
 * record per line). Every candidate value — each array element, the single
 * object, and each successfully-parsed NDJSON line — is passed through `accept`;
 * only values for which `accept` returns `true` are collected (and, because
 * `accept` is a type guard, narrowed to `T`).
 *
 * This mirrors, exactly, the uniform dispatch the AgentLens adapter used inline:
 *
 * ```ts
 * const out: T[] = [];
 * const trimmed = text.trim();
 * if (!trimmed) return out;
 * if (trimmed[0] === '[') {
 *   const arr = JSON.parse(trimmed);
 *   if (Array.isArray(arr)) for (const o of arr) if (accept(o)) out.push(o);
 * } else if (trimmed[0] === '{') {
 *   const o = JSON.parse(trimmed); if (accept(o)) out.push(o);
 * } else {
 *   for (const line of trimmed.split(/\r?\n/)) {
 *     const l = line.trim(); if (!l) continue;
 *     try { const o = JSON.parse(l); if (accept(o)) out.push(o); } catch {}
 *   }
 * }
 * ```
 *
 * Callers still own the `accept` predicate (which shapes count as a record for
 * that source), so no source-specific behaviour moves here.
 *
 * @param text    the raw export file contents
 * @param accept  type guard deciding whether a parsed value is a record to keep
 * @returns the accepted records, in document order (array/single) or line order
 *          (NDJSON, blanks and malformed lines skipped)
 */
export function parseExportRecords<T>(
  text: string,
  accept: (value: unknown) => value is T,
): T[] {
  const out: T[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;

  if (trimmed[0] === '[') {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) for (const o of arr) if (accept(o)) out.push(o);
  } else if (trimmed[0] === '{') {
    const o = JSON.parse(trimmed);
    if (accept(o)) out.push(o);
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if (accept(o)) out.push(o);
      } catch {
        /* skip malformed line */
      }
    }
  }

  return out;
}
