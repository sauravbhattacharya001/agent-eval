/**
 * Core eval runner — loads and executes eval suites.
 */

import type {
  Assertion,
  AssertionResult,
  EvalContext,
  EvalProvider,
  EvalSpec,
  EvalSuiteDefinition,
  Reporter,
  SpecResult,
  SuiteResult,
} from './types.js';

export interface RunnerOptions {
  /** Reporter(s) to use for output. */
  reporters?: Reporter[];
  /** Default timeout per spec in ms. */
  timeoutMs?: number;
  /** Run specs matching this pattern only. */
  filter?: RegExp;
  /** Fail fast — stop on first failure. */
  bail?: boolean;
  /** Concurrency limit for specs within a suite. */
  concurrency?: number;
}

/**
 * Run a single eval suite and return results.
 */
export async function runSuite(
  suite: EvalSuiteDefinition,
  options: RunnerOptions = {},
): Promise<SuiteResult> {
  const { reporters = [], timeoutMs = 30_000, filter, bail = false } = options;
  const startTime = performance.now();

  // Notify reporters of suite start
  for (const reporter of reporters) {
    reporter.onSuiteStart?.(suite);
  }

  // Run setup if defined
  if (suite.setup) {
    await suite.setup();
  }

  const specResults: SpecResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errors = 0;

  for (const spec of suite.specs) {
    // Filter check
    if (filter && !filter.test(spec.name)) {
      skipped++;
      specResults.push({
        name: spec.name,
        status: 'skip',
        assertions: [],
        durationMs: 0,
      });
      continue;
    }

    // Skip check
    if (spec.skip) {
      skipped++;
      specResults.push({
        name: spec.name,
        status: 'skip',
        assertions: [],
        durationMs: 0,
      });
      continue;
    }

    // Notify reporters of spec start
    for (const reporter of reporters) {
      reporter.onSpecStart?.(spec);
    }

    const specResult = await runSpec(spec, suite, timeoutMs);
    specResults.push(specResult);

    // Update counters
    switch (specResult.status) {
      case 'pass':
        passed++;
        break;
      case 'fail':
        failed++;
        break;
      case 'error':
        errors++;
        break;
      case 'skip':
        skipped++;
        break;
    }

    // Notify reporters of spec end
    for (const reporter of reporters) {
      reporter.onSpecEnd?.(specResult);
    }

    // Bail on first failure
    if (bail && (specResult.status === 'fail' || specResult.status === 'error')) {
      // Mark remaining specs as skipped
      const remaining = suite.specs.slice(suite.specs.indexOf(spec) + 1);
      for (const s of remaining) {
        skipped++;
        specResults.push({
          name: s.name,
          status: 'skip',
          assertions: [],
          durationMs: 0,
        });
      }
      break;
    }
  }

  // Run teardown if defined
  if (suite.teardown) {
    await suite.teardown();
  }

  const result: SuiteResult = {
    name: suite.name,
    specs: specResults,
    durationMs: performance.now() - startTime,
    passed,
    failed,
    skipped,
    errors,
  };

  // Notify reporters of suite end
  for (const reporter of reporters) {
    reporter.onSuiteEnd?.(result);
  }

  return result;
}

/**
 * Run a single spec — generate output and check assertions.
 */
async function runSpec(
  spec: EvalSpec,
  suite: EvalSuiteDefinition,
  defaultTimeoutMs: number,
): Promise<SpecResult> {
  const specStart = performance.now();
  const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;

  try {
    // Generate output from provider
    const output = await generateOutput(spec.prompt, suite);

    // Build eval context
    const context: EvalContext = {
      prompt: spec.prompt,
      references: spec.references ?? suite.references,
      model: suite.model,
    };

    // Run assertions
    const assertionResults = await runAssertions(spec.assertions, output, context, timeoutMs);

    // Determine overall status
    const hasFailure = assertionResults.some((r) => r.status === 'fail');
    const hasError = assertionResults.some((r) => r.status === 'error');
    const status = hasError ? 'error' : hasFailure ? 'fail' : 'pass';

    return {
      name: spec.name,
      status,
      assertions: assertionResults,
      output,
      durationMs: performance.now() - specStart,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: spec.name,
      status: 'error',
      assertions: [],
      durationMs: performance.now() - specStart,
      error: message,
    };
  }
}

/**
 * Generate output from the suite's provider.
 */
async function generateOutput(prompt: string, suite: EvalSuiteDefinition): Promise<string> {
  if (!suite.provider) {
    throw new Error(
      `No provider configured for suite "${suite.name}". ` +
        'Set a provider in the suite definition or use the local provider with pre-generated outputs.',
    );
  }

  // If provider is a string, it needs to be resolved (future: provider registry)
  if (typeof suite.provider === 'string') {
    throw new Error(
      `String provider "${suite.provider}" not yet supported. Pass an EvalProvider instance.`,
    );
  }

  return suite.provider.generate(prompt, { model: suite.model });
}

/**
 * Run all assertions against the output.
 */
async function runAssertions(
  assertions: Assertion[],
  output: string,
  context: EvalContext,
  _timeoutMs: number,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    const assertStart = performance.now();
    try {
      const result = await assertion.evaluate(output, context);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        status: 'error',
        name: assertion.name,
        message: `Assertion threw: ${message}`,
        durationMs: performance.now() - assertStart,
      });
    }
  }

  return results;
}

/**
 * Run multiple suites and return all results.
 */
export async function runSuites(
  suites: EvalSuiteDefinition[],
  options: RunnerOptions = {},
): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  for (const suite of suites) {
    results.push(await runSuite(suite, options));
  }
  return results;
}

/**
 * Helper to resolve a provider — currently only supports direct instances.
 * Future: add provider registry for string lookups.
 */
export function resolveProvider(provider: EvalProvider | string): EvalProvider {
  if (typeof provider === 'string') {
    throw new Error(`Provider registry not yet implemented. Pass an EvalProvider instance.`);
  }
  return provider;
}
