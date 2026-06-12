import { describe, it, expect } from 'vitest';
import {
  validateTranscript,
  validateParsedTranscript,
  TRANSCRIPT_CONTRACT_V1,
  CONTRACT_OUTCOME_TOKENS,
} from '../src/monitoring/contract.js';
import { parseTranscript } from '../src/monitoring/transcript-reader.js';
import { parseCliArgs } from '../src/cli/args.js';

const VALID = `# Builder Run - 2026-06-05 10:00 PT

## Task
Add a small user-facing feature to the everything repo.

## Actions Taken
1. Cloned the repo into a temp dir
2. Implemented the feature and added a unit test
3. Ran the build and test suite (all green)

## Key Outputs
- Commit a1b2c3d: add feature X with tests
- Pushed to master

## Outcome
pass - feature implemented, tested, and pushed

## Errors & Retries
- git commit mis-parsed under PowerShell once; re-ran with correct quoting

## Duration
10:00 PT -> 10:14 PT (14 minutes)
`;

describe('transcript contract v1', () => {
  describe('schema', () => {
    it('exposes a versioned contract with the canonical sections', () => {
      expect(TRANSCRIPT_CONTRACT_V1.version).toBe('transcript-contract@v1');
      const slugs = TRANSCRIPT_CONTRACT_V1.sections.map((s) => s.slug);
      expect(slugs).toEqual([
        'task',
        'actions-taken',
        'key-outputs',
        'outcome',
        'errors-retries',
        'duration',
      ]);
    });

    it('lists pass/fail/partial as the recognized outcome tokens', () => {
      expect(CONTRACT_OUTCOME_TOKENS).toEqual(['pass', 'fail', 'partial']);
    });
  });

  describe('valid transcripts', () => {
    it('accepts a fully-formed transcript', () => {
      const res = validateTranscript(VALID);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.warnings).toHaveLength(0);
      expect(res.version).toBe('transcript-contract@v1');
    });

    it('accepts markdown-formatted outcome tokens (**PASS**, emoji)', () => {
      const res = validateTranscript(VALID.replace('pass - feature', '**PASS** - feature'));
      expect(res.valid).toBe(true);
    });

    it('treats a missing Errors & Retries section as valid (optional)', () => {
      const noErrors = VALID.replace(
        /## Errors & Retries[\s\S]*?(?=## Duration)/,
        '',
      );
      const res = validateTranscript(noErrors);
      expect(res.valid).toBe(true);
    });
  });

  describe('error-severity violations', () => {
    it('flags a missing title', () => {
      const res = validateTranscript(VALID.replace(/^# .*\n/, ''));
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'missing-title')).toBe(true);
    });

    it('flags a missing required section', () => {
      const noOutputs = VALID.replace(
        /## Key Outputs[\s\S]*?(?=## Outcome)/,
        '',
      );
      const res = validateTranscript(noOutputs);
      expect(res.valid).toBe(false);
      const v = res.errors.find((e) => e.code === 'missing-section');
      expect(v?.field).toBe('key-outputs');
    });

    it('flags an empty required section', () => {
      const emptyTask = VALID.replace(
        '## Task\nAdd a small user-facing feature to the everything repo.',
        '## Task\n',
      );
      const res = validateTranscript(emptyTask);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'empty-section' && e.field === 'task')).toBe(true);
    });

    it('flags an unrecognized outcome token', () => {
      const weird = VALID.replace('pass - feature implemented, tested, and pushed', 'mostly fine I think');
      const res = validateTranscript(weird);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'outcome-unrecognized')).toBe(true);
    });
  });

  describe('in-progress stubs', () => {
    const STUB = `# Scrubme Run - 2026-06-11 13:30 PT

## Task
Audit public repos for leaked secrets.

## Actions Taken
IN-PROGRESS

## Key Outputs
IN-PROGRESS

## Outcome
IN-PROGRESS

## Duration
IN-PROGRESS
`;

    it('accepts an IN-PROGRESS stub by default (allowInProgress)', () => {
      const res = validateTranscript(STUB);
      // Outcome itself is allowed; but the empty-ish required sections still
      // carry IN-PROGRESS text, so they are non-empty and pass.
      expect(res.errors.some((e) => e.code === 'outcome-unrecognized')).toBe(false);
      expect(res.errors.some((e) => e.code === 'outcome-in-progress')).toBe(false);
    });

    it('rejects an IN-PROGRESS stub when --finished is requested', () => {
      const res = validateTranscript(STUB, { allowInProgress: false });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'outcome-in-progress')).toBe(true);
    });

    it('does NOT flag a finished transcript that merely mentions "IN-PROGRESS" in its outcome prose', () => {
      // Regression: the in-progress check used to test the whole Outcome body,
      // so a genuinely finished run whose reason text referenced the phrase
      // (e.g. a dogfood note about other workers' IN-PROGRESS stubs) was
      // mis-flagged as not-yet-finished. The token lives on the FIRST line; the
      // rest is free-text justification and must not flip the verdict.
      const FINISHED_MENTIONS = `# Eval Run - 2026-06-12 00:00 PT

## Task
Ship a piece of the eval framework.

## Actions Taken
1. Implemented the change and added tests
2. Ran the dogfood validation over the fleet transcripts

## Key Outputs
- Commit d5e0c71: staged the proposal

## Outcome
pass - shipped; dogfood found the only failures were the known scrubme IN-PROGRESS stubs

## Errors & Retries
- None.

## Duration
00:00 PT -> 00:08 PT (~8 minutes)
`;
      // Even under the strict --finished gate it must be accepted as finished.
      const res = validateTranscript(FINISHED_MENTIONS, { allowInProgress: false });
      expect(res.errors.some((e) => e.code === 'outcome-in-progress')).toBe(false);
      expect(res.valid).toBe(true);
      // And the outcome must resolve to `pass`, not `unknown`.
      const parsed = parseTranscript(FINISHED_MENTIONS);
      expect(parsed.outcome).toBe('pass');
    });

    it('still flags a real stub whose Outcome line leads with the sentinel even with trailing prose', () => {
      // The leading token on the first line is what counts: "IN-PROGRESS (...)"
      // is still a stub, regardless of any trailing note on that same line.
      const LEADING_STUB = STUB.replace(
        '## Outcome\nIN-PROGRESS',
        '## Outcome\nIN-PROGRESS - started, will fill in at the end',
      );
      const res = validateTranscript(LEADING_STUB, { allowInProgress: false });
      expect(res.errors.some((e) => e.code === 'outcome-in-progress')).toBe(true);
    });
  });

  describe('warning-severity violations', () => {
    it('warns when Actions Taken has prose but no list items', () => {
      const prose = VALID.replace(
        /## Actions Taken[\s\S]*?(?=## Key Outputs)/,
        '## Actions Taken\nI did a bunch of stuff without any list.\n\n',
      );
      const res = validateTranscript(prose);
      // still valid (warning only)
      expect(res.valid).toBe(true);
      expect(res.warnings.some((w) => w.code === 'actions-not-itemized')).toBe(true);
    });

    it('warns when the duration is unparseable', () => {
      const badDur = VALID.replace('10:00 PT -> 10:14 PT (14 minutes)', 'a little while');
      const res = validateTranscript(badDur);
      expect(res.warnings.some((w) => w.code === 'duration-unparseable')).toBe(true);
    });
  });

  describe('validateParsedTranscript', () => {
    it('works on an already-parsed transcript', () => {
      const t = parseTranscript(VALID, { filename: 'builder/2026-06-05-1000.md' });
      const res = validateParsedTranscript(t);
      expect(res.valid).toBe(true);
    });
  });

  describe('CLI: validate command parsing', () => {
    const parse = (...a: string[]) => parseCliArgs(['node', 'agent-eval', ...a]);

    it('parses `validate <file>`', () => {
      const p = parse('validate', './run.md');
      expect(p?.command).toBe('validate');
      expect(p?.paths).toEqual(['./run.md']);
      expect(p?.json).toBe(false);
      expect(p?.finished).toBe(false);
    });

    it('parses --json and --finished flags', () => {
      const p = parse('validate', './transcripts', '--json', '--finished');
      expect(p?.command).toBe('validate');
      expect(p?.paths).toEqual(['./transcripts']);
      expect(p?.json).toBe(true);
      expect(p?.finished).toBe(true);
    });

    it('accepts --strict as an alias for --finished', () => {
      const p = parse('validate', './t', '--strict');
      expect(p?.finished).toBe(true);
    });

    it('still parses the run command without the new flags', () => {
      const p = parse('run', './specs', '--bail');
      expect(p?.command).toBe('run');
      expect(p?.bail).toBe(true);
      expect(p?.json).toBe(false);
    });
  });
});
