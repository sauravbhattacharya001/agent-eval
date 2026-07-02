/**
 * CLI argument parsing.
 */

export interface ParsedArgs {
  command: 'run' | 'version' | 'help' | 'validate' | 'triage' | 'init-corpus';
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
  /** triage: promote the top-N flagged runs into regression cases. */
  promoteTop?: number;
  /** triage: directory to write promoted cases into. */
  to?: string;
  /** triage: dollars per million tokens for the cost projection. */
  dollarsPerMillionTokens?: number;
  /** triage: import specifier promoted cases use for the engine. */
  importFrom?: string;
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

  // Command: init-corpus <dir>
  if (command === 'init-corpus') {
    const parsed = baseArgs('init-corpus');
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg !== undefined && !arg.startsWith('-')) parsed.paths.push(arg);
    }
    return parsed;
  }

  // Command: triage <traces> --format <fmt> [--promote-top N --to <dir>]
  if (command === 'triage') {
    const parsed = baseArgs('triage');
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === '--format') {
        const v = args[++i];
        if (v === 'otlp' || v === 'langsmith' || v === 'agentlens') parsed.format = v;
      } else if (arg === '--promote-top') {
        const v = args[++i];
        if (v !== undefined) {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) parsed.promoteTop = n;
        }
      } else if (arg === '--to') {
        const v = args[++i];
        if (v !== undefined) parsed.to = v;
      } else if (arg === '--dollars-per-mtok') {
        const v = args[++i];
        if (v !== undefined) {
          const n = Number(v);
          if (!isNaN(n) && n > 0) parsed.dollarsPerMillionTokens = n;
        }
      } else if (arg === '--import-from') {
        const v = args[++i];
        if (v !== undefined) parsed.importFrom = v;
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

  const paths: string[] = [];
  let bail = false;
  let filter: string | undefined;
  let reporter: 'terminal' | 'json' = 'terminal';
  let timeoutMs = 30_000;
  let concurrency = 1;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--bail' || arg === '-b') {
      bail = true;
    } else if (arg === '--filter' || arg === '-f') {
      const next = args[++i];
      if (next !== undefined) filter = next;
    } else if (arg === '--reporter' || arg === '-r') {
      const value = args[++i];
      if (value === 'terminal' || value === 'json') {
        reporter = value;
      }
    } else if (arg === '--timeout' || arg === '-t') {
      const next = args[++i];
      if (next !== undefined) {
        const value = parseInt(next, 10);
        if (!isNaN(value) && value > 0) {
          timeoutMs = value;
        }
      }
    } else if (arg === '--concurrency' || arg === '-c') {
      const next = args[++i];
      if (next !== undefined) {
        const value = parseInt(next, 10);
        if (!isNaN(value) && value > 0) {
          concurrency = value;
        }
      }
    } else if (!arg.startsWith('-')) {
      paths.push(arg);
    }
  }

  return { command: 'run', paths, bail, filter, reporter, timeoutMs, concurrency, json: false, finished: false };
}
