/**
 * Tiered Runner — Cost Pyramid Orchestration
 *
 * Runs eval assertions in tier order (1 → 2 → 3), short-circuiting
 * when a cheaper tier catches a failure. This is the "don't run Tier 3
 * on output that can't even parse as JSON" principle.
 *
 * Cost model:
 * - Tier 1: FREE, instant, deterministic
 * - Tier 2: ¢¢, seconds, statistical/heuristic
 * - Tier 3: $$$, seconds, LLM-based
 *
 * If Tier 1 fails → stop (60% of failures caught here)
 * If Tier 2 fails → stop (30% of failures caught here)
 * Only Tier 3 runs on the 10% that pass both lower tiers.
 *
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Tier classification for an assertion. */
export type Tier = 1 | 2 | 3;

/** An assertion with explicit tier classification. */
export interface TieredAssertion {
  tier: Tier;
  assertion: Assertion;
}

/** Options for the tiered runner. */
export interface TieredRunnerOptions {
  /** Whether to short-circuit on first failure at each tier. Default: true */
  shortCircuit?: boolean;
  /** Whether to skip Tier 3 entirely (useful for cost control). Default: false */
  skipTier3?: boolean;
  /** Whether to continue to next tier even if current tier has failures. Default: false */
  runAllTiers?: boolean;
  /** Maximum total assertions to run (cost cap). Default: unlimited */
  maxAssertions?: number;
}

/** Result of the tiered evaluation. */
export interface TieredResult {
  /** Overall pass/fail. */
  passed: boolean;
  /** Which tier caught the failure (null if passed). */
  failedAtTier: Tier | null;
  /** Results per tier. */
  tiers: {
    tier1: TierResult;
    tier2: TierResult;
    tier3: TierResult;
  };
  /** All assertion results in execution order. */
  allResults: AssertionResult[];
  /** Total assertions run (for cost tracking). */
  totalRun: number;
  /** Total assertions skipped due to short-circuit. */
  totalSkipped: number;
  /** Total duration. */
  durationMs: number;
}

/** Result for a single tier. */
export interface TierResult {
  /** Whether this tier was run. */
  ran: boolean;
  /** Number of assertions in this tier. */
  total: number;
  /** Number that passed. */
  passed: number;
  /** Number that failed. */
  failed: number;
  /** Number skipped. */
  skipped: number;
  /** Duration of this tier's assertions. */
  durationMs: number;
  /** Individual results. */
  results: AssertionResult[];
}

// ─── TIER DETECTION ─────────────────────────────────────────────────────────────

/**
 * Auto-detect tier from assertion name conventions.
 *
 * Naming conventions:
 * - [Tier 1] or [Tier 1+2] prefix → Tier 1
 * - [Tier 2] prefix → Tier 2
 * - [Tier 3] prefix → Tier 3
 * - Contains "judge", "rubric", "consensus" → Tier 3
 * - Contains "hallucin", "relevance", "topic", "repetit" → Tier 2
 * - Default → Tier 1
 */
export function detectTier(assertion: Assertion): Tier {
  const name = assertion.name.toLowerCase();

  // Explicit tier markers
  if (name.includes('[tier 3]')) return 3;
  if (name.includes('[tier 2]')) return 2;
  if (name.includes('[tier 1]')) return 1;
  if (name.includes('[tier 1+2]')) return 1; // Mixed starts at lowest tier

  // Keyword detection
  if (name.includes('judge') || name.includes('rubric') || name.includes('consensus') || name.includes('adversarial')) return 3;
  if (name.includes('hallucin') || name.includes('relevance') || name.includes('topic') || name.includes('repetit') || name.includes('drift') || name.includes('saturat') || name.includes('grounding')) return 2;

  // Default to Tier 1 (cheapest assumption)
  return 1;
}

/**
 * Classify an array of assertions into tiers.
 * Uses explicit TieredAssertion if provided, otherwise auto-detects.
 */
export function classifyAssertions(
  assertions: Array<Assertion | TieredAssertion>,
): Map<Tier, Assertion[]> {
  const result = new Map<Tier, Assertion[]>([
    [1, []],
    [2, []],
    [3, []],
  ]);

  for (const item of assertions) {
    if ('tier' in item && 'assertion' in item) {
      result.get(item.tier)!.push(item.assertion);
    } else {
      const tier = detectTier(item as Assertion);
      result.get(tier)!.push(item as Assertion);
    }
  }

  return result;
}

// ─── TIERED RUNNER ──────────────────────────────────────────────────────────────

