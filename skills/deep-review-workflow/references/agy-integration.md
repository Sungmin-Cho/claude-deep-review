# agy integration

agy is an optional independent reviewer. `review-execution.md` resolves flags
and role eligibility before this reference is used.

## Privacy gate

Do not scan, create state, or patch config when `--no-agy` is effective,
including the expanded `--codex-only` route. Otherwise invoke:

```text
node {plugin_root}/hooks/scripts/agy-privacy-preflight.mjs --repo PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --config CONFIG_FILE --approval auto
```

The result is authoritative for the current repository fingerprint:

- `auto_ack` and `acknowledged` may continue.
- `needs_approval` must display the byte-sorted sensitive paths and fingerprint
  before requesting an explicit decision.
- approval reruns the preflight with `--approval approve`; decline reruns it
  with `--approval decline` and excludes the role.
- errors and stale results exclude the role. No project-access argument may be
  constructed before a successful outcome.

Only the acknowledgment fingerprint and timestamp may be patched. Preserve
all unrelated and unknown config keys.

## Reviewer bridge

After the current privacy gate succeeds, invoke with argv data:

```text
node {plugin_root}/hooks/scripts/run-agy-reviewer.mjs --binary AGY_FILE --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --mode hybrid --model AGY_MODEL --timeout-seconds 900
```

The bridge uses the shared payload, repeats the privacy validation, and captures
pre/post fingerprints. It may retry once without an unavailable model alias,
but the first pre-fingerprint remains authoritative across that retry. A
mutation, prompt-size refusal, timeout, authentication failure, or empty output
is a visible terminal status and contributes no vote.

## Synthesis identity

Label a trusted success `agy`. It is one Google-family vote independent of
`claude-opus`, `codex-review`, and `codex-adversarial`. Preserve a sole-family
dissent in the report even when a majority verdict is otherwise reached.
