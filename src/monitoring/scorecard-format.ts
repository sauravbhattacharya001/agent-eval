/**
 * Scorecard renderers — the human-facing surface of the monitoring pipeline.
 *
 * Split out of `scorecard.ts` along the orchestration/formatting seam: this
 * module holds ONLY the pure `(Scorecard) -> string` renderers and their
 * private display helpers. {@link aggregateScorecard} (the grouping/sorting
 * orchestration) stays in `scorecard.ts`, which re-exports these so consumers
 * keep the single import path at `./scorecard.js`.
 *
 * Everything here is pure formatting over an already-aggregated
 * {@link Scorecard}: no filesystem, no clock, no model-as-judge — reproducible
 * and offline by construction.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import {
  type HealthGrade,
  type Scorecard,
  GRADE_LABEL,
  GRADE_RANK,
} from './scorecard-types.js';

// ─── DISPLAY HELPERS (private) ─────────────────────────────────────────────────────

/**
 * Escape arbitrary text for safe interpolation into a Markdown table cell.
 *
 * Worker names and check ids flow in from transcript filenames and check
 * registrations, so a stray `|` would terminate the column early and an
 * embedded newline would split the row — silently corrupting the table
 * structure. This escapes `\` and `|` and folds CR/LF to a space, preserving
 * all characters (well-behaved content is returned unchanged).
 */
function mdCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function pctStr(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'n/a';
}

