/**
 * Doc <-> code guard for the documented CLI surface.
 *
 * `public-api.test.ts` already pins that every `import { ... } from 'agent-eval'`
 * in the README resolves to a real barrel export. But the README's other public
 * contract — the **CLI** section — was unguarded: the `npx agent-eval <cmd> ...`
 * examples and the "`run` options: ..." prose could rename or drop a flag and no
 * test would notice until a copy-pasting user hit a silently-ignored option.
 *
 * These tests parse the documented CLI usage straight out of README.md and assert
 * that `parseCliArgs` actually recognizes each documented command and flag (and
 * applies the documented effect, not just "doesn't crash"). If the parser and the
 * docs drift apart, this fails loudly — the code wins, so the fix is usually to
 * update the README.
 *
 * Intentionally parses the README rather than hard-coding the flag list, so the
 * docs remain the single source of the *documented* surface being checked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCliArgs } from '../src/cli/args.js';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');

/** Wrap a documented command line into a full argv (`node agent-eval ...`). */
function argv(cmdline: string): string[] {
  // Split on whitespace but keep simple quoted tokens intact ("hallucination").
  const tokens = cmdline.match(/"[^"]*"|\S+/g) ?? [];
  const cleaned = tokens.map((t) => t.replace(/^"|"$/g, ''));
  // Drop the leading `npx`/`agent-eval` program words; keep command + args.
  const start = cleaned.findIndex((t) => t === 'agent-eval');
  const rest = start >= 0 ? cleaned.slice(start + 1) : cleaned;
  return ['node', 'agent-eval', ...rest];
}

/**
 * Every `npx agent-eval ...` / `agent-eval ...` example line in the README,
 * with trailing `# comments` stripped. This is exactly what a reader copy-pastes.
 *
 * Only lines *inside fenced code blocks* count — prose sentences that merely begin
 * with the words "agent-eval" (e.g. "agent-eval is built on ...") are not commands.
 */
function documentedCommandLines(): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of readme.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const line = raw.trim();
    if (!/^(npx\s+)?agent-eval\s/.test(line)) continue;
    lines.push(line.replace(/\s+#.*$/, '').trim());
  }
  return lines;
}

describe('README CLI section stays in sync with parseCliArgs', () => {
  const commandLines = documentedCommandLines();

  it('finds documented agent-eval command lines to check', () => {
    // Guard the guard: if the extractor silently matches nothing (CLI section
    // reformatted), fail loudly rather than pass vacuously.
    expect(commandLines.length).toBeGreaterThan(5);
  });

  for (const line of commandLines) {
    it(`parses documented command: \`${line}\``, () => {
      const parsed = parseCliArgs(argv(line));
      expect(parsed, `parseCliArgs returned null for documented line: ${line}`).not.toBeNull();
      // A documented option must never be silently ignored as malformed.
      expect(
        parsed!.warnings,
        `documented command produced parse warnings (a documented flag was ignored): ${parsed!.warnings.join('; ')}`,
      ).toEqual([]);
      // triage examples name a real adapter, so invalidFormat must stay unset.
      expect(
        parsed!.invalidFormat,
        `documented --format value was not recognized: ${parsed!.invalidFormat}`,
      ).toBeUndefined();
    });
  }

  it('documented commands resolve to known subcommands only', () => {
    const known = new Set(['run', 'validate', 'triage', 'version', 'help']);
    for (const line of commandLines) {
      const parsed = parseCliArgs(argv(line));
      expect(parsed, `null parse for: ${line}`).not.toBeNull();
      expect(known.has(parsed!.command), `unknown command for: ${line}`).toBe(true);
    }
  });

  it('documented `run` example applies --bail and --filter', () => {
    const parsed = parseCliArgs(argv('agent-eval run ./specs/ --bail --filter "hallucination"'));
    expect(parsed!.command).toBe('run');
    expect(parsed!.bail).toBe(true);
    expect(parsed!.filter).toBe('hallucination');
  });

  it('documented `triage --format otlp` selects the otlp adapter', () => {
    const parsed = parseCliArgs(argv('agent-eval triage ./raw/export.json --format otlp'));
    expect(parsed!.command).toBe('triage');
    expect(parsed!.format).toBe('otlp');
  });

  it('documented `triage ... --json` sets JSON output', () => {
    const parsed = parseCliArgs(argv('agent-eval triage ./raw/export.json --format otlp --json'));
    expect(parsed!.json).toBe(true);
  });

  it('documented `validate --finished` requires a finished transcript', () => {
    const parsed = parseCliArgs(argv('agent-eval validate ./run.md --finished'));
    expect(parsed!.command).toBe('validate');
    expect(parsed!.finished).toBe(true);
  });
});

/**
 * The prose line ("`run` options: `--bail/-b`, ...") is a second, independent
 * documented surface. Pin that each option token it lists is one `parseCliArgs`
 * actually honors — a renamed flag would rot this sentence otherwise.
 *
 * Scope note: this checks ONLY the `run`/`validate`/`triage` options sentence,
 * not the whole README — other tools (e.g. the `fleet-judge` script, guarded by
 * `fleet-judge-flags.test.ts`) document their own separate flag vocabulary.
 */
describe('README prose CLI option list matches parseCliArgs', () => {
  /**
   * The one README sentence that enumerates the `parseCliArgs` option surface:
   * `run` options: ... `validate` options: ... `triage` options: ...
   */
  function optionsProseLine(): string {
    const line = readme
      .split('\n')
      .find((l) => /`run` options:/.test(l) && /`triage` options:/.test(l));
    return line ?? '';
  }

  /** Extract every `--flag`/`-x` token from the CLI options prose sentence. */
  function documentedFlagTokens(): string[] {
    const flags = new Set<string>();
    const prose = optionsProseLine();
    for (const m of prose.matchAll(/`([^`]+)`/g)) {
      for (const tok of m[1].split(/[\s,|/<]/)) {
        if (/^--?[a-z][a-z-]*$/.test(tok)) flags.add(tok);
      }
    }
    return [...flags];
  }

  it('locates the single CLI options prose sentence', () => {
    expect(optionsProseLine().length).toBeGreaterThan(0);
  });

  // The union of flags the parser recognizes across all subcommands.
  const RECOGNIZED = new Set([
    '--bail', '-b',
    '--filter', '-f',
    '--reporter', '-r',
    '--timeout', '-t',
    '--concurrency', '-c',
    '--json',
    '--finished', '--strict',
    '--format',
    '--dollars-per-mtok',
    '--version', '-v',
    '--help', '-h',
  ]);

  const documented = documentedFlagTokens();

  it('finds documented CLI flags in the README prose', () => {
    expect(documented.length).toBeGreaterThan(8);
  });

  for (const flag of documented) {
    it(`documented flag \`${flag}\` is recognized by parseCliArgs`, () => {
      expect(
        RECOGNIZED.has(flag),
        `README documents CLI flag "${flag}", but parseCliArgs does not recognize it. ` +
          `Fix the docs or restore the flag.`,
      ).toBe(true);
    });
  }
});
