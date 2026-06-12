/**
 * Chain Builder — Fluent API for defining multi-step prompt chains.
 *
 * Provides ergonomic chain construction without manual object assembly.
 *
 * @example
 * ```ts
 * import { defineChain, step } from 'agent-eval';
 *
 * const chain = defineChain({
 *   name: 'multi-turn conversation',
 *   input: 'Explain quantum computing',
 *   provider: myProvider,
 *   steps: [
 *     step('explain')
 *       .prompt('Explain quantum computing in simple terms')
 *       .assert(toBeNonEmpty(), toHaveMinLength(100))
 *       .build(),
 *     step('follow-up')
 *       .prompt((ctx) => `Now explain this part in more detail: "${ctx.outputs[0]?.slice(0, 100)}"`)
 *       .assert(toBeNonEmpty())
 *       .build(),
 *     step('verify')
 *       .prompt((ctx) => `Does this explanation contain errors? "${ctx.namedOutputs['follow-up']}"`)
 *       .assert(toContain('no'))
 *       .optional()
 *       .build(),
 *   ],
 * });
 * ```
 *
 * @module
 */

import type { Assertion, EvalProvider, ProviderOptions } from '../core/types.js';
import type { TieredAssertion } from '../core/tiered-runner.js';
import type {
  BranchTarget,
  ChainDefinition,
  ChainStep,
  GateFunction,
  OutputTransformer,
  PromptBuilder,
} from './types.js';

// ─── STEP BUILDER ───────────────────────────────────────────────────────────────

/**
 * Fluent step builder. Create with `step(name)`.
 *
 * @example
 * ```ts
 * step('generate')
 *   .prompt('Write a haiku about testing')
 *   .assert(toHaveMinLength(10), toContain('\n'))
 *   .gate((output) => output.split('\n').length >= 3)
 *   .retry(2, 1000)
 *   .build()
 * ```
 */
export class StepBuilder {
  private _name: string;
  private _prompt: string | PromptBuilder = '';
  private _assertions: Array<Assertion | TieredAssertion> = [];
  private _transform?: OutputTransformer;
  private _when?: GateFunction;
  private _gate?: GateFunction;
  private _branches: BranchTarget[] = [];
  private _provider?: EvalProvider;
  private _providerOptions?: ProviderOptions;
  private _timeoutMs?: number;
  private _outputKey?: string;
  private _retries = 0;
  private _retryDelayMs = 0;
  private _optional = false;

  constructor(name: string) {
    this._name = name;
  }

  /** Set the prompt (static string or dynamic builder). */
  prompt(promptOrBuilder: string | PromptBuilder): this {
    this._prompt = promptOrBuilder;
    return this;
  }

  /** Add assertions for this step. */
  assert(...assertions: Array<Assertion | TieredAssertion>): this {
    this._assertions.push(...assertions);
    return this;
  }

  /** Transform output before assertions run. */
  transform(fn: OutputTransformer): this {
    this._transform = fn;
    return this;
  }

  /** Pre-execution gate: skip step if condition returns false. */
  when(fn: GateFunction): this {
    this._when = fn;
    return this;
  }

  /** Post-output gate: abort chain if condition returns false. */
  gate(fn: GateFunction): this {
    this._gate = fn;
    return this;
  }

  /** Add a conditional branch. First matching branch wins. */
  branch(condition: BranchTarget['condition'], target: string | number): this {
    this._branches.push({ condition, target });
    return this;
  }

  /** Override the provider for this step. */
  useProvider(provider: EvalProvider, options?: ProviderOptions): this {
    this._provider = provider;
    this._providerOptions = options;
    return this;
  }

  /** Set timeout for this step. */
  timeout(ms: number): this {
    this._timeoutMs = ms;
    return this;
  }

  /** Set the output key for named access in context. */
  outputAs(key: string): this {
    this._outputKey = key;
    return this;
  }

  /** Configure retries on assertion failure. */
  retry(count: number, delayMs = 0): this {
    this._retries = count;
    this._retryDelayMs = delayMs;
    return this;
  }

  /** Mark step as optional — failure won't abort the chain. */
  optional(): this {
    this._optional = true;
    return this;
  }

