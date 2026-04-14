---
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, AskUserQuestion
description: 현재 변경사항을 독립 에이전트로 리뷰합니다. init으로 규칙 초기화, --contract로 Sprint Contract 기반 검증, --entropy로 엔트로피 스캔.
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy]"
---

# /deep-review — Independent Code Review

현재 코드 변경사항을 독립된 Evaluator 에이전트로 리뷰합니다.

## Argument Dispatch

- `init` → "init 모드" 섹션으로 분기 (프로젝트별 규칙 초기화)
- `--contract` / `--entropy` / 인수 없음 → "리뷰 모드"로 진행

## Prerequisites

`deep-review-workflow` 스킬을 로드합니다.

## 0. Auto-create .deep-review/ (리뷰 모드, 최초 실행 시)

`.deep-review/` 디렉토리가 없으면 **자동 생성** (init 실행 없이도 동작 보장):
```bash
mkdir -p .deep-review/contracts .deep-review/reports .deep-review/journeys
```
config.yaml이 없으면 기본값으로 생성:
```yaml
review_model: opus
codex_notified: false
last_review: null
app_qa:
  last_command: null
  last_url: null
```
rules.yaml은 생성하지 않음 (없으면 범용 기본 관점으로 리뷰).

## Steps (리뷰 모드)

### 1. 환경 감지

```bash
bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/detect-environment.sh
```

결과를 key=value 형식으로 파싱하여 환경 상태를 파악합니다.

**shallow clone (is_shallow=true) 감지 시:**
- "shallow clone에서는 review base가 부정확할 수 있습니다. `git fetch --unshallow`를 권장합니다." 안내
- HEAD~1 fallback으로 진행

### 2. 변경사항 수집 (Stage 1: Collect)

환경에 따라 diff를 수집합니다:

**non-git 환경 (change_state=non-git):**
- AskUserQuestion: "어떤 파일을 리뷰할까요?"
- 지정된 파일들의 전체 내용을 수집

**git + 커밋 0건 (change_state=initial):**
- 모든 파일 대상 리뷰 (empty tree hash 기준)

**git + clean (change_state=clean):**
- `git diff {review_base}..HEAD`로 최근 변경 수집

**git + staged/unstaged/mixed:**
- 해당 상태에 맞는 diff 수집 (staged: `--cached`, unstaged: `git diff`, mixed: `git diff HEAD`)
- AskUserQuestion으로 WIP 커밋 제안: "Codex 교차 검증을 위해 WIP 커밋을 생성할까요?"
  - 수락: `git add -A && git commit -m "wip: deep-review checkpoint"`
  - 거부: diff 기반으로 진행 (Claude Opus + 가능하면 Codex도)

**git + untracked-only:**
- `git ls-files --others --exclude-standard`로 파일 목록 수집 후 내용 읽기

**모든 git 상태에서 untracked > 0이면:**
- `git ls-files --others --exclude-standard`로 추가 파일을 리뷰 대상에 포함

diff에서 제외: 바이너리, vendor/, node_modules/, *.min.js, *.generated.*, *.lock

### 3. Contract 로드 (Stage 2: Contract Check)

`--contract` 플래그 처리:
- `--contract SLICE-{NNN}` (슬라이스 지정): `.deep-review/contracts/SLICE-{NNN}.yaml`만 로드
- `--contract` (슬라이스 미지정): `.deep-review/contracts/` 내 모든 `status: active` contract 로드하여 전체 검증
- 플래그 없이 `.deep-review/contracts/`에 active contract가 있으면: 자동으로 전체 contract 검증
- contract 디렉토리가 없거나 파일이 없으면: 이 단계 건너뜀

**Contract 유효성 검증:**
- `status: archived` contract는 자동 로드에서 제외
- `--contract SLICE-NNN`으로 archived contract를 명시적으로 지정한 경우: "SLICE-{NNN}은 archived 상태입니다. 리뷰를 계속할까요?" 확인
- YAML 파싱 오류 (문법 오류, 필수 필드 누락): 해당 contract 건너뜀 + 경고 메시지 출력
- 필수 필드: `slice`, `title`, `criteria` (하나라도 없으면 무효)
- `criteria`가 비어있으면: contract 검증 건너뜀 (Stage 3만 실행)

