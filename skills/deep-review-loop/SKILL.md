---
name: deep-review-loop
description: Alternate independent review and evidence-based response until convergence on Claude Code or Codex.
user-invocable: true
argument-hint: "[--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--no-agy] [--codex-only] [--max=N]"
---

# deep-review-loop — Review and Respond loop

Claude Code enters through `/deep-review-loop`; Codex enters through
`$deep-review:deep-review-loop`. Both execute this file with identical args.

Resolve `plugin_root` using `PLUGIN_ROOT`, then `CLAUDE_PLUGIN_ROOT`, then the
installed skill location. Use absolute paths joined to that root for every
reference and Node helper.

## 0. Validate

Serialize the original argument tokens as a private JSON array and invoke
`public-route.mjs --entry loop --host HOST --args-file ARGS_FILE`. Its returned
JSON is the executable grammar authority. Stop on `ok=false` and use its
expanded `argv` without independently reparsing it.

- Reject `init`, `--respond`, and `--qa`; those are terminal routes of the
  public `$deep-review:deep-review` skill.
- `--max=N` defaults to 5 and must be a positive integer. It counts Review
  calls, not Respond work.
- Accept `--contract [SLICE-NNN]`, `--entropy`, and all public reviewer flags.
- Expand and validate reviewer flags exactly as the public skill does.

Announce the safety maximum and that each round reports verdict, remaining
issues, and progress.

## 1. Round argument derivation

Never forward `--max`, `--respond`, `init`, or `--qa` to Review.

At round 1 start, clear residual `.deep-review/tmp/loop-*-round-*.state.json`
and `loop-*-round-*.prior.md` files left by a *crashed* previous loop, using the
Node runtime (never a shell-only helper):

```text
node {plugin_root}/hooks/scripts/loop-state.mjs cleanup-residue --tmp-dir .deep-review/tmp
```

`cleanup-residue` removes a loop's residue only when it is *provably not live* —
every recorded round's stamped owner (the host session process that drove that
loop, from `record-round` in §4) probes as departed **and** its most-recent
activity predates the staleness grace window. Any owner that is live,
permission-blocked, on a foreign host, timeline-inconsistent, or absent (legacy
state with no owner stamp), and any orphan `.prior.md` with no state file, is
left untouched. This mirrors the owner-token + liveness model in
`mutation-protocol.mjs` (`classifyLiveness`): a concurrent loop that is merely
idle — waiting on reviewers or human input, even for hours — keeps its live
round state and pending prior-context, because its session process is still
alive. Session-only, advisory-only REJECT memory therefore never leaks across
loop instances, and a live sibling loop is never disrupted. Round 1's
`record-round` (§4) mints a fresh `loop_id` and echoes it; store that value
and reuse it via `--loop-id` on every later round in this session — never
re-mint mid-session.

- Round 1 forwards the user's review, contract, entropy, and reviewer flags.
- If round 1 requested `--ultracode`, mark `ultracode_consumed=true` after that
  attempt. Rounds 2+ remove `--ultracode`, retain Codex, and inject
  `--no-opus --no-agy`.
- If that round reports Codex unavailable, withhold the injected `--no-opus`
  on the next round so at least one reviewer remains. Do not repeat ultracode.
- When the user never requested ultracode, preserve the original reviewer
  flags on every round. Plain loops therefore keep their normal reviewer set;
  `--codex-only` loops remain Codex-only.
- `review_model` is read by the review pipeline and forwarded unchanged on
  every eligible Claude round. Custom installed aliases such as `fable` are
  never replaced with a hardcoded model.

## 2. Review sub-step

At the beginning of every round, execute the review pipeline's Stage 0
`mutation-protocol.mjs auto-recover` path. Failure is an operational stop.

For round 2+, **before** `review-execution.md` Stage 0 begins (this ordering
keeps the write outside the Stage 3/4 fingerprint-sensitive window — RF-008),
render the previous round's advisory context from its `record-round`-echoed
`state_file`:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs render-prior-context --state-file PREVIOUS_STATE_FILE --output PRIOR_CONTEXT_FILE
```

Forward the echoed `output_file` explicitly as `--prior-rounds-file=PRIOR_CONTEXT_FILE`
on this round's review branch call — the file's mere existence never triggers
consumption; only this explicit flag does (`public-route.mjs` `parseReview`
accepts the token; `build-reviewer-payload.mjs` performs the validated
ingest, per `review-execution.md` Stage 2). Round 1 has no previous state, so
this step is skipped on round 1.

Before Review, create a private snapshot file with:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs snapshot-reports --reports-dir REPORTS_DIR --output SNAPSHOT_FILE
```

Then read and execute `deep-review-workflow/references/review-execution.md` with
the derived round args. Wait for all reviewer contexts and Stage 5.5 to finish.

Immediately resolve the report-set delta:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs resolve-round-report --reports-dir REPORTS_DIR --snapshot-file SNAPSHOT_FILE
```

The Node CLI compares exact absolute set entries and succeeds only when exactly
one new canonical `*-review.md` exists. Zero or multiple entries is a terminal
operational error. Store its `report_path` as `round_review_report_path`.

Apply reviewer-count rules before Respond:

- `N_actual == 0`: stop with operational failure; no verdict is trusted.
- `N_actual == 1`: Critical or security is `REQUEST_CHANGES`, Warning-only is
  `CONCERN`, and no blocking issue is `APPROVE`.
- Larger sets use the synthesis contract in `review-execution.md`.

## 3. Respond sub-step

Skip Respond for `APPROVE` with zero Critical and Warning issues. Also skip it
for a split-only `CONCERN` with no accepted actionable item.

Otherwise execute the public `--respond` branch with the exact absolute
`round_review_report_path`. After the response reference loads its source path,
verify identity through:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs assert-same-path --expected ROUND_REVIEW_REPORT_PATH --actual LOADED_RESPONSE_SOURCE
```

