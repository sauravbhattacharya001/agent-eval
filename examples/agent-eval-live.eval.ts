/**
 * Example: Evaluating a live agentic run with full pipeline.
 *
 * This demonstrates the complete flow:
 * 1. Define tools for the agent
 * 2. Run the agent against a real LLM (Azure OpenAI)
 * 3. Evaluate the run with tiered assertions (Tier 1 → 2 → 3)
 * 4. Use the captured timeline for staleness/loop checks
 *
 * To run (requires Azure OpenAI credentials):
 *   AZURE_OPENAI_ENDPOINT=https://... AZURE_OPENAI_API_KEY=... npx tsx examples/agent-eval-live.eval.ts
 */

import {
  defineEval,
  AgentProvider,
  defineTool,
  agentContext,
  runTiered,
  tier1,
  tier2,
  tier3,
  toBeValidJson,
  toBeNonEmpty,
  toBeRelevantTo,
  toNotRepeat,
  toNotBeStale,
  toNotBeAbandoned,
  toHaveMeaningfulDiff,
  toPassJudge,
  BUILTIN_RUBRICS,
  LLMJudgeBackend,
  runSuite,
  TerminalReporter,
} from '../src/index.js';

// ─── TOOLS ──────────────────────────────────────────────────────────────────────

const readFile = defineTool('read_file')
  .describe('Read a file and return its contents')
  .param('path', 'string', 'Path to the file', true)
  .execute(async (args) => {
    // Simulated file system for the example
    const files: Record<string, string> = {
      'auth.ts': `
export function authenticate(token: string): boolean {
  // TODO: this is insecure - using string comparison
  return token === "hardcoded-secret-123";
}

export function hashPassword(password: string): string {
  return password; // BUG: not actually hashing!
}
      `,
      'config.json': '{ "port": 3000, "debug": true, "secret": "should-not-be-here" }',
    };
    const content = files[args.path as string];
    if (!content) return `Error: File not found: ${args.path}`;
    return content;
  });

const writeFile = defineTool('write_file')
  .describe('Write content to a file')
  .param('path', 'string', 'Path to write', true)
  .param('content', 'string', 'File content', true)
  .execute(async (args) => {
    return `Successfully wrote ${(args.content as string).length} bytes to ${args.path}`;
  });

// ─── PROVIDER ───────────────────────────────────────────────────────────────────

const provider = new AgentProvider({
  llm: {
    type: 'groq',
    apiKey: process.env.GROQ_API_KEY ?? '',
    model: 'llama-3.3-70b-versatile',
  },
  tools: [readFile, writeFile],
  systemPrompt: 'You are a security auditor. Review code for vulnerabilities and fix them.',
  maxIterations: 8,
  maxDurationMs: 60000,
});

// ─── EVAL SUITE ─────────────────────────────────────────────────────────────────

const suite = defineEval({
  name: 'Security audit agent — live evaluation',
  provider,
  specs: [
    {
      name: 'finds and fixes hardcoded credentials',
      prompt: 'Review auth.ts and config.json for security issues. Fix any vulnerabilities you find.',
      assertions: [
        // These work with the standard EvalProvider interface
        toBeNonEmpty(),
        toBeRelevantTo({ task: 'security hardcoded secret hashing password vulnerability', threshold: 0.05 }),
      ],
    },
  ],
});

// ─── TIERED EVALUATION (using AgentProvider.run directly) ───────────────────────

async function runTieredEval() {
  console.log('=== Running tiered evaluation on live agent ===\n');

  // Run the agent
  const result = await provider.run(
    'Review auth.ts and config.json for security issues. Fix any vulnerabilities you find.'
  );

  console.log(`Agent completed in ${result.durationMs}ms`);
  console.log(`Turns: ${result.turns.length}, Stop reason: ${result.stopReason}`);
  console.log(`Tokens: ${result.totalTokens.total} total\n`);

  // Get the "before" content for diff checks
  const originalCode = `
export function authenticate(token: string): boolean {
  return token === "hardcoded-secret-123";
}
export function hashPassword(password: string): string {
  return password;
}
  `;

  // Set up the LLM judge for Tier 3
  const judgeBackend = new LLMJudgeBackend({
    type: 'groq',
    apiKey: process.env.GROQ_API_KEY!,
    model: 'llama-3.3-70b-versatile',
  });
  const codeReviewRubric = BUILTIN_RUBRICS.codeReview();

  // Run tiered assertions
  const tieredResult = await runTiered(result.output, [
    // Tier 1 — Deterministic (free, instant)
    tier1(toBeNonEmpty()),
    tier1(toNotBeAbandoned(result.timeline)),
    tier1(toHaveMeaningfulDiff(originalCode)),

    // Tier 2 — Heuristic (cheap, seconds)
    tier2(toBeRelevantTo({ task: 'security hardcoded secret hashing password vulnerability', threshold: 0.05 })),
    tier2(toNotRepeat()),
    tier2(toNotBeStale(result.timeline)),

    // Tier 3 — Model-as-Judge ($$$, seconds)
    tier3(toPassJudge(judgeBackend, codeReviewRubric)),
  ], { prompt: 'Review auth.ts for security issues' });

  console.log('\n=== Tiered Results ===');
  console.log(`Overall: ${tieredResult.passed ? '✅ PASS' : '❌ FAIL'}`);
  if (tieredResult.failedAtTier) {
    console.log(`Failed at: Tier ${tieredResult.failedAtTier}`);
  }
  console.log(`Ran: ${tieredResult.totalRun}, Skipped: ${tieredResult.totalSkipped}`);
  console.log(`Duration: ${tieredResult.durationMs.toFixed(0)}ms`);

  for (const [tier, key] of [[1, 'tier1'], [2, 'tier2'], [3, 'tier3']] as const) {
    const t = tieredResult.tiers[key as keyof typeof tieredResult.tiers];
    if (t.ran) {
      console.log(`  Tier ${tier}: ${t.passed}/${t.total} passed`);
    }
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────────

// Only run if credentials are available
if (process.env.GROQ_API_KEY) {
  // Standard suite
  const reporter = new TerminalReporter({ verbose: true });
  const suiteResult = await runSuite(suite, { reporters: [reporter] });
  console.log(reporter.format([suiteResult]));

  // Tiered evaluation
  await runTieredEval();
} else {
  console.log('⏭️  Skipping live eval — set GROQ_API_KEY to run');
  console.log('\nExample usage:');
  console.log('  GROQ_API_KEY=*** npx tsx examples/agent-eval-live.eval.ts');
}
