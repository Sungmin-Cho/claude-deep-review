# 변경 기록

[English](./CHANGELOG.md) | **한국어**

## [1.3.1] — 2026-04-17

### 수정

ultrareview 감사(`.deep-review/reports/2026-04-17-ultrareview.md`)에서 발견된 모든 항목을 반영했다.

#### 🔴 Critical
- **공개 플러그인 레포용 `.gitignore`**: `.deep-review/`와 `docs/`를 완전히 ignore (이 레포는 플러그인 소스이며 dogfooding 로그/내부 문서는 공개 대상이 아님). 과거 tracked였던 설계 문서 하나도 untrack. 사용자 프로젝트용 `.gitignore`는 `/deep-review init`이 계속 세분화된 규칙을 제안한다.
- **WIP 커밋 안전화**: `git add -A` 제거. 제안 전에 파일 목록 미리보기 + 민감 패턴(`.env*`, credentials, key) 경고. 리뷰 후 `git reset --soft HEAD~1` 원복 힌트.
- **`mktemp` 기반 adversarial focus 파일**: 고정 `/tmp/deep-review-focus.txt` 제거. `chmod 600` + `trap rm -f` 정리. /tmp race / symlink 공격 표면 제거.
- **`config.yaml` 수정은 `Edit` tool 전용**: 사용자가 수동 설정한 필드(`review_model`, `app_qa.*`)와 미지 필드 보존. `last_review`를 리뷰 완료 시 ISO8601로 명시적 업데이트.

#### 🟡 Warning
- **POSIX 호환 semver 정렬**을 `detect-environment.sh`에 적용(기존 `sort -V` 대체). 현재 macOS(Darwin 25)에서 검증, BusyBox awk는 미검증. pre-release 식별자 순서는 지원하지 않음(한계 명시).
- **Prompt injection 방어** 문구를 `code-reviewer` system prompt과 PR 코멘트 수집 단계에 추가. 의심 문구는 보안 이슈로 보고.
- **리뷰 리포트 파일명에 `{HHmmss}` 타임스탬프 추가** — 같은 날 덮어쓰기로 인한 recurring-findings 카운트 오염 제거.
- **대용량 diff 전략**을 Stage 3에 추가: 크기 기준 라우팅, >1 MB는 디렉토리 그룹 순차 spawn, 300 KB+ 단일 파일 경고.
- **Codex preflight**를 실제 `timeout 10 node codex-companion --help`로 구체화. 실 호출에는 `timeout 300` 적용. 부분 실행 대비 N-way 합성 표 추가.
- **`gh pr view`/`gh repo view` 실패 처리** 명시. `--pr=NNN` 수동 지정 추가. `gh api` 부분 실패 시 전체 중단 금지.
- **Contract YAML**은 `python3 yaml.safe_load` 래퍼로 파싱. 오류 시 해당 contract만 skip.
- **`--respond`의 "가장 최근"**을 `*-review.md` glob의 mtime으로 정의 (비표준 `-ultrareview.md` 등 제외).
- **3단계 skill 로딩**: 네임스페이스 Skill → 일반 Skill → `${CLAUDE_PLUGIN_ROOT}/skills/...` Read fallback.
- **Recurring findings 분류** 단일 소스화(`response-protocol.md` Phase 1). SKILL.md, command는 참조만.
- **`Failed Postings` 섹션**을 response 리포트에 추가. PR 코멘트 게시 실패 추적 + 3회 연속 실패 시 에스컬레이션.
- **`untracked-only` + Codex 불일치** 해결: 기본 Opus 단독, 명시 요청 시 `git add -N` intent-to-add 경로.
- **머신별 vs 팀 공유** 정책을 README(EN/KO)에 문서화.

#### ℹ️ Info
- `/deep-review --qa`를 "향후 릴리스 예정"으로 명확화 (v1.1 약속 취소). `app_qa.*`는 예약 스키마로 유지.
- `package.json`에 `"category": "Productivity"` 추가 — `plugin.json`과 정렬.
- "Good catch!" 사용 규칙에 구체적 허용/금지 예시 추가.
- Source Trust Matrix 단일 소스를 `receiving-review/SKILL.md`로 명시. 다른 위치는 참조.
- WIP 원복 힌트(`git reset --soft HEAD~1`)를 양국 README에 노출.

### 추가 수정 (self-review 2차 라운드)

v1.3.1 패치 브랜치에 대해 `/deep-review`를 재실행하자 1차 라운드가 **새로 도입한 버그**가 드러남. 동일 릴리스에 함께 반영:

#### 🔴 Critical
- **`timeout` portable shim**: 1차 라운드의 `timeout 10` / `timeout 300` 래퍼가 macOS에서 `timeout(1)` 부재로 silently 실패. `codex-integration.md`에 `gtimeout`/`timeout`을 우선 시도하고 없으면 `perl -e 'alarm …'` (macOS 기본 탑재)로 fallback하는 `_timeout` 헬퍼 도입. preflight가 항상 FAIL 반환해 macOS에서 모든 교차 검증이 1-way로 전락하던 문제 해결.
- **`$focus_file` subshell scoping**: 1차 라운드의 `mktemp → Write → Bash` 3단계 흐름은 쉘 변수가 별개의 `Bash` 호출 간 유지된다는 잘못된 가정 기반. 단일 inline `Bash` 명령(here-doc + `_timeout 300 node …` + `rm -f`)으로 재작성. Option B(리터럴 경로 캡처)도 대안으로 문서화. `trap EXIT` 주의점 명시.

#### 🟡 Warning
- **`python3 yaml.safe_load` ImportError 가드**: stock macOS python3에 PyYAML 없음. Contract loader가 hard failure 대신 `{"ok": false, "error": "pyyaml-missing", "fallback": "llm-parse"}`를 반환하고, 호출 측은 이를 "LLM fallback" 신호로 취급하도록 명시.
- **`mktemp "${TMPDIR:-/tmp}/…"`**: macOS/GNU 간 semantics 차이로 취약한 `mktemp -t PREFIX` 대체.
- **WIP 민감 파일 경고**를 state-neutral 문구로 통일 (staged/unstaged/untracked 모두 동일 경고).
- **`failed-postings.json` 롤링 레저**: PR 코멘트 3-strike 재시도 룰의 세션 간 집계 경로 명시.
- **`--qa` Argument Dispatch 분기** 추가 — "향후 릴리스 예정" 메시지가 실제로 나오도록.
- **`argument-hint`가 상호 배타성** 표현 (`REPORT_PATH | --source=pr`).
- **영어 README `(v1.1 placeholder)` 제거** (한국어는 이미 수정됨).
- **양국 README의 파일명 placeholder** `{timestamp}` → `{YYYY-MM-DD}-{HHmmss}` 통일.
- **`.gitignore` 정책 주석**이 `docs/` blanket unignore를 경고하고 `.deep-review/journeys/` 또는 `docs/internal/`을 대안으로 제시.

#### ℹ️ Info
- **injection severity 통일**: PR 코멘트 injection 시도를 `DEFER`가 아니라 `security` / 🔴 `SECURITY_ESCALATION`으로 격상 (code-reviewer agent와 일치).
- **`detect-environment.sh` semver 한계** 주석: pre-release 식별자 미처리, 구버전 BSD awk `+0` 주의.
- **`forbidden-patterns.md` "Good catch"** 설명 재표현: technical clause vs. social filler, 문장부호는 마법이 아님.

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
