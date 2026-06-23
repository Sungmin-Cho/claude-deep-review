---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, AskUserQuestion
description: 현재 변경사항을 독립 에이전트로 리뷰합니다. init으로 규칙 초기화, --contract로 Sprint Contract 기반 검증, --entropy로 엔트로피 스캔, --respond로 리뷰 피드백 대응. --ultracode(멀티에이전트 Claude 리뷰)·--codex(Codex 2-way)·--codex-only(Codex만) 등 합성 플래그로 리뷰어 구성을 조절.
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--no-agy] [--codex-only] [--respond (REPORT_PATH | --source=pr [--pr=NNN])]"
---

# /deep-review — Independent Code Review

현재 코드 변경사항을 독립된 Evaluator 에이전트로 리뷰합니다.

> 리뷰 → 대응 → 재리뷰 를 한 세션에서 자동 반복하려면 [`deep-review-loop` skill](../skills/deep-review-loop/SKILL.md) 을 사용하세요 (`/deep-review-loop` 또는 `Skill({ skill: "deep-review:deep-review-loop" })`). v1.5.0+ command 였으며 v1.6.0 부터 skill 로 마이그레이션되어 Codex 등 cross-platform 진입이 가능합니다.

## 0.5 플래그 파싱 & 검증 (reviewer 구성 플래그, 순서 고정)

리뷰 모드에서 reviewer 구성 플래그를 파싱·검증한다. **반드시 다음 순서** (순서가 결과를 바꾼다):

1. **슈가 전개 (먼저)**: `--codex-only` → `--codex --no-opus --no-agy` 로 전개한다. 검증을 raw 토큰에 먼저 하면 `--ultracode --codex-only` 가 모순 검사를 통과해버려 ultracode 가 무음 드롭된다 — 전개를 검증보다 먼저 한다.
2. **모순 검증 (전개된 집합 기준)**:
   - `--ultracode` + `--no-opus` → **모순 에러**(즉시 종료): "`--no-opus`는 Claude 리뷰어를 끄고 `--ultracode`는 업그레이드합니다. 하나만 쓰세요." (전개 후 기준이므로 `--ultracode --codex-only` 도 동일 에러)
   - `--codex` + `--no-codex` → 모순 에러(동일 패턴).
3. **플래그/위치 인자 분리**: 새 플래그는 모두 `--` 접두. `--contract` 의 선택 인자는 **다음 토큰이 `SLICE-[0-9]+` 패턴일 때만** 소비(아니면 bare `--contract`), `--respond` 의 `REPORT_PATH` 는 **존재하는 파일 경로일 때만** 소비. 따라서 `--contract --codex` / `--respond --codex` 에서 `--codex` 가 SLICE id·REPORT_PATH 로 오소비되지 않는다.

검증 통과 후:
- **`--respond` + reviewer 플래그 조합**: `--respond` 는 대응 모드라 reviewer 플래그가 무의미 → **하드 에러 아님**, 1줄 안내만: "reviewer 구성 플래그는 리뷰 모드 전용 — `--respond` 에서는 무시됩니다." (기존 `--qa` 안내 패턴과 동일.)

이 절은 runtime 동작의 문서화다 — 실제 실행은 Claude Code 가 본 markdown 의도를 읽어 수행한다.

## Argument Dispatch (route-first)

§0.5 검증을 먼저 적용한 뒤 모드별로 분기한다. **각 분기는 terminal** — 해당 참조를 Read·수행 후 종료하며, 리뷰 분기만 deep-review-workflow 스킬을 로드한다.

- `init` → `init-setup.md` 를 Read 하고 그대로 수행 후 종료. **deep-review-workflow 미로드.**
  `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/deep-review-workflow/references/init-setup.md" })`
- `--respond` → `respond-execution.md` 를 Read 하고 그대로 수행 후 종료(receiving-review 3단 로드·auto_recover 는 그 참조가 수행). **deep-review-workflow 미로드.**
  `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/receiving-review/references/respond-execution.md" })`
- `--qa` → 안내 후 즉시 종료: "App QA(`--qa`)는 향후 릴리스에서 지원 예정입니다. 현재 `.deep-review/config.yaml`의 `app_qa.*` 필드는 예약 스키마로만 유지되며 동작하지 않습니다."
- `--contract` / `--entropy` / 인수 없음 / reviewer 구성 플래그 → **리뷰 분기**: 아래 `## Prerequisites (리뷰 분기 전용)` 로 진행한다 — **스킬 로드(1단계) → review-execution.md Read(2단계)** 순.

## Prerequisites (리뷰 분기 전용)

> init/respond/qa 는 위 분기에서 종료하므로 여기 도달하지 않는다 — 이 스킬 로드는 **리뷰 경로 전용**(route-first 절감).

**1단계 — deep-review-workflow 스킬을 다음 순서로 로드한다** (`user-invocable: false` fallback):

<!-- SSOT:skill-load-fallback START -->
1. `Skill({ skill: "deep-review:deep-review-workflow" })`
2. 실패 시 `Skill({ skill: "deep-review-workflow" })`
3. 위 둘 다 실패 시 `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/deep-review-workflow/SKILL.md" })` + references 폴더 내 파일들 Read fallback.
<!-- SSOT:skill-load-fallback END -->

**2단계 — 그 다음 리뷰 절차를 Read 하고 그대로 수행한다** (스킬 로드 **이후**):

`Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/deep-review-workflow/references/review-execution.md" })`
