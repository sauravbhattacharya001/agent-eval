/**
 * CLI argument parsing.
 */

export interface ParsedArgs {
  command: 'run' | 'version' | 'help';
  paths: string[];
  bail: boolean;
  filter?: string;
  reporter: 'terminal' | 'json';
  timeoutMs: number;
  concurrency: number;
}

/**
 * Parse CLI arguments into a structured options object.
 * Returns null only for truly unrecoverable parse errors.
 */
export function parseCliArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    return {
      command: 'version',
      paths: [],
      bail: false,
      reporter: 'terminal',
      timeoutMs: 30_000,
      concurrency: 1,
    };
  }

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    return {
      command: 'help',
      paths: [],
      bail: false,
      reporter: 'terminal',
      timeoutMs: 30_000,
      concurrency: 1,
    };
  }

  const command = args[0];
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

  return { command: 'run', paths, bail, filter, reporter, timeoutMs, concurrency };
}
