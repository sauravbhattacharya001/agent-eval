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
import * as api from '../src/index.js';

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
});
