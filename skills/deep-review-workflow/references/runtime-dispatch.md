# Runtime dispatch — capability SSOT

The public entries and reviewer roles are selected from available host tools
and executable capabilities. The `Claude Code` and `Codex` columns are
capability profiles, not a `runtime_host` switch.

The executable capability contract in
`{plugin_root}/hooks/scripts/lib/capability-registry.mjs` is authoritative.
This table explains that contract for orchestrators; when prose and runtime
data differ, use the protocol `2.0` registry output. Native host assertions are
injected for the current run and are never restored from the executable cache.

| Role | Claude Code | Codex |
|---|---|---|
| public review/respond entry | `/deep-review` command shim | `$deep-review:deep-review` |
| loop entry | `/deep-review-loop` | `$deep-review:deep-review-loop` |
| independent Claude reviewer | named `Agent(code-reviewer)` or Node Claude bridge | Node Claude bridge when CLI exists |
| Codex standard reviewer | Node Codex bridge | generic subagent that reads `agents/code-reviewer.md` |
| Codex adversarial reviewer | Node Codex bridge | Node Codex bridge |
| agy reviewer | Node agy bridge | Node agy bridge |

## Selection invariants

- Enumerate roles by tool capability: named-agent availability and the
  detected Claude, Codex companion, and agy executables. `runtime_host` is
  diagnostic only and must never change reviewer enumeration or `N_actual`.
- A native Codex generic subagent is one fresh context, counts once as
  `codex-review`, and replaces the standard companion review. It is never
  labeled Opus. It is available without a separately installed companion;
  companion detection controls only optional `codex-adversarial`.
- The generic subagent's prompt first reads the absolute
  `{plugin_root}/agents/code-reviewer.md`, then reads the shared payload file,
  stays read-only, and returns the report contract. It consumes those paths
  directly and does not mutate the Git index merely because Codex is the host.
- When Claude CLI exists, `run-claude-reviewer.mjs` remains the distinct
  `claude-opus` role. A named Claude agent fills the same role when available.
- On a Claude capability profile, `run-codex-reviewer.mjs --kind review` fills
  `codex-review`; its optional second invocation fills `codex-adversarial`.
- `--no-codex` disables both the standard and adversarial Codex roles. It does
  not affect `claude-opus` or `agy`.
- The Git-index mutation protocol runs only when a planned companion process
  needs ignored-path exposure. The generic subagent never triggers it by
  itself.

## Read-only trust boundary

Capture a pre and post repository fingerprint around every external or generic
reviewer. Any mutation makes the result untrusted and excluded from synthesis.
Use the shared `lib/fingerprint.mjs` `captureFingerprint` API with identical
`repo`, `pluginRoot`, and `mode` options for both snapshots. Record the
exclusion in the final report; never silently reduce `N_actual`.
