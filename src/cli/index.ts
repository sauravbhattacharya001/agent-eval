#!/usr/bin/env node

/**
 * agent-eval CLI — load and run eval spec files.
 */

import { pathToFileURL } from 'node:url';
import { runSuites } from '../core/runner.js';
import { TerminalReporter, JsonReporter } from '../core/reporter.js';
import { parseCliArgs } from './args.js';
import { discoverSpecs } from './discover.js';
import type { EvalSuiteDefinition, Reporter } from '../core/types.js';

function printHelp(): void {
  console.log(`
agent-eval — Test and evaluate AI agent outputs

Usage:
  agent-eval run <specs-dir|file>  Run eval specs from directory or file
  agent-eval --version             Show version
  agent-eval --help                Show this help

Options:
  --bail, -b                Stop on first failure
  --filter, -f <pattern>   Only run specs matching pattern (regex)
  --reporter, -r <name>    Reporter: terminal (default) or json
  --timeout, -t <ms>       Default timeout per spec (default: 30000)
  --concurrency, -c <n>    Max parallel specs (default: 1)

Examples:
  agent-eval run ./specs/
  agent-eval run ./specs/code-gen.eval.ts
  agent-eval run ./specs/ --bail --filter "hallucination"
  agent-eval run ./specs/ --reporter json > results.json
`);
}

/**
 * Load an eval suite from a spec file via dynamic import.
 */
async function loadSuite(specPath: string): Promise<EvalSuiteDefinition | null> {
  const fileUrl = pathToFileURL(specPath).href;

  try {
    const module = (await import(fileUrl)) as Record<string, unknown>;
    const suite = (module.default ?? module.suite ?? module) as EvalSuiteDefinition;

    if (!suite || !suite.name || !Array.isArray(suite.specs)) {
      console.warn(
        `Warning: ${specPath} does not export a valid eval suite (missing name or specs). Skipping.`,
      );
      return null;
    }

    return suite;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error loading ${specPath}: ${message}`);
    return null;
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv);

  if (!parsed) {
    console.error('Unknown command. Run "agent-eval --help" for usage.');
    process.exit(1);
    return;
  }

  if (parsed.command === 'version') {
    console.log('agent-eval v0.1.0');
    process.exit(0);
    return;
  }

  if (parsed.command === 'help') {
    printHelp();
    process.exit(0);
    return;
  }

  // Command: run
  if (parsed.paths.length === 0) {
    console.error('No spec path provided. Usage: agent-eval run <specs-dir|file>');
    process.exit(1);
    return;
  }

  // Discover spec files
  const allSpecFiles: string[] = [];
  for (const p of parsed.paths) {
    try {
      const found = await discoverSpecs(p);
      allSpecFiles.push(...found);
    } catch {
      console.error(`Path not found: ${p}`);
      process.exit(1);
    }
  }

  if (allSpecFiles.length === 0) {
    console.error('No eval spec files found. Specs should end in .eval.ts or .eval.js');
    process.exit(1);
    return;
  }

  // Load suites
  const suites: EvalSuiteDefinition[] = [];
  for (const specFile of allSpecFiles) {
    const suite = await loadSuite(specFile);
    if (suite) {
      suites.push(suite);
    }
  }

  if (suites.length === 0) {
    console.error('No valid eval suites loaded.');
    process.exit(1);
    return;
  }

  // Create reporter
  const reporters: Reporter[] = [];
  if (parsed.reporter === 'json') {
    reporters.push(new JsonReporter());
  } else {
    reporters.push(new TerminalReporter());
  }

  // Run suites
  const filter = parsed.filter ? new RegExp(parsed.filter) : undefined;
  const results = await runSuites(suites, {
    reporters,
    bail: parsed.bail,
    filter,
    timeoutMs: parsed.timeoutMs,
    concurrency: parsed.concurrency,
  });

  // Output formatted results
  for (const reporter of reporters) {
    const output = reporter.format(results);
    console.log(output);
  }

  // Exit with appropriate code
  const hasFailures = results.some((r) => r.failed > 0 || r.errors > 0);
  process.exit(hasFailures ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
