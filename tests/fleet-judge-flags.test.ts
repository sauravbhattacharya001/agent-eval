/**
 * Doc-rot guard for the `fleet-judge` CLI flag table.
 *
 * The README documents `fleet-judge` (the offline Tier-3 fleet second-opinion
 * script) with a flag table users copy from. That table drifts silently from the
 * script's real argument parser: a flag can be added to `src/scripts/fleet-judge.ts`
 * (or removed) without anyone updating the README, and there is no compiler or
 * runtime link between the two. This exact drift shipped once — the script's
 * `--max-retries` 429-backoff knob existed in its own `--help` but was missing
 * from the README table even though the surrounding prose promised "429 backoff".
 *
 * This test pins the two together: every `--flag` the parser accepts MUST appear
 * in the README flag table, and every `--flag` documented in that table MUST be a
 * real flag the parser accepts. It never calls the script (no DB, no network); it
 * only reads the two source texts, exactly like the README-import guard in
 * public-api.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/** Flags in the script's manual `--help` are informational, not part of the config surface. */
const NOT_A_CONFIG_FLAG = new Set(['--help', '-h']);

/**
 * The `--flag` names the arg parser actually handles, read from the `case '--x':`
 * labels in `src/scripts/fleet-judge.ts`. This is the authoritative surface — the
 * README must match it.
 */
function parseScriptFlags(): Set<string> {
  const src = readFileSync(join(repoRoot, 'src', 'scripts', 'fleet-judge.ts'), 'utf8');
  const flags = new Set<string>();
  for (const m of src.matchAll(/case\s+'(-{1,2}[a-z][a-z-]*)'/g)) {
    const flag = m[1]!;
    if (!NOT_A_CONFIG_FLAG.has(flag)) flags.add(flag);
  }
  return flags;
}

/**
 * The `--flag` names documented in the README fleet-judge flag table. The table
 * lists one combined `--dollars-per-mtok-in/-out` row for the two real flags, so
 * that shorthand is expanded back to both concrete flags here.
 */
function parseReadmeFlagTable(): Set<string> {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  // Isolate the fleet-judge section so an unrelated future flag table can't leak in.
  const start = readme.indexOf('## Fleet Judge');
  const end = readme.indexOf('## Verifying claims');
  expect(start, 'README should have a "## Fleet Judge" section').toBeGreaterThan(-1);
  expect(end, 'README should have a "## Verifying claims" section after it').toBeGreaterThan(start);
  const section = readme.slice(start, end);

  const flags = new Set<string>();
  // Table rows look like: | `--flag <arg>` | default | description |
  for (const m of section.matchAll(/\|\s*`(-{1,2}[a-z][a-z/-]*)[^`]*`/g)) {
    const raw = m[1]!;
    // Expand the combined "--dollars-per-mtok-in/-out" documentation shorthand.
    const suffixMatch = /^(--[a-z-]+?)\/-([a-z-]+)$/.exec(raw);
    if (suffixMatch) {
      const [, base, altTail] = suffixMatch;
      const baseTail = base!.split('-').pop()!;
      flags.add(base!);
      flags.add(base!.slice(0, base!.length - baseTail.length) + altTail);
    } else {
      flags.add(raw);
    }
  }
  return flags;
}

describe('fleet-judge CLI flag table (README <-> script)', () => {
  it('documents every flag the script accepts', () => {
    const scriptFlags = parseScriptFlags();
    const readmeFlags = parseReadmeFlagTable();
    const undocumented = [...scriptFlags].filter((f) => !readmeFlags.has(f)).sort();
    expect(
      undocumented,
      `fleet-judge accepts these flags but the README flag table omits them: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('does not document any flag the script does not accept', () => {
    const scriptFlags = parseScriptFlags();
    const readmeFlags = parseReadmeFlagTable();
    const phantom = [...readmeFlags].filter((f) => !scriptFlags.has(f)).sort();
    expect(
      phantom,
      `the README flag table lists these flags but the script has no parser case for them: ${phantom.join(', ')}`,
    ).toEqual([]);
  });

  it('sanity-checks that both sources were actually found and non-trivial', () => {
    // Guards against a silently-empty parse (e.g. a moved file or renamed section)
    // making the two assertions above vacuously pass.
    expect(parseScriptFlags().size).toBeGreaterThanOrEqual(8);
    expect(parseReadmeFlagTable().size).toBeGreaterThanOrEqual(8);
    // The regression that motivated this test: --max-retries must be documented.
    expect(parseScriptFlags().has('--max-retries')).toBe(true);
    expect(parseReadmeFlagTable().has('--max-retries')).toBe(true);
  });
});
