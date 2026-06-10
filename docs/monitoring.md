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
- `parseDuration(body)` — handles `~15 minutes`, `1h 23m 4s`, `18:00 - 18:14 PT`, bare numbers
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
