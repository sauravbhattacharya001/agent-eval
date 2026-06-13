# Proposal: an optional runtime eval layer for `claude-code-action`

> **Status:** design note staged in `agent-eval`. This documents the case for
> contributing an *optional* output-quality eval step to
> [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
> and the exact, non-invasive shape it would take. Nothing here has been opened
> upstream; this is the writeup that precedes any contribution so the design can
> be reviewed against the action's real code first.

## The problem in one sentence

A `claude-code-action` run can finish with `conclusion: success` — the Claude
Code CLI exited 0 — and still be a **failure as a unit of work**: it sat idle
and posted nothing, or it posted the wrong thing. Today the only signal a
workflow can gate on is *"did the process exit cleanly?"*, which is necessary
but not sufficient. There is no check on *what the agent actually produced*.

This is the gap between **research-time safety** (the model was trained and
evaluated to be helpful and not crash) and **runtime safety** (this specific
autonomous run, on this PR, did the task it was given). A model can ship safe
and still have individual agent runs no-op, drift, or repost boilerplate. The
handoff from "safe model" to "safe run" is exactly where a deterministic runtime
check earns its place.

## The failure modes are already reported

The action's own issue tracker documents the two recurring shapes this layer
would catch. (Issue titles paraphrased; see the linked issues for detail.)

| Issue | Reported behavior | What a runtime check sees |
|-------|-------------------|---------------------------|
| [#1368](https://github.com/anthropics/claude-code-action/issues/1368) | Automation-mode review runs sit stale 2+ hours with **no actionable output**, hitting the stale-run limit | **Staleness / abandonment** — the run produced no end-of-work `result` turn and/or no artifacts a human can act on |
| [#1361](https://github.com/anthropics/claude-code-action/issues/1361) | Check runs silently abandoned, timing out at the 2-hour stale limit | **Abandonment** — same signal, surfaced as an explicit gate failure instead of a silent timeout |
| [#1302](https://github.com/anthropics/claude-code-action/issues/1302) | Action posts the repo's `CLAUDE.md` **verbatim** as the comment body instead of a structured review — *and the workflow still exits success* | **Off-task content** — the output isn't about *this* PR; it's a generic document (see the honest-limitations note below — a verbatim doc that happens to contain file paths/directives can read as "actionable" to the deterministic gate) |
| [#1308](https://github.com/anthropics/claude-code-action/issues/1308) | Two recurring output-quality failure modes | The cluster above — empty/abandoned, and on-topic-looking but substanceless |

The common thread: **the process succeeded, the work didn't.** A green check on
a stale or boilerplate run is worse than a red one, because it teaches reviewers
to trust output that didn't happen.

## What the layer would check

Two checks, both **Tier 1 — deterministic** (externally observable: the agent
can't forge a parse result or a missing turn). **No model-as-judge. No extra
network calls. No added API cost. No flake.** They run on bytes the action
already wrote.

- **Completeness** *(Tier 1)* — is the output non-empty / not a stub / not a
  bare refusal? A `result` turn with empty text and no assistant prose fails
  here. The bytes are the bytes; "non-empty" can't be faked.
- **Staleness / abandonment** *(Tier 1)* — did the run emit anything
  *actionable* (file refs, line numbers, code suggestions, directives,
  structured findings)? A run with no terminal `result` turn (→ abandoned) or an
  on-topic *"looks good to me"* with zero artifacts fails here. Directly targets
  #1368 / #1361.

> **Scope note (an honest one).** An earlier draft of this layer also shipped
> two Tier 2 heuristics — *keyword coverage* and *TF-IDF relevance*. They were
> **removed** because both collapse to ≈ 0 on the short, identifier-dense outputs
> a real CI review produces, which made them noisy and unreliable as a *gate*.
> The consequence, stated plainly: the deterministic gate cleanly catches the
> **empty / abandoned / no-op** cluster (#1368 / #1361 / #1308), but a #1302-style
> *verbatim `CLAUDE.md`* can slip past it — a guidance doc is non-empty and
> happens to contain file paths and imperative "do X" sentences, so it reads as
> "actionable" to a presence-counting check. Catching #1302 reliably needs a
> reference-aware signal (does the output cover *this prompt's* topics?), which
> is exactly the kind of thing best decided *with maintainers* rather than
> shipped as a noisy default. `agent-eval` keeps coverage/relevance and a
> model-as-judge available for **offline** grading; the proposed **gate** is the
> deterministic two-check core that is reliable on every PR. See
> [open question #2](#open-questions-to-resolve-before-any-pr).

Any single failing check trips the gate. The semantics, thresholds, and the
rationale for why the two checks diverge in practice live in the
[README's single-run section](../README.md#evaluating-a-single-run-one-pr--one-issue);
the precise hook into the action's lifecycle is documented in
[`claude-code-action-integration.md`](./claude-code-action-integration.md).

### Why deterministic-only is a feature, not a limitation

It would be tempting to reach for an LLM-as-judge to grade "review quality." We
deliberately don't, for the gate:

1. **Independence.** A judge that shares the model substrate with the agent it
   grades is the weakest possible auditor — *least independent, most forgeable*.
   A missing `result` turn and an empty string are not forgeable.
2. **Cost & determinism in CI.** A gate that adds an API call, a second source
   of latency, and a non-deterministic verdict is a hard sell for every-PR CI.
   These two are pure functions of the run's bytes.
3. **The 80%.** The reported failures are *mostly* in the deterministic band —
   stale, abandoned, empty (#1368 / #1361 / #1308). Shipping the 80% that Tier 1
   covers solves the most common filed problems reliably and cheaply. The
   remaining slice that genuinely needs a reference-aware or judgment signal
   (e.g. the #1302 verbatim-doc mode) is exactly the part to design *with*
   maintainers rather than ship as a noisy default — see the scope note above and
   open question #2.

Model-as-judge stays available in `agent-eval` for offline/subjective grading,
but the proposed **gate** is deterministic by design.

## The proposed integration (minimal, opt-in)

Two modes, in order of preference. Both are already mapped against the action's
real `src/entrypoints/run.ts` lifecycle and the `execution_file` it emits — see
the [integration doc](./claude-code-action-integration.md) for the line-level
seam.

### Mode A — downstream workflow step (recommended; **no fork**)

The eval runs as a separate step *after* the published action, reading its
`execution_file` output. This requires **zero changes to `claude-code-action`**
— it composes with `@v1` as shipped, so it's the lowest-risk way to adopt the
layer and the natural first proposal.

```yaml
- name: Run Claude
  id: claude
  uses: anthropics/claude-code-action@v1
  with:
    prompt: ${{ steps.prompt.outputs.text }}

# Gate on what the agent produced. always() so a blank/abandoned run is still
# evaluated; skip only when no execution file was emitted.
- name: Evaluate the run
  if: ${{ always() && steps.claude.outputs.execution_file != '' }}
  run: npx tsx examples/cca-execution-eval.ts
  env:
    EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}
    AGENT_PROMPT:   ${{ steps.prompt.outputs.text }}
    AGENT_EVAL_GATE: watch
```

### Mode B — in-process, inside the action's cleanup (for upstreaming)

If the layer is upstreamed, the natural home is the existing `run.ts` cleanup
block (the `finally` that always runs) — right after `writeStepSummary(...)`,
which already parses the execution file. The data and the prompt
(`context.inputs.prompt`) are both in hand there, so the addition is small and
self-contained:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    evaluate_output: true
    eval_checks: "completeness,staleness"
```

…wired to set `eval_passed` / `eval_score` / `eval_evidence` action outputs (and
optionally `core.setFailed(...)` when the gate trips). Off by default; a no-op
for anyone who doesn't set `evaluate_output: true`.

## Why this fits `claude-code-action` specifically

- **The seam already exists.** The cleanup phase already reads the execution
  file to render the report comment and update the tracking comment. The eval
  reads the *same file*; no new artifact, no new lifecycle.
- **Dependency-light and importable.** The eval engine is a library, not just a
  CLI — `extractCcaRunFromFile` → `evaluateCiRun` → `emitActionResult` is three
  importable calls. It adds no heavyweight transitive deps to the action.
- **Opt-in and backwards-compatible.** Default behavior is unchanged. A workflow
  that doesn't ask for evaluation never pays for it.
- **It turns silent timeouts into actionable failures.** #1368/#1361 today
  manifest as a 2-hour stale wait and a confusing green-ish end state. With the
  gate, the same run fails fast with `eval_evidence` explaining *no actionable
  output / run abandoned*.

## Open questions to resolve before any PR

These are the things to settle *with maintainers*, not unilaterally:

1. **Prompt availability.** The execution file records the conversation, not the
   task framing (the action passes the prompt via a prompt file). Any
   reference-aware check (e.g. a future coverage signal for the #1302 mode) needs
   the prompt. Mode A asks the user to pass it; Mode B can read
   `context.inputs.prompt`. Confirm the cleanest source. (The two deterministic
   gate checks do *not* require the prompt — they read only the output — so this
   is only a precondition for re-introducing a coverage/relevance signal.)
2. **Default thresholds.** What `gate` level (`watch` / `at-risk`) is the right
   default for an *opt-in* check so it's useful without being noisy? The current
   defaults have been validated against realistic execution-file fixtures for the
   cited failure modes — see [Threshold validation](#appendix-threshold-validation-against-realistic-runs)
   below. They cleanly separate a healthy review (pass) from the empty / no-op /
   abandoned failure modes (fail) with no false positive. The open calibration
   question worth a maintainer's eye is the inverse of a threshold: **whether the
   #1302 verbatim-doc mode should be in scope for the gate at all**, given that
   catching it reliably needs a reference-aware signal that was pulled for being
   noisy on short outputs (see the scope note under *What the layer would
   check*). The conservative answer — ship the deterministic two-check core,
   leave #1302 to an opt-in offline judge — is what this proposal recommends.
3. **Failure semantics.** Should a tripped gate `setFailed` the action, or only
   set `eval_passed=false` and let the workflow decide? (Lean: outputs only by
   default; let the workflow `if:` on `eval_passed`.)
4. **Surface area.** Is a downstream step (Mode A, no code change) the preferred
   contribution, with in-process (Mode B) as a follow-up — or do maintainers
   prefer it built in from the start?

## What's already built here (to back the proposal)

Everything the integration needs exists and is tested in this repo today:

- **`src/action/cca-execution.ts`** — total, dependency-free parser/extractor
  for the action's execution file (`parseCcaExecutionLog`, `extractCcaRun`,
  `extractCcaRunFromFile`); malformed input degrades to "no output", never
  throws.
- **`src/action/ci-run.ts`** — `evaluateCiRun`, the two-check (completeness +
  staleness) deterministic single-run gate. It surfaces the *specific* failing
  check reason in `eval_evidence` (e.g. `staleness: no-op: bare acknowledgement
  only`), not just the check name.
- **`src/action/adapter.ts`** — maps a verdict onto GitHub Action outputs / step
  summary / exit code (`emitActionResult`, `renderActionSummary`).
- **`examples/cca-execution-eval.ts`** — a runnable Mode-A entry point, smoke-tested
  end-to-end.
- **`tests/threshold-validation.test.ts` + `tests/fixtures/cca-runs/*.json`** —
  the default thresholds run against realistic execution-file fixtures for the
  cited failure modes plus a healthy run (the appendix below).
- **[`docs/claude-code-action-integration.md`](./claude-code-action-integration.md)**
  — the line-level seam against `run.ts` and the execution-file shape.

The remaining work is engagement, not engineering: the threshold defaults are
now validated against realistic runs (appendix below); the next step is to bring
the proposal (starting with Mode A) to the maintainers.

## Appendix: threshold validation against realistic runs

Open question #2 (default thresholds) is backed by a reproducible test rather
than an assertion. `tests/threshold-validation.test.ts` drives the **full
Mode-A pipeline** — `extractCcaRunFromFile(<execution file>) -> evaluateCiRun()`
— over `claude-code-action`-shaped execution-file fixtures
(`tests/fixtures/cca-runs/*.json`, the real `CcaTurn[]` array). **Only the
`watch` gate is set; every threshold is a documented default.** The fixtures are
the failure modes this proposal cites plus a healthy run that must not be
flagged.

The result (verdicts + the per-check breakdown the gate produced):

| Fixture | CLI result | Gate | Tripped by (default thresholds) |
|---------|-----------|------|---------------------------------|
| `healthy-review` | `success` | ✅ **pass** | — (completeness ✓ 136w; staleness ✓ 5 artifact kinds) |
| `stale-noop` | `success` | ❌ **fail** | **staleness** (bare-acknowledgement no-op, 0 artifacts) — completeness ✓ alone would have passed it |
| `abandoned-no-result` (#1361) | *(no result turn)* | ❌ **fail** | **staleness** (no terminal `result` turn; mid-task narration, 0 actionable artifacts) |
| `verbatim-claudemd` (#1302) | `success` | ⚠️ **pass** | — *(honest limitation: a verbatim guidance doc contains file paths + "do X" directives, so the presence-counting staleness check reads it as actionable; catching this mode needs the reference-aware signal that was pulled — see the scope note and open question #2)* |

What this demonstrates concretely:

- **No false positive.** The healthy review passes and emits an empty
  `eval_evidence`.
- **The `success`-but-failed cases are caught.** `stale-noop` ran
  `conclusion: success` (CLI exit 0) and `abandoned-no-result` had no result turn
  at all — the crash-only signal would pass both green. The gate fails them with
  a specific `eval_evidence` line.
- **Each failure is a Tier 1 check, no model-as-judge.** Both the no-op and the
  abandoned run are staleness fails; both reasons are deterministic
  artifact-presence / missing-turn facts.
- **`completeness` is necessary but not sufficient.** The stale `"LGTM"` run is
  structurally complete (grammatical, non-empty) and still fails — exactly why
  the gate is two checks, not one.
- **The limitation is stated, not hidden.** `verbatim-claudemd` (#1302) passes
  the deterministic gate; the proposal is explicit that this mode is out of scope
  for the two-check core and recommends an opt-in offline judge for it rather
  than a noisy default. Honesty about what the gate does *not* catch is part of
  the contribution.

### A concrete before/after (copy-pasteable)

This is the actual output of the Mode-A pipeline on the `stale-noop` fixture — a
run that finished `conclusion: success` with the comment body *"Looks good to me,
no changes needed."*. Reproduce it with:

```
EXECUTION_FILE=tests/fixtures/cca-runs/stale-noop.json \
AGENT_PROMPT="Review this PR (rate limiting on the login endpoint)…" \
AGENT_EVAL_GATE=watch \
npx tsx examples/cca-execution-eval.ts
```

**Before — what `claude-code-action` reports today** (crash-only signal):

```
conclusion: success     # the CLI exited 0, so the workflow goes green
```

A reviewer sees a green check and a one-line approval. Nothing tells them the run
did no review.

**After — the GitHub Action outputs the eval step sets:**

```
eval_passed   = false
eval_score    = 0.5000
eval_headline = FAIL — 1/1 workers below gate (watch), mean score 0.5000
eval_evidence = claude-review/staleness: no-op: run no_progress (1.0s); bare acknowledgement only (bare approval); claude-review: at-risk (0% pass), top failure: staleness (1)
```

The `eval_evidence` string carries the *specific reason* — `no-op: … bare
acknowledgement only` — not merely "a check failed", so the workflow can surface
it verbatim and a maintainer knows exactly why without re-running. A workflow
gates on it with one line:

```yaml
- if: ${{ steps.eval.outputs.eval_passed == 'false' }}
  run: echo "::warning::${{ steps.eval.outputs.eval_evidence }}"
```

The abandoned-run case (#1361) is identical in shape, with the reason
`no-op: no actionable content (no file refs, line numbers, code, directives, or
findings)`. Both strings are produced by the deterministic checks and pinned in
`tests/ci-run.test.ts` ("per-check evidence enrichment") and
`tests/threshold-validation.test.ts`, so a future change that drops the reason
from the evidence trips CI.

The healthy review against the *same* gate produces `eval_passed = true` and an
**empty** `eval_evidence` — the gate is quiet on a good run and loud, with a
reason, on a bad one.

## See also

- [README → CI Quality Gate](../README.md#ci-quality-gate-github-action)
- [README → Evaluating a single run](../README.md#evaluating-a-single-run-one-pr--one-issue)
- [Integration seam → `claude-code-action-integration.md`](./claude-code-action-integration.md)
