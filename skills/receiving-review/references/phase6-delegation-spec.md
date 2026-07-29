# Phase 6 Subagent Delegation — Cross-runtime Design

## 1. Problem

Phase 6 applies already accepted findings, but the implementation context is
untrusted and may leave dirty worktree or index state. The old response path
also embedded host-specific process and file operations. That made Windows
behavior divergent and allowed agent prose to stand in for verified state.

The design separates judgment, implementation, and state authority:

- main decides ACCEPT, REJECT, and DEFER;
- one implementation context edits a single severity group;
- Node snapshots and verifies every byte/index/HEAD transition;
- the user owns the same-path pre-staged confirmation decision;
- main publishes the response only after the state gate finishes.

## 2. Decisions

1. Dispatch granularity is one severity group, ordered Critical, Warning, Info.
2. Claude retains the named `phase6-implementer` with unnamespaced fallback.
3. Codex uses one generic subagent per severity group.
4. Both hosts consume one byte-identical Accepted Items prompt body.
5. Codex's first action is the absolute read of the shipped agent contract.
6. Snapshot, test logging, verify, recovery, and commit are Node operations.
7. A failed verification blocks later groups and recovers only with unchanged
   HEAD.
8. A verified same-path pre-staged change cannot commit without explicit user
   confirmation.
9. PR bodies use argv/stdin data boundaries and never become commands.
10. `DEEP_REVIEW_FORCE_FALLBACK=1` keeps the existing main fallback behavior.

## 3. Components

### `respond-runtime.mjs`

Owns local report discovery, GitHub review collection, GitHub response posting,
and atomic response publication. `listReviewReports` uses Node stat mtime and a
path tie-breaker. GitHub operations use resolved executables, argv arrays, and
JSON stdin bodies.

### `phase6-protocol.mjs`

Owns the trusted state machine:

- `snapshot`: exact allowlist, worktree bytes, index blobs, staged flags,
  outside dirty authority, HEAD, and private artifact paths;
- `run-test`: executable plus JSON argv, bounded child process, exact log
  markers;
- `verify`: strict Group Result parse, log proof, exact content delta, claim
  equality, index stability, outside-dirty stability, and HEAD equality;
- `recover`: exact worktree and index restoration from snapshot authority;
- `commit`: verification-receipt-bound path commit and pre-staged confirmation.

### `{plugin_root}/agents/phase6-implementer.md`

Defines the mechanical item loop, runner priority, JSON argv contract, result
schema, write allowlist, and recursion prohibition. Claude uses its frontmatter;
Codex reads the same file as instruction data before editing.

### Skills and references

`{plugin_root}/skills/receiving-review/references/respond-execution.md` is the orchestration SSOT. `{plugin_root}/skills/receiving-review/references/phase6-prompt-contract.md`
owns the shared prompt/result schemas. `{plugin_root}/skills/receiving-review/references/response-protocol.md` owns judgment and
PR trust classification. `{plugin_root}/skills/receiving-review/references/response-format.md` owns the published report.

## 4. Data flow

```text
source report or PR data
  -> main Phase 1 through 5 decisions
  -> sorted Accepted Items per severity
  -> Node snapshot
  -> one shared group prompt
  -> Claude named agent or Codex generic subagent
  -> raw Group Result file
  -> Node verify
  -> Node commit or Node recover
  -> next group only after verified success
  -> atomic response report
  -> optional GitHub response posting
```

The Codex host prefix contains only the absolute agent-contract read and the
no-nested-dispatch instruction. The Accepted Items portion is the same
serialized bytes supplied to Claude.

## 5. Responsibility boundaries

| Concern | Owner |
|---|---|
| source selection and confirmation | main + `respond-runtime.mjs` |
| trust classification and decisions | main receiving-review Phases 1 through 5 |
| accepted prompt serialization | main, once per group |
| bounded edits and tests | implementation context |
| allowed path derivation | Node snapshot |
| process output and markers | Node run-test |
| result validity and content delta | Node verify |
| dirty state restoration | Node recover |
| pre-staged decision | user |
| path-limited commit | Node commit |
| response filename and atomic publication | `respond-runtime.mjs` |
| PR API transport | `respond-runtime.mjs` |

