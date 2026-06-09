/**
 * Chain Runner — Execute multi-step prompt chains with per-step tiered assertions.
 *
 * The chain runner orchestrates sequential or branching LLM interactions where:
 * 1. Each step's prompt can depend on previous outputs (via ChainContext)
 * 2. Each step's output is evaluated with tier-aware assertions (Tier 1 → 2 → 3)
 * 3. Steps can branch, gate, retry, or be optional
 * 4. The full execution trace is captured for debugging and reporting
 *
 * This combines the prompt chaining pattern with the eval philosophy:
 * catch failures at the cheapest tier, escalate only when needed.
 *
 * @module
 */

import type { EvalContext, EvalProvider } from '../core/types.js';
import { runTiered } from '../core/tiered-runner.js';
import type { TieredResult } from '../core/tiered-runner.js';
import type {
  ChainContext,
  ChainDefinition,
  ChainResult,
  ChainStep,
  ChainStepResult,
  ChainStepStatus,
} from './types.js';

// ─── CHAIN RUNNER OPTIONS ───────────────────────────────────────────────────────

/** Runtime options for the chain runner (overrides ChainDefinition defaults). */
export interface ChainRunnerOptions {
  /** Override bail behavior. */
  bail?: boolean;
  /** Override max duration. */
  maxDurationMs?: number;
  /** Override tiered runner options. */
  tieredOptions?: ChainDefinition['tieredOptions'];
  /** Hook called before each step. Return false to skip. */
  beforeStep?: (step: ChainStep, ctx: ChainContext) => boolean | Promise<boolean>;
  /** Hook called after each step. */
  afterStep?: (result: ChainStepResult, ctx: ChainContext) => void | Promise<void>;
  /** Custom metadata to inject into initial context. */
  metadata?: Record<string, unknown>;
}

// ─── CHAIN RUNNER ───────────────────────────────────────────────────────────────

/**
 * Run a chain definition and return the full result.
 *
 * @example
 * ```ts
 * import { runChain, defineChain, step } from 'agent-eval';
 *
 * const chain = defineChain({
 *   name: 'code-review-quality',
 *   input: 'Review this TypeScript PR for security issues',
 *   provider: myProvider,
 *   steps: [
 *     step('generate-review', 'Review this code:\n```ts\nconst x = eval(input);\n```')
 *       .assert(toBeNonEmpty(), toContain('eval'))
 *       .build(),
 *     step('verify-actionable', (ctx) => `Is this review actionable? "${ctx.outputs[0]}"`)
 *       .assert(toContain('yes'), toBeRelevantTo('actionability'))
 *       .build(),
 *   ],
 * });
 *
 * const result = await runChain(chain);
 * console.log(result.passed); // true if all steps passed
 * ```
 */
