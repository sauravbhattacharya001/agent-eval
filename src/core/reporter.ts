/**
 * Terminal reporter — outputs eval results to stdout.
 */

import type { EvalSpec, EvalSuiteDefinition, Reporter, SpecResult, SuiteResult } from './types.js';

const ICONS = {
  pass: '✓',
  fail: '✗',
  skip: '○',
  error: '⚠',
} as const;

/**
 * Terminal reporter with colored output.
 */
export class TerminalReporter implements Reporter {
  private verbose: boolean;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose ?? false;
  }

  onSuiteStart(suite: EvalSuiteDefinition): void {
    console.log(`\n  ${suite.name}`);
    console.log(`  ${'─'.repeat(suite.name.length)}`);
  }

  onSpecStart(_spec: EvalSpec): void {
    // No-op for terminal
  }

  onSpecEnd(result: SpecResult): void {
    const icon = ICONS[result.status];
    const timeStr = result.durationMs > 100 ? ` (${Math.round(result.durationMs)}ms)` : '';
    console.log(`    ${icon} ${result.name}${timeStr}`);

    if (result.status === 'fail' && this.verbose) {
      for (const assertion of result.assertions) {
        if (assertion.status === 'fail') {
          console.log(`      → ${assertion.message}`);
          if (assertion.expected) console.log(`        expected: ${assertion.expected}`);
          if (assertion.actual) console.log(`        actual:   ${assertion.actual}`);
        }
      }
    }

    if (result.status === 'error' && result.error) {
      console.log(`      → Error: ${result.error}`);
    }
  }

  onSuiteEnd(result: SuiteResult): void {
    console.log('');
    const parts: string[] = [];
    if (result.passed > 0) parts.push(`${result.passed} passed`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    if (result.errors > 0) parts.push(`${result.errors} errors`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    console.log(`  ${parts.join(', ')} (${Math.round(result.durationMs)}ms)`);
  }

  format(results: SuiteResult[]): string {
    const lines: string[] = [];
    let totalPassed = 0;
    let totalFailed = 0;
    let totalErrors = 0;
    let totalSkipped = 0;

    for (const suite of results) {
      lines.push(`\n  ${suite.name}`);
      lines.push(`  ${'─'.repeat(suite.name.length)}`);

      for (const spec of suite.specs) {
        const icon = ICONS[spec.status];
        const timeStr = spec.durationMs > 100 ? ` (${Math.round(spec.durationMs)}ms)` : '';
        lines.push(`    ${icon} ${spec.name}${timeStr}`);

        if (spec.status === 'fail') {
          for (const assertion of spec.assertions) {
            if (assertion.status === 'fail') {
              lines.push(`      → ${assertion.message}`);
              if (assertion.expected) lines.push(`        expected: ${assertion.expected}`);
              if (assertion.actual) lines.push(`        actual:   ${assertion.actual}`);
            }
          }
        }

        if (spec.status === 'error' && spec.error) {
          lines.push(`      → Error: ${spec.error}`);
        }
      }

      totalPassed += suite.passed;
      totalFailed += suite.failed;
      totalErrors += suite.errors;
      totalSkipped += suite.skipped;
    }

    lines.push('');
    lines.push('  ─────────────────────────────');
    const parts: string[] = [];
    if (totalPassed > 0) parts.push(`${totalPassed} passed`);
    if (totalFailed > 0) parts.push(`${totalFailed} failed`);
    if (totalErrors > 0) parts.push(`${totalErrors} errors`);
    if (totalSkipped > 0) parts.push(`${totalSkipped} skipped`);
    lines.push(`  Total: ${parts.join(', ')}`);

    return lines.join('\n');
  }
}

/**
 * JSON reporter — outputs results as structured JSON.
 */
export class JsonReporter implements Reporter {
  format(results: SuiteResult[]): string {
    return JSON.stringify(results, null, 2);
  }
}