function scoreStr(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

/** Describe the covered window as a short string, or 'all-time' when absent. */
function windowLabel(window: Scorecard['window']): string {
  if (!window) return 'all-time';
  const { fromDate, toDate } = window;
  if (fromDate && toDate) return `${fromDate} .. ${toDate}`;
  if (fromDate) return `since ${fromDate}`;
  if (toDate) return `until ${toDate}`;
  return 'all-time';
}

/** Pad/truncate a string to a fixed display width. */
function fixed(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length > width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

// ─── FORMATTERS ──────────────────────────────────────────────────────────────────

/**
 * Render a compact terminal scorecard — the kind a cron worker drops into a
 * status file or a chat alert. A header, one aligned line per worker (grade,
 * pass rate, mean score, runs, trend arrow, top failure), then a fleet summary.
 *
 * @param card - A {@link Scorecard}.
 * @param options.maxFailures - Cap the failure categories shown per worker.
 *   Default: 3.
 */
export function formatScorecard(
  card: Scorecard,
  options: { maxFailures?: number } = {},
): string {
  const maxFailures = options.maxFailures ?? 3;
  const lines: string[] = [];

  const t = card.totals;
  lines.push(
    `Scorecard (${windowLabel(card.window)}) — ${t.workers} worker(s), ` +
      `${t.runs} run(s), fleet pass ${pctStr(t.passRate)}`,
  );

  if (card.workers.length === 0) {
    lines.push('  (no scored runs)');
    return lines.join('\n');
  }

  // Aligned columns: grade | worker | pass | mean | runs | arrow | failures.
  const nameWidth = Math.min(
    18,
    Math.max(6, ...card.workers.map((w) => w.worker.length)),
  );

  for (const w of card.workers) {
    const grade = fixed(GRADE_LABEL[w.grade], 5);
    const name = fixed(w.worker, nameWidth);
    const pass = fixed(pctStr(w.passRate), 4);
    const score = fixed(scoreStr(w.meanScore), 4);
    const runs = fixed(`${w.runs}r`, 4);
    const fails =
      w.failureCategories.length === 0
        ? 'clean'
        : w.failureCategories
            .slice(0, maxFailures)
            .map((f) => `${f.check}:${f.count}`)
            .join(' ') +
          (w.failureCategories.length > maxFailures
            ? ` +${w.failureCategories.length - maxFailures}`
            : '');
    lines.push(
      `  ${grade} ${name}  pass ${pass}  score ${score}  ${runs}  ${w.trend.arrow}  ${fails}`,
    );
  }

  // Fleet trend + grade tally footer.
  const gradeBits = (Object.keys(GRADE_RANK) as HealthGrade[])
    .sort((a, b) => GRADE_RANK[a] - GRADE_RANK[b])
    .filter((g) => t.grades[g] > 0)
    .map((g) => `${GRADE_LABEL[g]}=${t.grades[g]}`);
  lines.push(
    `  ── ${gradeBits.join(' ')} · trends ↓${t.degradingTrends} ↑${t.improvingTrends}`,
  );

  return lines.join('\n');
}

/**
 * Render the scorecard as a Markdown document — the format for a weekly report
 * dropped into a status file, a memory note, or a PR comment. A summary line, a
 * worker table with trend arrows, and per-worker failure/check drill-downs.
 *
 * @param card - A {@link Scorecard}.
 * @param options.title - Heading text. Default: "Weekly Scorecard".
 * @param options.maxFailures - Cap failure categories per worker in the table.
 *   Default: 3.
 * @param options.includeChecks - Add a per-check breakdown section. Default: true.
 */
export function formatScorecardMarkdown(
  card: Scorecard,
  options: { title?: string; maxFailures?: number; includeChecks?: boolean } = {},
): string {
  const title = options.title ?? 'Weekly Scorecard';
  const maxFailures = options.maxFailures ?? 3;
  const includeChecks = options.includeChecks ?? true;
  const t = card.totals;
  const out: string[] = [];

  out.push(`# ${title}`);
  out.push('');
  out.push(`**Window:** ${windowLabel(card.window)}  `);
  out.push(`**Generated:** ${card.generatedAt}  `);
  out.push(
    `**Fleet:** ${t.workers} worker(s) · ${t.runs} run(s) · ` +
      `pass ${pctStr(t.passRate)} · mean ${scoreStr(t.meanScore)} · ` +
      `trends ↓${t.degradingTrends} ↑${t.improvingTrends}`,
  );
  out.push('');

  if (card.workers.length === 0) {
    out.push('_No scored runs in this window._');
    return out.join('\n');
  }

  // Worker summary table.
  out.push('| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |');
  out.push('|---|---|---:|---:|---:|---:|:---:|---|');
  for (const w of card.workers) {
    const fails =
      w.failureCategories.length === 0
        ? '—'
        : w.failureCategories
            .slice(0, maxFailures)
            .map((f) => `${mdCell(f.check)} (${f.count})`)
            .join(', ') +
          (w.failureCategories.length > maxFailures
            ? `, +${w.failureCategories.length - maxFailures} more`
            : '');
    out.push(
      `| ${mdCell(w.worker)} | ${GRADE_LABEL[w.grade]} | ${pctStr(w.passRate)} | ` +
        `${scoreStr(w.meanScore)} | ${scoreStr(w.worstScore)} | ${w.runs} | ` +
        `${w.trend.arrow} | ${fails} |`,
    );
  }
  out.push('');

  if (includeChecks) {
    out.push('## Per-check breakdown');
    out.push('');
    for (const w of card.workers) {
      if (w.checks.length === 0) continue;
      out.push(`### ${w.worker} — ${GRADE_LABEL[w.grade]} ${w.trend.arrow}`);
      out.push('');
      out.push('| Check | Mean | Pass | Warn | Fail | Runs |');
      out.push('|---|---:|---:|---:|---:|---:|');
      for (const c of w.checks) {
        out.push(
          `| ${mdCell(c.check)} | ${scoreStr(c.meanScore)} | ${c.passes} | ` +
            `${c.warns} | ${c.fails} | ${c.runs} |`,
        );
      }
      if (w.trend.direction !== 'none') {
        out.push('');
        out.push(`_Trend: ${w.trend.summary} (${w.trend.arrow})._`);
      }
      out.push('');
    }
  }

  return out.join('\n').trimEnd() + '\n';
}
