/**
 * Seam tests for the Agent provider type-vocabulary split.
 *
 * `providers/agent.ts` had its type vocabulary extracted into a leaf module
 * `providers/agent-types.ts`: the public shapes (`ToolDefinition`,
 * `CapturedToolCall`, `AgentTurn`, `AgentRunResult`, `AgentProviderConfig`, the
 * four per-backend LLM configs, and their `LLMBackendConfig` union) plus the
 * internal OpenAI-compatible wire types. `agent.ts` was kept as the public
 * barrel (re-exporting the SAME public types) plus the agentic-loop engine.
 *
 * The behavioural suite in `agent-provider.test.ts` imports everything from
 * `agent.js` and therefore only reaches the moved types transitively. These
 * tests pin the seam boundary itself:
 *   1. every moved PUBLIC type is importable from its OWN new module
 *      (`agent-types.js`),
 *   2. the public barrel (`agent.js`) re-exports the SAME structural type (values
 *      built against one path assign to the other, so a future refactor cannot let
 *      the barrel silently diverge from the leaf), and
 *   3. a behaviour-preservation golden proves `AgentProvider.run(...)` still
 *      produces exactly the `AgentRunResult` shape end to end.
 *
 * Types are erased at runtime, so a "same reference" check (as used for function
 * seams) is impossible here; instead the cross-path assignments below are the
 * compile-time proof, and `tsc` in CI is what actually enforces them.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Leaf module - the new home of the vocabulary.
import type {
  ToolDefinition as ToolDefinitionLeaf,
  CapturedToolCall as CapturedToolCallLeaf,
  AgentTurn as AgentTurnLeaf,
  AgentRunResult as AgentRunResultLeaf,
  AgentProviderConfig as AgentProviderConfigLeaf,
  AzureOpenAIBackendConfig as AzureOpenAIBackendConfigLeaf,
  GeminiBackendConfig as GeminiBackendConfigLeaf,
  GroqBackendConfig as GroqBackendConfigLeaf,
  OpenRouterBackendConfig as OpenRouterBackendConfigLeaf,
  LLMBackendConfig as LLMBackendConfigLeaf,
} from '../src/providers/agent-types.js';

// Public barrel - what consumers import; must re-export the same types.
import { AgentProvider } from '../src/providers/agent.js';
import type {
  ToolDefinition as ToolDefinitionBarrel,
  CapturedToolCall as CapturedToolCallBarrel,
  AgentTurn as AgentTurnBarrel,
  AgentRunResult as AgentRunResultBarrel,
  AgentProviderConfig as AgentProviderConfigBarrel,
  AzureOpenAIBackendConfig as AzureOpenAIBackendConfigBarrel,
  GeminiBackendConfig as GeminiBackendConfigBarrel,
  GroqBackendConfig as GroqBackendConfigBarrel,
  OpenRouterBackendConfig as OpenRouterBackendConfigBarrel,
  LLMBackendConfig as LLMBackendConfigBarrel,
} from '../src/providers/agent.js';

// Top-level public barrel - the widest path these types ship through.
import type {
  AgentRunResult as AgentRunResultIndex,
  AgentProviderConfig as AgentProviderConfigIndex,
  LLMBackendConfig as LLMBackendConfigIndex,
} from '../src/index.js';

// === leaf <-> barrel identity (compile-time proof via cross-path assignment) ===

describe('agent-types seam: leaf <-> barrels are the same structural type', () => {
  it('a ToolDefinition built via the leaf type assigns to the barrel (and back)', () => {
    const viaLeaf: ToolDefinitionLeaf = {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => 'contents',
    };
    const viaBarrel: ToolDefinitionBarrel = viaLeaf;
    const backToLeaf: ToolDefinitionLeaf = viaBarrel;
    expect(backToLeaf.name).toBe('read_file');
    expect(backToLeaf).toBe(viaLeaf);
  });

  it('a CapturedToolCall unifies across leaf and barrel', () => {
    const viaLeaf: CapturedToolCallLeaf = {
      name: 'read_file',
      arguments: { path: 'a.txt' },
      result: 'ok',
      durationMs: 12,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const viaBarrel: CapturedToolCallBarrel = viaLeaf;
    expect(viaBarrel.durationMs).toBe(12);
  });

  it('an AgentTurn unifies across leaf and barrel', () => {
    const viaLeaf: AgentTurnLeaf = {
      index: 0,
      content: 'thinking',
      toolCalls: [],
      durationMs: 5,
      finishReason: 'stop',
    };
    const viaBarrel: AgentTurnBarrel = viaLeaf;
    expect(viaBarrel.index).toBe(0);
  });

  it('an AgentRunResult unifies across leaf, barrel, and the top-level index barrel', () => {
    const viaLeaf: AgentRunResultLeaf = {
      output: 'done',
      turns: [],
      timeline: { events: [] },
      totalTokens: { prompt: 1, completion: 2, total: 3 },
      durationMs: 7,
      completed: true,
      stopReason: 'complete',
    };
    const viaBarrel: AgentRunResultBarrel = viaLeaf;
    const viaIndex: AgentRunResultIndex = viaBarrel;
    const backToLeaf: AgentRunResultLeaf = viaIndex;
    expect(backToLeaf.stopReason).toBe('complete');
    expect(backToLeaf).toBe(viaLeaf);
  });

  it('AgentProviderConfig unifies across leaf, barrel, and index', () => {
    const viaLeaf: AgentProviderConfigLeaf = {
      llm: { type: 'azure-openai', endpoint: 'https://x', apiKey: 'k', deployment: 'd' },
      maxIterations: 3,
    };
    const viaBarrel: AgentProviderConfigBarrel = viaLeaf;
    const viaIndex: AgentProviderConfigIndex = viaBarrel;
    expect(viaIndex.maxIterations).toBe(3);
  });

  it('every backend config member of the LLMBackendConfig union unifies across paths', () => {
    const azure: AzureOpenAIBackendConfigLeaf = {
      type: 'azure-openai', endpoint: 'https://x', apiKey: 'k', deployment: 'd',
    };
    const gemini: GeminiBackendConfigLeaf = { type: 'gemini', apiKey: 'k' };
    const groq: GroqBackendConfigLeaf = { type: 'groq', apiKey: 'k' };
    const openrouter: OpenRouterBackendConfigLeaf = { type: 'openrouter', apiKey: 'k' };

    // Each variant assigns to the barrel-side per-backend type...
    const azureB: AzureOpenAIBackendConfigBarrel = azure;
    const geminiB: GeminiBackendConfigBarrel = gemini;
    const groqB: GroqBackendConfigBarrel = groq;
    const openrouterB: OpenRouterBackendConfigBarrel = openrouter;

    // ...and every variant widens into the union on the leaf, barrel, and index.
    const unions: LLMBackendConfigLeaf[] = [azureB, geminiB, groqB, openrouterB];
    const asBarrel: LLMBackendConfigBarrel[] = unions;
    const asIndex: LLMBackendConfigIndex[] = asBarrel;
    expect(asIndex.map((c) => c.type)).toEqual([
      'azure-openai', 'gemini', 'groq', 'openrouter',
    ]);
  });
});

// === behaviour preservation: run() still emits the exact AgentRunResult shape ===

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('agent-types seam: behaviour is preserved through the moved shapes', () => {
  it('AgentProvider.run returns an AgentRunResult assignable to the leaf type', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'All done.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })) as unknown as typeof fetch;

    const config: AgentProviderConfigLeaf = {
      llm: { type: 'azure-openai', endpoint: 'https://test.openai.azure.com', apiKey: 'k', deployment: 'gpt-4o' },
    };
    const provider = new AgentProvider(config);

    // The return value is typed via the leaf: if the barrel diverged, tsc fails.
    const out: AgentRunResultLeaf = await provider.run('Do the thing');

    expect(out.output).toBe('All done.');
    expect(out.completed).toBe(true);
    expect(out.stopReason).toBe('complete');
    expect(out.totalTokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(Array.isArray(out.turns)).toBe(true);
    expect(Array.isArray(out.timeline.events)).toBe(true);

    // Each turn is a well-formed AgentTurn (type-erased field-level proof).
    for (const turn of out.turns) {
      const t: AgentTurnLeaf = turn;
      expect(typeof t.index).toBe('number');
      expect(typeof t.content).toBe('string');
      expect(Array.isArray(t.toolCalls)).toBe(true);
      expect(typeof t.finishReason).toBe('string');
    }
  });
});