The comparison canonicalizes absolute paths without filesystem alias
resolution. A mismatch stops the loop before implementation. The loop's entry
notice pre-approves the ordinary response confirmation, but privacy warnings,
mutation ownership, pre-staged confirmation, and DEFER choices remain active.
If the user selects DEFER-and-stop, end after the current round.

## 4. Metrics sub-step

After Review and optional Respond, invoke:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs collect-metrics --round-number N --review-report ROUND_REVIEW_REPORT_PATH --response-report RESPONSE_REPORT_PATH --recurring-findings RECURRING_FILE
```

Omit the response arguments when Respond was skipped. Store the JSON fields:
round number, absolute review/response paths, verdict, Critical/Warning/Info
counts, accepted/rejected/deferred/implemented counts, halted, execution path,
and `findings_signature`.

Each signature is
`severity:file:floor(line/7):taxonomy_category`. The category comes from the
current recurring artifact's exact `example_files` match and otherwise is
`untagged`. This field is vestigial for stop-condition purposes — display and
backward-compatibility only. The deterministic stop logic in §5 consumes
`compare-rounds` output, never `findings_signature`.

Immediately after `collect-metrics`, record this round's finding-state for
convergence comparison:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs record-round --round-number N --review-report ROUND_REVIEW_REPORT_PATH --response-report RESPONSE_REPORT_PATH --base-commit REVIEW_BASE --repo-root PROJECT_ROOT --state-dir .deep-review/tmp [--loop-id LOOP_ID]
```

Omit `--response-report` when Respond was skipped. Omit `--loop-id` on round 1
only — `record-round` mints one and echoes `{loop_id, state_file}`; store both
for every later round in this session (pass the same `loop_id` back via
`--loop-id` on rounds 2+; never re-mint). `--base-commit` is required.
`--repo-root PROJECT_ROOT` is required so finding locations canonicalize to a
repo-relative identity — without it absolute path citations stay absolute and
`compare-rounds` misreads an unchanged finding as resolved+added instead of
repeated, defeating stall detection. `record-round` also stamps the round state
with this loop's host-session liveness owner, which §1's `cleanup-residue`
consults to tell a crashed loop's residue from a live sibling's.

## 5. Stop or continue

Stop immediately when any condition holds:

1. `APPROVE` with zero Critical and Warning issues.
2. Review count reaches `--max`.
3. `compare-rounds` (previous round's `state_file` vs. this round's) reports
   `stalled=true` AND this round's `implemented_count == 0`, or the response halted:

   ```text
   node {plugin_root}/hooks/scripts/loop-state.mjs compare-rounds --previous PREVIOUS_STATE_FILE --current CURRENT_STATE_FILE
   ```

   This condition **consumes `compare-rounds`'s code-owned `stalled` output**
   in place of the former natural-language "half of the larger set repeats"
   judgment; the `halted` branch is preserved unchanged. Round 1 has no
   previous state to compare against, so condition 3 cannot fire before
   round 2.
4. Two operational failures occur in one round.
5. The user chooses stop or DEFER-and-stop.
6. `N_actual == 0` or a Codex-only round has no Codex role.
7. This round's `accepted_count == 0` AND `implemented_count == 0` AND
   `halted == false` — a Review executed but nothing was accepted or
   implemented and Respond did not halt (most often a split-only `CONCERN`
   round where Respond was itself skipped per §3). Stop with the last
   trusted verdict; **do not start another Review round.**

**Condition interaction**: condition 7 fires immediately whenever a
split-only `CONCERN` round skips Respond (§3) — this is an intended early
stop, not a bug. §3's Respond-skip rule and condition 7 interact by design to
avoid an idle extra round.

**Skip semantics — three distinct kinds, never conflate them**:
(a) *Respond skip within an executed round* (§3 — `APPROVE` with zero issues,
or a split-only `CONCERN` with no accepted actionable item; that round's
metrics use response defaults);
(b) *stopping before starting another Review round* (conditions 2/3/6/7 — no
new round begins, and a new `verdict` or `N_actual` must never be generated
for a round whose Review was never started; the loop summary's final verdict
attribution is always the last executed canonical report, never inferred or
synthesized by the loop layer);
(c) the user's explicit DEFER-and-stop choice (§3), which ends after the
current round regardless of other conditions.

Continue when the verdict is actionable, at least one change was implemented,
the response did not halt, `compare-rounds` shows progress (`progressed=true`
or `stalled=false`), and the safety maximum is not reached. In a gray area,
stop on external dependency or repeatedly failing dispatch rather than
cycling without evidence.

After each round, report verdict, issue counts, change summary, and the decision
in one paragraph.

## 6. Final summary

Use a direct host file tool to write one unique
`.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-loop-summary.md`. Include each
round's review and response paths, counts, implemented total, final verdict,
stop reason, `rounds_saved` (the safety maximum `--max` minus the number of
rounds that actually executed a Review), and remaining human or external
work. Loop state is otherwise session-local; existing reports allow a later
explicit response to resume.

Delete this session's `loop-*-round-*.prior.md` advisory files with a direct
host file tool. Leave the `.state.json` files in place — they remain
readable evidence of the round history.
