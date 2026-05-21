# Changelog

**English** | [한국어](./CHANGELOG.ko.md)

## [1.7.0] — 2026-05-20 (agy 4-way Review Integration)

### Added

- **Google Antigravity CLI (`agy`, Gemini 3.5 Flash)** as a 4th reviewer in the cross-model review pipeline — cross-vendor-family parallel with Opus + Codex review + Codex adversarial.
- **`hooks/scripts/run-agy-reviewer.sh`** — standalone bridge with `_timeout`/`_sha256` shims, deterministic binary binding via Stage 1 detection.
- **`skills/deep-review-workflow/references/agy-integration.md`** — full reference doc covering preflight, spawn, timeout/auth handling, and N-way synthesis.
- **4-way verdict synthesis table** with `dissenter`/`dissenter_family`/`dissent_summary` annotations (preserves cross-vendor-family signal at 3/4 threshold).
- **Stage 3.5 pre-spawn fingerprint-based sensitive-file acknowledgment** (scan-on-every-spawn semantics).
- **`.deep-review/config.yaml` schema**: `agy_notified`, `agy_enabled`, `agy_sensitive_acked_fingerprint` (with idempotent migration for v1.6.x users).
- **Tests**: `test-detect-environment.sh` (extended), `test-run-agy-reviewer.sh` (Mechanism A/B + argv capture), `test-phase6-protocol-e2e.sh` E12 (source enum widening).

### Changed

- **`detect-environment.sh`** — `_emit_agy_vars` helper called before every `exit 0` (3 detection paths).
- **`commands/deep-review.md`** — Stage 1 parsing, Stage 3.5 acknowledgment, Stage 3 preflight + 4-way spawn, Stage 4 4-way synthesis.
- **`skills/deep-review-workflow/references/codex-integration.md`** — N-way table extended to 4, mutation gating documented as codex-only.
- **`skills/deep-review-workflow/references/report-format.md`** — Review Mode enum + 5-column Cross-Model table.
- **`CLAUDE.md`** — "3-way" → "최대 4-way" + new config flag mentions.

### Unchanged

- Mutation protocol (`git add -f -N` + lock) — codex-only; agy is orthogonal (uses `--add-dir` walk).
- Phase 6 implementer + envelope schema — reviewer count is independent of envelope shape.

### Migration notes

- v1.6.x users: on next `/deep-review` invocation, three new config fields are added independently (preserves `agy_enabled: false` opt-out — see migration logic in `commands/deep-review.md` Stage 0).

### Empirical validation

- The spec itself was validated through a 7-round deep-review-loop. Loop terminated by §3.C judgment after Round 7 — fix-introduces-defect pattern empirically confirmed across 4 consecutive rounds, validating the cross-vendor bias-elimination thesis the spec advocates. 12 Round 7 findings carried forward to this implementation (see plan §R7 Carry-Forward).

---

## [1.6.1] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- **`.codex-plugin/plugin.json`** — Codex-native plugin manifest pointing at the same skill and hook surfaces as the Claude Code manifest while preserving the existing `claude-deep-*` repository identity.
- **`AGENTS.md`** — Codex project guide covering runtime surfaces, verification commands, and the downstream suite marketplace update requirement.

### Changed

- Version bumped 1.6.0 → 1.6.1 across package and plugin manifests for a patch release.
- README documentation now calls out Codex compatibility alongside the existing Claude Code surface.

### Verification

- Repository validation was run before release; see the PR checklist for the exact command output.

## [1.6.0] — 2026-05-16 (`/deep-review-loop` command → user-invocable skill)

### Changed — `/deep-review-loop` migrates from a slash command to a `user-invocable: true` skill

The `/deep-review-loop` review↔respond auto-iteration wrapper, shipped in v1.5.0 as a slash command (`commands/deep-review-loop.md`), is now a skill (`skills/deep-review-loop/SKILL.md`). The intent is **Codex / SDK / non-Claude-Code platform parity** — slash commands are Claude-Code-specific, whereas skills are the cross-platform invocation surface understood by Claude Code, Codex CLI, Copilot CLI, Gemini CLI, and the Agent SDK. With this migration the loop becomes invokable from any of those environments via `Skill({ skill: "deep-review:deep-review-loop", args: "..." })`, while the existing slash entry `/deep-review-loop` keeps working in Claude Code (skills with `user-invocable: true` are exposed as slash entries automatically).

- **Behavioural delta: zero.** The §0–§9 protocol — argument pre-validation, the round body (Review → conditional Respond → Metrics), the round-identity set-difference invariant, the Respond-path realpath guard, the stalled-`findings_signature` ≥ 50% detector, the operational-error ≥ 2 hard stop, the natural `APPROVE` + 🔴/🟡 = 0 convergence, the `--max` safety cap (default 5; counts Review calls only) — all carry over verbatim. The only language change is "wrapper / command" → "skill" in self-references, plus a new `## Invocation` section disambiguating slash entry vs `Skill(...)` entry.
- **Frontmatter migration**: removed the command-specific `allowed-tools` + `argument-hint` fields. New skill frontmatter: `name: deep-review-loop`, `description: Use when ...` (third-person, triggering-conditions-only per skill-authoring guidance), `user-invocable: true`.
- **`commands/deep-review-loop.md`** deleted. **`skills/deep-review-loop/SKILL.md`** added. **`commands/deep-review.md`** §intro link adjusted to point to the skill path (`../skills/deep-review-loop/SKILL.md`) with a one-line invocation hint covering both entry surfaces.
- **`CLAUDE.md`** directory tree updated (`commands/` shrinks to a single file; `skills/deep-review-loop/` added). The "Slash commands" reference table renamed to "Slash commands & user-invocable skills" with a `Kind` column distinguishing command rows from the new skill row.
- **`README.md` / `README.ko.md`** rows updated to describe the dual entry (`/deep-review-loop` slash in Claude Code; `Skill({ skill: ... })` everywhere else).

### Why now

The v1.5.0 implementation was already designed not to dispatch other slash commands (it `Read`s `commands/deep-review.md` and follows it inline) precisely because slash-to-slash dispatch is not portable. Promoting it to a skill closes the loop: there is no command-only invariant left that justifies a command-only entry point. Codex migration prep — and any future Agent-SDK-driven harness wrapping deep-review — gets a uniform entry through `Skill(...)`.

### Versions

- `.claude-plugin/plugin.json` 1.5.1 → 1.6.0.
- `package.json` 1.5.1 → 1.6.0.

## [1.5.1] — 2026-05-13 (skill-drift cleanup — plugin-dev audit follow-up)

### Fixed — Documentation drift between v1.5.0 release and shipped artifacts

`plugin-dev:plugin-validator` + `plugin-dev:skill-reviewer` audit after the v1.5.0 release surfaced 7 documentation-drift items between the skill/spec docs and the actually-shipped artifacts. This patch resolves all of them; no command, script, hook protocol, or runtime behavior changes.

