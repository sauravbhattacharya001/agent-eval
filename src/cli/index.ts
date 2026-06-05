#!/usr/bin/env node

/**
 * agent-eval CLI entry point.
 * Placeholder — full implementation in a later run.
 */

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log('agent-eval v0.1.0');
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
agent-eval — Test and evaluate AI agent outputs

Usage:
  agent-eval run <specs-dir>    Run eval specs
  agent-eval --version          Show version
  agent-eval --help             Show this help

Examples:
  agent-eval run ./specs/
  agent-eval run ./specs/ --bail
  agent-eval run ./specs/ --filter "hallucination"
`);
  process.exit(0);
}

console.error(`Unknown command: ${args[0]}`);
console.error('Run "agent-eval --help" for usage.');
process.exit(1);
