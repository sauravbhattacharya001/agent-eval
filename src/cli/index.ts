#!/usr/bin/env node

/**
 * agent-eval CLI — load and run eval spec files.
 */

import { pathToFileURL } from 'node:url';
import { readFile, stat, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, basename, dirname, resolve as resolvePath } from 'node:path';
import { runSuites } from '../core/runner.js';
import { TerminalReporter, JsonReporter } from '../core/reporter.js';
import { parseCliArgs } from './args.js';
import type { ParsedArgs } from './args.js';
import { discoverSpecs } from './discover.js';
import { validateTranscript } from '../monitoring/contract.js';
import { parseOtlp, parseLangSmith, parseAgentLens } from '../adapters/index.js';
import { triageBuilt, renderTriageTable } from '../action/index.js';
import type { BuiltSession } from '../adapters/index.js';
import { corpusScaffold } from '../corpus/scaffold.js';
import { promoteFromTriage } from '../corpus/promote.js';
import type { EvalSuiteDefinition, Reporter } from '../core/types.js';

function printHelp(): void {
  console.log(`
agent-eval — Test and evaluate AI agent outputs

Usage:
  agent-eval run <specs-dir|file>      Run eval specs from directory or file
  agent-eval triage <trace> --format <fmt>   Triage a trace export; optionally promote failures
  agent-eval init-corpus <dir>         Scaffold a private regression corpus
  agent-eval validate <file|dir>       Validate transcript(s) against the contract
  agent-eval --version                 Show version
  agent-eval --help                    Show this help

Options (run):
  --bail, -b                Stop on first failure
  --filter, -f <pattern>   Only run specs matching pattern (regex)
  --reporter, -r <name>    Reporter: terminal (default) or json
  --timeout, -t <ms>       Default timeout per spec (default: 30000)
  --concurrency, -c <n>    Max parallel specs (default: 1)

Options (triage):
  --format <otlp|langsmith|agentlens>   Trace format (required)
  --promote-top <n>        Freeze the top-N flagged runs into regression cases
  --to <dir>               Where to write promoted cases (default: ./cases)
  --dollars-per-mtok <n>   Cost projection rate (default: 9)
  --import-from <spec>     Import specifier promoted cases use (default: agent-eval)
  --json                   Emit machine-readable JSON

Examples:
  agent-eval run ./specs/
  agent-eval run ./specs/ --bail --filter "hallucination"
  agent-eval triage ./raw/export.json --format otlp
  agent-eval triage ./raw/export.json --format otlp --promote-top 3 --to ./cases
  agent-eval init-corpus ./my-corpus
  agent-eval validate ./transcripts/ --finished
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

  if (parsed.command === 'validate') {
    await runValidate(parsed.paths, { json: parsed.json, finished: parsed.finished });
    return;
  }

  if (parsed.command === 'init-corpus') {
    await runInitCorpus(parsed.paths);
    return;
  }

  if (parsed.command === 'triage') {
    await runTriage(parsed);
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

/**
 * Collect transcript markdown files from a path (a single .md file or a
 * directory tree). Used by `agent-eval validate`.
 */
async function collectTranscriptFiles(p: string): Promise<string[]> {
  const info = await stat(p);
  if (info.isFile()) return [p];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  await walk(p);
  out.sort();
  return out;
}

/**
 * `agent-eval validate <file|dir>` - check transcript(s) against the contract.
 * Exit code 0 when all are valid, 1 when any has an error-severity violation.
 */
async function runValidate(
  paths: string[],
  opts: { json: boolean; finished: boolean },
): Promise<void> {
  if (paths.length === 0) {
    console.error('No path provided. Usage: agent-eval validate <file|dir> [--json] [--finished]');
    process.exit(1);
    return;
  }

  const files: string[] = [];
  for (const p of paths) {
    try {
      files.push(...(await collectTranscriptFiles(p)));
    } catch {
      console.error(`Path not found: ${p}`);
      process.exit(1);
      return;
    }
  }

  if (files.length === 0) {
    console.error('No .md transcript files found.');
    process.exit(1);
    return;
  }

  const results = [] as Array<{
    file: string;
    valid: boolean;
    version: string;
    errors: { code: string; field: string; message: string }[];
    warnings: { code: string; field: string; message: string }[];
  }>;

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const res = validateTranscript(text, {
      filename: file,
      allowInProgress: !opts.finished,
    });
    results.push({
      file,
      valid: res.valid,
      version: res.version,
      errors: res.errors.map((v) => ({ code: v.code, field: v.field, message: v.message })),
      warnings: res.warnings.map((v) => ({ code: v.code, field: v.field, message: v.message })),
    });
  }

  const failed = results.filter((r) => !r.valid).length;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version: results[0]?.version ?? 'transcript-contract@v1',
          total: results.length,
          valid: results.length - failed,
          invalid: failed,
          results,
        },
        null,
        2,
      ),
    );
    process.exit(failed > 0 ? 1 : 0);
    return;
  }

  for (const r of results) {
    const label = basename(r.file);
    if (r.valid && r.warnings.length === 0) {
      console.log(`\u2705 ${label} - valid (${r.version})`);
    } else if (r.valid) {
      console.log(`\u26a0\ufe0f  ${label} - valid with ${r.warnings.length} warning(s)`);
      for (const w of r.warnings) console.log(`     - [${w.field}] ${w.message}`);
    } else {
      console.log(`\u274c ${label} - ${r.errors.length} error(s)`);
      for (const e of r.errors) console.log(`     - [${e.field}] ${e.message}`);
      for (const w of r.warnings) console.log(`     - (warn) [${w.field}] ${w.message}`);
    }
  }

  if (results.length > 1) {
    console.log(
      `\n${results.length - failed}/${results.length} valid, ${failed} invalid (${results[0]?.version ?? 'transcript-contract@v1'}).`,
    );
  }

  process.exit(failed > 0 ? 1 : 0);
}

/**
 * `agent-eval init-corpus <dir>` - scaffold a private regression corpus with the
 * scrub discipline baked in (gitignore, SCRUBBING.md, secret scanner, CI gate).
 */
async function runInitCorpus(paths: string[]): Promise<void> {
  const target = paths[0];
  if (!target) {
    console.error('Usage: agent-eval init-corpus <dir>');
    process.exit(1);
    return;
  }
  const files = corpusScaffold();
  let wrote = 0;
  let skipped = 0;
  for (const f of files) {
    const dest = join(target, f.path);
    await mkdir(dirname(dest), { recursive: true });
    // Never clobber a file the user may have customized.
    try {
      await stat(dest);
      skipped++;
      continue;
    } catch {
      // does not exist -> write
    }
    await writeFile(dest, f.content, 'utf8');
    wrote++;
  }
  console.log(`\u2705 Corpus scaffolded at ${target} (${wrote} file(s) written, ${skipped} existing left untouched).`);
  console.log('\nNext:');
  console.log(`  cd ${target} && git init && git add . && git commit -m "init corpus"`);
  console.log('  # create a PRIVATE remote and push. Then feed it:');
  console.log('  agent-eval triage ./raw/export.json --format otlp --promote-top 3 --to ./cases');
  console.log('  # sanitize per SCRUBBING.md, then: node scripts/check-secrets.mjs && git commit');
  process.exit(0);
}

/**
 * `agent-eval triage <trace> --format <fmt> [--promote-top N --to <dir>]` -
 * deterministic Tier-1 triage over a trace export; optionally freeze the worst
 * runs into runnable regression cases (the promotion funnel).
 */
async function runTriage(parsed: ParsedArgs): Promise<void> {
  const tracePath = parsed.paths[0];
  if (!tracePath) {
    console.error('Usage: agent-eval triage <trace> --format <otlp|langsmith|agentlens> [--promote-top N --to <dir>]');
    process.exit(1);
    return;
  }
  if (!parsed.format) {
    console.error('Missing --format. One of: otlp | langsmith | agentlens');
    process.exit(1);
    return;
  }

  let text: string;
  try {
    text = await readFile(tracePath, 'utf8');
  } catch {
    console.error(`Trace file not found: ${tracePath}`);
    process.exit(1);
    return;
  }

  const parsers = { otlp: parseOtlp, langsmith: parseLangSmith, agentlens: parseAgentLens };
  let sessions: BuiltSession[];
  try {
    sessions = parsers[parsed.format](text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse ${parsed.format} trace: ${message}`);
    process.exit(1);
    return;
  }

  // AgentLens carries an explicit status verdict; consult it (staleOnly:false).
  const staleOnly = parsed.format !== 'agentlens';
  const report = triageBuilt(sessions, {
    dollarsPerMillionTokens: parsed.dollarsPerMillionTokens ?? 9,
    costlyTokenThreshold: 100_000,
    staleOnly,
  });

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderTriageTable(report, 15));
    console.log(`\nScanned ${report.scanned} sessions \u2014 ${report.flagged} flagged (${report.costly} costly). Projected waste: $${report.projectedCostUsd.toFixed(0)} @ $${report.dollarsPerMillionTokens}/M tokens.`);
  }

  // Promotion funnel: freeze the worst N into regression cases.
  if (parsed.promoteTop && parsed.promoteTop > 0) {
    const outDir = parsed.to ?? './cases';
    // Default import is the package name (what an installed client corpus uses).
    // A relative --import-from is resolved to an absolute path from CWD so the
    // generated case doesn't depend on where --to happens to land.
    let importFrom = parsed.importFrom ?? 'agent-eval';
    if (importFrom.startsWith('.') || importFrom.startsWith('/')) {
      importFrom = pathToFileURL(resolvePath(importFrom)).href;
    }
    const promoted = promoteFromTriage(sessions, report, {
      outDir,
      top: parsed.promoteTop,
      importFrom,
    });
    if (promoted.length === 0) {
      console.log('\nNothing flagged to promote \u2014 fleet is clean.');
    } else {
      console.log(`\nPromoted ${promoted.length} case(s) into ${outDir}:`);
      for (const c of promoted) {
        console.log(`  \u2022 ${basename(c.file)}  (${c.kind}, ~$${c.projectedCostUsd.toFixed(2)}, ${c.tokenUsage.toLocaleString()} tokens)`);
      }
      console.log('\nSANITIZE each case per SCRUBBING.md, then run scripts/check-secrets.mjs before committing.');
    }
  }

  // Triage itself is a report, not a gate: exit 0. The corpus run is the gate.
  process.exit(0);
}