export async function runChain(
  definition: ChainDefinition,
  options: ChainRunnerOptions = {},
): Promise<ChainResult> {
  const startTime = performance.now();
  const bail = options.bail ?? definition.bail ?? true;
  const maxDurationMs = options.maxDurationMs ?? definition.maxDurationMs ?? 300_000;
  const tieredOptions = options.tieredOptions ?? definition.tieredOptions ?? {};

  // Initialize context
  const ctx: ChainContext = {
    outputs: [],
    namedOutputs: {},
    metadata: { ...(options.metadata ?? {}) },
    input: definition.input,
    stepIndex: 0,
  };

  // Run setup
  if (definition.setup) {
    await definition.setup(ctx);
  }

  const stepResults: ChainStepResult[] = [];
  let stepsExecuted = 0;
  let stepsPassed = 0;
  let stepsFailed = 0;
  let stepsSkipped = 0;
  let aborted = false;
  let abortReason: string | undefined;

  // Build step name-to-index map for branching
  const stepNameMap = new Map<string, number>();
  for (let i = 0; i < definition.steps.length; i++) {
    const s = definition.steps[i];
    if (s) stepNameMap.set(s.name, i);
  }

  // Execution pointer — supports branching
  let pointer = 0;
  const visited = new Set<number>();

  while (pointer < definition.steps.length) {
    // Timeout check
    const elapsed = performance.now() - startTime;
    if (elapsed > maxDurationMs) {
      aborted = true;
      abortReason = `Chain timeout after ${Math.round(elapsed)}ms (max: ${maxDurationMs}ms)`;
      // Mark remaining as skipped
      for (let i = pointer; i < definition.steps.length; i++) {
        const skippedStep = definition.steps[i];
        if (!visited.has(i) && skippedStep) {
          stepResults.push(makeSkippedResult(skippedStep, i, 'timeout'));
          stepsSkipped++;
        }
      }
      break;
    }

    const currentStep = definition.steps[pointer];
    if (!currentStep) break;
    ctx.stepIndex = pointer;
    visited.add(pointer);

    // Run the step
    const stepResult = await executeStep(
      currentStep,
      pointer,
      ctx,
      definition,
      tieredOptions,
      options,
      visited.size > pointer + 1, // wasBranched = visited something after us already
    );

    stepResults.push(stepResult);

    // Update context with output
    if (stepResult.output !== undefined) {
      ctx.outputs[pointer] = stepResult.output;
      const key = currentStep.outputKey ?? currentStep.name;
      ctx.namedOutputs[key] = stepResult.output;
    }

    // Update counters
    switch (stepResult.status) {
      case 'pass':
      case 'retried':
        stepsExecuted++;
        stepsPassed++;
        break;
      case 'fail':
      case 'error':
      case 'timeout':
        stepsExecuted++;
        stepsFailed++;
        break;
      case 'skipped':
      case 'gated':
        stepsSkipped++;
        break;
    }

    // After-step hook
    if (options.afterStep) {
      await options.afterStep(stepResult, ctx);
    }

    // Handle bail on failure
    const isFailure = stepResult.status === 'fail' || stepResult.status === 'error' || stepResult.status === 'timeout';
    if (isFailure && !currentStep.optional) {
      if (bail) {
        aborted = true;
        abortReason = `Step "${currentStep.name}" failed (bail=true)`;
        // Mark remaining as skipped
        for (let i = pointer + 1; i < definition.steps.length; i++) {
          const remainingStep = definition.steps[i];
          if (!visited.has(i) && remainingStep) {
            stepResults.push(makeSkippedResult(remainingStep, i, 'bail'));
            stepsSkipped++;
          }
        }
        break;
      }
    }

    // Handle gate failure
    if (stepResult.status === 'gated') {
      if (bail) {
        aborted = true;
        abortReason = `Step "${currentStep.name}" gate failed`;
        for (let i = pointer + 1; i < definition.steps.length; i++) {
          const remainingStep = definition.steps[i];
          if (!visited.has(i) && remainingStep) {
            stepResults.push(makeSkippedResult(remainingStep, i, 'gated'));
            stepsSkipped++;
          }
        }
        break;
      }
    }

    // Handle branching
    if (stepResult.branchTarget !== undefined) {
      const target = stepResult.branchTarget;
      if (typeof target === 'number') {
        pointer = target;
      } else {
        const targetIndex = stepNameMap.get(target);
        if (targetIndex === undefined) {
          aborted = true;
          abortReason = `Branch target "${target}" not found`;
          break;
        }
        pointer = targetIndex;
      }
    } else {
      pointer++;
    }
  }

  // Run teardown
  if (definition.teardown) {
    await definition.teardown(ctx);
  }

  const passed = stepsFailed === 0 && !aborted;

  return {
    name: definition.name,
    passed,
    steps: stepResults,
    context: ctx,
    stepsExecuted,
    stepsPassed,
    stepsFailed,
    stepsSkipped,
    durationMs: performance.now() - startTime,
    aborted,
    abortReason,
  };
}

// ─── STEP EXECUTION ─────────────────────────────────────────────────────────────

async function executeStep(
  step: ChainStep,
  index: number,
  ctx: ChainContext,
  definition: ChainDefinition,
  tieredOptions: ChainDefinition['tieredOptions'],
  runnerOptions: ChainRunnerOptions,
  wasBranched: boolean,
): Promise<ChainStepResult> {
  const stepStart = performance.now();

  // Before-step hook
  if (runnerOptions.beforeStep) {
    const shouldRun = await runnerOptions.beforeStep(step, ctx);
    if (!shouldRun) {
      return {
        name: step.name,
        index,
        status: 'skipped',
        prompt: '',
        tieredResult: null,
        durationMs: performance.now() - stepStart,
        retriesAttempted: 0,
        wasBranched,
      };
    }
  }

  // Evaluate `when` gate
  if (step.when) {
    const lastOutput = ctx.outputs[ctx.outputs.length - 1] ?? '';
    const shouldRun = await step.when(lastOutput, ctx);
    if (!shouldRun) {
      return {
        name: step.name,
        index,
        status: 'skipped',
        prompt: '',
        tieredResult: null,
        durationMs: performance.now() - stepStart,
        retriesAttempted: 0,
        wasBranched,
      };
    }
  }

  // Build prompt
  let prompt: string;
  try {
    prompt = typeof step.prompt === 'string'
      ? step.prompt
      : await step.prompt(ctx);
  } catch (err) {
    return {
      name: step.name,
      index,
      status: 'error',
      prompt: '[prompt builder threw]',
      tieredResult: null,
      durationMs: performance.now() - stepStart,
      retriesAttempted: 0,
      error: `Prompt builder error: ${err instanceof Error ? err.message : String(err)}`,
      wasBranched,
    };
  }

  // Resolve provider
  const provider = step.provider ?? definition.provider;
  if (!provider) {
    return {
      name: step.name,
      index,
      status: 'error',
      prompt,
      tieredResult: null,
      durationMs: performance.now() - stepStart,
      retriesAttempted: 0,
      error: `No provider configured for step "${step.name}" or chain "${definition.name}"`,
      wasBranched,
    };
  }

  // Retry loop
  const maxRetries = step.retries ?? 0;
  let lastResult: ChainStepResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && step.retryDelayMs) {
      await delay(step.retryDelayMs);
    }

    const attemptResult = await executeStepAttempt(
      step,
      index,
      prompt,
      provider,
      ctx,
      definition,
      tieredOptions,
      stepStart,
      wasBranched,
    );

    lastResult = attemptResult;
    lastResult.retriesAttempted = attempt;

    // If passed or non-retriable status, return immediately
    if (attemptResult.status === 'pass' || attemptResult.status === 'error' || attemptResult.status === 'gated') {
      if (attempt > 0 && attemptResult.status === 'pass') {
        attemptResult.status = 'retried';
      }
      return attemptResult;
    }

    // If this was the last attempt, return as-is
    if (attempt === maxRetries) {
      return attemptResult;
    }
  }

  // Should be unreachable — lastResult is always set after first loop iteration
  /* c8 ignore next */
  return lastResult as ChainStepResult;
}

