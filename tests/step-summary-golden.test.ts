/**
 * Drift-pinning for `docs/step-summary-examples.md` — the human-facing golden doc.
 *
 * That page shows the exact `$GITHUB_STEP_SUMMARY` Markdown the CI eval step posts
 * for a passing and a failing run. A static doc full of rendered output rots the
 * instant the renderer or a fixture changes — and then it lies to every reader and
 * PR reviewer. This suite makes that impossible: it regenerates the doc in-memory
 * from the very same generator (`scripts/gen-summary-golden.ts` → `buildDoc()`,
 * which itself drives the real `parse → evaluateCiRun → renderActionSummary`
 * chain) and asserts the committed file matches **byte-for-byte**. If they differ,
 * the doc is stale and the fix is `npx tsx scripts/gen-summary-golden.ts`.
 *
 * On top of the exact-match pin, a few structural assertions document the contract
 * the doc is supposed to demonstrate (a passing example with no Findings, a failing
 * example whose Findings name the specific staleness reason) so a reader of the
 * test alone learns what the page is for.
 *
 * @tier 1 — Externally observable (the bytes are the bytes; no AI, no network)
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildDoc, GOLDEN_DOC_PATH } from '../scripts/gen-summary-golden.js';

// The committed doc on disk (what a reader actually sees).
const committed = readFileSync(GOLDEN_DOC_PATH, 'utf8');
// What the generator produces right now from the current code + fixtures.
const regenerated = buildDoc();

describe('step-summary golden doc — stays in lockstep with the renderer', () => {
  it('the committed docs/step-summary-examples.md matches the generator byte-for-byte', () => {
    // The single load-bearing assertion: if this fails, the doc is stale.
    // Regenerate it with: npx tsx scripts/gen-summary-golden.ts
    expect(committed).toBe(regenerated);
  });

  it('is marked as generated so no one hand-edits it', () => {
    expect(committed).toContain('Generated file — do not edit by hand.');
    expect(committed).toContain('scripts/gen-summary-golden.ts');
  });
});

describe('step-summary golden doc — documents the two scenarios faithfully', () => {
  it('shows a passing run: green heading, watch gate, and NO Findings section', () => {
    const passing = sectionFor(committed, 'Passing run — a substantive review');
    expect(passing).toContain('## ✅ Agent Eval — passed');
    expect(passing).toContain('PASS — 1/1 workers within gate (watch)');
    // Nothing failed, so the renderer omits Findings entirely — that absence is
    // the point (a clean run does not spam evidence).
    expect(passing).not.toContain('### Findings');
    // Both Tier 1 checks are visible in the embedded per-check breakdown.
    expect(passing).toContain('| completeness |');
    expect(passing).toContain('| staleness |');
  });

  it('shows a failing run: red heading + Findings that name the staleness no-op reason', () => {
    const failing = sectionFor(committed, 'Failing run — a stale "LGTM" no-op');
    expect(failing).toContain('## ❌ Agent Eval — failed');
    expect(failing).toContain('FAIL — 1/1 workers below gate (watch)');
    expect(failing).toContain('### Findings');
    // The specific, actionable per-check reason a crash check could never give —
    // this is the whole pitch of the eval layer, so pin that it actually shows.
    expect(failing).toMatch(/🔴 claude-review\/staleness: no-op:/);
    expect(failing.toLowerCase()).toContain('bare acknowledgement only');
    // The worker-level grade line still rides along after the per-check reason.
    expect(failing).toContain('claude-review: at-risk');
  });

  it('shows a second failing mode (abandoned mid-task): no actionable content, completeness still passes', () => {
    const abandoned = sectionFor(committed, 'Failing run — abandoned mid-task');
    expect(abandoned).toContain('## ❌ Agent Eval — failed');
    expect(abandoned).toContain('FAIL — 1/1 workers below gate (watch)');
    expect(abandoned).toContain('### Findings');
    // This mode is distinct from the LGTM no-op: the staleness reason is the
    // *absence of actionable content*, not a bare approval. Pin that specific
    // wording so the doc keeps demonstrating the #1361 timeout/abandonment mode.
    expect(abandoned).toMatch(/🔴 claude-review\/staleness: no-op: no actionable content/);
    // The text was on-topic and non-empty, so completeness is NOT the failing
    // check here — it still passes (1.00). That contrast (complete yet stale) is
    // the point of showing this fixture alongside the LGTM one.
    expect(abandoned).toMatch(/\| completeness \| 1\.00 \| 1 \| 0 \| 0 \| 1 \|/);
    expect(abandoned).toMatch(/\| staleness \| 0\.00 \| 0 \| 0 \| 1 \| 1 \|/);
  });

  it('cross-references the companion workflow example (so the two stay discoverable)', () => {
    expect(committed).toContain('examples/workflows/pr-review-with-eval.yml');
  });

  it('fences the embedded summaries with ~~~~ so their inner ``` blocks survive', () => {
    // The rendered summary can contain fenced code (e.g. a diff/code suggestion),
    // so the doc must wrap each block in a longer fence. Pin that the generator
    // used ~~~~markdown rather than ``` (which would terminate early).
    expect(committed).toContain('~~~~markdown');
    expect(committed).not.toContain('```markdown');
  });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Slice the committed doc to the body of one scenario section. Sections are
 * delimited by the doc's own top-level scenario headings; the rendered summaries
 * *inside* a section contain their own `## ` lines (e.g. `## ✅ Agent Eval`,
 * `## Per-check breakdown`), so we must split on the known sibling headings
 * rather than on any `## ` — otherwise a summary's inner heading would truncate
 * the section early.
 */
function sectionFor(doc: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = doc.indexOf(marker);
  expect(start, `section not found: ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + marker.length);

  // The only real sibling section boundaries in this doc.
  const SIBLINGS = ['\n## Passing run', '\n## Failing run', '\n## How to read it'];
  let cut = rest.length;
  for (const sib of SIBLINGS) {
    const i = rest.indexOf(sib);
    if (i >= 0 && i < cut) cut = i;
  }
  return rest.slice(0, cut);
}
