/**
 * Public API surface contract.
 *
 * The root barrel (`src/index.ts`) is the library's public contract: every name
 * here is something a downstream consumer can depend on. This test pins that
 * surface so:
 *
 *   1. The key entry points of all three pillars stay exported and callable —
 *      a refactor that accidentally drops one fails here instead of in a
 *      downstream consumer.
 *   2. Names that were deliberately removed (dead exports, the out-of-scope
 *      chain runner) cannot silently creep back in.
 *
 * It is intentionally written against the public barrel only (`../src/index.js`),
 * never deep module paths, so it mirrors exactly what an installed consumer sees.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as api from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * Names the root barrel (`src/index.ts`) exports, parsed from source text so
 * that type-only exports (e.g. `EvalProvider`) count too — they are erased at
 * runtime and would be invisible to `import * as api`.
 */
function parseBarrelExports(): Set<string> {
  const src = readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8');
  const names = new Set<string>();
  // Strip `//` line comments so inline notes inside a multi-line `export { ... }`
  // block never contaminate the parsed names.
  const stripComments = (s: string): string => s.replace(/\/\/[^\n]*/g, '');
  // `export { a, b as c, type D } from '...'` and multi-line variants.
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of stripComments(m[1]).split(',')) {
      const cleaned = raw.replace(/\btype\b/g, '').trim();
      if (!cleaned) continue;
      const alias = cleaned.split(/\s+as\s+/).pop();
      if (alias) names.add(alias.trim());
    }
  }
  // `export function foo` / `export const bar` / `export class Baz` ...
  for (const m of src.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Every symbol imported `from 'agent-eval'` in a README code block. This is the
 * exact contract a copy-pasting reader depends on: if the docs import a name the
 * barrel no longer exports, that snippet is broken.
 */
function parseReadmeAgentEvalImports(): string[] {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const symbols = new Set<string>();
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]agent-eval['"]/g;
  for (const m of readme.matchAll(importRe)) {
    for (const raw of m[1].split(',')) {
      const cleaned = raw.replace(/\btype\b/g, '').trim();
      if (!cleaned) continue;
      // A README import always names the exported symbol (before any `as`).
      const name = cleaned.split(/\s+as\s+/)[0].trim();
      if (name) symbols.add(name);
    }
  }
  return [...symbols];
}

/** Names that must be exported as callable functions, grouped by pillar. */
const PILLAR_FUNCTIONS = {
  'pillar 1 — eval framework (core + runner + helpers)': [
    'runSuite',
    'runSuites',
    'runTiered',
    'tier1',
    'tier2',
    'tier3',
    'defineEval',
    'detectTier',
    'classifyAssertions',
  ],
  'pillar 1 — assertions (Tier 1/2 standalone matchers)': [
    'toContain',
    'toMatch',
    'toBeValidJson',
    'toBeNonEmpty',
    'toContainKeywords',
    'toNotBeAbandoned',
    'toHaveValidPaths',
    'toHaveMeaningfulDiff',
    'toNotRepeat',
  ],
  'pillar 1 — judge framework (Tier 3)': ['buildRubric', 'toPassJudge', 'computeVerdict'],
  'pillar 1 — providers': ['AzureOpenAIProvider', 'AgentProvider'],
  'pillar 2 — fleet monitoring': [
    'discoverTranscripts',
    'parseTranscript',
    'scoreTranscript',
    'scoreTranscripts',
    'scoreHistory',
    'detectTrends',
    'detectTrendsFromDisk',
    'buildScorecard',
    'validateTranscript',
  ],
  'pillar 3 — deterministic trace analysis (report, not a gate)': [
    'triageBuilt',
    'triageSessions',
    'triageOne',
    'renderTriageTable',
    'createGuard',
  ],
  // Section F (agent-eval's unfrozen pillar) — harness×model selection, Tier 1+2
  // only. Slice 4 is the capstone that ranks a controlled sweep; pin its public
  // entry points so the selection answer stays a first-class, callable surface.
  'section F — selection ranking (slice 4)': [
    'rankSelection',
    'toSelectionRun',
    'parseSelectionKey',
  ],
} as const;

/**
 * Names that were intentionally removed and must NOT come back.
 * - resolveProvider / extractTranscriptReferences: dead exports (never called
 *   anywhere) removed during a scope-reduction sweep.
 * - the chain.* family: the out-of-scope "fourth offering" prompt-chain runner,
 *   removed wholesale. Re-adding any of it is a scope regression.
 * - LocalProvider + the CI-quality-gate / action layer: removed in the reframe
 *   to a post-hoc, report-only tool. There is no gate; the loop is closed by a
 *   human feeding fixes back to the agent. Re-adding any of these is a scope
 *   regression against that thesis.
 */
const REMOVED_NAMES = [
  'resolveProvider',
  'extractTranscriptReferences',
  'runChain',
  'defineChain',
  'chainBuilder',
  'summarizeChain',
  'StepBuilder',
  'previousOutput',
  'extractChainJson',
  'extractSection',
  'extractList',
  // Removed provider primitive (replay-a-frozen-string): a false-free crutch.
  'LocalProvider',
  // Removed CI-quality-gate / action layer (pass/fail verdicts that blocked a
  // merge). The tool reports; it does not gate.
  'evaluateForAction',
  'toActionOutputs',
  'renderActionSummary',
  'runActionEval',
  'emitActionResult',
  'runAndEmit',
  'createEnvWriter',
  'createMemoryWriter',
  'scoreCiRun',
  'evaluateCiRun',
  'analyzeActionability',
  'analyzeCiStaleness',
  'analyzeTaskGrounding',
  'parseCcaExecutionLog',
  'extractCcaRun',
  'extractCcaRunFromFile',
] as const;

describe('public API surface (src/index.ts)', () => {
  describe('pillar entry points are exported and callable', () => {
    for (const [group, names] of Object.entries(PILLAR_FUNCTIONS)) {
      describe(group, () => {
        for (const name of names) {
          it(`exports ${name} as a function`, () => {
            expect(name in api, `${name} should be exported from the public barrel`).toBe(true);
            expect(
              typeof (api as Record<string, unknown>)[name],
              `${name} should be a function`,
            ).toBe('function');
          });
        }
      });
    }
  });

  describe('removed names do not leak back into the public surface', () => {
    for (const name of REMOVED_NAMES) {
      it(`does not export ${name}`, () => {
        expect(
          name in api,
          `${name} was intentionally removed and must not be re-exported`,
        ).toBe(false);
      });
    }

    it('exposes no export whose name contains "chain" (scope guard)', () => {
      const chainish = Object.keys(api).filter((k) => /chain/i.test(k));
      expect(chainish, `unexpected chain-related exports: ${chainish.join(', ')}`).toEqual([]);
    });
  });

  describe('barrel is intentional, not a wildcard re-export', () => {
    it('still exposes the monitoring reference extractor only under its plain name', () => {
      // checks/paths `extractReferences` stays public; the dead monitoring alias
      // `extractTranscriptReferences` is gone (covered above). Guard the survivor.
      expect(typeof (api as Record<string, unknown>).extractReferences).toBe('function');
    });

    it('exports a stable, bounded set of runtime values', () => {
      // A coarse drift sensor: if this number jumps unexpectedly, someone widened
      // the public surface without intent. Update deliberately when adding API.
      const runtimeValueCount = Object.keys(api).length;
      expect(runtimeValueCount).toBeGreaterThan(150);
      expect(runtimeValueCount).toBeLessThan(260);
    });
  });

  describe('README code snippets import only real exports (docs cannot rot)', () => {
    const barrel = parseBarrelExports();
    const readmeImports = parseReadmeAgentEvalImports();

    it('finds agent-eval imports to check in the README', () => {
      // Guards the guard: if the extractor silently matches nothing (README
      // reformatted, fenced blocks changed), fail loudly instead of passing
      // vacuously.
      expect(readmeImports.length).toBeGreaterThan(10);
    });

    for (const name of parseReadmeAgentEvalImports()) {
      it(`README imports \`${name}\` which the barrel exports`, () => {
        expect(
          barrel.has(name),
          `README.md imports "${name}" from 'agent-eval', but src/index.ts does not export it. ` +
            `Fix the docs or restore the export.`,
        ).toBe(true);
      });
    }
  });
});
