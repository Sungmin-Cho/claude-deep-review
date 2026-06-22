[English](./README.md) | **한국어**

# deep-review

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-review?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-review)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

AI 코딩 에이전트를 위한 독립 Evaluator 플러그인 — Codex 연동 교차 모델 코드 리뷰와 Sprint Contract 지원.

AI 코딩 에이전트에는 구조적 맹점이 있습니다: 자신이 작성한 코드를 스스로 리뷰합니다. 코드를 작성한 에이전트가 그것을 판단하므로 자기 승인 편향이 구조적으로 내재합니다. deep-review는 원본 세션 컨텍스트 — 코드 뒤의 추론·의도·가정 — 를 전혀 모르고 diff만 보는 **별도의 Opus 서브에이전트**를 생성하여 구조적으로 독립된 평가를 수행합니다. [Codex](https://github.com/openai/codex)(및 선택적으로 `agy` CLI)가 설치되어 있으면 리뷰가 병렬 교차 모델 검증으로 확장되고, 발견 사항은 신뢰도 수준에 따라 합성됩니다.

## deep-suite에서의 역할

deep-review는 [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)의 **독립 평가자**로, [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 프레임워크의 Generator–Evaluator 분리를 구현합니다:

- **Inferential 센서** — Generator 컨텍스트 없는 독립 Opus 서브에이전트 리뷰. computational 센서가 잡지 못하는 의미론적 문제의 주요 품질 게이트.
- **교차 모델 검증** — Opus + Codex review + Codex adversarial (+ agy). 프레임워크의 "LLM-as-judge" 개념을 초과.
- **Fitness 인지 리뷰** — [deep-work](https://github.com/Sungmin-Cho/claude-deep-work)의 `fitness.json` 규칙과 `health_report`를 소비하여 아키텍처 의도 인지 평가.
- **Sprint Contract 검증** — 구조화된 성공 기준 확인.

## 설치

`claude-deep-suite` marketplace를 통해:

```bash
# Claude Code
/plugin install deep-review@claude-deep-suite

# Codex
codex plugin install deep-review
```

추가 설정은 필요 없습니다. 첫 실행 시 기본 `config.yaml`과 함께 `.deep-review/`가 생성됩니다. 프로젝트별 `rules.yaml`을 생성하려면 `/deep-review init`을 실행합니다.

## 커맨드

| 커맨드 | 설명 |
|---|---|
| `/deep-review` | 독립 Opus 서브에이전트로 현재 변경사항 리뷰 (Codex/agy 존재 시 교차 모델) |
| `/deep-review --ultracode [--codex]` | 멀티에이전트 Claude fan-out (하이브리드: Workflow 도구 가용 시 우선, 그 외 병렬 `code-reviewer` 에이전트) — 단일 "Claude(ultracode)" 보이스로 collapse + 선택적 Codex 2-way |
| `/deep-review --codex-only` | 내부 Claude 리뷰어를 끄고 Codex 2-way 만 실행 (외부 `--ultracode` 세션과 역할분담) |
| `/deep-review --contract [SLICE-NNN]` | Sprint Contract 기반 구조적 검증 |
| `/deep-review --entropy` | 엔트로피 스캔 (중복, 패턴 드리프트, 네이밍 불일치) |
| `/deep-review --respond [REPORT_PATH]` | 증거 기반 프로토콜로 리뷰 피드백 대응 |
| `/deep-review --respond --source=pr` | GitHub PR 리뷰 코멘트에 대응 |
| `/deep-review-loop [--max=N]` | 리뷰 ↔ 대응을 수렴까지 자동 반복 (`user-invocable` 스킬이기도 함 — Codex CLI / SDK 진입용 `Skill({ skill: "deep-review:deep-review-loop" })`) |
| `/deep-review-loop --ultracode --codex` | ultracode 1회(라운드 1) + codex 매 라운드 통합 루프 |
| `/deep-review init` | 프로젝트별 리뷰 규칙 대화형 초기화 |

**합성 리뷰어 플래그** (v1.10.0):

- `--ultracode` — Claude 쪽 리뷰를 멀티에이전트 fan-out 으로 수행 (하이브리드: Workflow 도구 가용 시 우선, 그 외 병렬 `code-reviewer` 에이전트), 단일 "Claude(ultracode)" 보이스로 collapse.
- `--codex` / `--no-codex` / `--no-opus` / `--no-agy`, 슈가 `--codex-only`(= `--codex --no-opus --no-agy`).
- `/deep-review-loop --ultracode --codex`: ultracode 1회(라운드 1) + codex 매 라운드.
- 무플래그 시 기존 동작 100% 유지.

## 리뷰 파이프라인

deep-review는 매 실행 시 4단계 파이프라인을 수행하며, 선택적으로 Stage 5에서 피드백에 대응합니다:

```
Stage 1: Collect      — 환경 감지, diff 수집
Stage 2: Contract     — Sprint Contract가 있으면 로드
Stage 3: Deep Review  — Opus 서브에이전트 백그라운드 생성 (Codex / agy 가능 시 추가)
Stage 4: Verdict      — 결과 합성, APPROVE / CONCERN / REQUEST_CHANGES 판정
Stage 5: Respond      — 증거 기반 피드백 대응 (--respond로 진입)
```

### Stage 1: Collect (수집)

환경 감지가 git 상태를 파악하고 적절한 diff를 수집합니다:

- `non-git` — 사용자에게 리뷰할 파일 목록 요청
- `initial` (커밋 0건) — 빈 트리 기준으로 전체 파일 리뷰
- `clean` — `git diff {review_base}..HEAD`
- `staged` — `git diff --cached`
- `unstaged` — `git diff`
- `mixed` — `git diff HEAD`
- `untracked-only` — untracked 파일 직접 읽기

diff 제외 대상: 바이너리, `vendor/`, `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.git/`, `*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`.

### Stage 2: Contract 검증

- `--contract SLICE-NNN` — `.deep-review/contracts/SLICE-NNN.yaml`만 로드 (`status: active` 확인)
- `--contract` — 모든 `status: active` contract 로드
- 플래그 없음 — `.deep-review/contracts/`의 active contract 자동 로드, 아카이브된 contract 제외
- malformed YAML — 해당 contract는 경고와 함께 skip

각 기준(criteria)을 실제 코드 변경사항에 대해 검증합니다.

### Stage 3: Deep Review (심층 리뷰)

독립 `code-reviewer` 에이전트가 `model: opus`, `run_in_background: true`로 생성됩니다. Codex / non-Claude 런타임에서는 동일 reviewer를 `claude -p --agent code-reviewer`로 실행합니다. spawn 전 실행될 리뷰어 구성(Opus 단독 또는 교차 모델)을 고지합니다. 에이전트는 diff, rules, contract만 받으며 — 원본 세션 컨텍스트는 절대 받지 않습니다 — 6가지 관점을 평가합니다:

| # | 관점 | 검사 내용 |
|---|---|---|
| 1 | 정확성 | 로직 버그, 엣지 케이스, 에러 핸들링 |
| 2 | 아키텍처 정합성 | `rules.yaml` 위반, 레이어 경계, 종속성 방향 |
| 3 | 엔트로피 | 중복 코드, 패턴 드리프트, ad-hoc 헬퍼 |
| 4 | 테스트 충분성 | 변경 대비 커버리지, 누락 시나리오 |
| 5 | 가독성 | 다음 에이전트가 처음 읽을 때 이해 가능한가 |
| 6 | 보안 | 입력 검증, 인증/인가 우회, 인젝션(prompt injection 포함), 비밀 노출, 위험한 연산 |

v1.12.0부터 공유 리뷰어 페이로드(Opus 리뷰어, ultracode 샤드, agy가 사용)에 두 가지가 추가됩니다:

- **`change_files` 매니페스트** — NUL-safe, capped 교차 파일 매니페스트(이름 변경/복사 감지, dirty 상태 untracked 유니온)로 리뷰어가 diff 하나가 아닌 전체 변경 집합을 봅니다. diff 자체는 instruction-attention을 위해 마지막에 배치되며, 위 Stage 1 제외 목록을 동일하게 따릅니다.
- **FP-억제 독트린** — false-positive 억제 독트린과 conservative-balance 반대 가중치를 `review-criteria.md` 단일 출처에서 Opus 프롬프트, ultracode 샤드, agy 페이로드에 주입합니다. 표준 `codex review`와 Codex adversarial 패스는 공격성 보존을 위해 의도적으로 제외됩니다.

### Stage 4: Verdict (판정)

| 발견 사항 | 판정 |
|---|---|
| 🔴 Critical 1건 이상 | `REQUEST_CHANGES` |
| 🟡 Warning, 리뷰어 전원 동의 | `REQUEST_CHANGES` |
| 🟡 Warning, 의견 분리 | `CONCERN` |
| 전원 통과 | `APPROVE` |

리포트는 `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`에 저장됩니다.

### Codex 자동 노출 프로토콜

git 리포지터리 + Codex 플러그인 설치 환경에서 `/deep-review`는 이번 세션에서 편집한 gitignored 파일 — 전형적으로 스펙, 리서치 노트, 플랜 문서 — 을 감지해 사용자 승인 하에 Codex에 임시 노출하여 교차 모델 리뷰를 수행합니다. 실행될 git 명령을 단일 프롬프트에 표시하고, atomic `mkdir` lock을 획득한 뒤 `--scope working-tree`로 리뷰를 실행하고, 상태를 원복합니다(리뷰 중 사용자가 실제로 staging한 것은 보존). 중간에 크래시된 세션은 다음 실행 시 자동 회수됩니다. 민감 패턴(`.env*`, credentials, SSH 키, GCP 서비스 계정, `.pgpass`, `.netrc`, `wrangler.toml`, JWT 등)을 대소문자 불문 스캔하며, 전원 민감 파일이면 프롬프트 없이 자동 skip합니다.

## 교차 모델 검증

Codex가 설치되어 있고 git 커밋이 있는 경우, 리뷰는 병렬로 실행되어 신뢰도 수준에 따라 합성됩니다:

```
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

`agy`(Google Antigravity) CLI가 감지되면 cross-vendor-family 4번째 리뷰어로 합류합니다. Codex가 미설치면 deep-review는 1회 알림 후 Opus 단독으로 진행합니다. 리뷰어가 실패하면(인증 오류, 타임아웃) graceful하게 fallback하고 해당 리뷰어를 "미수행"으로 표시합니다.

`staged`, `unstaged`, `mixed` 상태에서는 교차 모델 검증이 실제 커밋 베이스에 대해 실행되도록 WIP 커밋 생성을 제안합니다. 제안은 파일 목록을 미리 보여주고 민감 패턴을 경고하며 `git add -A`를 사용하지 않습니다; `git reset --soft HEAD~1`로 원복합니다. shallow clone은 감지되어 `git fetch --unshallow` 권장이 표시됩니다.

## Receiving Review (Stage 5)

Stage 4가 `REQUEST_CHANGES`를 반환하면 deep-review는 증거 기반 대응(`/deep-review --respond`), `codex:rescue` 위임(Codex 설치 시), 수동 처리를 제공합니다. `--respond` 플래그가 6단계 프로토콜을 활성화합니다:

| 단계 | 행동 |
|---|---|
| READ | 반응 없이 전체 피드백 읽기 |
| UNDERSTAND | 각 요구사항을 기술적으로 재진술 |
| VERIFY | 코드베이스와 대조 검증 (파일, grep, 테스트, blame) |
| EVALUATE | source 신뢰도에 따라 수락 / 반박 / 보류 판단 |
| RESPOND | 수정과 함께 수락 또는 증거로 반박 |
| IMPLEMENT | 심각도 우선순위로 수정 적용, 심각도 그룹별 커밋 |

각 source는 검증 수준을 결정하는 기본 신뢰도를 가집니다:

| Source | 기본 신뢰도 |
|---|---|
| Human (사용자) | 높음 |
| deep-review Opus | 중간 |
| Codex review | 중간 |
| Codex adversarial | 낮음 |
| PR comment (외부) | 낮음 |

`/deep-review --respond --source=pr`는 `gh api`로 GitHub PR 코멘트를 수집하고 동일 프로토콜을 적용합니다 — 인라인 코멘트에는 스레드 답글, 일반 코멘트에는 이슈 레벨 답글로 응답합니다. 각 세션은 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 모든 결정을 evidence와 함께 기록한 리포트를 생성합니다.

## Sprint Contract

Sprint Contract는 기능 슬라이스의 성공 기준을 정의하며, deep-review는 의도가 아닌 실제 코드에 대해 각 기준을 검증합니다. Contract는 `.deep-review/contracts/SLICE-NNN.yaml`에 위치합니다:

```yaml
slice: SLICE-001
title: "JWT 인증"
status: active
criteria:
  - id: C1
    description: "모든 보호된 라우트에서 토큰 만료를 검증한다"
    verification: auto       # auto | manual | mixed
    status: null             # Evaluator가 채움: PASS | FAIL | PARTIAL | SKIP
    evidence: null           # Evaluator가 채움
```

- `verification: auto` — Evaluator가 코드를 읽고 pass/fail을 판단합니다.
- `verification: manual` — 자동으로 스킵되며 "수동 확인 필요"로 표시됩니다.
- `verification: mixed` — 자동 검증 가능한 부분만 검사하고 나머지는 스킵합니다.

## 설정

deep-review는 `.deep-review/` 아래 여러 파일을 읽습니다:

- **`rules.yaml`** (inferential) — `/deep-review init`이 생성하는 프로젝트별 리뷰 규칙; LLM이 읽고 적용합니다. 없으면 범용 모범 사례 기준을 사용합니다.
- **`fitness.json`** (computational) — deep-work Health Engine이 생성·검증하는 아키텍처 fitness 규칙; 존재 시 리뷰어 프롬프트에 주입하여 아키텍처 의도 인지 리뷰를 수행합니다.
- **`config.yaml`** — 런타임 상태(리뷰 모델, Codex/agy 알림 플래그, fingerprint 모드). 첫 실행 시 자동 생성되며 한 번에 한 필드씩 갱신해 수동 설정이 보존됩니다.
- **`recurring-findings.json`** — 매 리뷰 후 반복 패턴을 7개 taxonomy(`error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`)로 분류하고 M3 cross-plugin envelope으로 emit하며, deep-evolve가 소비하여 실험 방향을 조향합니다.

**팀 공유**: `rules.yaml`, `contracts/`, `journeys/`는 프로젝트 지식이므로 커밋해야 하며, `config.yaml`, `reports/`, `responses/`, `entropy-log.jsonl`, `recurring-findings.json`은 머신별 런타임 상태입니다. `/deep-review init`이 이 구분을 `.gitignore`에 반영합니다.

## 링크

- [변경 기록](./CHANGELOG.ko.md)
- [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) — marketplace 및 형제 플러그인
- [기여 가이드](./CONTRIBUTING.md) · [보안 정책](./SECURITY.md)

## 라이선스

[MIT](./LICENSE)
