# Changelog

**English** | [한국어](./CHANGELOG.ko.md)

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
