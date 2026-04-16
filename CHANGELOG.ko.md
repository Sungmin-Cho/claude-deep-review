# 변경 기록

[English](./CHANGELOG.md) | **한국어**

## [1.3.0] — 2026-04-16

### 추가
- **Stage 5: Receiving Review** — 리뷰 피드백 증거 기반 대응 프로토콜. READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT 6단계 워크플로우로 맹목적 동의를 차단하고 모든 판단에 코드 증거를 첨부.
- **`/deep-review --respond`** — 대응 모드 진입. 가장 최근 리뷰 리포트를 자동 로드하거나 경로를 직접 지정.
- **`/deep-review --respond --source=pr`** — GitHub PR 리뷰 코멘트에 `gh api`를 통해 대응. 인라인 코멘트에는 스레드 답글.
- **`receiving-review` 스킬** — source 신뢰도 매트릭스, 금지 표현 차단, 합리화 탐지로 대응 프로토콜을 가이드.
- **Response Report** — 수락/반박/보류 결정을 evidence와 함께 구조화하여 `.deep-review/responses/`에 저장.
- **Recurring Findings 연동** — 대응 항목이 3회 이상 반복된 패턴과 일치하면 자동 경고.

### 변경
- **Stage 4 Verdict 행동** — `REQUEST_CHANGES` 시 3가지 선택지 제공: (1) 증거 기반 대응 (기본 추천), (2) codex:rescue 위임, (3) 수동 처리. 기존에는 codex:rescue만 제안.

## [1.2.0] — 2026-04-14

### 추가
- **Stage 5.5 반복 발견 패턴 내보내기**: taxonomy 기반(7 카테고리) LLM 의미 분류로 반복 발견 패턴을 `recurring-findings.json`에 기록. deep-evolve가 소비하여 실험 방향 조향에 활용.

## [1.1.2] - 2026-04-12

### 수정
- **Codex review 호출 버그** — `Skill(codex:review)` 호출 시 `disable-model-invocation: true`로 인해 `codex:rescue`가 실행되던 문제 수정; `codex-companion.mjs`를 Bash tool로 직접 호출
- **focus_text 쉘 인젝션** — repo 파일(rules.yaml, contract)에서 생성된 focus_text가 쉘 명령에 직접 삽입되던 문제; stdin 리다이렉트로 전달
- **플러그인 미설치 시 스크립트 중단** — `set -euo pipefail`에서 Codex 플러그인 경로 미존재 시 스크립트 종료; `|| true` fallback 추가
- **dirty tree 리뷰 불일치** — Codex가 커밋 히스토리(`--base`)만 리뷰하고 Opus는 dirty diff를 리뷰하던 문제; dirty tree에서 `--uncommitted` 사용

### 변경
- **Codex 감지 분리** — `codex_plugin`(Claude Code 플러그인)과 `codex_cli`(독립 CLI) 감지 분리, `codex_companion_path` / `codex_cli_path` 경로 출력
- **CLI만 설치 시 안내** — Codex CLI만 설치된 경우 맞춤 안내: "CLI가 감지되었지만 플러그인이 필요합니다"

## [1.1.1] - 2026-04-11

### 변경
- **Stage 3 백그라운드 실행** — 모든 리뷰어(Opus 서브에이전트, codex:review, codex:adversarial-review)를 `run_in_background: true`로 백그라운드에서 실행
- **리뷰 전 유저 고지** — 리뷰어 구성을 spawn 전 표시: Opus 단독(Case A/B) 또는 3-way(Case C)
- **Stage 4 결과 수집 방식** — 백그라운드 완료 알림으로 결과 수집; 부분 성공 시 실제 완료된 리뷰어 수 기준 N-way 합성

## [1.1.0] - 2026-04-09

### 추가
- **fitness.json 통합** — Stage 3는 이제 `.deep-review/fitness.json`(있는 경우)을 로드하고 컴퓨테이션 아키텍처 규칙을 code-reviewer 에이전트 프롬프트에 주입하여 아키텍처 의도 인식 리뷰 수행
- **Receipt health_report 통합** — Stage 3는 최신 deep-work 세션 receipt를 발견하고 `scan_commit`의 오래됨 여부를 확인하며 drift/fitness 컨텍스트를 리뷰에 주입
- **Code-reviewer의 Fitness Function 인식** — 새로운 "Fitness Function 인식" 섹션은 리뷰어가 규칙 위반만 아니라 설계 의도 정렬을 평가하도록 가이드
- **init 모드의 fitness.json 가이던스** — `/deep-review init`은 이제 추론 규칙(rules.yaml)과 컴퓨테이션 규칙(fitness.json)의 차이를 설명하고 사용자를 deep-work Phase 1으로 자동 생성을 위해 안내

## [1.0.0] - 2026-04-08

### 추가
- Mode 1: Code Review — 독립 Opus 서브에이전트 리뷰
- Codex 교차 검증 (codex:review + codex:adversarial-review)
- Sprint Contract 소비 및 검증
- 엔트로피 탐지
- 환경 자동 감지 (git/non-git, Codex 유무)
- `/deep-review init` — 프로젝트별 규칙 초기화

### 변경
- `--contract`는 이제 slice 특정 contract 로딩을 위해 `SLICE-NNN` 지원
- Contract 로딩: `status: active`인 모든 contracts을 자동 로드, 아카이브된 contracts는 제외
- 리뷰 기준을 command, SKILL.md, README에 걸쳐 정렬

### 수정
- change_state에 관계없이 항상 untracked 파일을 리뷰에 포함
- Codex 통합 합성 규칙과 command verdict 로직 정렬 (2/3 → CONCERN)
- 무음 성능 저하를 방지하기 위한 Codex preflight 체크 추가
- codex_notified를 repo 영구적으로 명확화 (session-scoped 아님)
- 에이전트 파일 참조에 전체 경로 추가
- 자동 생성된 config.yaml을 전체 schema와 정렬
- SKILL.md의 중복 단계 번호 수정, exclusions에 *.lock 추가
- Shallow clone 처리 및 사용자 가이던스 추가
- Archived contract 필터 및 malformed YAML 오류 처리 추가