### 4. 리뷰 실행 (Stage 3: Deep Review)

**fitness.json 주입 (있으면):**
- `.deep-review/fitness.json` 파일 확인 → `JSON.parse`로 로드
- 있으면: code-reviewer 에이전트 prompt에 추가:
  "다음은 프로젝트의 계산적 아키텍처 규칙(fitness.json)입니다. 이 규칙들은 deep-work에서 자동 검증되지만, 리뷰 시 규칙의 의도를 기준으로 설계 방향성을 평가하세요."
- 없으면: skip (에러 아님)

**Receipt health_report 주입 (있으면):**
- Receipt 발견 계약:
  1. `.deep-work/sessions/` 디렉토리에서 가장 최근 세션의 receipt.json 탐색
  2. receipt의 `health_report.scan_commit`과 현재 `git rev-parse HEAD` 비교
  3. 일치 → health_report를 code-reviewer prompt에 추가
  4. 불일치 → "stale health report — skip" 경고 + 주입하지 않음
  5. receipt 없음 → skip (에러 아님)

**유저 고지 (리뷰어 spawn 직전):**

리뷰어를 spawn하기 직전, 실행되는 리뷰어 구성에 따라 고지:
- Opus 단독 (Case A/B): "Opus 리뷰를 백그라운드에서 실행합니다. 완료되면 결과를 알려드리겠습니다."
- 3-way (Case C): "3개 리뷰어(Opus, Codex review, Codex adversarial)를 백그라운드에서 실행합니다. 완료되면 결과를 합성하여 알려드리겠습니다."

**Claude Opus 서브에이전트 (항상 실행):**

Agent tool로 `code-reviewer` 에이전트를 백그라운드에서 spawn합니다:
- `model: "opus"` (config.yaml의 review_model로 오버라이드 가능)
- `run_in_background: true`
- prompt에 포함: diff 내용, rules.yaml (있으면), fitness.json (있으면), health_report (있으면), contract (있으면)

**Codex preflight (codex_plugin=true일 때):**
1. codex:review를 시도하기 전에 Codex가 실제로 동작하는지 확인
2. 실패 시 (인증 오류, 타임아웃 등): Codex 결과를 "미수행"으로 표시하고 Claude Opus 단독으로 fallback
3. 합성 시 미수행 리뷰어는 제외 (3-way가 아닌 실제 수행된 리뷰어 수 기준)

**Codex 교차 검증 (git + codex_plugin=true 시):**

Codex 리뷰 대상은 change_state에 따라 결정:
- `clean` → `--base {review_base}` (커밋 기준 브랜치 diff)
- `staged`/`unstaged`/`mixed`/`untracked-only` → `--uncommitted` (작업 트리 변경사항)
  - WIP 커밋을 수락한 경우 → `--base {review_base}` (커밋 기준)

이렇게 해야 Opus(diff 기반)와 Codex가 같은 대상을 리뷰한다.

병렬 백그라운드 실행 (Bash tool 직접 호출):
- `Bash({ command: 'node "{codex_companion_path}" review {codex_target_flag}', run_in_background: true })`
- adversarial-review (focus_text는 stdin으로 전달하여 쉘 인젝션 방지):
  1. Write tool로 focus_text를 임시 파일에 저장 (예: `/tmp/deep-review-focus.txt`)
  2. `Bash({ command: 'node "{codex_companion_path}" adversarial-review {codex_target_flag} - < /tmp/deep-review-focus.txt', run_in_background: true })`
  3. 리뷰 완료 후 임시 파일 삭제

여기서 `{codex_target_flag}`는:
- clean 또는 WIP 커밋 후: `--base {review_base}`
- dirty tree (WIP 거부): `--uncommitted`

⚠️ 보안: focus_text는 rules.yaml/contract에서 생성되며 repo 파일이므로, 쉘 명령 문자열에 직접 삽입하면 안 된다. 반드시 stdin(`-` 인자 + 파일 리다이렉트)으로 전달할 것.

