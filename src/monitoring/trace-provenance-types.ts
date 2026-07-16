/**
 * Trace Provenance — shared trace shape + provenance label types (Section F, slice 1).
 *
 * These declarations are the type foundation consumed by the static provenance
 * map ({@link ./trace-provenance-map.js}) and the read-only ingest adapter
 * ({@link ./trace-provenance.js}). They are split out so the shape and the
 * labels can be imported without pulling in the map/ingest logic, and so the
 * ingest module stays focused on the read-only adapter.
 *
 * The interfaces describe the session/event/tool-call/decision trace shape
 * emitted by common agent-tracing SDKs (a session of events; each event may
 * carry a model call, a tool call, and/or a decision trace, with inputs,
 * outputs, tokens, timing, and cost). They are declared here — not imported —
 * so the library stays zero-dependency and decoupled from any specific tracer;
 * only the *shape* is shared. Unknown/extra fields are tolerated.
 *
 * @tier 1 — Deterministic (types only; no AI, no IO, no network)
 * @module
 */

// ─── PROVENANCE LABEL ──────────────────────────────────────────────────────────

/**
 * Static provenance of a trace field, decided by *where the value comes from*,
 * never by what it contains.
 *
 * - `proof`   — produced by the harness/runtime/code; the agent could not author
 *               it (tool results, exit/error flags, timing, token counts,
 *               collector-computed rollups). Admissible as Tier-1 evidence.
 * - `claim`   — authored by the model; the hypothesis under test (narration,
 *               stated reasoning, a tool name/args the model *chose*). NEVER
 *               admissible as evidence — only ever the thing being falsified.
 * - `neutral` — identifiers/context that assert nothing about agent behaviour
 *               (ids, agent name, timestamps used purely for ordering,
 *               arbitrary metadata, the input prompt). Excluded from scoring.
 */
export type Provenance = 'proof' | 'claim' | 'neutral';

// ─── AGENT TRACE SHAPE (a common session/span trace format) ─────────────────────

/** A single tool/function call recorded inside an event. */
export interface TraceToolCall {
  tool_call_id?: string;
  /** Tool the model chose to invoke. CLAIM (model-authored intent). */
  tool_name?: string;
  /** Arguments the model chose. CLAIM (model-authored intent). */
  tool_input?: Record<string, unknown> | null;
  /** The harness's actual tool result. PROOF (code-produced; unforgeable). */
  tool_output?: Record<string, unknown> | null;
  /** Wall-clock time the tool ran. PROOF (harness timing). */
  timestamp?: string | number;
  /** Tool execution time in ms. PROOF (harness timing). */
  duration_ms?: number | null;
  [extra: string]: unknown;
}

/** The model's self-reported reasoning behind a decision. Entirely CLAIM. */
export interface TraceDecision {
  trace_id?: string;
  step?: number;
  /** Free-text reasoning the model authored. CLAIM (the hypothesis). */
  reasoning?: string;
  /** Alternatives the model says it considered. CLAIM. */
  alternatives_considered?: string[];
  /** The model's self-reported confidence. CLAIM. */
  confidence?: number | null;
  timestamp?: string | number;
  [extra: string]: unknown;
}

/** A single observable event in an agent's execution. */
export interface TraceEvent {
  event_id?: string;
  session_id?: string;
  /** Harness-assigned kind: llm_call, tool_call, decision, error, … PROOF. */
  event_type?: string;
  /** Event wall-clock time. PROOF (harness timing). */
  timestamp?: string | number;
  /** Input/prompt handed to the model. NEUTRAL context (not claim, not proof). */
  input_data?: Record<string, unknown> | null;
  /** Model-authored output/narration for non-tool events. CLAIM. */
  output_data?: Record<string, unknown> | null;
  /** Model identifier for an llm_call. NEUTRAL (selection key, not behaviour). */
  model?: string | null;
  /** Prompt tokens counted by the runtime. PROOF. */
  tokens_in?: number;
  /** Completion tokens counted by the runtime. PROOF. */
  tokens_out?: number;
  /** Tool call sub-record (mixed provenance — see {@link TraceToolCall}). */
  tool_call?: TraceToolCall | null;
  /** Decision sub-record (all CLAIM — see {@link TraceDecision}). */
  decision_trace?: TraceDecision | null;
  /** Event duration in ms. PROOF (harness timing). */
  duration_ms?: number | null;
  [extra: string]: unknown;
}

/** An agent tracking session: the unit F ingests. */
export interface TraceSession {
  session_id?: string;
  /** Agent name (often `model@harness` or similar). NEUTRAL selection key. */
  agent_name?: string;
  started_at?: string | number;
  ended_at?: string | number | null;
  /** Arbitrary user metadata. NEUTRAL. */
  metadata?: Record<string, unknown>;
  events?: TraceEvent[];
  /** Collector-summed prompt tokens. PROOF (code-computed rollup). */
  total_tokens_in?: number;
  /** Collector-summed completion tokens. PROOF (code-computed rollup). */
  total_tokens_out?: number;
  /** Collector-assigned status: active/completed/error. PROOF. */
  status?: string;
  [extra: string]: unknown;
}

// ─── NORMALIZED RECORDS ─────────────────────────────────────────────────────────

/**
 * One labeled field extracted from a trace. The atomic unit slice-1 produces:
 * a `(value, provenance)` pair anchored to its origin by a static `path`.
 */
export interface ProvenanceRecord {
  /** Zero-based index of the owning event within the session. */
  eventIndex: number;
  /** Harness-assigned event type (verbatim), e.g. `tool_call`. */
  eventType: string;
  /** Dotted field path within the event, e.g. `tool_call.tool_output`. */
  path: string;
  /** Static provenance label for this path (content was NOT inspected). */
  provenance: Provenance;
  /** The field's value (copied by reference; never mutated). */
  value: unknown;
}

/**
 * The result of ingesting a session: every meaningful field, partitioned by
 * static provenance, ready for the Tier 1+2 checks in later slices. CLAIM
 * records are hypotheses; PROOF records are admissible evidence; NEUTRAL
 * records are excluded from scoring.
 */
export interface TraceProvenance {
  /** Session id (or `''` if absent). */
  sessionId: string;
  /** Agent/selection label as recorded (`agent_name`). */
  agentName: string;
  /** Number of events ingested. */
  eventCount: number;
  /** All labeled records in event order, then field order. */
  records: ProvenanceRecord[];
  /** Convenience views (references into {@link records}). */
  claims: ProvenanceRecord[];
  proofs: ProvenanceRecord[];
  neutral: ProvenanceRecord[];
}
