# Codex integration

`runtime-dispatch.md` owns role selection. This file owns Codex execution and
cross-model synthesis after the public route has resolved `plugin_root`.

## Roles

- `codex-review` is the standard OpenAI voice. On Codex it is one fresh generic
  subagent. On a host without that capability, an installed companion may fill
  it through `run-codex-reviewer.mjs --kind review`.
- `codex-adversarial` is optional and requires a detected companion. It runs
  through `run-codex-reviewer.mjs --kind adversarial`.
- A native generic role replaces the standard companion role; never count both
  for the same review. `--no-codex` disables both Codex roles.
- Companion availability never controls native generic availability and never
  controls the independent `claude-opus` bridge.

## Native generic prompt

Pass absolute paths as data. The first instructions, in order, are:

1. Read `{plugin_root}/agents/code-reviewer.md` in full.
2. Read the shared payload file built by `build-reviewer-payload.mjs`.
3. Operate in read-only mode; never edit, create, stage, or commit.
4. Inspect relevant target files and return the shared report contract as text.

Capture the repository fingerprint before and after `spawn_agent`. Mark any
changed result `untrusted` and exclude it from synthesis. Identify the voice as
`codex-review`, not as a Claude model.

## Companion bridge

Use direct argv invocation and the exact target selected in Stage 1:

```text
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --companion COMPANION_FILE --kind review --scope working-tree --output OUTPUT_FILE --timeout-seconds 900
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --companion COMPANION_FILE --kind adversarial --base REVIEW_BASE --focus-file FOCUS_FILE --output OUTPUT_FILE --timeout-seconds 900
```

Swap `--scope working-tree` and `--base REVIEW_BASE` according to dirty versus
committed target state. The Node bridge owns timeout, focus transport, result
sidecars, and cleanup.

Run `mutation-protocol.mjs` only when the selected companion needs ignored
paths exposed. Native generic review reads the allowed paths directly and does
not alter the index.

## Synthesis

Normalize issues to severity, path, seven-line bucket, and substance. Merge
only materially identical issues. Preserve each role's agreement and dissent:

- with two trusted voices: unanimous or split;
- with three: unanimous, majority, or solo;
- with four: unanimous, majority three of four, split two of four, or solo.

`N_actual` is the number of trusted successful roles, not the number requested.
Apply the N=0/N=1 rules in `review-execution.md` before ordinary consensus.
Ultracode's collapsed output remains one Anthropic voice. A failed or untrusted
role is named in Summary and contributes no vote.
