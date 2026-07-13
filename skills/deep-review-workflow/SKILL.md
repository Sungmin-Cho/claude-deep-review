---
name: deep-review-workflow
description: Internal cross-runtime review pipeline used by the public deep-review skill.
user-invocable: false
---

# Deep Review Workflow

This internal skill is loaded only by the public review branch. Public users
invoke `$deep-review:deep-review` or its `/deep-review` Claude adapter.

## Reference map

- `references/runtime-dispatch.md` — capability-based entry and reviewer matrix
- `references/review-execution.md` — executable review pipeline
- `references/review-criteria.md` — six review lenses and severity doctrine
- `references/codex-integration.md` — Codex roles and synthesis
- `references/agy-integration.md` — privacy-gated agy role
- `references/ultracode-integration.md` — optional six-lens Claude fan-out
- `references/recurring-findings-export.md` — Stage 5.5 export
- `references/init-setup.md` — public init terminal branch
- `references/contract-schema.md` and `references/report-format.md` — data contracts

The reviewed runtime-reference file map is the list above. Every executable
review or loop path uses `.mjs`/`.js` helpers or direct host tools.

## Runtime root contract

Resolve `plugin_root` in this order: generic `PLUGIN_ROOT`, compatibility
`CLAUDE_PLUGIN_ROOT`, then the current runtime module location. The generic
override never identifies the host. Invoke
`node {plugin_root}/hooks/scripts/detect-environment.mjs --cwd {project_root} --format json`
and use its absolute `plugin_root` value for every later plugin path.

## Pipeline map

1. Collect environment and target data with `detect-environment.mjs`,
   `build-change-files.mjs`, direct Git host commands, and direct file reads.
2. Load active Sprint Contracts when requested or present.
3. Build one shared reviewer payload with `build-reviewer-payload.mjs`.
4. Enumerate independent roles from `runtime-dispatch.md`, dispatch all
   eligible roles, and enforce read-only fingerprints.
5. Synthesize only trusted successful results into `report-format.md`.
6. Restore any planned companion index exposure with `mutation-protocol.mjs`.
7. Export recurring evidence through `wrap-recurring-findings-envelope.js`.

The detailed stages and failure behavior live only in `review-execution.md`.

## Configuration

`review_model` is a non-empty installed Claude model alias; `fable` is a valid
example. Treat the value as opaque and forward it unchanged to the named
Claude agent or `run-claude-reviewer.mjs`. Unknown or unavailable aliases fail
that role visibly and never fall back to a different model identity.

The remaining top-level keys retain their existing meaning:

```yaml
review_model: fable
codex_notified: false
agy_notified: false
agy_enabled: true
agy_sensitive_acked_fingerprint: ""
agy_sensitive_acked_at: ""
agy_fingerprint_mode: hybrid
last_review: null
app_qa:
  last_command: null
  last_url: null
```

Patch only the intended top-level key through the Node config writer or a
precise host edit. Preserve unknown user keys.
