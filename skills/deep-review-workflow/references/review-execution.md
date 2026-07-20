# Review execution — cross-runtime SSOT

This file is executed only by the public skill's terminal review branch. Host
labels are diagnostic; capabilities decide the reviewer set. Read
`runtime-dispatch.md` before dispatch.

## 0. Runtime root and state

Resolve `plugin_root` once using the runtime root contract: `PLUGIN_ROOT`, then
`CLAUDE_PLUGIN_ROOT`, then the current module location. Run every plugin helper
by joining its path to the absolute `plugin_root` returned by:

```text
node {plugin_root}/hooks/scripts/detect-environment.mjs --cwd PROJECT_ROOT --format json
```

Use the host's direct directory/file tools to ensure `.deep-review/reports`,
`.deep-review/responses`, and `.deep-review/tmp` exist. No hook or MCP server is
part of this workflow.

If `.deep-review/config.yaml` is absent, create it with the defaults in
`init-setup.md` through a direct host file tool. If it predates the agy fields,
use `lib/config.mjs` `patchTopLevelConfig` to add each missing scalar
independently: `agy_notified=false`, `agy_enabled=true`, empty acknowledgment
fingerprint/timestamp, and `agy_fingerprint_mode=hybrid`. Never reset an
existing value and never replace the whole file during migration.

Before every review, send an `auto-recover` framed JSON request directly to
`node {plugin_root}/hooks/scripts/mutation-protocol.mjs --request-stdin`.
Construct the frame with the module's exported request encoder and pass it as
process stdin. If recovery returns `manual`, `busy`, or an error, stop and show
the JSON result. Never start a reviewer over an unresolved mutation.

All mutation requests use the exported `buildCliRequest` API and this exact
object shape before framing:

```json
{
  "protocol": "deep-review-mutation-v3",
  "command": "auto-recover",
  "repo": "ABSOLUTE_PROJECT_ROOT",
  "owner_token": null,
  "files": []
}
```

Change only `command`, `owner_token`, and `files` for later lifecycle calls.
The helper's stdout is one JSON result and is the authority for the next step.

## 1. Collect

Read the JSON result from `detect-environment.mjs`. Preserve `runtime_host` only
for diagnostics; never branch reviewer enumeration on it.

Build the cross-file manifest with:

```text
node {plugin_root}/hooks/scripts/build-change-files.mjs --repo PROJECT_ROOT --change-state CHANGE_STATE --review-base REVIEW_BASE
```

Use direct Git host commands with argv arrays to collect the matching diff:

- `non-git`: ask for an explicit file set and read it directly.
- `initial`: staged plus untracked files.
- `clean`: `REVIEW_BASE..HEAD` only; do not union leftover untracked files.
- `staged`, `unstaged`, `mixed`, `untracked-only`: collect that state and union
  eligible untracked files when `has_untracked` is true.

<!-- SSOT:diff-exclusion-set START -->
Exclude directory segments `node_modules`, `dist`, `build`, `.next`, `target`,
`.venv`, `__pycache__`, `.pytest_cache`, `vendor`, and `.git`; exclude
`*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`, and binary blobs.
<!-- SSOT:diff-exclusion-set END -->

For an oversized target, keep the existing thresholds: below 200 KB include
the diff, 200 KB through 1 MB provide the manifest and focused context, and
above 1 MB partition by architectural layer. A single file above 300 KB needs
explicit inclusion. One size-related retry is the maximum.

For a dirty Git target, offer a WIP commit. Create it only after an explicit
affirmative response. Acceptance changes the effective target to
`REVIEW_BASE..HEAD`; decline keeps the exact working-tree target and does not
disable eligible reviewers. Re-run environment detection after a WIP commit so
payload, companion scope, and report metadata use the same post-decision state.

## 2. Context and shared payload

Read `.deep-review/rules.yaml`, fitness evidence, and a canonical deep-work
session receipt when present. Validate any envelope identity before using its
health report. Treat malformed optional context as a visible warning, not as
reviewer instructions.

Contract selection remains exact: `--contract SLICE-NNN` reads only that named
contract and warns/skips when archived; bare `--contract` reads every active
contract; without the flag, active contracts are auto-loaded when present.
Ignore archived contracts during automatic selection. A malformed contract is
skipped with a visible path-specific warning while other active contracts
continue.

Write context and diff bytes to private temporary files through direct host
file tools, then invoke:

```text
node {plugin_root}/hooks/scripts/build-reviewer-payload.mjs --plugin-root PLUGIN_ROOT_ABS --repo PROJECT_ROOT --change-state CHANGE_STATE --review-base REVIEW_BASE --context-file CONTEXT_FILE --diff-file DIFF_FILE
```

If (and only if) the caller's argv carried `--prior-rounds-file=PATH`
(deep-review-loop round 2+ — see its §2), forward that same path to
`build-reviewer-payload.mjs` unchanged as `--prior-rounds-file PATH` together
with `--prior-base REVIEW_BASE`. Forward `--prior-rounds-file` **only when it
was explicitly passed** — the file's existence alone must never trigger
automatic consumption; that would be exactly the fixed-path-existence keying
this design replaced. A single-shot review invocation (no loop) never has
this flag and therefore never sees the section.

