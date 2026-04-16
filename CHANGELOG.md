# Changelog

**English** | [한국어](./CHANGELOG.ko.md)

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