focus_text 생성:
- rules.yaml이 있으면: 아키텍처 규칙, 엔트로피 규칙에서 추출
- contract가 있으면: criteria 목록 추가
- 둘 다 없으면: "코드 품질, 버그, 아키텍처 문제를 집중 검토"

**Codex 플러그인 미설치 시 (codex_plugin=false):**
- `.deep-review/config.yaml`의 `codex_notified` 확인
- false이면 1회 안내:
  - codex_cli=false: "Codex 플러그인이 설치되어 있으면 교차 모델 검증이 가능합니다. 설치: `claude plugin add codex`"
  - codex_cli=true: "Codex CLI가 감지되었지만, 교차 모델 검증에는 Codex Claude Code 플러그인이 필요합니다. 설치: `claude plugin add codex`"
- `codex_notified: true`로 업데이트

### 5. 합성 및 판정 (Stage 4: Verdict)

모든 백그라운드 리뷰어의 완료 알림이 수신된 후:
- Agent tool(`run_in_background`)과 Skill tool(`--background`)은 완료 시 자동 알림 반환
- polling 불필요 — Claude Code 런타임이 완료 알림을 자동 전달
- Opus background task 실패 시: "미수행"으로 표시, 실행된 리뷰어만으로 합성
- 부분 성공 시: 성공한 리뷰어 수 기준으로 합성 (3-way가 아닌 실제 수행된 N-way)

1. 교차 검증 합성 (Codex 결과가 있을 때):
   - 전원 일치 지적 → 🔴 높은 확신
   - 2/3 지적 → 🟡 중간 확신
   - 단독 지적 → 참고
   - 전원 통과 → 🟢

2. Verdict 결정:
   - 🔴 1건 이상 → **REQUEST_CHANGES**
   - 🟡만, 전원 일치 → **REQUEST_CHANGES**
   - 🟡만, 의견 분리 → **CONCERN**
   - 🟢만 → **APPROVE**

3. 리포트 저장: `.deep-review/reports/{YYYY-MM-DD}-review.md`

4. REQUEST_CHANGES + Codex 있을 때:
   "수정을 codex:rescue로 위임하시겠습니까?"

### 5.5 Recurring Findings Export

리포트 생성 후 자동 실행. `.deep-review/reports/` 내 리포트가 2개 미만이면 건너뜀.

**Finding Taxonomy (v1.0):**

분류 카테고리:
- `error-handling` — try-catch 누락, 에러 전파 미흡
- `naming-convention` — 네이밍 불일치, 스타일 혼용
- `type-safety` — any 타입, 타입 단언 남용
- `test-coverage` — 테스트 누락, 경계값 미검증
- `security` — 인젝션, 인증/인가 미흡
- `performance` — N+1, 불필요한 재계산
- `architecture` — 순환 의존, 레이어 침범, SRP 위반

**프로세스:**

1. `.deep-review/reports/` 내 모든 리포트를 읽어 🔴 Critical + 🟡 Warning 항목 수집

2. 각 항목을 taxonomy 카테고리로 LLM 의미 기반 분류:
   - 항목의 설명과 코드 컨텍스트를 읽고 7개 카테고리 중 가장 적합한 것을 선택
   - 하나의 LLM 호출로 전체 항목을 일괄 분류 (호출 간 비결정성 방지)

3. 같은 카테고리가 3회 이상 나타나면 "recurring"으로 분류
   - 같은 카테고리에서 severity가 혼재하면 (critical + warning), 가장 높은 severity를 채택
   - 예: error-handling이 critical 3회, warning 2회이면 → severity: "critical", occurrences: 5

4. `.deep-review/recurring-findings.json`에 기록:

```json
{
  "updated_at": "<ISO 8601>",
  "taxonomy_version": "1.0",
  "findings": [
    {
      "category": "<taxonomy category>",
      "severity": "critical|warning",
      "occurrences": "<count>",
      "example_files": ["<file:line>"],
      "description": "<패턴 설명>",
      "source_reports": ["<report filename>"]
    }
  ]
}
```