An implementation context never evaluates acceptance, expands allowed paths,
stages, commits, recovers, posts, or dispatches another context.

## 6. Host matrix

### Claude Code

Main first requests the namespaced agent. Only type unavailability permits the
unnamespaced retry, with the same prompt object. Other dispatch failures enter
main fallback. The shipped agent keeps `model: sonnet`.

### Codex

Main starts a generic implementation subagent for the current group. The first
prompt instruction names the absolute shipped agent file and requires a full
read. The second prohibits nested dispatch. The shared group prompt follows
unchanged. No Claude model identity is asserted.

### Main fallback

Main fallback is not a weaker protocol. It uses the same snapshot, item order,
JSON argv logging, strict result file, verify, recover, and confirmation-bearing
commit. When five or more items remain, main offers an explicit context-saving
DEFER choice before editing.

## 7. State and failure semantics

### Empty input

A zero-item severity group is skipped without snapshot or dispatch. No ACCEPT
items across all groups yields `execution_path: n/a`.

### Dispatch failure

Before any edit, a dispatch failure can move to main fallback. After an
implementation context may have edited, main writes whatever result text was
returned and invokes verify. It never trusts a dispatch error to imply a clean
tree.

### Verification failure

Malformed output, failed-item counts, missing logs, unexpected delta, false
claims, index drift, outside-dirty drift, and HEAD movement are errors. With
unchanged HEAD, recover restores snapshot path state. With changed HEAD,
automated history recovery is prohibited.

### Partial failure

`halted_on_regression`, `execution_status: error`, or `items_failed > 0` blocks
the next group. Passed edits from a failed group are not committed. Recovery or
manual stop resolves their dirty state before the response ends.

### Same-path pre-staged changes

Verify may succeed while a changed allowed path was staged before snapshot.
The first commit call returns `requires_user_confirmation` without changing
HEAD or the index. Only an explicit affirmative answer permits the dedicated
confirmation-bearing call. Decline and defer remain uncommitted decisions.

### GitHub failures

One failed collection category is reported while other categories continue.
All collection categories failing escalates to the user. A posting failure is
recorded for retry and cannot turn an implementation failure into success.

## 8. Compatibility contracts

The following existing behaviors remain stable:

- source confidence and priority order;
- named Claude fallback;
- `DEEP_REVIEW_FORCE_FALLBACK=1`;
- zero-item skip;
- partial-failure stop;
- main fallback;
- `execution_path` values `subagent`, `main_fallback`, `mixed`, and `n/a`;
- review-loop defer and stop semantics;
- frontmatter `model: sonnet` for the Claude agent.

The runtime change replaces only the host-specific executable path. It does not
broaden Phase 6 scope or make private receiving skills public.

## 9. Verification strategy

Automated tests cover:

- equal-mtime report selection and exact suffix filtering;
- explicit path preservation;
- GitHub argv and JSON stdin transport with quotes, newlines, and Unicode;
- invalid identifier rejection before process start;
- snapshot/verify/recover behavior for dirty, deleted, staged, and raw paths;
- strict Group Result and exact JSON path tokens;
- missing log, outside delta, and HEAD fail-closed cases;
- pre-staged confirmation with invariant HEAD and index before consent;
- Claude/Codex prompt parity and recursion prohibition;
- response references, including `{plugin_root}/skills/receiving-review/references/response-format.md`, remaining free of
  executable host-specific recipes;
- current Node and exact supported Node 22 execution.

Release requires focused tests, full regression tests, syntax and JSON checks,
shell-free reference scans, and Windows CI.

## 10. Non-goals

- no nested implementation orchestration;
- no parallel severity groups;
- no re-evaluation of accepted findings;
- no automatic merge or PR approval;
- no hooks or MCP server for respond;
- no change to the reviewer's independent evaluation pipeline;
- no edit outside snapshot allowlists.
