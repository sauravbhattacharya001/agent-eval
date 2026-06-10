# Production Monitoring (Phase 3.5)

`agent-eval` includes a **transcript reader** for parsing structured run
transcripts produced by long-lived agent workers. This is the foundation for
historical scoring, trend detection, and weekly scorecards: parse first, score
later.

The reader is deterministic Tier 1 — pure parsing, no AI, no network.

## Transcript format

Workers write one markdown file per run, one file per directory:

```
transcripts/
├── builder/
│   └── 2026-06-08-1815.md
├── gardener/
│   └── 2026-06-08-0900.md
└── sentinel/
    └── 2026-06-08-0615.md
```

Filenames embed the run start time as `YYYY-MM-DD-HHmm.md`. Each file has
this shape:

```markdown
# <Worker> Run — YYYY-MM-DD HH:mm PT

## Task
…

## Actions Taken
1. step one
2. step two

## Key Outputs
- commit abcd123
- file `src/foo.ts`

## Outcome
pass | fail | partial

## Errors & Retries
…

## Duration
~15 minutes
```

Sections may appear in any order. Missing sections are tolerated and surface
as `transcript.warnings`. Extra sections are preserved on
`transcript.sections` but ignored by built-in scorers.

## Quick start

```ts
import {
  discoverTranscripts,
  loadTranscript,
  transcriptToTimeline,
} from 'agent-eval';
import { detectTimeout } from 'agent-eval';

// Find all transcripts, newest first.
const files = discoverTranscripts('./transcripts');

// Or filter to a specific worker / date range.
const recent = discoverTranscripts('./transcripts', {
  workers: ['builder'],
  fromDate: '2026-06-01',
  toDate: '2026-06-08',
  limit: 10,
});

for (const f of recent) {
  const t = loadTranscript(f);
  console.log(`${t.identity.worker} ${t.identity.date} → ${t.outcome}`);

  // Bridge into the existing Tier 1 staleness checks:
  const timeline = transcriptToTimeline(t, { timeoutMs: 60 * 60 * 1000 });
  const issue = detectTimeout(timeline);
  if (issue) console.warn('  timeout:', issue.message);
}
```

## API surface

### Parsing

| Function | Purpose |
| --- | --- |
| `parseTranscript(source, options?)` | Parse a markdown string into a `Transcript`. |
| `loadTranscript(file \| path)` | Read + parse a transcript file from disk. |
| `loadTranscripts(root, options?)` | Discover + parse in one call. |
| `parseTranscriptFiles(files)` | Parse a batch with per-file error capture. |

### Discovery

| Function | Purpose |
| --- | --- |
| `discoverTranscripts(root, options?)` | List `TranscriptFile`s under a transcripts root, sorted newest first by default. |
| `rollingWindow(days, today?)` | Inclusive `{ fromDate, toDate }` for the trailing N days. |

`DiscoveryOptions` supports `workers`, `fromDate`, `toDate`, `limit`,
`order` (`'asc' \| 'desc'`), `excludeWorkers`, `includeNonConforming`.

### Bridging into Tier 1 staleness checks

The reader does not duplicate the staleness logic that already lives in
`src/checks/staleness.ts`. Instead, `transcriptToTimeline` converts a parsed
`Transcript` into the `RunTimeline` shape the existing checks consume:

```ts
const tl = transcriptToTimeline(t, {
  timeoutMs: 60 * 60 * 1000,    // 60 min budget
  expandActions: true,          // synthesize one event per action item
  emitErrorEvent: true,         // include an error event when transcript reports errors
});
```

You can then run `detectTimeout`, `detectStaleness`, `detectAbandonment`,
or any of the existing assertion factories against `tl`.

### Lower-level helpers

The parser exposes its building blocks for power users:

- `extractTitle(lines)`
- `extractSections(lines)` — returns one `TranscriptSection` per `## …` heading
- `extractListItems(body)` — numbered / bulleted lists with continuation folding
- `parseOutcome(body)` — `'pass' | 'fail' | 'partial' | 'unknown'`
- `parseDuration(body)` — handles `~15 minutes`, `1h 23m 4s`, `18:00 - 18:14 PT`, bare numbers. A clock-time **range** (`HH:mm … HH:mm`) wins over loose `N min` tokens, since transcripts often pair an exact headline range with approximate sub-durations.
- `extractTranscriptReferences(sections)` — surface commit SHAs, file paths, URLs, issue numbers
- `slugifyHeading(heading)` — deterministic section slugger

## Design notes

- **Tolerant parsing.** Missing sections produce empty strings + a warning
  rather than throwing. Same input always produces the same output, and the
  reader never fails on UTF-8 input.
- **Identity inference.** Worker name comes from (in order) the explicit
  option, the parent directory name, or the title prefix. Start time is
  parsed from the filename — workers generate filenames programmatically, so
  this is the most reliable signal.
- **Pacific timezone.** The transcript convention uses PT wall-clock times.
  The reader emits ISO timestamps with a fixed `-07:00` offset by default.
  Pass `defaultTimezone: 'auto'` to apply a PDT/PST boundary heuristic, or
  pass an explicit offset for tests.
- **No AI.** Everything in `src/monitoring/` is deterministic. Tier 2/3
  scoring of transcripts is built on top by separate modules.

