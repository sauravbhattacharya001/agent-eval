/**
 * CLI argument parsing.
 */

export interface ParsedArgs {
  command: 'run' | 'version' | 'help' | 'validate' | 'triage';
  paths: string[];
  bail: boolean;
  filter?: string;
  reporter: 'terminal' | 'json';
  timeoutMs: number;
  concurrency: number;
  /** validate: emit machine-readable JSON instead of human text. */
  json: boolean;
  /** validate: require a FINISHED transcript (IN-PROGRESS stubs are errors). */
  finished: boolean;
  /** triage: trace format (adapter to use). */
  format?: 'otlp' | 'langsmith' | 'agentlens';
  /**
   * triage: the raw `--format` value when it was supplied but NOT one of the
   * recognized adapters. `format` stays unset in that case; this field lets the
   * CLI tell "you passed an unknown format" apart from "you passed no --format".
   */
  invalidFormat?: string;
  /** triage: dollars per million tokens for the cost projection. */
  dollarsPerMillionTokens?: number;
  /**
   * Non-fatal diagnostics gathered while parsing: an option value that was
   * malformed and therefore ignored (so the effective value silently fell back
   * to its default). The CLI surfaces these to stderr so a typo like
   * `--timeout abc` or `--reporter xml` doesn't vanish without a trace.
   */
  warnings: string[];
}

function baseArgs(command: ParsedArgs['command']): ParsedArgs {
  return {
    command,
    paths: [],
    bail: false,
    reporter: 'terminal',
    timeoutMs: 30_000,
    concurrency: 1,
    json: false,
    finished: false,
    warnings: [],
  };
}

/**
 * Parse CLI arguments into a structured options object.
 * Returns null only for truly unrecoverable parse errors.
 */
export function parseCliArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    return baseArgs('version');
  }

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    return baseArgs('help');
  }

  const command = args[0];

  // Command: triage <traces> --format <fmt>
  if (command === 'triage') {
    const parsed = baseArgs('triage');
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === '--format') {
        const v = args[++i];
        if (v === 'otlp' || v === 'langsmith' || v === 'agentlens') parsed.format = v;
        else if (v !== undefined) parsed.invalidFormat = v;
      } else if (arg === '--dollars-per-mtok') {
        const v = args[++i];
        if (v !== undefined) {
          const n = Number(v);
          if (!isNaN(n) && n > 0) parsed.dollarsPerMillionTokens = n;
          else parsed.warnings.push(`ignored --dollars-per-mtok "${v}": expected a positive number (using default 9)`);
        }
      } else if (arg === '--json') {
        parsed.json = true;
      } else if (!arg.startsWith('-')) {
        parsed.paths.push(arg);
      }
    }
    return parsed;
  }

  // Command: validate <file|dir> [--json] [--finished]
  if (command === 'validate') {
    const parsed = baseArgs('validate');
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === '--json') {
        parsed.json = true;
      } else if (arg === '--finished' || arg === '--strict') {
        parsed.finished = true;
      } else if (!arg.startsWith('-')) {
        parsed.paths.push(arg);
      }
    }
    return parsed;
  }

  if (command !== 'run') {
    return null;
  }

  const parsed = baseArgs('run');

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--bail' || arg === '-b') {
      parsed.bail = true;
    } else if (arg === '--filter' || arg === '-f') {
      const next = args[++i];
      if (next !== undefined) parsed.filter = next;
    } else if (arg === '--reporter' || arg === '-r') {
      const value = args[++i];
      if (value === 'terminal' || value === 'json') {
        parsed.reporter = value;
      } else if (value !== undefined) {
        parsed.warnings.push(`ignored --reporter "${value}": expected terminal | json (using terminal)`);
      }
    } else if (arg === '--timeout' || arg === '-t') {
      const next = args[++i];
      if (next !== undefined) {
        const value = parseInt(next, 10);
        if (!isNaN(value) && value > 0) {
          parsed.timeoutMs = value;
        } else {
          parsed.warnings.push(`ignored --timeout "${next}": expected a positive integer ms (using ${parsed.timeoutMs})`);
        }
      }
    } else if (arg === '--concurrency' || arg === '-c') {
      const next = args[++i];
      if (next !== undefined) {
        const value = parseInt(next, 10);
        if (!isNaN(value) && value > 0) {
          parsed.concurrency = value;
        } else {
          parsed.warnings.push(`ignored --concurrency "${next}": expected a positive integer (using ${parsed.concurrency})`);
        }
      }
    } else if (!arg.startsWith('-')) {
      parsed.paths.push(arg);
    }
  }

  return parsed;
}
