/**
 * Chain Runner Tests — Multi-step prompt sequences with per-step assertions.
 */

import { describe, it, expect, vi } from 'vitest';
import { runChain } from '../src/chain/runner.js';
import { step, chainBuilder, defineChain } from '../src/chain/builder.js';
import {
  previousOutput,
  namedOutput,
  namedOutputOr,
  outputAt,
  allOutputs,
  template,
  followUp,
  refine,
  validate,
  summarizeChain,
  setMeta,
  getMeta,
  incrementMeta,
  extractJson,
  extractSection,
  extractList,
} from '../src/chain/context.js';
import { toContain, toHaveMinLength, toBeValidJson, custom } from '../src/core/assertions.js';
import { tier1, tier2 } from '../src/core/tiered-runner.js';
import type { EvalProvider } from '../src/core/types.js';
import type { ChainContext } from '../src/chain/types.js';

// ─── TEST HELPERS ───────────────────────────────────────────────────────────────

function mockProvider(responses: string[]): EvalProvider {
  let callIndex = 0;
  return {
    name: 'mock',
    generate: vi.fn(async () => {
      const response = responses[callIndex] ?? `response-${callIndex}`;
      callIndex++;
      return response;
    }),
  };
}

function sequenceProvider(responseFn: (prompt: string, index: number) => string): EvalProvider {
  let callIndex = 0;
  return {
    name: 'sequence',
    generate: vi.fn(async (prompt: string) => {
      const response = responseFn(prompt, callIndex);
      callIndex++;
      return response;
    }),
  };
}

function delayProvider(responses: string[], delayMs: number): EvalProvider {
  let callIndex = 0;
  return {
    name: 'delayed',
    generate: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      const response = responses[callIndex] ?? `delayed-${callIndex}`;
      callIndex++;
      return response;
    }),
  };
}

// ─── BASIC CHAIN EXECUTION ──────────────────────────────────────────────────────

