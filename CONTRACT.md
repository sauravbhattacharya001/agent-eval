# Transcript Contract (v1)

`transcript-contract@v1`

The **transcript contract** is the interface between whatever *produces* an agent
run transcript and agent-eval, which *consumes* it (parses, validates, scores).

You can satisfy this contract three ways, in increasing order of guarantee:

1. **Custom instructions** â€” paste the [instruction block](#agent-instruction-block)
   below into your agent's system prompt. Lowest friction; works with any agent
   and no extra tooling.
2. **Validate in CI** â€” run [`agent-eval validate`](#validating) on the
   transcripts your agent writes, so a non-compliant transcript fails loudly
   instead of being silently mis-scored.
3. **Generate them** â€” have a dedicated export tool emit transcripts directly to
   this schema, so compliance is guaranteed by construction. Use both for maximum
   effectiveness; neither is required to use the other.

agent-eval's parser is deliberately **liberal in what it accepts** (it will still
read a transcript that bends the rules). This contract defines what is considered
**compliant**, so producers know exactly how to conform and CI can enforce it.

---

## File layout

One markdown file per run:

```
transcripts/<agent-or-worker>/YYYY-MM-DD-HHmm.md
```

Example: `transcripts/builder/2026-06-05-1000.md`

- One file per run. Never overwrite a previous run's transcript.
- Write a **stub at the start** of the run (so a crash still leaves a record),
  then **update it at the end** with the real result. See
  [the lifecycle](#run-lifecycle).

---

## Schema

A transcript is a markdown document with a level-1 title and a fixed set of
`##` sections, in this order:

````markdown
# <Agent/Worker> Run - YYYY-MM-DD HH:mm <TZ>

## Task
<The task or prompt the run was given.>

## Actions Taken
1. <What you actually did - cloned repos, edited files, ran commands, made commits>
2. <...>

## Key Outputs
- <The concrete deliverables: commit SHAs, code, issues filed, summaries>

## Outcome
pass - <one-line reason>

## Errors & Retries
- <Any failures hit and how they were handled. Omit or leave empty if none.>

## Duration
10:00 PT -> 10:14 PT (14 minutes)
````

### Rules

| Section | Required | Rule |
|---|---|---|
| **Title** (`#`) | yes | Non-empty level-1 heading. |
| `## Task` | yes | Non-empty. |
| `## Actions Taken` | yes | Non-empty. Use a **numbered or bulleted list** so each action is individually parseable (prose-only is a warning). |
| `## Key Outputs` | yes | Non-empty. |
| `## Outcome` | yes | Must **start** with a bare token: `pass`, `fail`, or `partial` (optionally followed by ` - reason`). |
| `## Errors & Retries` | no | Optional. Include for any non-fatal errors you recovered from. |
| `## Duration` | yes | Non-empty. Use a parseable form like `10:00 PT -> 10:14 PT` or `~14 minutes` (unparseable is a warning). |

### Outcome token rules (the #1 source of drift)

- âœ… `pass - 2/2 tasks complete and pushed`
- âœ… `fail - the upstream API was down`
- âœ… `partial - fixed 1 of 2 repos`
- âœ… `**PASS** - ...`, `` `pass` ``, `âœ… PASS - ...` are tolerated (the parser
  strips leading emphasis/emoji) â€” but the **bare token is preferred**.
- âŒ `mostly worked`, `done-ish`, `see above` â€” won't resolve to a token and
  fails validation.

Use `pass` only when the work genuinely completed. `partial` and `fail`
transcripts are the **most valuable** eval data â€” never inflate the outcome.

### Sub-structure

You may use `###` subheadings *inside* a section (e.g. `### Setup`, `### Task 1`
under `## Actions Taken`). The parser folds them into the parent section, so your
list items are still counted. Only `##` starts a new top-level section.

---

## Run lifecycle (write the stub FIRST)

The single most valuable transcript is the one written by a run that later
**died** â€” without it, the failure is invisible.

1. **At the start of the run**, immediately write the file with `## Task` filled
   in and `## Outcome` set to `IN-PROGRESS`. This guarantees a record exists even
   if the run is killed.
2. **At the end**, update the same file with Actions Taken, Key Outputs, the
   final `## Outcome` (`pass`/`fail`/`partial`), Errors & Retries, and Duration.
3. **If you hit a fatal error**, update `## Outcome` to `fail - <error>` before
   you stop.

`IN-PROGRESS` is accepted by default (it's a valid not-yet-finished stub). When
you validate **finished** runs (e.g. in CI after the run completes), pass
`--finished` and any transcript still stuck at `IN-PROGRESS` becomes an error â€”
that's how you detect runs that died mid-flight. As with `pass`/`fail`/`partial`,
only the **leading token** of the `## Outcome` line decides this: a finished run
that merely *mentions* the phrase in its reason prose (e.g.
`pass - dogfood found the known IN-PROGRESS stubs`) is still `pass`, not a stub.

---

## Validating

```bash
# Validate a single transcript
agent-eval validate transcripts/builder/2026-06-05-1000.md

# Validate a whole tree
agent-eval validate transcripts/

# Require finished transcripts (IN-PROGRESS stubs become errors) - use in CI
agent-eval validate transcripts/ --finished

# Machine-readable output for tooling / CI
agent-eval validate transcripts/ --json
```

Exit code is `0` when everything is valid, `1` when any transcript has an
error-severity violation â€” so it drops straight into CI.

Programmatic API:

```ts
import { validateTranscript } from 'agent-eval';

const res = validateTranscript(markdown, { allowInProgress: false });
if (!res.valid) {
  for (const v of res.errors) console.error(`[${v.field}] ${v.message}`);
}
```

### Validation checks; scoring grades

There are two distinct evaluation surfaces, and they answer different questions:

| | `validate` (this contract) | `scoreTranscript` (quality monitoring) |
|---|---|---|
| Asks | *Is this a well-formed, finished transcript?* | *How good was the run?* |
| Verdict | binary — exit `0` / `1`; one error-severity violation fails | binary, forge-proof checks + a 0–1 score |
| Use | a well-formedness check you can wire into CI | trend dashboards, regression spotting |

Within `scoreTranscript`, every check is a **binary, deterministic signal** the worker cannot forge after the fact:

- **Binary checks** (`completeness`, `staleness`, `verification`) ask *did the agent do the thing?* — they may emit `fail`. A check that cannot run for a given transcript (e.g. `verification` with no run metadata) is emitted as `skip` and left out of the roll-up rather than counted against the score.

The `## Outcome` token in this contract (`pass`/`fail`/`partial`) is the **agent's own self-report** of the run — a *third* thing again, independent of both the validator and the scorer. The `verification` check exists precisely to catch when that self-report disagrees with ground truth (the agent claims `pass` but the orchestrator recorded an error).

---

## Agent instruction block

Paste this into your agent's system prompt / task instructions. It makes the
agent emit contract-compliant transcripts with no other tooling required.

> **Transcript logging (required).** At the **start** of your run, create a
> markdown file at `transcripts/<your-name>/YYYY-MM-DD-HHmm.md` with the
> `## Task` section filled in and `## Outcome` set to `IN-PROGRESS`. At the
> **end** of your run, update that same file. The file MUST have a level-1
> title and these sections, in order:
>
> - `# <Name> Run - YYYY-MM-DD HH:mm <TZ>` (title)
> - `## Task` â€” the task you were given
> - `## Actions Taken` â€” a **numbered list** of what you actually did
> - `## Key Outputs` â€” the concrete deliverables (commit SHAs, files, links)
> - `## Outcome` â€” a line that **starts with one bare token**: `pass`, `fail`,
>   or `partial`, optionally followed by ` - <reason>`. Do not wrap it in bold
>   or prose; do not invent other words.
> - `## Errors & Retries` â€” any errors you recovered from (omit if none)
> - `## Duration` â€” e.g. `10:00 PT -> 10:14 PT (14 minutes)`
>
> If you hit a fatal error, set `## Outcome` to `fail - <error>` before stopping.
> Never finish â€” success or failure â€” without this transcript on disk. Use
> `partial`/`fail` honestly; do not report `pass` unless the work truly completed.

---

## Wiring `validate` into CI (GitHub Actions)

`agent-eval validate` is a well-formedness check, not a quality gate: it exits
non-zero when any transcript has an error-severity violation, so you *can* wire
it into CI to catch malformed or unfinished transcripts. Use `--finished` in CI
so a run that died mid-flight (left an `IN-PROGRESS` stub) fails loudly instead
of passing silently. This checks transcript *shape*, never agent quality.

```yaml
# .github/workflows/transcripts.yml
name: Validate agent transcripts
on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g agent-eval
      # Fail the build on any non-compliant or unfinished transcript.
      - run: agent-eval validate ./transcripts --finished
```

For machine-readable output (e.g. to annotate a PR), add `--json` and parse the
result; the JSON includes per-file `errors[]`/`warnings[]` with stable `code`s.

---

## Versioning

This is `transcript-contract@v1`. The canonical machine definition lives in
[`src/monitoring/contract.ts`](./src/monitoring/contract.ts)
(`TRANSCRIPT_CONTRACT_V1`). Breaking changes to the required sections or outcome
tokens will bump the version.
