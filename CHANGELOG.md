# Changelog

**English** | [한국어](./CHANGELOG.ko.md)

## [1.1.2] - 2026-04-12

### Fixed
- **Codex review invocation bug** — `Skill(codex:review)` was routed to `codex:rescue` due to `disable-model-invocation: true`; now calls `codex-companion.mjs` directly via Bash tool

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