describe('Chain Runner — Basic Execution', () => {
  it('runs a single-step chain', async () => {
    const provider = mockProvider(['Hello, world!']);
    const chain = defineChain({
      name: 'single-step',
      input: 'test input',
      provider,
      steps: [{ name: 'greet', prompt: 'Say hello', assertions: [toContain('Hello')] }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe('pass');
    expect(result.steps[0]!.output).toBe('Hello, world!');
    expect(result.stepsExecuted).toBe(1);
    expect(result.stepsPassed).toBe(1);
    expect(result.stepsFailed).toBe(0);
  });

  it('runs a multi-step chain', async () => {
    const provider = mockProvider(['Step 1 output', 'Step 2 output', 'Step 3 output']);
    const chain = defineChain({
      name: 'multi-step',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'First prompt' },
        { name: 'second', prompt: 'Second prompt' },
        { name: 'third', prompt: 'Third prompt' },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.stepsExecuted).toBe(3);
    expect(result.context.outputs).toEqual(['Step 1 output', 'Step 2 output', 'Step 3 output']);
  });

  it('passes context between steps (dynamic prompt)', async () => {
    const provider = sequenceProvider((prompt) => `echo: ${prompt}`);
    const chain = defineChain({
      name: 'context-passing',
      input: 'initial task',
      provider,
      steps: [
        { name: 'first', prompt: 'Start here' },
        {
          name: 'second',
          prompt: (ctx) => `Follow up on: ${ctx.outputs[0]}`,
        },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[1]!.prompt).toBe('Follow up on: echo: Start here');
  });

  it('stores named outputs', async () => {
    const provider = mockProvider(['output-A', 'output-B']);
    const chain = defineChain({
      name: 'named-outputs',
      input: 'test',
      provider,
      steps: [
        { name: 'alpha', prompt: 'A', outputKey: 'my-key' },
        { name: 'beta', prompt: 'B' },
      ],
    });

    const result = await runChain(chain);
    expect(result.context.namedOutputs['my-key']).toBe('output-A');
    expect(result.context.namedOutputs['beta']).toBe('output-B');
  });

  it('provides chain input in context', async () => {
    let capturedInput = '';
    const provider = mockProvider(['done']);
    const chain = defineChain({
      name: 'input-access',
      input: 'my specific task',
      provider,
      steps: [
        {
          name: 'check',
          prompt: (ctx) => {
            capturedInput = ctx.input;
            return 'do something';
          },
        },
      ],
    });

    await runChain(chain);
    expect(capturedInput).toBe('my specific task');
  });
});

// ─── ASSERTIONS (TIERED) ────────────────────────────────────────────────────────

describe('Chain Runner — Tiered Assertions', () => {
  it('passes when all assertions pass', async () => {
    const provider = mockProvider(['Hello world, this is a long enough response']);
    const chain = defineChain({
      name: 'assertions-pass',
      input: 'test',
      provider,
      steps: [{
        name: 'check',
        prompt: 'Generate',
        assertions: [toContain('Hello'), toHaveMinLength(10)],
      }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[0]!.tieredResult).not.toBeNull();
    expect(result.steps[0]!.tieredResult!.passed).toBe(true);
  });

  it('fails when an assertion fails', async () => {
    const provider = mockProvider(['short']);
    const chain = defineChain({
      name: 'assertions-fail',
      input: 'test',
      provider,
      steps: [{
        name: 'check',
        prompt: 'Generate',
        assertions: [toHaveMinLength(100)],
      }],
      bail: false,
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[0]!.tieredResult!.passed).toBe(false);
  });

  it('supports explicit tier markers', async () => {
    const provider = mockProvider(['{"valid": true}']);
    const chain = defineChain({
      name: 'tiered',
      input: 'test',
      provider,
      steps: [{
        name: 'check',
        prompt: 'Generate JSON',
        assertions: [
          tier1(toBeValidJson()),
          tier1(toContain('valid')),
        ],
      }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[0]!.tieredResult!.tiers.tier1.ran).toBe(true);
  });

  it('short-circuits tiers (tier 1 fails, tier 2 skipped)', async () => {
    const provider = mockProvider(['not json at all']);
    const tier2Assertion = custom('[Tier 2] relevance check', () => ({
      status: 'pass', name: '[Tier 2] relevance check', message: '', durationMs: 0,
    }));

    const chain = defineChain({
      name: 'short-circuit',
      input: 'test',
      provider,
      steps: [{
        name: 'check',
        prompt: 'Generate',
        assertions: [
          tier1(toBeValidJson()),
          tier2(tier2Assertion),
        ],
      }],
      bail: false,
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    const tiered = result.steps[0]!.tieredResult!;
    expect(tiered.tiers.tier1.failed).toBeGreaterThan(0);
    expect(tiered.tiers.tier2.ran).toBe(false);
  });
});

// ─── BAIL BEHAVIOR ──────────────────────────────────────────────────────────────

describe('Chain Runner — Bail', () => {
  it('bails by default on step failure', async () => {
    const provider = mockProvider(['bad', 'never reached']);
    const chain = defineChain({
      name: 'bail-default',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A', assertions: [toContain('MISSING')] },
        { name: 'second', prompt: 'B' },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[1]!.status).toBe('skipped');
    expect(result.stepsSkipped).toBe(1);
  });

  it('continues when bail=false', async () => {
    const provider = mockProvider(['bad', 'good stuff']);
    const chain = defineChain({
      name: 'no-bail',
      input: 'test',
      provider,
      bail: false,
      steps: [
        { name: 'first', prompt: 'A', assertions: [toContain('MISSING')] },
        { name: 'second', prompt: 'B', assertions: [toContain('good')] },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[1]!.status).toBe('pass');
    expect(result.stepsFailed).toBe(1);
    expect(result.stepsPassed).toBe(1);
  });

  it('does not bail on optional step failure', async () => {
    const provider = mockProvider(['bad', 'good output']);
    const chain = defineChain({
      name: 'optional-step',
      input: 'test',
      provider,
      steps: [
        { name: 'optional', prompt: 'A', assertions: [toContain('MISSING')], optional: true },
        { name: 'required', prompt: 'B', assertions: [toContain('good')] },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.steps[1]!.status).toBe('pass');
  });
});

// ─── GATES ──────────────────────────────────────────────────────────────────────

describe('Chain Runner — Gates', () => {
  it('skips step when `when` gate returns false', async () => {
    const provider = mockProvider(['first output', 'third output']);
    const chain = defineChain({
      name: 'when-gate',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A' },
        { name: 'skipped', prompt: 'B', when: () => false },
        { name: 'third', prompt: 'C' },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[1]!.status).toBe('skipped');
    expect(result.stepsSkipped).toBe(1);
    expect(result.stepsExecuted).toBe(2);
  });

  it('`when` gate receives previous output and context', async () => {
    const provider = mockProvider(['SKIP_NEXT', 'should not run']);
    let gateOutput = '';
    const chain = defineChain({
      name: 'when-context',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A' },
        {
          name: 'conditional',
          prompt: 'B',
          when: (output, ctx) => {
            gateOutput = output;
            return !ctx.outputs[0]?.includes('SKIP');
          },
        },
      ],
    });

    const result = await runChain(chain);
    expect(result.steps[1]!.status).toBe('skipped');
    expect(gateOutput).toBe('SKIP_NEXT');
  });

  it('aborts chain when `gate` returns false', async () => {
    const provider = mockProvider(['bad output', 'never reached']);
    const chain = defineChain({
      name: 'post-gate',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A', gate: (output) => output.includes('good') },
        { name: 'second', prompt: 'B' },
      ],
    });

    const result = await runChain(chain);
    expect(result.steps[0]!.status).toBe('gated');
    expect(result.aborted).toBe(true);
    expect(result.steps[1]!.status).toBe('skipped');
  });
});

// ─── BRANCHING ──────────────────────────────────────────────────────────────────

describe('Chain Runner — Branching', () => {
  it('branches to named step when condition matches', async () => {
    const provider = mockProvider(['go-to-C', 'at-C']);
    const chain = defineChain({
      name: 'branching',
      input: 'test',
      provider,
      steps: [
        {
          name: 'decide',
          prompt: 'A',
          branches: [
            { condition: (output) => output.includes('go-to-C'), target: 'target-c' },
          ],
        },
        { name: 'skipped-b', prompt: 'B' },
        { name: 'target-c', prompt: 'C' },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[0]!.branchTarget).toBe('target-c');
    expect(result.steps).toHaveLength(2);
  });

  it('branches to index', async () => {
    const provider = mockProvider(['jump', 'at-index-2']);
    const chain = defineChain({
      name: 'branch-index',
      input: 'test',
      provider,
      steps: [
        {
          name: 'decide',
          prompt: 'A',
          branches: [{ condition: () => true, target: 2 }],
        },
        { name: 'skipped', prompt: 'B' },
        { name: 'target', prompt: 'C' },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(2);
  });

  it('proceeds normally when no branch matches', async () => {
    const provider = mockProvider(['no match', 'sequential']);
    const chain = defineChain({
      name: 'no-branch',
      input: 'test',
      provider,
      steps: [
        {
          name: 'first',
          prompt: 'A',
          branches: [{ condition: () => false, target: 'nowhere' }],
        },
        { name: 'second', prompt: 'B' },
      ],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.branchTarget).toBeUndefined();
  });
});

// ─── RETRIES ────────────────────────────────────────────────────────────────────

describe('Chain Runner — Retries', () => {
  it('retries on assertion failure and eventually passes', async () => {
    let callCount = 0;
    const provider: EvalProvider = {
      name: 'retry-mock',
      generate: vi.fn(async () => {
        callCount++;
        return callCount >= 2 ? 'SUCCESS found' : 'failure';
      }),
    };

    const chain = defineChain({
      name: 'retry-pass',
      input: 'test',
      provider,
      steps: [{
        name: 'retried',
        prompt: 'Try',
        assertions: [toContain('SUCCESS')],
        retries: 3,
      }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[0]!.status).toBe('retried');
    expect(result.steps[0]!.retriesAttempted).toBe(1);
  });

  it('exhausts retries and fails', async () => {
    const provider = mockProvider(['bad', 'bad', 'bad', 'bad']);
    const chain = defineChain({
      name: 'retry-fail',
      input: 'test',
      provider,
      bail: false,
      steps: [{
        name: 'always-fails',
        prompt: 'Try',
        assertions: [toContain('NEVER')],
        retries: 2,
      }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[0]!.retriesAttempted).toBe(2);
  });
});

// ─── OUTPUT TRANSFORM ───────────────────────────────────────────────────────────

describe('Chain Runner — Output Transform', () => {
  it('transforms output before assertions', async () => {
    const provider = mockProvider(['```json\n{"key": "value"}\n```']);
    const chain = defineChain({
      name: 'transform',
      input: 'test',
      provider,
      steps: [{
        name: 'extract-json',
        prompt: 'Generate JSON',
        transform: (output) => {
          const match = output.match(/```json\n([\s\S]*?)\n```/);
          return match ? match[1]! : output;
        },
        assertions: [toBeValidJson()],
      }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(true);
    expect(result.steps[0]!.transformedOutput).toBe('{"key": "value"}');
  });
});

// ─── PROVIDER OVERRIDE ──────────────────────────────────────────────────────────

describe('Chain Runner — Provider Override', () => {
  it('uses step-level provider when specified', async () => {
    const defaultProvider = mockProvider(['default output']);
    const stepProvider = mockProvider(['step output']);

    const chain = defineChain({
      name: 'provider-override',
      input: 'test',
      provider: defaultProvider,
      steps: [
        { name: 'uses-default', prompt: 'A' },
        { name: 'uses-override', prompt: 'B', provider: stepProvider },
      ],
    });

    const result = await runChain(chain);
    expect(result.context.outputs[0]).toBe('default output');
    expect(result.context.outputs[1]).toBe('step output');
  });

  it('errors when no provider is configured', async () => {
    const chain = defineChain({
      name: 'no-provider',
      input: 'test',
      steps: [{ name: 'broken', prompt: 'A' }],
      bail: false,
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.steps[0]!.status).toBe('error');
    expect(result.steps[0]!.error).toContain('No provider configured');
  });
});

// ─── TIMEOUT ────────────────────────────────────────────────────────────────────

describe('Chain Runner — Timeout', () => {
  it('times out a step', async () => {
    const provider = delayProvider(['slow response'], 500);
    const chain = defineChain({
      name: 'step-timeout',
      input: 'test',
      provider,
      bail: false,
      steps: [{
        name: 'slow',
        prompt: 'A',
        timeoutMs: 50,
      }],
    });

    const result = await runChain(chain);
    expect(result.passed).toBe(false);
    expect(result.steps[0]!.status).toBe('timeout');
  });

  it('times out entire chain', async () => {
    const provider = delayProvider(['a', 'b', 'c'], 100);
    const chain = defineChain({
      name: 'chain-timeout',
      input: 'test',
      provider,
      maxDurationMs: 150,
      steps: [
        { name: 'first', prompt: 'A' },
        { name: 'second', prompt: 'B' },
        { name: 'third', prompt: 'C' },
      ],
    });

    const result = await runChain(chain);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toContain('timeout');
  });
});

// ─── SETUP & TEARDOWN ───────────────────────────────────────────────────────────

describe('Chain Runner — Setup & Teardown', () => {
  it('runs setup before steps', async () => {
    const order: string[] = [];
    const provider = mockProvider(['output']);

    const chain = defineChain({
      name: 'setup-test',
      input: 'test',
      provider,
      setup: async (ctx) => {
        order.push('setup');
        ctx.metadata['initialized'] = true;
      },
      steps: [{
        name: 'check',
        prompt: (ctx) => {
          order.push('step');
          return ctx.metadata['initialized'] ? 'yes' : 'no';
        },
      }],
    });

    await runChain(chain);
    expect(order).toEqual(['setup', 'step']);
  });

  it('runs teardown after steps', async () => {
    let teardownRan = false;
    const provider = mockProvider(['output']);

    const chain = defineChain({
      name: 'teardown-test',
      input: 'test',
      provider,
      teardown: async () => {
        teardownRan = true;
      },
      steps: [{ name: 'step', prompt: 'A' }],
    });

    await runChain(chain);
    expect(teardownRan).toBe(true);
  });

  it('runs teardown even on abort', async () => {
    let teardownRan = false;
    const provider = mockProvider(['bad']);

    const chain = defineChain({
      name: 'teardown-on-abort',
      input: 'test',
      provider,
      teardown: async () => {
        teardownRan = true;
      },
      steps: [{ name: 'fail', prompt: 'A', assertions: [toContain('NEVER')] }],
    });

    await runChain(chain);
    expect(teardownRan).toBe(true);
  });
});

// ─── HOOKS ──────────────────────────────────────────────────────────────────────

describe('Chain Runner — Hooks', () => {
  it('calls beforeStep hook', async () => {
    const provider = mockProvider(['a', 'b']);
    const beforeSteps: string[] = [];

    const chain = defineChain({
      name: 'before-hook',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A' },
        { name: 'second', prompt: 'B' },
      ],
    });

    await runChain(chain, {
      beforeStep: (s) => {
        beforeSteps.push(s.name);
        return true;
      },
    });

    expect(beforeSteps).toEqual(['first', 'second']);
  });

  it('skips step when beforeStep returns false', async () => {
    const provider = mockProvider(['a', 'b']);

    const chain = defineChain({
      name: 'before-skip',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A' },
        { name: 'skip-me', prompt: 'B' },
      ],
    });

    const result = await runChain(chain, {
      beforeStep: (s) => s.name !== 'skip-me',
    });

    expect(result.steps[1]!.status).toBe('skipped');
  });

  it('calls afterStep hook', async () => {
    const provider = mockProvider(['output1', 'output2']);
    const afterOutputs: string[] = [];

    const chain = defineChain({
      name: 'after-hook',
      input: 'test',
      provider,
      steps: [
        { name: 'first', prompt: 'A' },
        { name: 'second', prompt: 'B' },
      ],
    });

    await runChain(chain, {
      afterStep: (result) => {
        if (result.output) afterOutputs.push(result.output);
      },
    });

    expect(afterOutputs).toEqual(['output1', 'output2']);
  });
});

// ─── STEP BUILDER (FLUENT API) ──────────────────────────────────────────────────

describe('StepBuilder', () => {
  it('builds a basic step', () => {
    const s = step('my-step')
      .prompt('Hello')
      .assert(toContain('world'))
      .build();

    expect(s.name).toBe('my-step');
    expect(s.prompt).toBe('Hello');
    expect(s.assertions).toHaveLength(1);
  });

  it('supports all builder methods', () => {
    const provider = mockProvider([]);
    const s = step('full')
      .prompt((ctx) => ctx.input)
      .assert(toContain('x'), toHaveMinLength(5))
      .transform((o) => o.trim())
      .when(() => true)
      .gate((o) => o.length > 0)
      .branch(() => true, 'other')
      .useProvider(provider)
      .timeout(5000)
      .outputAs('custom-key')
      .retry(3, 1000)
      .optional()
      .build();

    expect(s.name).toBe('full');
    expect(s.assertions).toHaveLength(2);
    expect(s.transform).toBeDefined();
    expect(s.when).toBeDefined();
    expect(s.gate).toBeDefined();
    expect(s.branches).toHaveLength(1);
    expect(s.provider).toBe(provider);
    expect(s.timeoutMs).toBe(5000);
    expect(s.outputKey).toBe('custom-key');
    expect(s.retries).toBe(3);
    expect(s.retryDelayMs).toBe(1000);
    expect(s.optional).toBe(true);
  });
});

// ─── CHAIN BUILDER (FLUENT API) ─────────────────────────────────────────────────

describe('ChainBuilder', () => {
  it('builds a chain definition', () => {
    const provider = mockProvider([]);
    const chain = chainBuilder('my-chain')
      .describe('A test chain')
      .input('initial prompt')
      .provider(provider)
      .step(step('s1').prompt('A').build())
      .step(step('s2').prompt('B').build())
      .bail(false)
      .maxDuration(60000)
      .build();

    expect(chain.name).toBe('my-chain');
    expect(chain.description).toBe('A test chain');
    expect(chain.input).toBe('initial prompt');
    expect(chain.provider).toBe(provider);
    expect(chain.steps).toHaveLength(2);
    expect(chain.bail).toBe(false);
    expect(chain.maxDurationMs).toBe(60000);
  });

  it('supports steps() for batch add', () => {
    const chain = chainBuilder('batch')
      .input('test')
      .steps(
        step('a').prompt('A').build(),
        step('b').prompt('B').build(),
        step('c').prompt('C').build(),
      )
      .build();

    expect(chain.steps).toHaveLength(3);
  });
});

// ─── CONTEXT UTILITIES ──────────────────────────────────────────────────────────

describe('Context Utilities', () => {
  const makeCtx = (overrides: Partial<ChainContext> = {}): ChainContext => ({
    outputs: ['first', 'second', 'third'],
    namedOutputs: { alpha: 'aaa', beta: 'bbb' },
    metadata: { count: 5, label: 'test' },
    input: 'initial task',
    stepIndex: 2,
    ...overrides,
  });

  describe('previousOutput', () => {
    it('returns last defined output', () => {
      expect(previousOutput(makeCtx())).toBe('third');
    });

    it('returns empty string when no outputs', () => {
      expect(previousOutput(makeCtx({ outputs: [] }))).toBe('');
    });
  });

  describe('namedOutput', () => {
    it('returns named output', () => {
      expect(namedOutput(makeCtx(), 'alpha')).toBe('aaa');
    });

    it('throws on missing key', () => {
      expect(() => namedOutput(makeCtx(), 'missing')).toThrow('no output named "missing"');
    });
  });

  describe('namedOutputOr', () => {
    it('returns named output when present', () => {
      expect(namedOutputOr(makeCtx(), 'alpha', 'default')).toBe('aaa');
    });

    it('returns fallback when missing', () => {
      expect(namedOutputOr(makeCtx(), 'missing', 'default')).toBe('default');
    });
  });

  describe('outputAt', () => {
    it('returns output at index', () => {
      expect(outputAt(makeCtx(), 1)).toBe('second');
    });

    it('throws on invalid index', () => {
      expect(() => outputAt(makeCtx(), 10)).toThrow('no output at index 10');
    });
  });

  describe('allOutputs', () => {
    it('returns all defined outputs', () => {
      expect(allOutputs(makeCtx())).toEqual(['first', 'second', 'third']);
    });
  });

  describe('template', () => {
    it('interpolates {{input}}', () => {
      const fn = template('Task: {{input}}');
      expect(fn(makeCtx())).toBe('Task: initial task');
    });

    it('interpolates {{prev}}', () => {
      const fn = template('Previous was: {{prev}}');
      expect(fn(makeCtx())).toBe('Previous was: third');
    });

    it('interpolates {{output.name}}', () => {
      const fn = template('Alpha: {{output.alpha}}');
      expect(fn(makeCtx())).toBe('Alpha: aaa');
    });

    it('interpolates {{output[0]}}', () => {
      const fn = template('First: {{output[0]}}');
      expect(fn(makeCtx())).toBe('First: first');
    });

    it('interpolates {{meta.key}}', () => {
      const fn = template('Count: {{meta.count}}');
      expect(fn(makeCtx())).toBe('Count: 5');
    });

    it('shows placeholder for missing values', () => {
      const fn = template('{{output.missing}}');
      expect(fn(makeCtx())).toBe('[missing: missing]');
    });
  });

  describe('followUp', () => {
    it('builds follow-up prompt', () => {
      const fn = followUp('Explain more');
      const result = fn(makeCtx());
      expect(result).toContain('third');
      expect(result).toContain('Explain more');
    });
  });

  describe('refine', () => {
    it('builds refinement prompt', () => {
      const fn = refine('Be more concise');
      const result = fn(makeCtx());
      expect(result).toContain('third');
      expect(result).toContain('Be more concise');
    });
  });

  describe('validate', () => {
    it('builds validation prompt', () => {
      const fn = validate('check for errors');
      const result = fn(makeCtx());
      expect(result).toContain('third');
      expect(result).toContain('check for errors');
    });
  });

  describe('summarizeChain', () => {
    it('builds summary prompt with all outputs', () => {
      const fn = summarizeChain('Summarize the conversation');
      const result = fn(makeCtx());
      expect(result).toContain('Summarize the conversation');
      expect(result).toContain('Step 1');
      expect(result).toContain('first');
      expect(result).toContain('third');
    });
  });

  describe('metadata helpers', () => {
    it('setMeta and getMeta', () => {
      const ctx = makeCtx();
      setMeta(ctx, 'newKey', 42);
      expect(getMeta<number>(ctx, 'newKey')).toBe(42);
    });

    it('incrementMeta', () => {
      const ctx = makeCtx();
      expect(incrementMeta(ctx, 'count')).toBe(6);
      expect(incrementMeta(ctx, 'count')).toBe(7);
      expect(incrementMeta(ctx, 'newCounter')).toBe(1);
    });
  });
});

// ─── EXTRACTION UTILITIES ───────────────────────────────────────────────────────

describe('Extraction Utilities', () => {
  describe('extractJson', () => {
    it('parses direct JSON', () => {
      expect(extractJson('{"key": "value"}')).toEqual({ key: 'value' });
    });

    it('extracts JSON from code fence', () => {
      const output = 'Here is the result:\n```json\n{"x": 1}\n```\nDone.';
      expect(extractJson(output)).toEqual({ x: 1 });
    });

    it('returns null for invalid JSON', () => {
      expect(extractJson('not json at all')).toBeNull();
    });
  });

  describe('extractSection', () => {
    it('extracts a markdown section', () => {
      const md = '# Title\n\n## Section A\nContent A\n\n## Section B\nContent B';
      expect(extractSection(md, 'Section A')).toBe('Content A');
    });

    it('returns null when section not found', () => {
      expect(extractSection('# Only heading', 'Missing')).toBeNull();
    });
  });

  describe('extractList', () => {
    it('extracts bullet list', () => {
      const output = 'Items:\n- Apple\n- Banana\n- Cherry';
      expect(extractList(output)).toEqual(['Apple', 'Banana', 'Cherry']);
    });

    it('extracts numbered list', () => {
      const output = '1. First\n2. Second\n3. Third';
      expect(extractList(output)).toEqual(['First', 'Second', 'Third']);
    });

    it('returns empty for no list', () => {
      expect(extractList('No list here')).toEqual([]);
    });
  });
});