5. 이 파일은 deep-evolve가 소비할 수 있는 표준 인터페이스 (init Stage 3.5에서 읽음).

### 6. 엔트로피 스캔 (--entropy)

`--entropy` 플래그가 있으면 추가 스캔:
- 프로젝트 전체에서 중복 코드 블록 탐지
- 기존 유틸리티와 중복되는 새 헬퍼 함수 탐지
- 네이밍 컨벤션 불일치 탐지
- 결과를 `.deep-review/entropy-log.jsonl`에 append

### 7. App QA (--qa) — v1.1에서 구현

현재 v1.0에서는: "App QA는 deep-review v1.1에서 지원 예정입니다."

---

## Steps (init 모드 — 인수가 "init"일 때)

### 1. 기존 설정 확인

`.deep-review/` 디렉토리가 이미 존재하는지 확인합니다.
- 존재하면: AskUserQuestion "이미 초기화되어 있습니다. 다시 초기화할까요?"
- 없으면: 진행

### 2. 디렉토리 생성

```bash
mkdir -p .deep-review/contracts
mkdir -p .deep-review/reports
mkdir -p .deep-review/journeys
```

### 3. 프로젝트 분석

코드베이스를 탐색하여 아키텍처 규칙을 추론합니다:

1. **언어/프레임워크 감지**: package.json, pyproject.toml, Cargo.toml 등
2. **디렉토리 구조 분석**: src/, lib/, components/ 등의 패턴
3. **기존 린터 규칙**: .eslintrc, .prettierrc, ruff.toml 등에서 스타일 규칙 추출
4. **네이밍 컨벤션**: 기존 파일/함수의 네이밍 패턴 분석

### 4. 사용자와 대화형 규칙 설정 (AskUserQuestion)

분석 결과를 바탕으로 AskUserQuestion으로 질문:

"프로젝트를 분석했습니다. 다음 규칙을 적용할까요?"

**(A) 아키텍처 레이어:**
- 감지된 레이어 구조 제시 (또는 "감지된 구조 없음")
- 사용자가 수정/추가/건너뛰기 가능

**(B) 스타일 규칙:**
- 감지된 네이밍 컨벤션, 파일 크기 제한 등
- 기존 린터 규칙과 통합

**(C) 엔트로피 규칙:**
- 공유 유틸리티 선호 여부
- 유사 블록 반복 허용 횟수

### 5. config.yaml 생성

```yaml
# .deep-review/config.yaml
review_model: opus
codex_notified: false
last_review: null
app_qa:
  last_command: null
  last_url: null
```

### 6. rules.yaml 생성

사용자 확인을 받은 규칙으로 생성합니다. 예시:

```yaml
# .deep-review/rules.yaml
# Generated by /deep-review init on {날짜}

architecture:
  layers: []          # 사용자 정의 또는 빈 배열
  direction: top-down
  cross_cutting: []

style:
  max_file_lines: 300
  naming: null        # 감지된 컨벤션 또는 null
  logging: null

entropy:
  prefer_shared_utils: true
  max_similar_blocks: 3
  validate_at_boundaries: true
```

### 7. Fitness.json 안내

"아키텍처 규칙을 계산적으로 강제하려면 deep-work의 fitness.json을 사용하세요.
 /deep-work 세션 Phase 1에서 자동으로 fitness.json 생성을 제안합니다.
 rules.yaml은 LLM이 판단하는 inferential 규칙, fitness.json은 코드가 검증하는 computational 규칙입니다."

### 8. .gitignore 업데이트

`.deep-review/reports/`를 .gitignore에 추가할지 사용자에게 확인:
- 리포트는 보통 커밋할 필요 없음 (일시적)
- config.yaml과 rules.yaml은 커밋 권장

### 9. 완료 메시지

"deep-review 초기화 완료. `/deep-review`로 리뷰를 시작하세요."

(이 init 로직은 메인 커맨드 deep-review.md의 "init 모드" 섹션에 포함되어 있음 — 별도 커맨드 파일 없음)