- **`agents/code-reviewer.md`, `agents/phase6-implementer.md`** — Removed non-standard `whenToUse` frontmatter field (the Claude Code agent schema has no such key; it was silently ignored). The "do not call directly" guidance is merged into the existing `description` block scalar.
- **`skills/deep-review-workflow/SKILL.md`**:
  - Stage 5 dangling cross-reference clarified — the `(Stage 5)` label now reads `(/deep-review --respond 모드, Stage 5+ 참조)`, anchored against a new `## Stage 5+ (커맨드 레벨 확장)` section that explicitly delegates stages 5 / 5.5 / 6 / 7 to `commands/deep-review.md`.
  - Codex Mutation Protocol section gains a `*왜 필요한가*` rationale paragraph (Codex CLI sees only git-tracked paths → gitignored session files require intent-to-add mutation + post-verification restore).
  - Inline `(v1.3.x …)` changelog crumbs trimmed from Stage 3 Case 3 — technical facts retained, version tags removed (they belong in CHANGELOG, not in spec).
- **`skills/receiving-review/SKILL.md`** — `references/phase6-delegation-spec.md` (Phase 6 dispatch design spec) is now linked from "참조 문서" with a 1-line purpose so debugging discovers it through the SKILL.
- **`skills/receiving-review/references/response-protocol.md`** — Phase 6 "구현 규칙 — 그룹 dispatch" trimmed from 35 lines of duplicated shell logic (sed/awk/git commit --only specifics) to a single-source-of-truth table + 7-item invariant summary. The shell logic lives canonically in `commands/deep-review.md` `--respond` Step 2.5; duplication created drift risk. Re-review suggestion block also replaced with a pointer to `SKILL.md "Re-review 제안"`.
- **`skills/receiving-review/references/phase6-delegation-spec.md`** — Status `Draft (브레인스토밍 합의 반영)` → `Shipped (v1.3.3+, revised through v1.5.0)`; dual-dated `2026-04-24 (initial), revised 2026-05-13`. The embedded YAML frontmatter example synced to the shipped shape (no `whenToUse`), with a migration note explaining the v1.3.3 → v1.5.1 schema convergence.

Validation: `plugin-dev:plugin-validator` + `plugin-dev:skill-reviewer` re-runs report PASS with zero new warnings/errors after these changes.

### Versions

- `.claude-plugin/plugin.json` 1.5.0 → 1.5.1.
- `package.json` 1.5.0 → 1.5.1.

## [1.5.0] — 2026-05-13

### Added — `/deep-review-loop` wrapper command

New slash command `/deep-review-loop` that runs `/deep-review` (review) and `/deep-review --respond` (respond) back-to-back, repeating until the main agent decides further iteration is no longer useful.

- **Argument**: accepts `--contract [SLICE-NNN]` / `--entropy` (forwarded to each review round) plus a `--max=N` safety cap (default 5; **unit = Review calls**, Respond does not advance the counter). Rejects `--respond` / `init` / `--qa` because they collide with the loop semantics.
- **Termination policy**: not a hard iteration count. The main agent terminates on (a) natural convergence (`verdict=APPROVE`, no 🔴/🟡), (b) `--max` reached, (c) **stalled state** — same `findings_signature` set (severity:file:line±3:taxonomy_category) reappears ≥50% with `implemented_count=0` or `halted=true`, (d) operational errors (mutation restore failures, lock contention) accumulating ≥ 2 in one round, or (e) user picking "stop" at any guard. Soft-continue requires verdict in `(REQUEST_CHANGES, CONCERN)` AND at least one implemented change in the previous round AND meaningfully different `findings_signature`.
- **Implementation**: the wrapper `Read`s `commands/deep-review.md` once and follows its existing "리뷰 모드" / "대응 모드" sections inline per round — no new state files are introduced. Loop metrics live in session memory only; the final summary lands in `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-loop-summary.md` (untracked under existing `.gitignore` policy).

Use case: the common pattern of running `/deep-review` → seeing `REQUEST_CHANGES` → immediately running `/deep-review --respond` → re-running `/deep-review` to verify can now be triggered as a single wrapper that converges on its own.

### Changed — Codex per-call timeout 300s → 900s (15 min)

- `commands/deep-review.md` (4 call sites: §3 stderr probe, review, adversarial-review Option A, Option B step 3).
- `skills/deep-review-workflow/SKILL.md` Stage 3 Case 3 (review + adversarial-review).
- `skills/deep-review-workflow/references/codex-integration.md` §Preflight Step 3, §3-way (review + adversarial-review), §Codex 인증 실패 처리.
- Historical references to `timeout 300` in CHANGELOG entries are preserved as point-in-time facts.

Reason: 300s was repeatedly hit on large diffs, rate-limited Codex sessions, and retry-prone first-token latency, demoting valid 3-way reviews to 1-way with `CODEX_STATUS=timeout`. 900s preserves the safety net while removing the false-positive timeout class. The shim semantics (gtimeout → timeout → perl alarm fallback) are unchanged.

### Changed — `REVIEW_TIMEOUT_SECONDS` 600s → 1200s (mutation lock orphan window)

`hooks/scripts/mutation-protocol.sh:43` — the mid-review orphan-detection window for `status=committed` locks is raised from 600s (10 min) to 1200s (20 min). With the new `_timeout 900` per Codex call, a legitimate review can hold the lock close to 900s; the prior 600s threshold made a concurrent session's `auto_recover` misclassify the active reviewer's lock as orphaned and pull its intent-to-add entries out from under it. 1200s = 900s + 300s synthesis/I-O margin. Override per-session with `export REVIEW_TIMEOUT_SECONDS=N`.

### Versions

- `.claude-plugin/plugin.json` 1.4.2 → 1.5.0.
- `package.json` 1.4.2 → 1.5.0 (kept in lockstep with the plugin manifest per prior release policy).

## [1.4.2] — 2026-05-12 (M5.5 #5 follow-up — cross-platform `stat` order fix)

### Fixed — `mutation-protocol.sh` BSD-first `stat -f %m` ordering broke ubuntu

Pre-fix, `acquire_mutation_lock()` and `auto_recover()` resolved the lock mtime via:

```bash
lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
```

The order was wrong: GNU `stat -f` **accepts** the flag (it means "filesystem status" on Linux, not file status) and `%m` resolves to the mount-point STRING (e.g. `/`). The fallback `||` never triggered. The next line `age=$((now - lock_mtime))` then hit an arithmetic syntax error because `/` is not a numeric operand, and under `set -e` the script exited.

This stayed latent because the bash test (`test-mutation-protocol.sh`) was never run in CI before M5.5 #5 (PR #11) added it; the failure was deferred at the time (per the v1.4.1 CHANGELOG note) and surfaced again in this investigation.

