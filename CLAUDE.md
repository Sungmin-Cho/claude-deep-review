@AGENTS.md

# deep-review — Claude Code notes

`AGENTS.md` above is the whole guide, shared by both hosts. Only what is specific to
Claude Code lives here.

## Adapter and subagents

`{plugin_root}/commands/deep-review.md` is the `/deep-review` command on this host. It resolves the
absolute plugin root, reads `{plugin_root}/skills/deep-review/SKILL.md` in full, and
executes that public skill with the original arguments byte-for-byte — it does not
re-parse, add, remove or reorder flags. Behaviour changes belong in the skill, not in
the adapter.

`{plugin_root}/agents/code-reviewer.md` and `{plugin_root}/agents/phase6-implementer.md`
are Claude subagent
definitions. They are spawned by the pipeline, never invoked directly.

## Commit trailer

```text
Co-Authored-By: Claude <model> (1M context) <noreply@anthropic.com>
```

Read the model name from the session rather than copying one from an older commit — a
hardcoded name here goes stale the way a hardcoded version does.
