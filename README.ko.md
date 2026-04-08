[English](./README.md) | **한국어**

# Deep Review 플러그인

AI 코딩 에이전트의 작업을 독립적으로 평가하는 Evaluator 플러그인 — Codex 연동 교차 모델 코드 리뷰와 Sprint Contract 지원.

## 문제

AI 코딩 에이전트에는 구조적인 맹점이 있습니다: 자신이 작성한 코드를 스스로 리뷰합니다.

- 코드를 작성한 에이전트가 그것을 판단하기도 합니다 — 자기 승인 편향은 구조적입니다
- Opus가 500줄을 쓰고 같은 컨텍스트 윈도우 안에서 "리뷰"합니다
- 심각한 버그, 아키텍처 드리프트, 엔트로피가 감지되지 않고 쌓입니다
- Generator와 Evaluator의 분리 없이는 "리뷰"가 단순한 서술에 불과합니다

Generator-Evaluator 분리는 선택이 아닙니다. 진정한 독립적 의견을 얻는 유일한 방법입니다.

## 해결책

Deep Review는 원본 세션 컨텍스트를 전혀 모르는 **별도의 Opus 서브에이전트**를 생성합니다. diff만 봅니다 — 코드 뒤의 추론, 의도, 가정은 보지 않습니다. 이것이 구조적으로 독립된 평가입니다.

