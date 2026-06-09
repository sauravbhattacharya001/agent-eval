/**
 * Chain Types — Multi-step prompt sequence evaluation.
 *
 * A chain is an ordered series of "steps", where each step sends a prompt
 * (potentially derived from previous outputs) and evaluates the response
 * with tier-aware assertions.
 *
 * @module
 */

import type { Assertion, EvalProvider, ProviderOptions } from '../core/types.js';
import type { TieredAssertion, TieredRunnerOptions, TieredResult } from '../core/tiered-runner.js';

// ─── CHAIN DEFINITION ───────────────────────────────────────────────────────────

/** Context passed between steps — accumulates outputs and metadata. */
export interface ChainContext {
  /** All step outputs so far, indexed by step index. */
  outputs: string[];
  /** Named outputs for keyed access. */
  namedOutputs: Record<string, string>;
  /** Metadata accumulated across steps. */
  metadata: Record<string, unknown>;
  /** The original chain-level input/task. */
  input: string;
  /** Current step index (0-based). */
  stepIndex: number;
}

/** A function that builds a prompt from chain context. */
export type PromptBuilder = (ctx: ChainContext) => string | Promise<string>;

/** A function that transforms output before assertions. */
export type OutputTransformer = (output: string, ctx: ChainContext) => string | Promise<string>;

/** A function that decides whether to proceed to the next step. */
export type GateFunction = (output: string, ctx: ChainContext) => boolean | Promise<boolean>;

/** Branch target based on output evaluation. */
export interface BranchTarget {
  /** Condition to match this branch. */
  condition: (output: string, ctx: ChainContext) => boolean | Promise<boolean>;
  /** Step index or name to jump to if condition is true. */
  target: number | string;
}

/** A single step in a chain. */
export interface ChainStep {
  /** Step name (for identification and keyed output access). */
  name: string;
  /** The prompt — either static string or dynamic builder from context. */
  prompt: string | PromptBuilder;
  /** Assertions to run on this step's output. Can be tiered or plain. */
  assertions?: Array<Assertion | TieredAssertion>;
  /** Transform output before assertions run. */
  transform?: OutputTransformer;
  /** Gate: if false, skip this step. */
  when?: GateFunction;
  /** Gate: if false after output, abort the chain at this step. */
  gate?: GateFunction;
  /** Conditional branching after this step. First match wins. */
  branches?: BranchTarget[];
  /** Provider override for this specific step. */
  provider?: EvalProvider;
  /** Provider options override for this step. */
  providerOptions?: ProviderOptions;
  /** Timeout for this step in ms. */
  timeoutMs?: number;
  /** Store output under this key in namedOutputs (defaults to step name). */
  outputKey?: string;
  /** Maximum retries on assertion failure. Default: 0 */
  retries?: number;
  /** Delay between retries in ms. Default: 0 */
  retryDelayMs?: number;
  /** Mark step as optional — failure doesn't abort the chain. */
  optional?: boolean;
}

/** Complete chain definition. */
export interface ChainDefinition {
  /** Chain name. */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** The initial input/task for the chain. */
  input: string;
  /** Default provider for all steps. */
  provider?: EvalProvider;
  /** Default provider options. */
  providerOptions?: ProviderOptions;
  /** Ordered steps to execute. */
  steps: ChainStep[];
  /** Global setup before chain runs. */
  setup?: (ctx: ChainContext) => void | Promise<void>;
  /** Global teardown after chain completes. */
  teardown?: (ctx: ChainContext) => void | Promise<void>;
  /** Tiered runner options for step-level assertions. */
  tieredOptions?: TieredRunnerOptions;
  /** Maximum total chain duration in ms. Default: 300000 (5 min) */
  maxDurationMs?: number;
  /** Whether to bail on first step failure. Default: true */
  bail?: boolean;
}

// ─── CHAIN RESULTS ──────────────────────────────────────────────────────────────

/** Status of a chain step execution. */
export type ChainStepStatus = 'pass' | 'fail' | 'skipped' | 'gated' | 'error' | 'timeout' | 'retried';

/** Result of running a single chain step. */
export interface ChainStepResult {
  /** Step name. */
  name: string;
  /** Step index. */
  index: number;
  /** Overall status. */
  status: ChainStepStatus;
  /** The prompt that was sent (after builder evaluation). */
  prompt: string;
  /** Raw output from the provider. */
  output?: string;
  /** Transformed output (if transform was applied). */
  transformedOutput?: string;
  /** Tiered assertion results (null if no assertions defined). */
  tieredResult: TieredResult | null;
  /** Duration of this step in ms. */
  durationMs: number;
  /** Number of retries attempted. */
  retriesAttempted: number;
  /** Error message if status is 'error'. */
  error?: string;
  /** Whether this step was branched to (non-sequential). */
  wasBranched: boolean;
  /** The branch target this step resolved to (if any). */
  branchTarget?: string | number;
}

/** Overall result of running a chain. */
export interface ChainResult {
  /** Chain name. */
  name: string;
  /** Overall chain pass/fail. */
  passed: boolean;
  /** Step results in execution order. */
  steps: ChainStepResult[];
  /** Final chain context (accumulated outputs, metadata). */
  context: ChainContext;
  /** Total steps executed (excluding skipped). */
  stepsExecuted: number;
  /** Steps that passed. */
  stepsPassed: number;
  /** Steps that failed. */
  stepsFailed: number;
  /** Steps skipped (by gate or bail). */
  stepsSkipped: number;
  /** Total duration. */
  durationMs: number;
  /** Whether chain was aborted (bail, timeout, gate). */
  aborted: boolean;
  /** Abort reason if applicable. */
  abortReason?: string;
}