  /** Build the step definition. */
  build(): ChainStep {
    return {
      name: this._name,
      prompt: this._prompt,
      assertions: this._assertions.length > 0 ? this._assertions : undefined,
      transform: this._transform,
      when: this._when,
      gate: this._gate,
      branches: this._branches.length > 0 ? this._branches : undefined,
      provider: this._provider,
      providerOptions: this._providerOptions,
      timeoutMs: this._timeoutMs,
      outputKey: this._outputKey,
      retries: this._retries,
      retryDelayMs: this._retryDelayMs,
      optional: this._optional,
    };
  }
}

/**
 * Create a step builder. Sugar for `new StepBuilder(name)`.
 *
 * @example
 * ```ts
 * const myStep = step('summarize')
 *   .prompt((ctx) => `Summarize: ${ctx.outputs[0]}`)
 *   .assert(toBeNonEmpty())
 *   .build();
 * ```
 */
export function step(name: string): StepBuilder {
  return new StepBuilder(name);
}

// ─── CHAIN BUILDER ──────────────────────────────────────────────────────────────

/**
 * Fluent chain builder.
 *
 * @example
 * ```ts
 * const chain = chainBuilder('code-review')
 *   .input('Review this PR for security issues')
 *   .provider(myProvider)
 *   .step(step('review').prompt('Review: ...').assert(...).build())
 *   .step(step('verify').prompt((ctx) => ...).assert(...).build())
 *   .bail(true)
 *   .build();
 * ```
 */
export class ChainBuilder {
  private _name: string;
  private _description?: string;
  private _input = '';
  private _provider?: EvalProvider;
  private _providerOptions?: ProviderOptions;
  private _steps: ChainStep[] = [];
  private _setup?: ChainDefinition['setup'];
  private _teardown?: ChainDefinition['teardown'];
  private _tieredOptions?: ChainDefinition['tieredOptions'];
  private _maxDurationMs?: number;
  private _bail = true;

  constructor(name: string) {
    this._name = name;
  }

  /** Set chain description. */
  describe(description: string): this {
    this._description = description;
    return this;
  }

  /** Set chain input/task. */
  input(input: string): this {
    this._input = input;
    return this;
  }

  /** Set default provider. */
  provider(provider: EvalProvider, options?: ProviderOptions): this {
    this._provider = provider;
    this._providerOptions = options;
    return this;
  }

  /** Add a step. */
  step(stepDef: ChainStep): this {
    this._steps.push(stepDef);
    return this;
  }

  /** Add multiple steps. */
  steps(...stepDefs: ChainStep[]): this {
    this._steps.push(...stepDefs);
    return this;
  }

  /** Set setup function. */
  setup(fn: NonNullable<ChainDefinition['setup']>): this {
    this._setup = fn;
    return this;
  }

  /** Set teardown function. */
  teardown(fn: NonNullable<ChainDefinition['teardown']>): this {
    this._teardown = fn;
    return this;
  }

  /** Set tiered runner options for assertions. */
  tieredOptions(opts: NonNullable<ChainDefinition['tieredOptions']>): this {
    this._tieredOptions = opts;
    return this;
  }

  /** Set max chain duration. */
  maxDuration(ms: number): this {
    this._maxDurationMs = ms;
    return this;
  }

  /** Set bail behavior. */
  bail(bail: boolean): this {
    this._bail = bail;
    return this;
  }

  /** Build the chain definition. */
  build(): ChainDefinition {
    return {
      name: this._name,
      description: this._description,
      input: this._input,
      provider: this._provider,
      providerOptions: this._providerOptions,
      steps: this._steps,
      setup: this._setup,
      teardown: this._teardown,
      tieredOptions: this._tieredOptions,
      maxDurationMs: this._maxDurationMs,
      bail: this._bail,
    };
  }
}

/**
 * Create a chain builder. Sugar for `new ChainBuilder(name)`.
 */
export function chainBuilder(name: string): ChainBuilder {
  return new ChainBuilder(name);
}

/**
 * Define a chain directly from an object literal.
 * This is the simplest API — just pass the definition.
 *
 * @example
 * ```ts
 * const chain = defineChain({
 *   name: 'simple-qa',
 *   input: 'Test basic QA',
 *   provider: localProvider,
 *   steps: [
 *     { name: 'ask', prompt: 'What is 2+2?', assertions: [toContain('4')] },
 *     { name: 'follow-up', prompt: (ctx) => `Why is "${ctx.outputs[0]}" correct?`, assertions: [toBeNonEmpty()] },
 *   ],
 * });
 * ```
 */
export function defineChain(definition: ChainDefinition): ChainDefinition {
  return definition;
}
