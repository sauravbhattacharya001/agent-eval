/**
 * gen-report.mjs - run ONE triage pass over three real-schema trace exports
 * (OTLP + LangSmith + AgentLens) and write a clean, legible report to disk.
 *
 * This is the product: post-hoc, offline, deterministic (Tier 1/2). No model,
 * no API key, no gate. It reports process failures worst-first; a human reads
 * it and decides the fix.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseOtlp, parseLangSmith, parseAgentLens,
  triageBuilt, renderTriageTable,
} from '../dist/index.js';

const TRACES = [
  { tool: 'OpenTelemetry (Phoenix/Traceloop)', file: 'otlp-trace.real-schema.json',      parse: parseOtlp },
  { tool: 'LangSmith',                          file: 'langsmith-export.real-schema.json', parse: parseLangSmith },
  { tool: 'AgentLens',                          file: 'agentlens-export.real-schema.json', parse: parseAgentLens },
];

// Ingest all three formats into one unified list of sessions.
const sessions = TRACES.flatMap((t) =>
  t.parse(readFileSync(join('demo', 'traces', t.file), 'utf8')));

const DOLLARS_PER_MTOK = 9;
const report = triageBuilt(sessions, { dollarsPerMillionTokens: DOLLARS_PER_MTOK });

// renderTriageTable() already emits a summary line + the ranked table, so we do
// not duplicate the summary ourselves. Keep all our own prose ASCII-only.
const table = renderTriageTable(report);
const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// Per-row actionable diagnosis, straight from row.diagnosis (real trace fields).
function fmtGap(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const diagnoses = report.rows.map((r, i) => {
  const d = r.diagnosis ?? {};
  const where = d.lastEventType
    ? `last event: \`${d.lastEventType}\`${d.lastRole ? ` (${d.lastRole})` : ''}`
    : 'last event: unknown';
  const activity = `${d.eventCount ?? 0} events, ${d.assistantCount ?? 0} assistant turns` +
    `, longest silence ${fmtGap(d.longestGapMs)}` +
    (d.hadTrajectory ? '' : ' _(no trajectory — lower-confidence timing)_');
  const signals = (d.signals && d.signals.length)
    ? d.signals.map((s) => `\`${s}\``).join(', ')
    : '_none recorded_';
  const findings = (d.findings && d.findings.length)
    ? d.findings.map((f) => `  - ${f}`).join('\n')
    : '  - _(no deterministic issue lines)_';
  const contradiction = (d.contradictions && d.contradictions.length)
    ? '\n' + d.contradictions.map((c) => `- **[!] Contradiction:** ${c}`).join('\n')
    : '';
  return `### ${i + 1}. \`${r.id}\` — ${r.kind} (~$${r.projectedCostUsd.toFixed(0)})
${contradiction}
- **Where it stopped:** ${where}
- **Activity:** ${activity}
- **Signals that fired:** ${signals}
- **Findings:**
${findings}`;
}).join('\n\n');

const md = `# agent-eval - trace triage report

_Generated ${when} - deterministic Tier 1/2, offline._

**Sources ingested (one pass, three formats):**
${TRACES.map((t) => `- \`${t.file}\` - ${t.tool}`).join('\n')}

${table}
${report.rows.length ? `\n## Diagnosis (per run, worst-first)\n\n${diagnoses}\n` : ''}`;

writeFileSync('reports/triage-report.md', md, 'utf8');
writeFileSync('reports/triage-report.json', JSON.stringify(report, null, 2), 'utf8');

console.log('Wrote reports/triage-report.md and reports/triage-report.json');
console.log(`  scanned=${report.scanned} flagged=${report.flagged} costly=${report.costly} waste=$${report.projectedCostUsd.toFixed(0)}`);
