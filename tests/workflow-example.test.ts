/**
 * Verification test for the human-facing example workflow
 * `examples/workflows/pr-review-with-eval.yml`.
 *
 * The workflow is documentation, but documentation that names a real entry point
 * (`examples/cca-execution-eval.ts`), the env vars that entry point reads, and
 * the GitHub Action outputs the eval emits. If any of those drift, the example
 * silently lies. These checks pin the workflow to the *actual* code so a rename
 * or an output-key change breaks the build instead of the copy-paste.
 *
 * It is deliberately dependency-free: no YAML parser is added (the framework
 * keeps zero runtime deps). The assertions are raw-text/structural — enough to
 * catch drift and gross malformation without pulling in a parser.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { toActionOutputs, type ActionEvaluation } from '../src/action/adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowPath = resolve(repoRoot, 'examples/workflows/pr-review-with-eval.yml');
const entryPointRel = 'examples/cca-execution-eval.ts';

function readWorkflow(): string {
  return readFileSync(workflowPath, 'utf8');
}

/** Every `eval_*` token the workflow references, deduped. */
function referencedEvalOutputs(text: string): string[] {
  const matches = text.match(/eval_[a-z_]+/g) ?? [];
  return [...new Set(matches)];
}

/** The canonical output keys, derived from the real emitter so it self-updates. */
function canonicalOutputKeys(): string[] {
  const evaluation: ActionEvaluation = {
    passed: false,
    exitCode: 1,
    score: 0.42,
    gate: 'watch',
    verdicts: [],
    evidence: [{ worker: 'w', severity: 'critical', message: 'why' }],
    failingWorkers: 1,
    evaluatedWorkers: 1,
    headline: 'FAIL — 1/1 workers below watch',
  };
  return Object.keys(toActionOutputs(evaluation));
}

describe('examples/workflows/pr-review-with-eval.yml', () => {
  it('exists and is non-trivial', () => {
    expect(existsSync(workflowPath)).toBe(true);
    expect(readWorkflow().length).toBeGreaterThan(500);
  });

  it('has the expected top-level workflow structure', () => {
    const text = readWorkflow();
    // Top-level keys appear at column 0 (no leading whitespace).
    expect(text).toMatch(/^name:\s*\S/m);
    expect(text).toMatch(/^on:\s*$/m);
    expect(text).toMatch(/^permissions:\s*$/m);
    expect(text).toMatch(/^jobs:\s*$/m);
    // Triggered on pull_request (a PR-review gate).
    expect(text).toMatch(/^\s+pull_request:/m);
  });

  it('runs the real claude-code-action and the real eval entry point', () => {
    const text = readWorkflow();
    // Mode A composes with the *published* action.
    expect(text).toContain('anthropics/claude-code-action@v1');
    // The eval step invokes the actual runnable example in this repo.
    expect(text).toContain(`npx tsx ${entryPointRel}`);
    expect(existsSync(resolve(repoRoot, entryPointRel))).toBe(true);
  });

  it('wires the entry point with the env vars it reads', () => {
    const text = readWorkflow();
    // cca-execution-eval.ts reads EXECUTION_FILE (required), AGENT_PROMPT, and
    // AGENT_EVAL_GATE. The execution file must come from the action's output.
    expect(text).toContain('EXECUTION_FILE:');
    expect(text).toContain('execution_file'); // the claude-code-action output
    expect(text).toContain('AGENT_PROMPT:');
    expect(text).toContain('AGENT_EVAL_GATE:');
  });

  it('cross-checks the env var names against the entry point source', () => {
    const text = readWorkflow();
    const entrySrc = readFileSync(resolve(repoRoot, entryPointRel), 'utf8');
    // Each env var the workflow sets for the eval step must actually be consumed
    // by the entry point (process.env.<NAME>); otherwise the wiring is dead.
    for (const name of ['EXECUTION_FILE', 'AGENT_PROMPT', 'AGENT_EVAL_GATE', 'AGENT_EVAL_WORKER']) {
      if (text.includes(`${name}:`)) {
        expect(entrySrc).toContain(`process.env.${name}`);
      }
    }
  });

  it('only references real GitHub Action outputs (no drift / typos)', () => {
    const referenced = referencedEvalOutputs(readWorkflow());
    const canonical = new Set(canonicalOutputKeys());
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(canonical.has(key), `workflow references unknown output "${key}"`).toBe(true);
    }
    // The gate itself branches on eval_passed; that one must be present.
    expect(referenced).toContain('eval_passed');
  });

  it('evaluates blank/failed runs too (always() guard) and gates on a downstream step', () => {
    const text = readWorkflow();
    // `always()` so an abandoned/blank run is still evaluated — the case a crash
    // check (exit 0) misses.
    expect(text).toContain('always()');
    // It guards on the execution file being present before running the eval.
    expect(text).toMatch(/execution_file\s*!=\s*''/);
    // A downstream step branches on the eval verdict without re-running it.
    expect(text).toMatch(/outputs\.eval_passed\s*==\s*'false'/);
  });
});