async function executeStepAttempt(
  step: ChainStep,
  index: number,
  prompt: string,
  provider: EvalProvider,
  ctx: ChainContext,
  definition: ChainDefinition,
  tieredOptions: ChainDefinition['tieredOptions'],
  stepStart: number,
  wasBranched: boolean,
): Promise<ChainStepResult> {
  // Generate output
  let output: string;
  try {
    const providerOpts = step.providerOptions ?? definition.providerOptions;
    if (step.timeoutMs) {
      output = await withTimeout(
        provider.generate(prompt, providerOpts),
        step.timeoutMs,
        `Step "${step.name}" timed out after ${step.timeoutMs}ms`,
      );
    } else {
      output = await provider.generate(prompt, step.providerOptions ?? definition.providerOptions);
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    return {
      name: step.name,
      index,
      status: isTimeout ? 'timeout' : 'error',
      prompt,
      tieredResult: null,
      durationMs: performance.now() - stepStart,
      retriesAttempted: 0,
      error: err instanceof Error ? err.message : String(err),
      wasBranched,
    };
  }

  // Apply output transformer
  let transformedOutput: string | undefined;
  if (step.transform) {
    try {
      transformedOutput = await step.transform(output, ctx);
    } catch (err) {
      return {
        name: step.name,
        index,
        status: 'error',
        prompt,
        output,
        tieredResult: null,
        durationMs: performance.now() - stepStart,
        retriesAttempted: 0,
        error: `Transform error: ${err instanceof Error ? err.message : String(err)}`,
        wasBranched,
      };
    }
  }

  const evalOutput = transformedOutput ?? output;

  // Evaluate post-output gate
  if (step.gate) {
    const passed = await step.gate(evalOutput, ctx);
    if (!passed) {
      return {
        name: step.name,
        index,
        status: 'gated',
        prompt,
        output,
        transformedOutput,
        tieredResult: null,
        durationMs: performance.now() - stepStart,
        retriesAttempted: 0,
        wasBranched,
      };
    }
  }

  // Run assertions (tiered)
  let tieredResult: TieredResult | null = null;
  let stepStatus: ChainStepStatus = 'pass';

  if (step.assertions && step.assertions.length > 0) {
    const evalContext: EvalContext = {
      prompt,
      references: undefined,
      model: undefined,
      metadata: {
        chainName: definition.name,
        stepName: step.name,
        stepIndex: index,
        chainContext: ctx,
      },
    };

    tieredResult = await runTiered(evalOutput, step.assertions, evalContext, tieredOptions);
    stepStatus = tieredResult.passed ? 'pass' : 'fail';
  }

  // Evaluate branches
  let branchTarget: string | number | undefined;
  if (step.branches && step.branches.length > 0) {
    for (const branch of step.branches) {
      const matches = await branch.condition(evalOutput, ctx);
      if (matches) {
        branchTarget = branch.target;
        break;
      }
    }
  }

  return {
    name: step.name,
    index,
    status: stepStatus,
    prompt,
    output,
    transformedOutput,
    tieredResult,
    durationMs: performance.now() - stepStart,
    retriesAttempted: 0,
    wasBranched,
    branchTarget,
  };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────────

function makeSkippedResult(step: ChainStep, index: number, reason: string): ChainStepResult {
  return {
    name: step.name,
    index,
    status: 'skipped',
    prompt: '',
    tieredResult: null,
    durationMs: 0,
    retriesAttempted: 0,
    error: `Skipped: ${reason}`,
    wasBranched: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