**Fix**: reverse the stat order — GNU `-c %Y` first, BSD `-f %m` fallback. Mirrors the deep-work PR #27 `test-v6.4.2-regression.sh` §2 BSD/GNU `stat` reverse-order pattern.

### Changed

- `hooks/scripts/mutation-protocol.sh` lines 65 and 253 — two call sites updated, with cross-reference comments explaining the order contract.
- `.github/workflows/tests.yml` — re-enabled the `bash hooks/scripts/test/test-mutation-protocol.sh` CI step that was disabled in v1.4.1 as a workaround. Both ubuntu and macOS legs now exercise the full mutation-protocol regression.
- `.claude-plugin/plugin.json` + `package.json` version: 1.4.1 → 1.4.2.

### Investigation

Root cause was identified via a debug branch (`debug/ubuntu-mutation-protocol-trace`, PR #12) that added `>>> MARK` trace lines around every test transition and inside `assert_failure()`. The trace showed the exit happening between `assert_failure: pre-eval` and `post-eval` — i.e. inside the inner `eval "acquire_mutation_lock"` of the second call (when the lock was already held). That narrowed the suspect to acquire_mutation_lock's fallback-stat block, which then identified the `-f %m` cross-platform divergence.

## [1.4.1] — 2026-05-12

### Added — M5.5 #5 mutation-lock stale-recovery integration test

3 new test cases in `hooks/scripts/test/test-mutation-protocol.sh` (Test 26 / 27 / 28) close the M5.5 acceptance gap that Test 12 (stale state, no lock) and Test 10 (restore_mutation user-staging filter) leave open: the **integration scenario** of leftover `.deep-review/.mutation.lock` + `.pending-mutation.json` co-existing with user-staged changes from an unrelated flow. The new tests pin all 5 contract properties simultaneously — (1) orphan-lock detection, (2) lock release, (3) our i-t-a removal, (4) **user staging preservation**, (5) state-file cleanup. A single regression that breaks (4) without breaking (1)/(2)/(3)/(5) would have slipped past the prior suite.

- Test 26 (M5.5 #5-A): single user-staged file + crashed mutation → recover + preserve.
- Test 27 (M5.5 #5-B): defensive no-op when state file missing (auto_recover must not strip legitimate staging).
- Test 28 (M5.5 #5-C): 3 user-staged files survive recovery (off-by-one in i-t-a filter regression guard).

Total assertions: 51 → 54 (+3). No production code changes — this PR is test-only.

### Changed

- `.claude-plugin/plugin.json` version: 1.4.0 → 1.4.1 (test-only patch).

### Notes

- Bash regression tests (`test-mutation-protocol.sh`) are run **locally on macOS** but **deferred from ubuntu CI integration** to a follow-up. An initial attempt to add the bash step to `tests.yml` exposed a pre-existing ubuntu-specific failure between tests 5 → 6 that is unrelated to the M5.5 #5 additions; macOS bash 3.2 paths through cleanly. The latent bug investigation will be its own PR.
- Spec: `claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-tests-handoff.md` §2 #5 (deep-review row).

## [1.4.0] — 2026-05-08

M3 Phase 2 envelope adoption (handoff §3 procedure). `.deep-review/recurring-findings.json` is now emitted as an M3 cross-plugin envelope (cf. `claude-deep-suite/docs/envelope-migration.md`). Reader paths that consume deep-work session-receipt are envelope-aware with a strict 3-way identity guard. Pattern adapted from deep-evolve PR #11 `9b867b1` (the most recent prior plugin migration). Suite repo's `docs/envelope-migration.md` §6.1 is the canonical adoption ledger — this CHANGELOG intentionally avoids reproducing position counts (handoff §4 cross-section count drift rule).

### Added
- `hooks/scripts/envelope.js` — zero-dep, CommonJS envelope library. Exports: `generateUlid` (MSB-first Crockford Base32 26-char ULID, lex-monotonic across timestamps), `detectGit` (head/branch/dirty trio with `0000000`/`unknown` fallback for shallow CI clones), `loadProducerVersion` (resolves `.claude-plugin/plugin.json` relative to module `__dirname`, **not** caller cwd — handoff §4 literal-cwd-resolve lesson), `wrapEnvelope` (builds the envelope object; rejects null/array payload, validates own runId AND parentRunId as ULIDs at library boundary), `isEnvelope` (loose detector — collision-safe against legacy receipts that lack `envelope` key), `isValidEnvelope` (strict — adds the W4 payload-shape gate so corrupt envelopes don't contribute trace data downstream), `unwrapEnvelope` (legacy pass-through + identity-matched payload extraction + corrupt-payload rejection with stderr warning).
- `hooks/scripts/wrap-recurring-findings-envelope.js` — CLI used by `commands/deep-review.md` Stage 5.5 ("Recurring Findings Export") via the Bash tool. GNU-style flag parsing accepts `--key value` AND `--key=value`; required-value flags reject empty values at the CLI layer (`--source-session-receipt=`, `--output=`, `--payload-file=`, `--session-id=`); unknown flags are rejected (KNOWN_FLAGS allow-list). `--source-session-receipt` performs strict 3-way identity check (producer=deep-work, artifact_kind=session-receipt, schema.name match) on the consumed deep-work session-receipt; on success its `envelope.run_id` is auto-set as `parent_run_id` (handoff §3.3 chain) AND added to `provenance.source_artifacts` with run_id; on legacy/foreign envelope, only the path lands in source_artifacts (no chain corruption). `--source-artifact <path[:run_id]>` is repeatable for multi-source aggregation (typically review report markdown paths); path-only entries auto-harvest run_id IF the file is a self-consistent envelope (producer === schema.name === artifact_kind, valid ULID), else path-only. Caller's `--parent-run-id` (must itself be a valid ULID — boundary validation before payload read) always wins over auto-detection. Atomic write via `<output>.tmp.<pid>.<Date.now()>` + `fs.renameSync` — mid-write Ctrl-C/OOM/hook-timeout or two concurrent writers cannot leave a truncated artifact (deep-work round-1 C1 lesson).
- `scripts/validate-envelope-emit.js` — zero-dep release lint that mirrors the suite-side `artifact-envelope.schema.json` without external schema validators. Enforces: `additionalProperties:false` on root, envelope, git, schema, provenance, and source_artifacts items (root + envelope additionally allow `^x-` prefixed forward-compat keys); `producer === "deep-review"`; `artifact_kind === schema.name` (round-4 identity drift guard); ULID 26-char Crockford Base32 (excludes I/L/O/U) for run_id and parent_run_id; SemVer 2.0.0 strict for producer_version (rejects leading zeros, accepts prerelease + build metadata); RFC 3339 for generated_at; `git.head` matches `/^[a-f0-9]{7,40}$/`; `git.dirty ∈ {true, false, "unknown"}`; `tool_versions` container is object (not array — JS `typeof []==='object'` gotcha guard, handoff §4 round-3) AND each value is string OR (object && !array); payload is non-null/non-array object (suite payload-registry locks the domain shape in Phase 3). Exit 0/1/2 on valid/invalid/IO-error. Emits per-file `OK`/`FAIL` lines and indented error reasons.
- `tests/envelope-emit.test.js` + `tests/envelope-chain.test.js` (87 cases via `node --test`) — exercise generateUlid lex-monotonicity, wrapEnvelope identity rejections (artifactKind/payload/parentRunId), unwrapEnvelope identity guards (producer/artifact_kind/schema.name 3-way + corrupt payload), isEnvelope/isValidEnvelope detection, loadProducerVersion literal-cwd-resolve, fixture round-trip, every additionalProperties violation, ULID/SemVer/RFC 3339/git.head boundary cases, **and** the chain contract: `recurring-findings.envelope.parent_run_id === consumed session-receipt.envelope.run_id` (handoff §3.3 contract test), CLI rejection of malformed `--parent-run-id` and empty required flags, foreign-envelope rejection at the session-receipt path (no parent_run_id chain, no run_id leak into source_artifacts), atomic write residue check.
- `tests/fixtures/sample-recurring-findings.json` — canonical envelope-wrapped emit. Phase 3 input for the suite-side payload-registry placeholder → authoritative shape replacement at `claude-deep-suite/schemas/payload-registry/deep-review/recurring-findings/v1.0.schema.json`.
- `package.json` `scripts.test` — `node --test tests/envelope-emit.test.js tests/envelope-chain.test.js`.

### Changed
- `.claude-plugin/plugin.json` and `package.json` `version`: `1.3.4` → `1.4.0` (envelope adoption is a new contract — minor bump per handoff §3.4).
- `commands/deep-review.md` Stage 5.5 ("Recurring Findings Export") — payload synthesis (LLM taxonomy classification of `.deep-review/reports/*.md` Critical+Warning items) now writes to a temp file at `.deep-review/.tmp-recurring-payload.<pid>.<RANDOM>.json`, then `wrap-recurring-findings-envelope.js` produces the final envelope-wrapped artifact at `.deep-review/recurring-findings.json`. Bash snippet uses `set -euo pipefail` + gated cleanup (helper-success-only `rm`, on failure the payload temp file is preserved so the user can retry without re-running the LLM classification — deep-work round-1 C2 lesson). `${CLAUDE_PLUGIN_ROOT:?...}` and `git rev-parse --show-toplevel` give caller-contract-explicit env handling (Bash tool spawns a fresh shell per invocation so prior exports don't persist — deep-evolve round-2 R2-3 lesson). Multi-source: every review report markdown path lands in `provenance.source_artifacts` via repeatable `--source-artifact` (path-only — markdown can't be envelope-detected, so no run_id).
- `commands/deep-review.md` Stage 3 ("Receipt health_report 주입") — receipt loader is now envelope-aware. Detection: `schema_version === "1.0"` AND `envelope` (object) AND `payload` present at top level. Strict 3-way identity guard (producer=deep-work, artifact_kind=session-receipt, schema.name=session-receipt) AND payload non-null/non-array — only on full pass do we read `payload.health_report` AND remember `envelope.run_id` as `SOURCE_SESSION_RECEIPT_RUN_ID` (Stage 5.5 chain source). Identity mismatch (foreign producer / drift / corrupt payload) is **not** a legacy fall-through — it emits a "envelope identity mismatch — skip" warning to surface possible corruption (round-1 C2 + corrupt-payload lessons). Legacy (envelope-shape-absent) receipts continue to fall through to top-level `health_report` access; their absence of an envelope means SOURCE_SESSION_RECEIPT_RUN_ID stays unset and Stage 5.5 doesn't chain (graceful pre-1.4.0 compatibility).

### Cross-plugin chain contract
- `recurring-findings.envelope.parent_run_id` := `<consumed session-receipt envelope.run_id>` when Stage 3 found an envelope-wrapped deep-work session-receipt that passed all identity guards. Stage 5.5 hands the session-receipt path to the wrap helper; the helper runs the same 3-way check and harvests run_id strictly. Foreign envelopes contribute path-only with no run_id (defense-in-depth — silent run_id leak would corrupt M4 telemetry trace reconstruction; deep-evolve round-1 C2 lesson). `tests/envelope-chain.test.js` exercises this contract end-to-end via the actual CLI helper.
- Both downstream consumers (deep-evolve `init.md` Stage 3.5 and deep-work `gather-signals.sh`) are already envelope-aware as of their respective M3 PRs (deep-evolve PR #11 `9b867b1`, deep-work PR #25 `6f23e79`). Their identity check is mirror-symmetric (producer=deep-review, artifact_kind=recurring-findings, schema.name match), so this writer's emit Just Works for chain trace reconstruction without further consumer changes.

### Compatibility / migration
- Pre-1.4.0 consumers reading the legacy top-level `findings[]` shape continue to work IF the producer is also pre-1.4.0. The envelope wrap is **not** a breaking change for the payload itself — `payload.findings`, `payload.taxonomy_version`, and `payload.updated_at` keep the same shape. Consumers that have already adopted envelope-aware unwrap (deep-evolve, deep-work as of M3 PRs) Just Work because their unwrap returns the same shape. Pre-envelope consumers that try to read `findings[]` from a 1.4.0 emit will see no top-level `findings` key — they need to upgrade to envelope-aware read OR access `payload.findings` directly.
- The 6-month migration window (handoff §6) gives consumer plugins time to adopt envelope unwrap before the suite repo's dashboard starts warning on legacy emits. The T+0 timer start and the deep-review row in `claude-deep-suite/docs/envelope-migration.md` §6.1 (Adoption ledger) are intentionally **not** updated by this PR — Phase 2 §1 policy reserves all suite-repo writes (marketplace.json SHA bump, payload-registry replacement, adoption ledger update, dashboard cutover) for the Phase 3 batch after the 6th plugin lands.

## [1.3.4] — 2026-04-24

Follow-up release that resolves every `Known limitations` item published with 1.3.3 and adds CI coverage. No Phase 1–5 logic changes; subagent model remains `sonnet`; parallel dispatch is still non-goal.

### Added
- `skills/receiving-review/references/phase6-delegation-spec.md` — the Phase 6 design spec is now a **shipped** on-demand reference. The previous copy under `docs/superpowers/specs/` never shipped because the plugin repo blanket-ignores `docs/`.
- `hooks/scripts/test/test-phase6-protocol-e2e.sh` — 6 new scenarios: **E6** `log_path` single-quote wrap survives paths with spaces/glob metacharacters; **E7** `git diff --name-status -M` extracts the new path from a staged rename (also covers staged ∪ unstaged union); **E8** `git hash-object` detects content mutation in a binary (NUL-byte) file; **E9** pre-existing dirty outside path mutation is flagged via content-hash snapshot (blocks allowlist bypass); **E10** recovery restores both worktree and index when subagent used `git add`; **E11** recovery preserves tracked-but-deleted WIP state (` D` stays ` D`, not `D `). Total e2e count 5 → 11.
- `.github/workflows/phase6-protocol.yml` — CI job running both structural (10) and protocol e2e (11) tests on `ubuntu-latest` **and** `macos-latest` (GNU vs BSD awk/sed compatibility). Triggered on `main` push and on PRs that touch the agent, `commands/deep-review.md`, `skills/receiving-review/**`, the test scripts, or the workflow itself. `permissions: contents: read` (minimum).

### Changed
- `agents/phase6-implementer.md` — the literal `log_path` substitution pattern now mandates single-quote wrap around the absolute path. Escape rule `'\''` is documented; `printf '%q'` pre-quoting is **forbidden** inside the single-quote wrap (its backslash-escape output would become literal backslash inside `'...'`, producing a non-existent path). Two additional forbidden patterns are explicitly enumerated: (a) `tee -a "$log_path"` inside single quotes (empty variable expansion), and (b) `tee -a /path with space/log` without quoting (word-split into three arguments).
- `commands/deep-review.md` Step 2.5 (Phase 6 group loop) — path-set baselines now merge **both** `git diff --name-status -M` (unstaged) **and** `git diff --cached --name-status -M` (staged) before running an awk post-processor that selects the new path from any `R`/`C` rename/copy row. `git mv` is auto-staged, so reading only the unstaged diff would leave staged renames invisible to `NEW_PATHS`/`REVERTED` — a trust-boundary gap when the subagent can call `Bash`. Binary files continue to flow through `git hash-object` for DELTA computation — explicitly documented so readers don't infer a hidden branch.
- `commands/deep-review.md` Step 2.5 — added a "Step ↔ spec §5.4 mapping" table at the top of the group loop. Every step headline (3–8) now carries a `(spec §5.4.X)` back-reference. Spec §5.4 adds the reciprocal `(→ commands Step X)` on every item and a mapping table at the top. Numbering itself is unchanged (drift risk); only cross-references are added.
- **Tone unification** — three runtime warning strings in `commands/deep-review.md` and `skills/receiving-review/references/phase6-delegation-spec.md` that were still English are now Korean, matching the rest of the review/response UI (`⚠ Phase 6 범위 외에 pre-staged 파일이 감지됐습니다:` and two siblings).
- **Placeholder convention** — the subagent output template in `agents/phase6-implementer.md` and the Accepted-Items prompt template in `phase6-prompt-contract.md` each gained a one-line preamble declaring `<...>` as "fill with the actual value before emitting" and `{...}` as "type label for the value that replaces it". This closes a long-standing ambiguity that risked subagents echoing the placeholder verbatim.

### Fixed
- `phase6-delegation-spec.md` §5.4.2 used to reference `§5.4.7 Dirty recovery` but Dirty recovery is at `§5.4.9`. Corrected. Similarly `§5.4.9` referenced "Step 1" when the relevant per-file snapshot originates at `§5.4.1`; updated to the intra-document reference.
- **Trust-boundary — allowlist bypass via pre-dirty outside files** (3rd-round review C3): Step 5 verification compared only `ALLOWED` paths (DELTA) and path-membership (NEW_PATHS/REVERTED). If a non-allowed file was already dirty before dispatch, a subagent could mutate it a second time and leave no trace. Step 3 now snapshots content hashes for the full pre-dispatch dirty/untracked set (`PRE_OUTSIDE_HASH_FILE`), and Step 5 compares post-hashes, routing any mismatch to `execution_status=error`. E9 exercises this explicitly.
- **Trust-boundary — dirty recovery did not restore the index** (3rd-round review W4): the recovery path only replayed baseline content into the worktree. If a failed subagent had used `git add`/`git mv`, staged state survived "recovery". Step 7 now calls `git restore --staged` / `git rm --cached --ignore-unmatch` per allowed path before the worktree copy. E10 exercises this.
- **Recovery — tracked-but-deleted WIP preserved** (3rd-round review C5): `PRE_HASH=="absent"` previously conflated two states (originally untracked vs. originally tracked + WIP-deleted). A pre-existing ` D a.txt` would emerge from recovery as `D  a.txt`. Step 3 now records `PRE_TRACKED_FILE` via `git ls-files --error-unmatch` and Step 7 branches on the real tracking state. E11 exercises this.
- **macOS `/bin/bash` 3.2 compatibility** (3rd-round review C4): the Step 3/5/7 snippets used `declare -A` (bash 4+), which fails with `invalid option` under the shipped macOS shell. All associative arrays have been replaced with TSV temp files (`PRE_HASH_FILE`, `PRE_TRACKED_FILE`, `PRE_STAGED_FILE`, `PRE_OUTSIDE_HASH_FILE`), and lookups now use `awk -F'\t'` / `while IFS=$'\t' read`. The local-machine `bash` is still tested on both `macos-latest` and `ubuntu-latest` CI runners.
- **Partial-hunk staging warning during recovery** (3rd-round review W7 — minimal fix): `git restore --staged` also un-stages the user's own `git add -p` hunk-selection state. Step 3 now records `PRE_STAGED_FILE` for every allowed path, and Step 7 emits a before-recovery warning listing the affected paths so users can re-stage. Full blob-level snapshot is deferred to v1.3.5.
- **Test-order drift between spec and agent** (3rd-round review W8): `phase6-delegation-spec.md` Step 4.1 listed `hooks/scripts/test/test-*.sh` ahead of the project runner, while `agents/phase6-implementer.md` 46-52 correctly treats hooks as a **fallback only** ("smoke test must not hide the real suite"). Spec realigned to the agent ordering; agent is now explicitly named as the normative source.
- **tmp artifact rotation extended** (4th-round review N2): the `/deep-review --respond` rotation block under `.deep-review/tmp/` previously only moved `.log` files into `prev/`; the C4-introduced TSV snapshots (`phase6-*-{pre-hash,pre-tracked,pre-staged,pre-outside-hash}.tsv`) and the W4/C5 `phase6-{severity}-baseline/` directories accumulated indefinitely. The rotation block now covers all three artifact kinds on the same 1-step schedule, so only the last two sessions' artifacts are kept on disk.

### Known limitations (v1.3.4)
- Phase 6 dogfood T3 / T4 (release gate §7.5) remains pending — both require a live review on a real feature branch. Captured as a follow-up session task; the protocol has not regressed (all 10 + 11 tests green), only the manual verification ritual is deferred.
- Full blob-level restoration of pre-existing `git add -p` hunk selection after Phase 6 recovery is **not** implemented (v1.3.5 candidate). The current warning + response-log records affected paths; users re-run `git add -p` to reconstruct hunk selection.
- `--qa` flag is still reserved-only (v1.3.4 out-of-scope).

## [1.3.3] — 2026-04-24

### Added
- `agents/phase6-implementer.md` — dedicated Phase 6 implementation subagent (`model: sonnet`), auto-dispatched by `/deep-review --respond`.
- `hooks/scripts/test/test-phase6-subagent.sh` — structural regression check for Phase 6 delegation (10 assertions including `Execution path` capitalization guard).
- `hooks/scripts/test/test-phase6-protocol-e2e.sh` — executable end-to-end tests (5 scenarios) that validate main-session verification logic against real git state: suffix normalization, content-aware delta via `git hash-object`, `:(exclude)` pathspec array, allowlist with companion files, and WIP-preserving restore via per-file content baseline.
- `implementation_guide.modifiable_paths` — new field in the Phase 5 accepted-item contract. Main expands the Phase 6 allowlist to include companion files (tests, fixtures, helpers) that the acceptance criteria legitimately need.

### Changed
- `/deep-review --respond` Phase 6 is now delegated to `phase6-implementer` subagent per severity group (default path). Main session gracefully falls back to in-session execution on dispatch failure.
- `.deep-review/responses/*-response.md` Summary gains an `execution_path` field (`subagent | main_fallback | mixed | n/a`) and per-item `log_unavailable` flag.
- Phase 6 test logs land in `.deep-review/tmp/phase6-{severity}.log` (ephemeral, 1-generation rotation into `tmp/prev/`).
- `/deep-review init` Step 8 `.gitignore` suggestion now includes `.deep-review/tmp/`.
- **Fail-closed main verification** (replaces earlier non-blocking warning):
  - `files_changed` claim is normalized via suffix strip (`sed -E 's/ \(\+[0-9]+ -[0-9]+\)$//'`) before comparison.
  - `DELTA` is computed from `git hash-object` content snapshots per path (not from path membership), so dirty-tree workflows are first-class supported.
  - `VIOLATIONS = NEW_PATHS - ALLOWED` and `REVERTED = PRE_ALL - POST_ALL` both route to `execution_status=error` with commit and PR-posting suppressed.
  - Missing log file → `log_unavailable=true`, error.
- **Group commit** uses `git commit --only -m "..." -- "${CHANGED_FILES[@]}"` — flag before `--` so the message is not parsed as pathspec; untracked files are `git add`-ed first; pre-staged hunks in excluded paths trigger a non-blocking warning (the `:(exclude)` pathspec array is built with an explicit `for` loop to avoid a subtle bash expansion bug).
- **Dirty recovery** restores from per-file content snapshots saved in `.deep-review/tmp/phase6-{severity}-baseline/` during the Step 3 pre-dispatch pass. `git restore --source=HEAD` is explicitly forbidden because it discards pre-existing user WIP.
- `receiving-review/references/response-protocol.md` Phase 6 section is now a summary that declares `commands/deep-review.md` as the authoritative source (drift-proof).

### Behavior notes
- Within a severity group, a partial failure halts remaining groups. The partially-failed group is **not committed**; passed-item edits remain in the working tree for user review.
- When dispatch fails mid-run and ≥5 items remain, the main session prompts to DEFER the rest (context conservation).
- On malformed/error subagent returns with a dirty workspace, main asks the user before doing anything (keep / restore-from-baseline / abort).
- `DEEP_REVIEW_FORCE_FALLBACK=1` env var forces the fallback path for testing/dogfood.

### Known limitations (v1.3.3)
- `log_path` containing spaces or glob characters may need shell quoting in the agent's literal substitution (follow-up in v1.3.4).
- Rename/binary file handling relies on default `git diff` behavior; `--name-status` precision is a v1.3.4 candidate.
- The design spec lives under `docs/` which the plugin repo blanket-ignores; it is not shipped. Authoritative runtime references are `commands/deep-review.md` and `skills/receiving-review/references/response-protocol.md`.

## [1.3.2] — 2026-04-21

### Added

- **Codex Auto-Exposure Protocol (Case 3)**: `/deep-review` now detects gitignored files the user has been editing in the current Claude Code session (via Edit/Write tool-use history) and offers to temporarily expose them to Codex via `git add -f -N` for cross-model review. Mutual exclusion is enforced by a `mkdir`-based atomic lock (`.deep-review/.mutation.lock/`, POSIX-portable, no `flock` dependency). State is tracked in `.deep-review/.pending-mutation.json` with `schema_version: 1`.
- **Shared Bash library**: new `hooks/scripts/mutation-protocol.sh` with 7 functions — `is_our_ita_entry`, `acquire_mutation_lock`, `release_mutation_lock`, `perform_mutation`, `restore_mutation`, `auto_recover`, `scan_sensitive_files`. Bash 3.2 compatible (no `mapfile`, no `globstar`) and macOS / GNU Linux tested.
- **F1 / plugin detection boundary**: tests assert that only the canonical `openai-codex` marketplace is trusted. Non-openai-codex paths are explicitly rejected (supply-chain boundary).
- **F2 / Node.js availability**: `detect-environment.sh` emits `node_available` + `node_path` flags in every output branch (non-git / no-commits / main). Preflight uses this to distinguish "plugin installed but node missing" from other failures.
- **F3 / Codex auth error detection**: review/adversarial-review stderr is captured and pattern-matched against `not authenticated`, `Codex CLI is not authenticated`, `Run.*codex login`. A matching status produces a dedicated "run `!codex login`" hint instead of generic failure.
- **Session inference (Stage 2.1)**: session context is used to infer which gitignored files the user is actively working on. Strict inclusion rules — only Edit/Write tool calls qualify. Read and Bash are excluded to avoid false positives.
- **Sensitive file scan**: 40+ patterns (dotenv, credentials, SSH keys, GCP service accounts, `.pgpass`, `.netrc`, `wrangler.toml`, JWT, etc.) matched via Python `fnmatch` (case-insensitive). Nested paths like `apps/web/.env.local` are covered. All-sensitive sets auto-skip without prompting.
- **Graceful mutation fallback**: if `perform_mutation` fails (precondition or `git add` error), the workflow falls back to 1-way Opus-only review instead of aborting the entire command.
- **Stale mutation auto-recovery**: at `/deep-review` and `/deep-review --respond` entry, stale `.pending-mutation.json` from crashed sessions is silently cleaned up via `is_our_ita_entry` filter (user's real staging is preserved). A `restore_attempts` counter escalates to the user after 3 failures.

### Fixed

- **F8 / Codex `--uncommitted` → `--scope working-tree` (pre-existing bug)**: Codex companion 1.0.x accepts only `--base <ref>` and `--scope <auto|working-tree|branch>`. The `--uncommitted` flag was treated as positional focus text and rejected by native review. This silent failure existed across v1.3.x until now. All call sites in `commands/deep-review.md`, `SKILL.md`, and `codex-integration.md` corrected.
- **`detect-environment.sh` empty-tree SHA**: the fallback `review_base` was using `4b825dc642cb6eb9a060e54bf899d69f7cb46617`, which is not a valid git empty-tree object. The canonical hash (verified via `git hash-object -t tree /dev/null`) is `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. Git silently accepted the wrong value as an arbitrary treeish, so this never surfaced before.

### Changed

- **Case gate extension**: Case 3 (3-way review) now requires only `is_git=true AND codex_plugin=true`. The previous `has_commits=true` requirement is dropped, so repositories in their initial-commit state also get cross-model review (using `--scope working-tree`).
- **Case renaming**: internal labels A/B/C renamed to 1/2/3 for clarity across `commands/deep-review.md` and `SKILL.md`.
- **`.gitignore` init block**: `init` mode now suggests ignoring `.deep-review/.pending-mutation.json` and `.deep-review/.mutation.lock/`.

### Deprecated

- **`codex_installed` field in `detect-environment.sh` output**: still emitted in v1.3.2 for backward compatibility, but slated for removal in v1.4.0. New consumers should use `codex_plugin` directly. The field has no in-repo consumers today.

### Notes

- **bash 3.2 compatibility**: all new library code in `mutation-protocol.sh` avoids `mapfile`, `globstar`, and bash 4+ features. Tested under macOS `/bin/bash` 3.2.57.
- **F1 marketplace widening deferred**: the original v1.3.2 plan considered loosening plugin discovery to `~/.claude/plugins/cache/*/codex/*`. This was reverted after a 3rd-round review flagged it as a supply-chain risk (any third-party plugin named `codex` would become trusted executable code). F1 is now tracked in backlog and requires publisher verification before reopening.
- **4th-round review fixes**: 4 additional bugs surfaced during the final implementation dogfood were fixed before merge:
  - **FR1**: `perform_mutation` now releases the lock on precondition-failure early-return (was leaking the lock for up to 1 hour).
  - **FR2**: partial `git add -f -N` failure now triggers inline rollback via `restore_mutation` (was leaving orphan intent-to-add entries).
  - **FR3**: `auto_recover` distinguishes crashed sessions from active reviews using `status` + `REVIEW_TIMEOUT_SECONDS` (10 min for `status=committed`, 1 h for `status=in-progress`).
  - **W1**: module-scoped `_MUTATION_LOCK_OWNED` flag prevents a session from accidentally releasing another session's lock.

### Known Limitations

- **Empty file during active review (W2)**: `is_our_ita_entry` cannot distinguish a genuinely new 0-byte file the user stages (e.g., `.gitkeep`) from the protocol's own intent-to-add placeholder (both produce the `:000000 e69de29b...` raw record). Mutation-time precondition prevents this for pre-existing staging; but if the user stages an empty file **during** the review, the restore step may remove it. Workaround: don't stage new empty files while a Case 3 review is in flight. A full fix requires recording pre-mutation index state per file and is tracked in backlog for v1.4.0.

## [1.3.1] — 2026-04-17

### Fixed

Addresses all findings from the ultrareview audit (`.deep-review/reports/2026-04-17-ultrareview.md`).

#### 🔴 Critical
- **`.gitignore` for public plugin repo**: `.deep-review/` and `docs/` are now fully ignored; legacy tracked design doc untracked. Downstream users continue to receive granular `.gitignore` guidance from `/deep-review init`.
- **WIP commit safety**: removed `git add -A`; new prompt previews file list, warns on sensitive patterns (`.env*`, credentials, keys), and shows `git reset --soft HEAD~1` undo hint.
- **`mktemp`-based adversarial focus file**: replaces fixed `/tmp/deep-review-focus.txt`; `chmod 600` + `trap rm -f` cleanup. Eliminates /tmp race and symlink attack surface.
- **`config.yaml` updates via `Edit` tool only**: preserves user-modified fields (`review_model`, `app_qa.*`) and unknown keys; `last_review` is now explicitly updated with ISO8601 after each review.

#### 🟡 Warning
- **POSIX-safe semver sort** in `detect-environment.sh` (replaces `sort -V`); tested on current macOS (Darwin 25), BusyBox awk coverage not yet verified. Pre-release identifiers are not ordered (documented limitation).
- **Prompt-injection defense** baked into `code-reviewer` system prompt and PR-comment ingestion (structural wrapping, red-flag strings flagged as security issues).
- **Report filename adds `{HHmmss}` timestamp** — no more same-day overwrites that corrupted recurring-findings counts.
- **Large-diff strategy** in Stage 3: threshold-based routing, directory-grouped sequential spawn for >1 MB, explicit size cap warnings.
- **Codex preflight** uses real `timeout 10 node codex-companion --help` probe; per-call `timeout 300`; N-way synthesis table covers partial-reviewer outcomes.
- **`gh pr view`/`gh repo view` failure paths** documented; new `--pr=NNN` manual override; partial `gh api` failures no longer abort the run.
- **Contract YAML** loaded via `python3 yaml.safe_load` wrapper; malformed contracts are skipped with a clear error.
- **`--respond` "most recent"** defined as mtime on `*-review.md` glob (excludes non-standard suffixes like `-ultrareview.md`).
- **3-tier skill loading**: namespaced Skill → bare Skill → Read fallback on `${CLAUDE_PLUGIN_ROOT}/skills/...`.
- **Recurring-findings classification** has a single source of truth (`response-protocol.md` Phase 1); SKILL.md and command link to it instead of restating.
- **`Failed Postings` section** in response report tracks PR-comment delivery failures for idempotent retries; 3-strike escalation.
- **`untracked-only` + Codex mismatch** resolved: default is Opus-only; optional `git add -N` intent-to-add path for explicit 3-way.
- **Team-vs-machine split** for `.deep-review/` contents documented in README (EN/KO).

#### ℹ️ Info
- `/deep-review --qa` clarified as "future release" (v1.1 placeholder rescinded); `app_qa.*` remains as reserved schema.
- `package.json` gains `"category": "Productivity"` to match `plugin.json`.
- "Good catch!" usage rule clarified with concrete examples.
- Source Trust Matrix is now explicitly single-sourced in `receiving-review/SKILL.md`; other occurrences reference it.
- WIP undo hint (`git reset --soft HEAD~1`) surfaced in both READMEs.

### Additional fixes (self-review round 2)

Subsequent `/deep-review` on the v1.3.1 patch branch uncovered bugs *introduced* by the first round. Addressed in the same release:

#### 🔴 Critical
- **`timeout` portable shim**: `timeout 10` / `timeout 300` wrappers silently fail on macOS (no `timeout(1)` binary). `codex-integration.md` now defines a `_timeout` helper that prefers `gtimeout`/`timeout` and falls back to `perl -e 'alarm …'` (bundled with macOS). Avoids always-false preflight that downgraded every cross-model review to 1-way.
- **`$focus_file` subshell scoping**: the staged `mktemp` → `Write` → `Bash` workflow in v1.3.1 round 1 assumed shell variable persistence across separate `Bash` tool calls — it doesn't. Replaced with a single inline `Bash` command (here-doc + `_timeout 300 node …` + `rm -f`). Option B (literal path capture) documented as a longer alternative. `trap EXIT` caveat spelled out.

#### 🟡 Warning
- **`python3 yaml.safe_load` ImportError guard**: stock macOS python3 has no PyYAML. Contract loader now returns `{"ok": false, "error": "pyyaml-missing", "fallback": "llm-parse"}` instead of a hard failure, and caller is instructed to treat that signal as "LLM fallback" rather than "contract broken".
- **`mktemp "${TMPDIR:-/tmp}/…"`**: replaces fragile `mktemp -t PREFIX`, which has different semantics on BSD vs GNU.
- **WIP sensitive-file warning** is now state-neutral (staged/unstaged/untracked all warned identically).
- **`failed-postings.json` rolling ledger** defines cross-session aggregation for the 3-strike PR-comment retry rule.
- **`--qa` Argument Dispatch branch** added so the "future release" message actually fires instead of falling through to review mode.
- **`argument-hint` expresses mutual exclusion** between `REPORT_PATH` and `--source=pr`.
- **EN README dropped `(v1.1 placeholder)`** (KO had already been updated).
- **EN/KO README filename placeholders** changed from `{timestamp}` to `{YYYY-MM-DD}-{HHmmss}` for consistency.
- **`.gitignore` policy comment** warns against blanket unignoring `docs/`; suggests `.deep-review/journeys/` or `docs/internal/` for internal-but-tracked docs.

#### ℹ️ Info
- **Injection severity unified**: PR-comment injection attempts are now flagged as `security` / 🔴 `SECURITY_ESCALATION` (matching the `code-reviewer` agent), not `DEFER`.
- **`detect-environment.sh` semver limitations documented**: pre-release identifiers are not ordered; older BSD awk `+0` caveat noted.
- **`forbidden-patterns.md` "Good catch" rationale rephrased**: technical clause vs. social filler, punctuation is not magic.

## [1.3.0] — 2026-04-16

### Added
- **Stage 5: Receiving Review** — Evidence-based response protocol for review feedback. 6-phase workflow (READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT) prevents blind agreement and ensures all decisions are backed by code evidence.
- **`/deep-review --respond`** — Enter response mode to address review findings. Auto-loads the most recent review report or a specified path.
- **`/deep-review --respond --source=pr`** — Respond to GitHub PR review comments via `gh api`. Inline comments get threaded replies.
- **`receiving-review` skill** — Guides the response protocol with source trust matrix, forbidden expression blocking, and rationalization detection.
- **Response Report** — Structured record of accept/reject/defer decisions with evidence, saved to `.deep-review/responses/`.
- **Recurring Findings integration** — Auto-warns when a response item matches a pattern that has occurred 3+ times.

### Changed
- **Stage 4 Verdict action** — `REQUEST_CHANGES` now offers 3 options: (1) evidence-based response (default), (2) codex:rescue delegation, (3) manual handling. Previously only offered codex:rescue.

## [1.2.0] — 2026-04-14

### Added
- **Stage 5.5 Recurring Findings Export**: taxonomy 기반(7 카테고리) LLM 의미 분류로 반복 발견 패턴을 `recurring-findings.json`에 기록. deep-evolve가 소비하여 실험 방향 조향에 활용.


## [1.1.2] - 2026-04-12

### Fixed
- **Codex review invocation bug** — `Skill(codex:review)` was routed to `codex:rescue` due to `disable-model-invocation: true`; now calls `codex-companion.mjs` directly via Bash tool
- **Shell injection via focus_text** — focus_text from repo-controlled files (rules.yaml, contracts) was interpolated directly into shell commands; now passed via stdin redirect
- **Script abort on missing plugin** — `set -euo pipefail` caused detect-environment.sh to exit when Codex plugin path didn't exist; added `|| true` fallback
- **Dirty tree review mismatch** — Codex reviewed committed history (`--base`) while Opus reviewed dirty diff; now uses `--uncommitted` for dirty trees so both reviewers see the same changes

### Changed
- **Codex detection split** — Separate `codex_plugin` (Claude Code plugin) and `codex_cli` (standalone CLI) detection with `codex_companion_path` / `codex_cli_path` exports
- **CLI-only guidance** — When only Codex CLI is installed (no plugin), shows targeted install message: "CLI detected but plugin required"

## [1.1.1] - 2026-04-11

### Changed
- **Stage 3 background execution** — All reviewers (Opus subagent, codex:review, codex:adversarial-review) now run in the background with `run_in_background: true`
- **User notification before review** — Displays reviewer composition before spawning: Opus-only (Case A/B) or 3-way (Case C)
- **Stage 4 collection mechanism** — Results collected via background completion notifications; partial success handled by N-way synthesis based on actually completed reviewers

## [1.1.0] - 2026-04-09

### Added
- **fitness.json integration** — Stage 3 now loads `.deep-review/fitness.json` (if present) and injects computational architecture rules into the code-reviewer agent prompt for architecture-intent-aware review
- **Receipt health_report integration** — Stage 3 discovers the latest deep-work session receipt, checks `scan_commit` for staleness, and injects drift/fitness context into the review
- **Fitness Function awareness in code-reviewer** — New "Fitness Function 인지" section guides the reviewer to evaluate design intent alignment, not just rule violations
- **fitness.json guidance in init mode** — `/deep-review init` now explains the distinction between inferential rules (rules.yaml) and computational rules (fitness.json) and directs users to deep-work Phase 1 for auto-generation

## [1.0.0] - 2026-04-08

### Added
- Mode 1: Code Review — 독립 Opus 서브에이전트 리뷰
- Codex 교차 검증 (codex:review + codex:adversarial-review)
- Sprint Contract 소비 및 검증
- 엔트로피 탐지
- 환경 자동 감지 (git/non-git, Codex 유무)
- `/deep-review init` — 프로젝트별 규칙 초기화

### Changed
- `--contract` now supports `SLICE-NNN` for slice-specific contract loading
- Contract loading: auto-loads all `status: active` contracts, archived contracts excluded
- Review criteria aligned across command, SKILL.md, and README

### Fixed
- Always include untracked files in review regardless of change_state
- Aligned codex-integration synthesis rules with command verdict logic (2/3 → CONCERN)
- Added Codex preflight check to prevent silent degradation
- Clarified codex_notified as repo-persistent (not session-scoped)
- Added full paths to agent file references
- Aligned auto-created config.yaml with full schema
- Fixed duplicate step numbering in SKILL.md, added *.lock to exclusions
- Added shallow clone handling with user guidance
- Added archived contract filter and malformed YAML error handling
