/**
 * Chain Context Utilities — Helpers for working with chain context in prompts.
 *
 * These utilities make it ergonomic to reference previous outputs, build
 * prompts that depend on chain state, and extract structured data from
 * intermediate outputs.
 *
 * @module
 */

import type { ChainContext } from './types.js';

// ─── CONTEXT ACCESSORS ──────────────────────────────────────────────────────────

/**
 * Get the previous step's output. Returns empty string if no previous output.
 */
export function previousOutput(ctx: ChainContext): string {
  const outputs = ctx.outputs.filter((o) => o !== undefined);
  return outputs.length > 0 ? (outputs[outputs.length - 1] ?? '') : '';
}

/**
 * Get a named output from the context.
 * Throws if the key doesn't exist (catches misspelled keys early).
 */
export function namedOutput(ctx: ChainContext, key: string): string {
  if (!(key in ctx.namedOutputs)) {
    const available = Object.keys(ctx.namedOutputs).join(', ') || '(none)';
    throw new Error(
      `Chain context has no output named "${key}". Available: ${available}`,
    );
  }
  return ctx.namedOutputs[key] ?? '';
}

/**
 * Get a named output or a fallback if not present.
 */
export function namedOutputOr(ctx: ChainContext, key: string, fallback: string): string {
  return ctx.namedOutputs[key] ?? fallback;
}

/**
 * Get output at a specific step index.
 */
export function outputAt(ctx: ChainContext, index: number): string {
  if (index < 0 || index >= ctx.outputs.length) {
    throw new Error(
      `Chain context has no output at index ${index}. Available indices: 0-${ctx.outputs.length - 1}`,
    );
  }
  return ctx.outputs[index] ?? '';
}

/**
 * Get all outputs collected so far.
 */
export function allOutputs(ctx: ChainContext): string[] {
  return ctx.outputs.filter((o) => o !== undefined);
}

// ─── PROMPT TEMPLATES ───────────────────────────────────────────────────────────

/**
 * Create a prompt that interpolates chain context values.
 *
 * Template syntax:
 * - `{{input}}` → chain input
 * - `{{prev}}` → previous step output
 * - `{{output.name}}` → named output
 * - `{{output[0]}}` → output at index
 * - `{{meta.key}}` → metadata value
 *
 * @example
 * ```ts
 * step('verify')
 *   .prompt(template('Is this correct? "{{output.explain}}"'))
 *   .build()
 * ```
 */
export function template(templateStr: string): (ctx: ChainContext) => string {
  return (ctx: ChainContext): string => {
    return templateStr.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
      const trimmed = expr.trim();

      if (trimmed === 'input') {
        return ctx.input;
      }

      if (trimmed === 'prev') {
        return previousOutput(ctx);
      }

      // Named output: {{output.name}}
      const namedMatch = trimmed.match(/^output\.(.+)$/);
      if (namedMatch) {
        const key = namedMatch[1] ?? '';
        return ctx.namedOutputs[key] ?? `[missing: ${key}]`;
      }

      // Indexed output: {{output[0]}}
      const indexMatch = trimmed.match(/^output\[(\d+)\]$/);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1] ?? '0', 10);
        return ctx.outputs[idx] ?? `[missing: output[${idx}]]`;
      }

      // Metadata: {{meta.key}}
      const metaMatch = trimmed.match(/^meta\.(.+)$/);
      if (metaMatch) {
        const key = metaMatch[1] ?? '';
        const value = ctx.metadata[key];
        return value !== undefined ? String(value) : `[missing: meta.${key}]`;
      }

      return `[unknown: ${trimmed}]`;
    });
  };
}

/**
 * Create a prompt that passes previous output with a follow-up question.
 *
 * @example
 * ```ts
 * step('follow-up')
 *   .prompt(followUp('Can you explain that more simply?'))
 *   .build()
 * ```
 */
