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
`untagged`.

## 5. Stop or continue

Stop immediately when any condition holds:

1. `APPROVE` with zero Critical and Warning issues.
2. Review count reaches `--max`.
3. At least half of the larger adjacent signature set repeats and no change was
   implemented, or the response halted.
4. Two operational failures occur in one round.
5. The user chooses stop or DEFER-and-stop.
6. `N_actual == 0` or a Codex-only round has no Codex role.

Continue when the verdict is actionable, at least one change was implemented,
the response did not halt, signatures show progress, and the safety maximum is
not reached. In a gray area, stop on external dependency or repeatedly failing
dispatch rather than cycling without evidence.

After each round, report verdict, issue counts, change summary, and the decision
in one paragraph.

## 6. Final summary

Use a direct host file tool to write one unique
`.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-loop-summary.md`. Include each
round's review and response paths, counts, implemented total, final verdict,
stop reason, and remaining human or external work. Loop state is otherwise
session-local; existing reports allow a later explicit response to resume.
