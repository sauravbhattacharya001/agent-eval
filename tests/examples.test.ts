/**
 * Integration test — run the example eval specs and verify they pass.
 */

import { describe, it, expect } from 'vitest';
import { runSuite } from '../src/core/runner.js';
import type { EvalSuiteDefinition } from '../src/core/types.js';

// Import examples directly
import codeGenSuite from '../examples/code-gen.eval.js';
import formatComplianceSuite from '../examples/format-compliance.eval.js';

describe('Example Eval Specs', () => {
  it('code-gen.eval passes all assertions', async () => {
    const result = await runSuite(codeGenSuite as EvalSuiteDefinition);

    expect(result.failed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.passed).toBe(4);
    expect(result.name).toBe('Code generation quality');

    // Verify each spec passed
    for (const spec of result.specs) {
      expect(spec.status).toBe('pass');
      for (const assertion of spec.assertions) {
        expect(assertion.status).toBe('pass');
      }
    }
  });

  it('format-compliance.eval passes all assertions', async () => {
    const result = await runSuite(formatComplianceSuite as EvalSuiteDefinition);

    expect(result.failed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.passed).toBe(3);
    expect(result.name).toBe('Output format compliance');

    for (const spec of result.specs) {
      expect(spec.status).toBe('pass');
    }
  });

  it('code-gen spec captures output from LocalProvider', async () => {
    const result = await runSuite(codeGenSuite as EvalSuiteDefinition);

    // First spec should have captured the TypeScript code output
    const firstSpec = result.specs[0];
    expect(firstSpec.output).toBeDefined();
    expect(firstSpec.output).toContain('function');
    expect(firstSpec.output).toContain('reverse');
  });

  it('format-compliance JSON spec validates structure', async () => {
    const result = await runSuite(formatComplianceSuite as EvalSuiteDefinition);

    // First spec tests JSON format
    const jsonSpec = result.specs[0];
    expect(jsonSpec.status).toBe('pass');
    expect(jsonSpec.assertions.length).toBeGreaterThanOrEqual(3);
  });
});