export function followUp(question: string): (ctx: ChainContext) => string {
  return (ctx: ChainContext): string => {
    const prev = previousOutput(ctx);
    return `Given this previous response:\n\n${prev}\n\n${question}`;
  };
}

/**
 * Create a prompt that asks the model to refine its previous output.
 *
 * @example
 * ```ts
 * step('refine')
 *   .prompt(refine('Make it more concise and add code examples'))
 *   .build()
 * ```
 */
export function refine(instruction: string): (ctx: ChainContext) => string {
  return (ctx: ChainContext): string => {
    const prev = previousOutput(ctx);
    return `Here is your previous response:\n\n${prev}\n\nPlease revise it with the following instruction: ${instruction}`;
  };
}

/**
 * Create a prompt that validates or fact-checks a previous output.
 *
 * @example
 * ```ts
 * step('validate')
 *   .prompt(validate('Check all claims for accuracy'))
 *   .build()
 * ```
 */
export function validate(criteria: string): (ctx: ChainContext) => string {
  return (ctx: ChainContext): string => {
    const prev = previousOutput(ctx);
    return `Please review the following text and ${criteria}:\n\n${prev}\n\nProvide your assessment with specific examples of any issues found.`;
  };
}

/**
 * Create a prompt that summarizes all outputs so far.
 *
 * @example
 * ```ts
 * step('summarize')
 *   .prompt(summarizeChain('Provide a brief summary of the conversation'))
 *   .build()
 * ```
 */
export function summarizeChain(instruction: string): (ctx: ChainContext) => string {
  return (ctx: ChainContext): string => {
    const outputs = allOutputs(ctx);
    const formatted = outputs
      .map((o, i) => `--- Step ${i + 1} ---\n${o}`)
      .join('\n\n');
    return `${instruction}\n\nConversation history:\n\n${formatted}`;
  };
}

// ─── CONTEXT METADATA HELPERS ───────────────────────────────────────────────────

/**
 * Set metadata on the chain context (for use in setup or step transforms).
 */
export function setMeta(ctx: ChainContext, key: string, value: unknown): void {
  ctx.metadata[key] = value;
}

/**
 * Get typed metadata from chain context.
 */
export function getMeta<T>(ctx: ChainContext, key: string): T | undefined {
  return ctx.metadata[key] as T | undefined;
}

/**
 * Increment a numeric counter in metadata.
 */
export function incrementMeta(ctx: ChainContext, key: string, by = 1): number {
  const current = (ctx.metadata[key] as number) ?? 0;
  ctx.metadata[key] = current + by;
  return current + by;
}

// ─── OUTPUT EXTRACTION ──────────────────────────────────────────────────────────

/**
 * Extract JSON from an output string (handles markdown code fences).
 */
export function extractJson<T = unknown>(output: string): T | null {
  // Try direct parse first
  try {
    return JSON.parse(output) as T;
  } catch {
    // Try extracting from code fence
    const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1] ?? '') as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Extract a section from markdown output by heading.
 */
export function extractSection(output: string, heading: string): string | null {
  const headingPattern = new RegExp(
    `^#{1,6}\\s+${escapeRegex(heading)}\\s*$`,
    'mi',
  );
  const match = headingPattern.exec(output);
  if (!match) return null;

  const start = (match.index ?? 0) + match[0].length;
  // Find next heading of same or higher level
  const headingHashes = match[0].match(/^#+/);
  const headingLevel = headingHashes ? headingHashes[0].length : 1;
  const nextHeading = output.slice(start).search(
    new RegExp(`^#{1,${headingLevel}}\\s`, 'm'),
  );

  const end = nextHeading === -1 ? output.length : start + nextHeading;
  return output.slice(start, end).trim();
}

/**
 * Extract a list from output (bullet points or numbered).
 */
export function extractList(output: string): string[] {
  const lines = output.split('\n');
  const items: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]|\d+[.)]\s)\s*(.*)/);
    if (match) {
      items.push((match[1] ?? '').trim());
    }
  }

  return items;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
