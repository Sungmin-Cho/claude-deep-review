---
name: deep-review
description: Public cross-runtime entrypoint for independent review, initialization, and evidence-based review response.
user-invocable: true
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--no-agy] [--codex-only] [--respond (REPORT_PATH | --source=pr [--pr=NNN])]"
---

# deep-review — public route

Use this skill through `$deep-review:deep-review` on Codex or through the
`/deep-review` Claude adapter. Both entrypoints pass the same argument tokens
to this file; this file is the single owner of argument validation and routing.

## Runtime root

Resolve `plugin_root` once with the shared runtime contract: `PLUGIN_ROOT`, then
the Claude compatibility alias, then the installed skill location. Every file
below is read by joining its relative path to that absolute `plugin_root`.
Never infer reviewer availability from the selected root or from a host label.

## Argument validation

Serialize the original argument tokens as a private JSON array and invoke:

```text
node {plugin_root}/hooks/scripts/public-route.mjs --entry review --host HOST --cwd PROJECT_ROOT --args-file ARGS_FILE
```

The returned JSON is the executable route authority. Stop on `ok=false`; use
its expanded `argv` and terminal `route` without independently reparsing them.
The runtime enforces this grammar:

1. Expand `--codex-only` to `--codex --no-opus --no-agy` before validation.
2. Reject `--ultracode` with `--no-opus`, and reject `--codex` with
   `--no-codex`.
3. `--contract` consumes the next token only when it matches `SLICE-[0-9]+`.
   `--respond` consumes a following report path only when it names an existing
   file; `--source=pr` and `--pr=NNN` stay respond options.
4. Reviewer flags combined with `--respond` are ignored with one visible note.
5. Any unknown flag or extra positional token is a terminal validation error.

## Terminal routes

- `init` — terminal. Read
  `{plugin_root}/skills/deep-review-workflow/references/init-setup.md`, execute
  it, report completion, and 종료. Do not load the review pipeline.
- `--respond` — terminal. Read
  `{plugin_root}/skills/receiving-review/references/respond-execution.md`,
  execute the response protocol using returned `reportPath` when non-null or
  the validated PR-source options in returned `argv` otherwise, and 종료.
  That reference uses `respond-runtime.mjs` for report/PR/report-file I/O and
  `phase6-protocol.mjs` for snapshot/test/verify/recover/commit on both hosts.
  Claude named-agent fallback and Codex generic-subagent dispatch consume one
  shared Accepted Items prompt; neither route uses a hook or MCP server.
- `--qa` — terminal. Explain that App QA is reserved for a later release and
  종료 without creating state.
- `review` — terminal for `--contract`, `--entropy`, reviewer flags, or no
  arguments. Read the internal workflow skill and then
  `{plugin_root}/skills/deep-review-workflow/references/review-execution.md`;
  execute it once and 종료 with the resulting report path and verdict.

The internal workflow and receiving skills are implementation details and are
not public marketplace prompts.