/**
 * Run assertions in tier order with short-circuit on failure.
 *
 * The cost pyramid: run cheap checks first, escalate only when they pass.
 *
 * @example
 * ```ts
 * const result = await runTiered(output, [
 *   // Tier 1 — free
 *   toBeValidJson(),
 *   toNotBeAbandoned(),
 *   toHaveMeaningfulDiff(before),
 *   // Tier 2 — cheap
 *   toNotHallucinate(refs),
 *   toNotRepeat(),
 *   toBeRelevantTo(task),
 *   // Tier 3 — expensive
 *   toPassJudge(backend, rubric),
 * ], { prompt: task });
 *
 * if (!result.passed) {
 *   console.log(`Failed at Tier ${result.failedAtTier}`);
 * }
 * ```
 */
export async function runTiered(
  output: string,
  assertions: Array<Assertion | TieredAssertion>,
  context?: EvalContext,
  options: TieredRunnerOptions = {},
): Promise<TieredResult> {
  const start = performance.now();
  const {
    shortCircuit = true,
    skipTier3 = false,
    runAllTiers = false,
    maxAssertions,
  } = options;

  const classified = classifyAssertions(assertions);
  const allResults: AssertionResult[] = [];
  let totalRun = 0;
  let totalSkipped = 0;
  let failedAtTier: Tier | null = null;

  const tiers: TieredResult['tiers'] = {
    tier1: { ran: false, total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, results: [] },
    tier2: { ran: false, total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, results: [] },
    tier3: { ran: false, total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0, results: [] },
  };

  const tierKeys: Array<[Tier, keyof TieredResult['tiers']]> = [
    [1, 'tier1'],
    [2, 'tier2'],
    [3, 'tier3'],
  ];

  for (const [tier, key] of tierKeys) {
    const tierAssertions = classified.get(tier) ?? [];
    const tierResult = tiers[key];
    tierResult.total = tierAssertions.length;

    // Skip conditions
    if (skipTier3 && tier === 3) {
      tierResult.skipped = tierAssertions.length;
      totalSkipped += tierAssertions.length;
      continue;
    }

    if (!runAllTiers && failedAtTier !== null) {
      tierResult.skipped = tierAssertions.length;
      totalSkipped += tierAssertions.length;
      continue;
    }

    if (tierAssertions.length === 0) continue;

    tierResult.ran = true;
    const tierStart = performance.now();

    for (const assertion of tierAssertions) {
      if (maxAssertions && totalRun >= maxAssertions) {
        tierResult.skipped++;
        totalSkipped++;
        continue;
      }

      try {
        const result = await assertion.evaluate(output, context);
        tierResult.results.push(result);
        allResults.push(result);
        totalRun++;

        if (result.status === 'pass') {
          tierResult.passed++;
        } else if (result.status === 'fail') {
          tierResult.failed++;
          if (failedAtTier === null) failedAtTier = tier;
          if (shortCircuit) break;
        } else if (result.status === 'skip') {
          tierResult.skipped++;
        } else {
          tierResult.failed++; // errors count as failures
          if (failedAtTier === null) failedAtTier = tier;
          if (shortCircuit) break;
        }
      } catch (err) {
        const errorResult: AssertionResult = {
          status: 'error',
          name: assertion.name,
          message: `Assertion threw: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: 0,
        };
        tierResult.results.push(errorResult);
        allResults.push(errorResult);
        tierResult.failed++;
        totalRun++;
        if (failedAtTier === null) failedAtTier = tier;
        if (shortCircuit) break;
      }
    }

    tierResult.durationMs = performance.now() - tierStart;

    // Short-circuit remaining assertions in this tier if we broke out
    if (shortCircuit && tierResult.failed > 0) {
      const remaining = tierAssertions.length - tierResult.results.length;
      tierResult.skipped += remaining;
      totalSkipped += remaining;
    }
  }

  return {
    passed: failedAtTier === null,
    failedAtTier,
    tiers,
    allResults,
    totalRun,
    totalSkipped,
    durationMs: performance.now() - start,
  };
}

// ─── HELPER: TIER WRAPPERS ──────────────────────────────────────────────────────

/** Explicitly mark an assertion as Tier 1 (deterministic). */
export function tier1(assertion: Assertion): TieredAssertion {
  return { tier: 1, assertion };
}

/** Explicitly mark an assertion as Tier 2 (heuristic/statistical). */
export function tier2(assertion: Assertion): TieredAssertion {
  return { tier: 2, assertion };
}

/** Explicitly mark an assertion as Tier 3 (model-as-judge). */
export function tier3(assertion: Assertion): TieredAssertion {
  return { tier: 3, assertion };
}
