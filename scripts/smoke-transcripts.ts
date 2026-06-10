/**
 * Smoke test: parse the real workspace transcripts to prove the reader works
 * on production data. Invoked manually, not part of `npm test` (it would tie
 * tests to a specific user environment).
 *
 * Usage:
 *   npx tsx scripts/smoke-transcripts.ts <transcripts-root>
 */

import { argv, exit } from 'node:process';

import {
  discoverTranscripts,
  loadTranscript,
  transcriptToTimeline,
} from '../src/monitoring/index.js';
import { detectTimeout } from '../src/checks/staleness.js';

const root = argv[2];
if (!root) {
  console.error('usage: tsx scripts/smoke-transcripts.ts <transcripts-root>');
  exit(2);
}

const files = discoverTranscripts(root);
console.log(`Found ${files.length} transcripts under ${root}`);

let ok = 0;
let warn = 0;
const byOutcome: Record<string, number> = {};
const byWorker: Record<string, number> = {};
let totalDurMs = 0;
let durSamples = 0;

for (const f of files) {
  try {
    const t = loadTranscript(f);
    ok += 1;
    if (t.warnings.length > 0) warn += 1;
    byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1;
    byWorker[t.identity.worker] = (byWorker[t.identity.worker] ?? 0) + 1;
    if (Number.isFinite(t.duration.ms)) {
      totalDurMs += t.duration.ms;
      durSamples += 1;
    }
    // Bridge: feed into the existing Tier 1 staleness checks.
    const tl = transcriptToTimeline(t, { timeoutMs: 60 * 60 * 1000 });
    detectTimeout(tl);
  } catch (e) {
    console.error(`FAIL ${f.path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`Parsed: ${ok}/${files.length}`);
console.log(`With warnings: ${warn}`);
console.log('By outcome:', byOutcome);
console.log('By worker:', byWorker);
if (durSamples > 0) {
  console.log(`Avg duration: ${(totalDurMs / durSamples / 60000).toFixed(1)} min`);
}
