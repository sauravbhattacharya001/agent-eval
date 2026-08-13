/**
 * Doc <-> code guard for the README's PROSE API surface.
 *
 * Two existing guards pin the other two documented surfaces:
 *   - `public-api.test.ts` pins every `import { ... } from 'agent-eval'` block.
 *   - `readme-cli-guard.test.ts` pins the `npx agent-eval <cmd>` CLI examples.
 *
 * But the README also documents a large API surface in **prose and tables** as
 * backticked call-forms — e.g. `triageOtlp(text, opts)`, `parseAgentLens(...)`,
 * `renderTriageTable(report, n)`, `buildAllSessions(...)`. None of those symbols
 * ever appear in an `import { ... }` block (the reader is told they exist, not
 * shown importing them), so `public-api.test.ts` never checks them. A rename or
 * removal of `triageOtlp` would leave the README table pointing at a symbol the
 * barrel no longer exports, and no test would notice until a reader tried it.
 *
 * This guard closes that gap: it extracts every backticked `symbol(...)` call-form
 * from README.md and asserts each one resolves to a real public barrel export
 * (runtime value OR type-only export parsed from source). The code wins, so a
 * failure means either the docs rotted (fix the README) or an export was dropped
 * (restore it).
 *
 * Intentionally parses the README rather than hard-coding a symbol list, so the
 * docs stay the single source of the *documented* surface being checked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as api from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

/**
 * Type-only exports are erased at runtime and invisible to `import * as api`,
 * so parse the barrel source for `export { type X }` / `export interface X`
 * names too. Mirrors the parser in `public-api.test.ts`.
 */
function parseBarrelExports(): Set<string> {
  const src = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8');
  const names = new Set<string>();
  const stripComments = (s: string): string => s.replace(/\/\/[^\n]*/g, '');
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of stripComments(m[1]).split(',')) {
      const cleaned = raw.replace(/\btype\b/g, '').trim();
      if (!cleaned) continue;
      const alias = cleaned.split(/\s+as\s+/).pop();
      if (alias) names.add(alias.trim());
    }
  }
  for (const m of src.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Tokens that appear in the README as a backticked `word(...)` call-form but are
 * NOT library exports — they are object *methods* or *property* references on a
 * value the reader already holds, or a config field name, not the `agent-eval`
 * barrel surface. Kept explicit and tiny so a genuinely-missing export can never
 * hide behind a broad exclusion.
 *
 *   - `generate` — `provider.generate(prompt)` instance method (EvalProvider).
 *   - `edit`     — a *tool name* in a tool-loop signature example, not an export.
 *   - `name`     — a `{ name: ... }` field reference in prose.
 */
const NON_EXPORT_METHOD_TOKENS = new Set(['generate', 'edit', 'name']);

/**
 * Every backticked `symbol(...)` call-form documented in the README. This is the
 * exact "here is the function you call" contract a reader trusts from the API
 * tables and prose, distinct from the import blocks and CLI lines.
 */
function documentedCallForms(): string[] {
  const symbols = new Set<string>();
  for (const m of readme.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = m[1];
    if (NON_EXPORT_METHOD_TOKENS.has(name)) continue;
    symbols.add(name);
  }
  return [...symbols].sort();
}

describe('README prose API symbols resolve to real exports (docs cannot rot)', () => {
  const barrel = parseBarrelExports();
  const callForms = documentedCallForms();

  const isExported = (name: string): boolean =>
    name in (api as Record<string, unknown>) || barrel.has(name);

  it('finds documented API call-forms to check', () => {
    // Guard the guard: if the extractor silently matches nothing (README
    // reformatted, backticks stripped), fail loudly rather than pass vacuously.
    expect(callForms.length).toBeGreaterThan(20);
  });

  for (const name of callForms) {
    it(`README documents \`${name}(...)\` which the barrel exports`, () => {
      expect(
        isExported(name),
        `README.md documents "${name}(...)", but src/index.ts does not export it. ` +
          `Fix the docs or restore the export.`,
      ).toBe(true);
    });
  }

  it('covers the triage adapter family documented only in prose tables', () => {
    // These are the highest-value symbols this guard adds over the import/CLI
    // guards: named in prose/tables, never in an `import { ... }` block.
    for (const name of [
      'triageOtlp',
      'parseOtlp',
      'triageLangSmith',
      'parseLangSmith',
      'triageAgentLens',
      'parseAgentLens',
      'renderTriageTable',
    ]) {
      expect(callForms).toContain(name);
      expect(isExported(name), `${name} should be an export`).toBe(true);
    }
  });
});