[Codex](https://github.com/openai/codex)가 설치되어 있으면, 리뷰는 **3-way 병렬 검증**으로 확장됩니다: Claude Opus + codex:review + codex:adversarial-review. 발견 사항은 신뢰도 수준에 따라 합성됩니다.

## 주요 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/deep-review` | 독립 Opus 서브에이전트로 현재 변경사항 리뷰 |
| `/deep-review --contract` | Sprint Contract 기반 구조적 검증 |
| `/deep-review --entropy` | 엔트로피 스캔 (중복, 패턴 드리프트, 네이밍 불일치) |
| `/deep-review init` | 프로젝트별 리뷰 규칙 대화형 초기화 |

## 리뷰 파이프라인

Deep Review는 매 실행 시 4단계 파이프라인을 수행합니다:

```
Stage 1: Collect      — 환경 감지, diff 수집
Stage 2: Contract     — Sprint Contract가 있으면 로드
Stage 3: Deep Review  — Opus 서브에이전트 생성 (Codex 가능 시 추가)
Stage 4: Verdict      — 결과 합성, APPROVE / CONCERN / REQUEST_CHANGES 판정
```

### Stage 1: Collect (수집)

환경 감지 스크립트가 git 상태를 파악하고 적절한 diff를 수집합니다:

- `non-git` — 사용자에게 리뷰할 파일 목록 요청
- `initial` (커밋 0건) — 빈 트리 기준으로 전체 파일 리뷰
- `clean` — `git diff {review_base}..HEAD`
- `staged` — `git diff --cached`
- `unstaged` — `git diff`
- `mixed` — `git diff HEAD`
- `untracked-only` — `git ls-files --others --exclude-standard`

diff 제외 대상: 바이너리, `vendor/`, `node_modules/`, `*.min.js`, `*.generated.*`, `*.lock`

### Stage 2: Contract Check (계약 검증)

`--contract` 플래그 처리:
- `--contract SLICE-NNN`: `.deep-review/contracts/SLICE-NNN.yaml`만 로드 (`status: active` 확인)
- `--contract`: `.deep-review/contracts/` 내 모든 `status: active` contract 로드하여 전체 검증
- 플래그 없음: `.deep-review/contracts/`에 active contract가 있으면 자동으로 전체 contract 검증
- `status: archived` contract는 자동 로드에서 제외; 명시적으로 지정 시 경고 표시
- YAML 파싱 오류: 해당 contract 건너뜀 + 경고 메시지 출력

각 기준(criteria)을 실제 코드 변경사항에 대해 검증합니다.

### Stage 3: Deep Review (심층 리뷰)

독립적인 `code-reviewer` 에이전트가 Agent 도구를 통해 `model: opus`로 생성됩니다. 에이전트는 diff, rules, contract만 받습니다 — 원본 세션 컨텍스트는 절대 받지 않습니다.

에이전트는 5가지 관점을 평가합니다:

| # | 관점 | 검사 내용 |
|---|------|-----------|
| 1 | 정확성 | 로직 버그, 엣지 케이스, 에러 핸들링 |
| 2 | 아키텍처 정합성 | rules.yaml 위반, 레이어 경계, 종속성 방향 |
| 3 | 엔트로피 | 중복 코드, 패턴 드리프트, ad-hoc 헬퍼 |
| 4 | 테스트 충분성 | 변경 대비 커버리지, 누락 시나리오 |
| 5 | 가독성 | 다음 에이전트가 처음 읽을 때 이해 가능한가 |

### Stage 4: Verdict (판정)

| 발견 사항 | 판정 |
|-----------|------|
| 🔴 Critical 1건 이상 | `REQUEST_CHANGES` |
| 🟡 Warning, 리뷰어 전원 동의 | `REQUEST_CHANGES` |
| 🟡 Warning, 의견 분리 | `CONCERN` |
| 전원 통과 | `APPROVE` |

리포트는 `.deep-review/reports/{YYYY-MM-DD}-review.md`에 저장됩니다.

## 교차 모델 검증

Codex가 설치되어 있고 git 커밋이 있는 경우, 리뷰는 3-way 병렬로 실행됩니다:

```
                    ┌─────────────────────────┐
                    │     Deep Review 시작     │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
     Claude Opus           codex:review      codex:adversarial
    (독립 서브에이전트)      (표준 리뷰)        (적대적 리뷰)
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │   신뢰도 기준 합성      │
                    │                        │
                    │  전원 일치  → 🔴 높음  │
                    │  2/3 일치   → 🟡 중간  │
                    │  단독 지적  → ℹ️ 참고  │
                    │  전원 통과  → 🟢       │
                    └────────────────────────┘
```

Codex가 미설치된 경우, Deep Review는 1회 알림을 표시하고 (`config.yaml`에 저장) Claude Opus 단독으로 진행합니다. Codex가 설치되었지만 실패하는 경우 (인증 오류, 타임아웃), Claude Opus 단독으로 fallback하고 Codex를 "미수행"으로 표시합니다.

## 환경 적응

Deep Review는 모든 환경에서 동작합니다. 리뷰 전략이 자동으로 조정됩니다:

| 상태 | 조건 | 리뷰 전략 |
|------|------|-----------|
| `non-git` | git 저장소 없음 | 사용자에게 파일 목록 요청 → 전체 내용 리뷰 |
| `initial` | git 저장소, 커밋 0건 | 빈 트리 기준으로 전체 파일 리뷰 |
| `clean` | 대기 중인 변경사항 없음 | `git diff {base}..HEAD` |
| `staged` | 스테이지된 변경사항만 | `git diff --cached` |
| `unstaged` | 스테이지되지 않은 변경사항만 | `git diff` |
| `mixed` | staged + unstaged 모두 | `git diff HEAD` |
| `untracked-only` | 새 파일, 스테이지 안 됨 | untracked 파일 직접 읽기 |

`staged`, `unstaged`, `mixed` 상태에서는 Codex 교차 검증이 실제 커밋 베이스에 대해 실행될 수 있도록 WIP 커밋 생성을 제안합니다.

Shallow clone (`git clone --depth`)은 자동으로 감지됩니다; `git fetch --unshallow` 권장 사항이 표시되고 HEAD~1이 fallback 베이스로 사용됩니다.

## Sprint Contract

Sprint Contract는 기능 슬라이스의 성공 기준을 정의합니다. Deep Review는 의도가 아닌 실제 코드에 대해 각 기준을 검증합니다.

Contract는 `.deep-review/contracts/SLICE-NNN.yaml`에 위치합니다:

```yaml
slice: SLICE-001
title: "JWT 인증"
source_plan: "plan.md#slice-001"
created_at: "2026-04-08T10:00:00Z"
status: active
criteria:
  - id: C1
    description: "모든 보호된 라우트에서 토큰 만료를 검증한다"
    verification: auto       # auto | manual | mixed
    prerequisites: []
    status: null             # Evaluator가 채움: PASS | FAIL | PARTIAL | SKIP
    evidence: null           # Evaluator가 채움
  - id: C2
    description: "동시 요청 환경에서 리프레시 플로우가 테스트됨"
    verification: manual     # 코드만으로는 검증 불가
    status: null
    evidence: null
```

`verification: auto` — Evaluator가 코드를 읽고 pass/fail을 판단합니다.
`verification: manual` — 자동으로 스킵되며, "수동 확인 필요"로 표시됩니다.
`verification: mixed` — 자동 검증 가능한 부분만 검사하고 나머지는 스킵합니다.

특정 슬라이스를 검증하려면 `/deep-review --contract SLICE-NNN`을, 모든 active contract를 검증하려면 `/deep-review --contract`를 사용합니다. `.deep-review/contracts/`에 active contract가 있으면 플래그 없이도 자동으로 로드됩니다. Archived contract는 자동 로드에서 제외됩니다.

## 설정

### `.deep-review/rules.yaml`

`/deep-review init`이 대화형으로 생성하는 프로젝트별 리뷰 규칙:

```yaml
architecture:
  layers: [api, service, repository]
  direction: top-down
  cross_cutting: [logger, config]

style:
  max_file_lines: 300
  naming: camelCase
  logging: structured

entropy:
  prefer_shared_utils: true
  max_similar_blocks: 3
  validate_at_boundaries: true
```

`rules.yaml`이 없으면 Deep Review는 범용 모범 사례 기준을 사용합니다.

### `.deep-review/config.yaml`

첫 실행 시 자동 생성되는 런타임 상태:

```yaml
review_model: opus       # opus | sonnet
codex_notified: false    # Codex 설치 안내 표시 여부
last_review: null        # 마지막 리뷰 시각
app_qa:
  last_command: null
  last_url: null
```

### 엔트로피 스캔 (`--entropy`)

`/deep-review --entropy` 실행 시 프로젝트 전체 엔트로피 스캔을 수행합니다:

- 파일 간 중복 코드 블록 탐지
- 기존 유틸리티와 중복되는 새 헬퍼 함수 탐지
- 네이밍 컨벤션 불일치 탐지
- 결과는 `.deep-review/entropy-log.jsonl`에 append됩니다

## 설치

```bash
claude plugin add deep-review
```

추가 설정이 필요 없습니다. 첫 실행 시 기본 `config.yaml`과 함께 `.deep-review/`가 자동으로 생성됩니다. 프로젝트별 `rules.yaml`을 생성하려면 `/deep-review init`을 실행합니다.

## 라이선스

MIT
