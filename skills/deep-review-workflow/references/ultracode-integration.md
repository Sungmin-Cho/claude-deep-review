# Ultracode integration

`--ultracode` upgrades the Claude family role to six focused lenses. It does
not create six independent vendor votes.

## Preconditions and payload

Resolve flags first. `--ultracode` with `--no-opus` is a terminal conflict.
Build one shared payload with `build-reviewer-payload.mjs`; every lens receives
the identical doctrine, change manifest, project context, and target diff.
Forward the configured non-empty Claude model alias unchanged, including a
custom alias such as `fable`.

When named-agent capability exists, create six fresh `Agent(code-reviewer)`
contexts focused on correctness, architecture, entropy, tests, readability,
and security. Every context remains read-only and returns the report contract.
Capture pre/post fingerprints around each context and exclude mutated output.

When six named contexts are unavailable, degrade visibly to one independent
Claude bridge through `run-claude-reviewer.mjs`; do not emulate fan-out with a
different model family and do not claim ultracode verification.

## Quorum and one-voice collapse

Let `K` be trusted successful lenses:

- `K == 0`: Claude family status is `failed`.
- `1 <= K < 4`: status is `partial`; collapse the available evidence but mark
  it unverified.
- `K >= 4`: status is `success`; collapse the six-lens evidence.

Normalize issues by severity, path, seven-line bucket, and substance, then
merge materially identical items. The collapsed result contributes exactly one
`claude-opus` voice to `N_actual`. Keep lens-level provenance in the report.

## Loop cadence

`deep-review-loop` forwards `--ultracode` only in round 1. After that successful
attempt it sets `ultracode_consumed=true`, removes `--ultracode`, and normally
injects `--no-opus --no-agy` while retaining Codex. If Codex was unavailable,
the next round withholds `--no-opus` so at least one reviewer remains. A loop
that never requested ultracode keeps its original reviewer flags on every
round.
