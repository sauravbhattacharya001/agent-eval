/**
 * Core types for agent-eval framework.
 */

/** Result status for an individual assertion. */
export type AssertionStatus = 'pass' | 'fail' | 'skip' | 'error';

/** A single assertion result with evidence. */
export interface AssertionResult {
  status: AssertionStatus;
  name: string;
  message?: string;
  expected?: string;
  actual?: string;
  evidence?: string;
  durationMs: number;
}

/** Result of running a single eval spec. */
export interface SpecResult {
  name: string;
  status: AssertionStatus;
  assertions: AssertionResult[];
  output?: string;
  durationMs: number;
  error?: string;
}

/** Result of running an entire eval suite. */
export interface SuiteResult {
  name: string;
  specs: SpecResult[];
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
}

/** An assertion function that evaluates agent output. */
export interface Assertion {
  name: string;
  evaluate(output: string, context?: EvalContext): AssertionResult | Promise<AssertionResult>;
}

/** Context passed to assertions during evaluation. */
export interface EvalContext {
  /** The original prompt/task given to the agent. */
  prompt: string;
  /** Reference materials the agent was given. */
  references?: string[];
  /** Model used to generate the output. */
  model?: string;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}

/** A single eval spec — one prompt + assertions. */
export interface EvalSpec {
  name: string;
  prompt: string;
  assertions: Assertion[];
  /** Optional reference context for hallucination checks etc. */
  references?: string[];
  /** Skip this spec. */
  skip?: boolean;
  /** Timeout in ms for generating output. */
  timeoutMs?: number;
}

/** Provider interface for generating agent outputs. */
export interface EvalProvider {
  name: string;
  generate(prompt: string, options?: ProviderOptions): Promise<string>;
}

/** Options passed to a provider. */
export interface ProviderOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** A complete eval suite definition. */
export interface EvalSuiteDefinition {
  name: string;
  provider?: EvalProvider | string;
  model?: string;
  specs: EvalSpec[];
  /** Global references available to all specs. */
  references?: string[];
  /** Setup function called before the suite runs. */
  setup?: () => void | Promise<void>;
  /** Teardown function called after the suite finishes. */
  teardown?: () => void | Promise<void>;
}

/** Reporter interface for outputting results. */
export interface Reporter {
  onSuiteStart?(suite: EvalSuiteDefinition): void;
  onSpecStart?(spec: EvalSpec): void;
  onSpecEnd?(result: SpecResult): void;
  onSuiteEnd?(result: SuiteResult): void;
  format(results: SuiteResult[]): string;
}