The JSON result contains the absolute shared payload path. This Node builder is
the sole doctrine injector for all supported reviewer roles. Preserve every
builder warning in the final report.

## 3. Reviewer flags, privacy, and capability enumeration

### 3.0 resolve reviewer flags

Resolve reviewer flags before any privacy work:

Build the current adapter set with `buildCapabilities` from
`{plugin_root}/hooks/scripts/lib/capability-registry.mjs`, combining detected
executables and fresh host assertions. Feed those protocol `2.0` capability
objects, normalized public-route overrides, merged review policy, and artifact
classification directly to `buildRoutingPlan` in
`{plugin_root}/hooks/scripts/lib/model-router.mjs`. Do not infer support from a
host label, duplicate the routing matrix in prose, or move model IDs through a
shell string.

1. Expand `--codex-only` to `--codex --no-opus --no-agy`.
2. Reject `--ultracode` with `--no-opus`; reject `--codex` with `--no-codex`.
3. `--no-opus` disables `claude-opus`; `--no-codex` disables both
   `codex-review` and `codex-adversarial`; `--no-agy` disables `agy`.
4. A native Codex generic subagent supplies `codex-review` whenever its host
   tool capability exists. It replaces the standard companion review rather
   than duplicating it. The generic role is available without a companion.
5. A companion may supply the standard role only when no generic role exists,
   and may independently supply optional `codex-adversarial`.
6. A named Claude agent or the Claude CLI bridge supplies `claude-opus`.
   Forward `review_model` unchanged; it is a non-empty installed Claude model
   alias such as `fable`.
7. Config value `agy_enabled: false` disables `agy` before privacy work.

`--no-agy`: skip the scan and preflight, create no state or config changes;
this disabled privacy branch is a no-op. `--codex-only`: after expansion, skip
the agy scan and preflight, create no state or config changes; it is also a
no-op privacy branch.

### 3.1 agy privacy preflight

Only when `agy` remains eligible, invoke this before any bridge can receive an
`--add-dir` argument:

```text
node {plugin_root}/hooks/scripts/agy-privacy-preflight.mjs --repo PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --config CONFIG_FILE --approval auto
```

- `auto_ack`: patch only the two acknowledgment config fields and continue.
- `acknowledged`: continue without changing unrelated config.
- `needs_approval`: show the sensitive hits and fingerprint, request explicit
  approval, and rerun with `--approval approve` or `--approval decline`.
- A positive approval may patch only those acknowledgment fields. Decline or
  any error excludes `agy`; no reviewer process receives project access.

### 3.2 planned companion index exposure

Run index mutation only if an eligible companion needs ignored-path exposure.
Send `scan-sensitive`, then `perform`, as framed JSON requests to
`mutation-protocol.mjs`. Obtain approval for sensitive files before `perform`.
Keep the returned owner token private for Stage 5 restoration. A generic Codex
subagent reads the payload and allowed project paths directly and never causes
index mutation merely because Codex is the host.

### 3.3 artifact classification and routing preflight

Immediately before Stage 4, invoke the reviewer-free preflight with argv-array
transport:

```text
node {plugin_root}/hooks/scripts/classify-artifacts.mjs --repo PROJECT_ROOT --emit-routing-plan --routing-plan-out .deep-review/tmp/routing-plan.json
```

When public-route returned normalized overrides, append `--overrides-json` and
the compact `JSON.stringify(route.overrides)` as one argv value. An explicit
override makes this preflight mandatory and any error stops dispatch. With no
explicit override, the plan is shadow provenance: a preflight error is a visible
warning and dispatch continues with the existing arguments unchanged. Automatic
routes are applied only when policy enables `automatic_model_routing` and sets
`routing_shadow_mode: false`.

Treat the emitted routing plan as the dispatch authority. It carries one
validated execution plan per canonical reviewer plus requested, resolved,
applied, fallback, and semantic provenance. Stage 4 leaf adapters consume that
plan by path and reviewer id; they do not reinterpret provider or reviewer
flags.

## 4. Dispatch independent reviewers

Launch every eligible role in a fresh background context. Capture a repository
fingerprint immediately before and after each reviewer. A changed fingerprint
makes that output untrusted and excluded.

Use the exported `captureFingerprint` API from
`{plugin_root}/hooks/scripts/lib/fingerprint.mjs` for both snapshots, with the
same `{ repo: PROJECT_ROOT, pluginRoot: PLUGIN_ROOT_ABS, mode }` options. Read
`mode` from `agy_fingerprint_mode` and default to `hybrid`. A capture error is
conservative drift. Persist only the digest/mode evidence needed by the report;
never expose file contents.

### 4.1 `claude-opus`

When named-agent capability exists, call `Agent(code-reviewer)` with the
configured model alias and the shared payload. The native Agent interface has a
model parameter, but effort is unsupported. Therefore an explicit
effort override on a native-agent-only route is a strict error; never report an
effort as requested-but-unverified when it could not be transmitted. Otherwise,
when Claude CLI exists, invoke:

```text
node {plugin_root}/hooks/scripts/run-claude-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --model REVIEW_MODEL --agent code-reviewer --timeout-seconds 1200
```

Only for an explicit override plan, append
`--routing-plan .deep-review/tmp/routing-plan.json --reviewer-id claude-opus`.
With no explicit override, preserve the command above byte-for-byte.

Do not replace a requested Claude role with a Codex identity. Record timeout,
authentication, empty-output, or unavailable-model status exactly as emitted.

### 4.2 `codex-review`

On native Codex, create one generic `spawn_agent` context. Its prompt must begin
with these ordered actions:

1. read the absolute `{plugin_root}/agents/code-reviewer.md` in full;
2. read the shared payload from its absolute path;
3. stay strictly read-only and inspect only the target repository;
4. return the `report-format.md` report contract as text.

Label it `codex-review`, never Opus. Capture the pre/post fingerprint and
exclude an untrusted result.

When generic capability is absent and a standard companion is eligible, use:

```text
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --companion COMPANION_FILE --kind review --scope working-tree --output OUTPUT_FILE --timeout-seconds 900
```

For a clean committed target, replace `--scope working-tree` with
`--base REVIEW_BASE`.

### 4.3 `codex-adversarial`

Write the adversarial focus text with a direct host file tool, then invoke:

```text
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --companion COMPANION_FILE --kind adversarial --base REVIEW_BASE --focus-file FOCUS_FILE --output OUTPUT_FILE --timeout-seconds 900
```

Use `--scope working-tree` instead of `--base` for a dirty target. The bridge
owns secure transport and cleanup.

### 4.4 `agy`

After a successful current privacy outcome, invoke:

```text
node {plugin_root}/hooks/scripts/run-agy-reviewer.mjs --binary AGY_FILE --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --mode hybrid --model AGY_MODEL --timeout-seconds 900
```

Only for an explicit override plan, append
`--routing-plan .deep-review/tmp/routing-plan.json --reviewer-id agy`. With no
explicit override, preserve the command above byte-for-byte.

The bridge revalidates privacy and fingerprint state. A `mutated` result is
untrusted even if the process produced report text.

### 4.5 `--ultracode`

Follow `ultracode-integration.md`. Six lenses collapse to one Anthropic voice;
they never increase `N_actual` above one for the Claude family. The loop may
request ultracode only on its first round.

## 5. Restore, synthesize, and report

If Stage 3 performed index exposure, send `restore` with the exact owner token
to `mutation-protocol.mjs` before synthesis. A restore error is a terminal
operational failure and must remain visible.

For every attempted role, serialize `role`, raw `output`, and the pre/post
fingerprint results to a private `attempts` JSON array. When at least two roles
remain trusted, perform the issue matching from `codex-integration.md` and add
a `consensus.findings` array. Each finding records `severity` (`critical` or
`warning`) and the unique admitted reviewer `roles` that reported that material
finding. Include every admitted critical and warning exactly once per reporting
role. Serialize `{ attempts, consensus }`, then invoke:

```text
node {plugin_root}/hooks/scripts/review-synthesis.mjs --input ATTEMPTS_FILE
```

This production helper validates the report contract, excludes fingerprint
drift or malformed/empty output, and is the executable authority for
`N_actual`, terminal status, verdict, and `phase6_allowed`. Stop when it returns
`operational_failure`; no later response or Phase 6 commit may proceed. A
missing, invalid, or count-inconsistent materialized consensus for two or more
trusted roles fails closed with `consensus_required`.

Count only successful trusted reviewer roles:

- `N_actual == 0`: no verdict is allowed; report an operational failure.
- `N_actual == 1`: critical or security findings yield `REQUEST_CHANGES`,
  warnings alone yield `CONCERN`, and no blocking finding yields `APPROVE`.
- `N_actual >= 2`: critical findings or agreed warnings yield
  `REQUEST_CHANGES`; split warnings yield `CONCERN`; otherwise `APPROVE`.

Ultracode's six lenses are one role. A degraded failed Claude role never
downgrades a blocking verdict; it raises a low-confidence `APPROVE` to
`CONCERN` when at most one external role remains.

Use `codex-integration.md` for issue matching and `report-format.md` for the
artifact. Create one unique
`.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md` through a direct host
file tool. Record every attempted role, terminal status, `N_actual`, builder
warning, privacy exclusion, mutation outcome, and fingerprint exclusion.

## 6. Stage 5.5 and optional entropy

After the report exists, read `recurring-findings-export.md`. When at least two
reports exist, classify the taxonomy once, write the payload file directly,
and call `wrap-recurring-findings-envelope.js --discover-sources-from`.
Preserve the payload and return a visible nonzero result if wrapping fails.

When `--entropy` is present, read `entropy-scan.md` and append its evidence.
Patch `last_review` only after the report and optional export complete, while
preserving every unrelated config field.