## Historical scoring

The **historical scorer** runs the existing Tier 1 + Tier 2 checks against
parsed transcripts and persists one score row per check to
`transcripts/<worker>/scores.jsonl`. It is the second Phase 3.5 building block,
layered on top of the transcript reader, and feeds the trend detector and
weekly scorecard.

It is fully offline and reproducible — **no model-as-judge**. The four checks it
runs are exactly the ones the worker cannot forge or influence after the fact:

| Check | Tier | Source check | What it measures |
| --- | --- | --- | --- |
| `staleness` | 1 | `detectTimeout` | Did the run finish within its timeout budget? |
| `completeness` | 1 | `checkCompleteness` | Did it produce real deliverables vs. empty/stub output? |
| `relevance` | 2 | `analyzeRelevance` | Does the output topic match the task (TF-IDF cosine)? |
| `keyword-coverage` | 2 | `scoreKeywordCoverage` | Did it touch the key topics named in the task? |

`relevance` and `keyword-coverage` both need a `## Task` section as the
reference point. When a transcript has no task, those two checks are emitted
with `status: 'skip'` and excluded from the roll-up rather than dropped — so a
missing task never silently inflates or deflates a score.

> **Independence note.** The reference point each check compares against (the
> timeout budget, the task text, the expected-output heuristics) is something
> the scoring layer supplies from outside the worker's control surface. The
> worker never wrote the yardstick it is measured by.

### Quick start

```ts
import { scoreHistory } from 'agent-eval';

// Discover → score → persist scores.jsonl per worker.
const result = scoreHistory('./transcripts');
console.log(`scored ${result.scored}/${result.discovered} transcripts`);
for (const s of result.scores) {
  console.log(`${s.worker}/${s.runId}  overall=${s.overall.toFixed(2)}  fails=${s.failCount}`);
}
```

Filter by worker, rolling window, explicit dates, or limit — and dry-run
without writing:

```ts
scoreHistory('./transcripts', {
  workers: ['sentinel'],
  window: 7,            // trailing 7 days (or fromDate / toDate)
  timeoutMs: { sentinel: 45 * 60_000 },
  persist: false,      // compute only; do not touch scores.jsonl
});
```

Re-running is **idempotent**: rows are upserted by `(worker, runId, check)`, so
the twice-daily cron converges instead of appending duplicates.

### Scoring a single transcript

For ad-hoc use, score a parsed `Transcript` directly (pure, no filesystem):

```ts
import { loadTranscript, scoreTranscript } from 'agent-eval';

const t = loadTranscript('./transcripts/sentinel/2026-06-08-1815.md');
const score = scoreTranscript(t, { timeoutMs: 45 * 60_000 });
// score.overall   — mean of non-skipped check scores (0..1)
// score.worst     — lowest non-skipped check score
// score.checks[]  — one CheckScore per check, each with score/status/summary
```

### API surface

| Function | Module | Purpose |
| --- | --- | --- |
| `scoreTranscript(t, options?)` | `scorer` | Score one transcript → `TranscriptScore` (pure). |
| `scoreTranscripts(list, options?)` | `scorer` | Score a batch in order. |
| `toScoreRows(scores)` | `scorer` | Flatten `TranscriptScore[]` → `CheckScore[]` rows. |
| `scoreHistory(root, options?)` | `score-runner` | Discover + load + score + persist, end to end. |
| `readScores(path)` / `readAllScores(root, workers?)` | `scores-store` | Read rows back from JSONL. |
| `writeScoresFor(root, rows, options?)` | `scores-store` | Write one worker's rows (upsert by default). |
| `writeScoresByWorker(root, rows)` | `scores-store` | Fan a mixed batch out to per-worker files. |
| `upsertScores(existing, incoming)` | `scores-store` | Merge by `(worker, runId, check)` key. |

`ScoreTranscriptOptions` accepts `timeoutMs` (a single budget or a per-worker
map), `minOutputWords`, `relevanceThreshold`, `coverageThreshold`, and `now`
(for deterministic `scoredAt` in tests). Each surfaces as a tunable threshold
so scoring stays explicit rather than magic.

### Storage format

One JSON object per line — crash-safe, greppable, cheap to append:

```jsonl
{"worker":"sentinel","runId":"2026-06-08-1815","check":"staleness","tier":1,"score":1,"status":"pass","summary":"ok (17.0m)",...}
{"worker":"sentinel","runId":"2026-06-08-1815","check":"completeness","tier":1,"score":1,"status":"pass",...}
```

Each worker owns its own `scores.jsonl`; `writeScoresFor` throws if asked to
write rows spanning multiple workers. Malformed or partial lines are skipped on
read, so a half-written final line never corrupts the history.

### Design notes

- **Three modules, one job each.** `scorer.ts` is pure (no fs), `scores-store.ts`
  owns JSONL persistence, and `score-runner.ts` orchestrates the pipeline. Each
  is independently testable.
- **Per-file failure isolation.** `scoreHistory` captures parse/score errors
  per transcript on `result.errors` (with a `result.failed` count) — one corrupt
  file never aborts the batch.
- **Reuse, don't re-implement.** The scorer calls the same check functions the
  live runner uses, so a transcript scores identically whether checked at
  runtime or replayed from history.

