/**
 * Tests for CLI argument parsing and spec discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { parseCliArgs } from '../src/cli/args.js';
import { discoverSpecs } from '../src/cli/discover.js';

describe('CLI Argument Parsing', () => {
  it('parses run command with path', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs']);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('run');
    expect(result!.paths).toEqual(['./specs']);
  });

  it('parses --bail flag', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '--bail']);
    expect(result!.bail).toBe(true);
  });

  it('parses -b short flag', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '-b']);
    expect(result!.bail).toBe(true);
  });

  it('parses --filter with pattern', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '--filter', 'hall']);
    expect(result!.filter).toBe('hall');
  });

  it('parses -f short flag', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '-f', 'drift']);
    expect(result!.filter).toBe('drift');
  });

  it('parses --reporter json', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '--reporter', 'json']);
    expect(result!.reporter).toBe('json');
  });

  it('parses --timeout option', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '--timeout', '60000']);
    expect(result!.timeoutMs).toBe(60000);
  });

  it('parses --concurrency option', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', '-c', '4']);
    expect(result!.concurrency).toBe(4);
  });

  it('parses multiple paths', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs', './more-specs']);
    expect(result!.paths).toEqual(['./specs', './more-specs']);
  });

  it('returns version command for --version', () => {
    const result = parseCliArgs(['node', 'agent-eval', '--version']);
    expect(result!.command).toBe('version');
  });

  it('returns version command for -v', () => {
    const result = parseCliArgs(['node', 'agent-eval', '-v']);
    expect(result!.command).toBe('version');
  });

  it('returns help command for --help', () => {
    const result = parseCliArgs(['node', 'agent-eval', '--help']);
    expect(result!.command).toBe('help');
  });

  it('returns help command for -h', () => {
    const result = parseCliArgs(['node', 'agent-eval', '-h']);
    expect(result!.command).toBe('help');
  });

  it('returns help command when no args', () => {
    const result = parseCliArgs(['node', 'agent-eval']);
    expect(result!.command).toBe('help');
  });

  it('returns null for unknown command', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'unknown']);
    expect(result).toBeNull();
  });

  it('defaults to terminal reporter', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs']);
    expect(result!.reporter).toBe('terminal');
  });

  it('defaults to 30000ms timeout', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs']);
    expect(result!.timeoutMs).toBe(30_000);
  });

  it('defaults to concurrency 1', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs']);
    expect(result!.concurrency).toBe(1);
  });

  it('defaults bail to false', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'run', './specs']);
    expect(result!.bail).toBe(false);
  });
});

describe('CLI Argument Parsing - triage command', () => {
  it('parses triage command with a trace path', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces']);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('triage');
    expect(result!.paths).toEqual(['./traces']);
  });

  it('parses --format agentlens', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces', '--format', 'agentlens']);
    expect(result!.format).toBe('agentlens');
  });

  it('parses --format otlp and langsmith', () => {
    expect(parseCliArgs(['node', 'agent-eval', 'triage', 't', '--format', 'otlp'])!.format).toBe('otlp');
    expect(parseCliArgs(['node', 'agent-eval', 'triage', 't', '--format', 'langsmith'])!.format).toBe('langsmith');
  });

  it('captures an unrecognized --format value as invalidFormat (format stays unset)', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces', '--format', 'bogus']);
    expect(result!.format).toBeUndefined();
    expect(result!.invalidFormat).toBe('bogus');
  });

  it('leaves invalidFormat unset for a recognized --format value', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', 't', '--format', 'otlp']);
    expect(result!.format).toBe('otlp');
    expect(result!.invalidFormat).toBeUndefined();
  });

  it('leaves invalidFormat unset when no --format is supplied', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces']);
    expect(result!.invalidFormat).toBeUndefined();
  });

  it('parses a positive --dollars-per-mtok value', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces', '--dollars-per-mtok', '3.5']);
    expect(result!.dollarsPerMillionTokens).toBe(3.5);
  });

  it('ignores a non-numeric --dollars-per-mtok value', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces', '--dollars-per-mtok', 'abc']);
    expect(result!.dollarsPerMillionTokens).toBeUndefined();
  });

  it('ignores a non-positive --dollars-per-mtok value', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces', '--dollars-per-mtok', '0']);
    expect(result!.dollarsPerMillionTokens).toBeUndefined();
  });

  it('parses --json on triage', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './traces', '--json']);
    expect(result!.json).toBe(true);
  });

  it('collects multiple positional trace paths and skips flags', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'triage', './a', './b', '--json']);
    expect(result!.paths).toEqual(['./a', './b']);
  });
});

describe('CLI Argument Parsing - validate command', () => {
  it('parses validate command with a path', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'validate', './transcripts']);
    expect(result).not.toBeNull();
    expect(result!.command).toBe('validate');
    expect(result!.paths).toEqual(['./transcripts']);
  });

  it('parses --json on validate', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'validate', './transcripts', '--json']);
    expect(result!.json).toBe(true);
  });

  it('parses --finished flag', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'validate', './transcripts', '--finished']);
    expect(result!.finished).toBe(true);
  });

  it('treats --strict as an alias for --finished', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'validate', './transcripts', '--strict']);
    expect(result!.finished).toBe(true);
  });

  it('defaults json and finished to false', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'validate', './transcripts']);
    expect(result!.json).toBe(false);
    expect(result!.finished).toBe(false);
  });

  it('collects multiple positional paths and skips unknown flags', () => {
    const result = parseCliArgs(['node', 'agent-eval', 'validate', './a', './b', '--json', '--finished']);
    expect(result!.paths).toEqual(['./a', './b']);
  });
});

describe('Spec Discovery', () => {
  const tmpDir = resolve('./test-specs-discovery-tmp');

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers .eval.ts files in a directory', async () => {
    await writeFile(join(tmpDir, 'basic.eval.ts'), 'export default {}');
    await writeFile(join(tmpDir, 'other.ts'), 'export default {}');
    await writeFile(join(tmpDir, 'sub', 'nested.eval.ts'), 'export default {}');

    const specs = await discoverSpecs(tmpDir);

    expect(specs).toHaveLength(2);
    expect(specs.every((s) => s.endsWith('.eval.ts'))).toBe(true);
  });

  it('discovers .eval.js files', async () => {
    await writeFile(join(tmpDir, 'compiled.eval.js'), 'module.exports = {}');
    await writeFile(join(tmpDir, 'noteval.js'), 'module.exports = {}');

    const specs = await discoverSpecs(tmpDir);

    expect(specs).toHaveLength(1);
    expect(specs[0]).toContain('compiled.eval.js');
  });

  it('discovers .eval.mjs files', async () => {
    await writeFile(join(tmpDir, 'esm.eval.mjs'), 'export default {}');

    const specs = await discoverSpecs(tmpDir);

    expect(specs).toHaveLength(1);
    expect(specs[0]).toContain('esm.eval.mjs');
  });

  it('returns single file when pointed at a file', async () => {
    const filePath = join(tmpDir, 'single.eval.ts');
    await writeFile(filePath, 'export default {}');

    const specs = await discoverSpecs(filePath);

    expect(specs).toHaveLength(1);
    expect(specs[0]).toBe(resolve(filePath));
  });

  it('throws for non-existent path', async () => {
    await expect(discoverSpecs('/nonexistent/path/xyz')).rejects.toThrow();
  });

  it('returns empty for directory with no eval files', async () => {
    await writeFile(join(tmpDir, 'regular.ts'), 'export {}');
    await writeFile(join(tmpDir, 'test.spec.ts'), 'export {}');

    const specs = await discoverSpecs(tmpDir);

    expect(specs).toHaveLength(0);
  });

  it('sorts results alphabetically', async () => {
    await writeFile(join(tmpDir, 'z-last.eval.ts'), '');
    await writeFile(join(tmpDir, 'a-first.eval.ts'), '');
    await writeFile(join(tmpDir, 'm-middle.eval.ts'), '');

    const specs = await discoverSpecs(tmpDir);

    expect(specs[0]).toContain('a-first');
    expect(specs[1]).toContain('m-middle');
    expect(specs[2]).toContain('z-last');
  });
});
