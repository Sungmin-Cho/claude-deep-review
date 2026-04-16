# Receiving Review — 설계 문서

> **작성일**: 2026-04-16
> **대상 버전**: deep-review v1.3.0
> **참조**: superpowers v5.0.7 `receiving-code-review` skill

---

## 1. 동기

deep-review는 현재 **리뷰 생성(Evaluator)** 역할만 수행한다. Stage 4 Verdict에서 `REQUEST_CHANGES`가 나오면 codex:rescue 위임을 제안하지만, 리뷰 피드백을 **어떻게 수용/반박/구현해야 하는지**에 대한 프로토콜이 없다.

Superpowers의 `receiving-code-review`는 이 영역을 다루지만 행동 지침(behavioral guidance)에 그친다. deep-suite의 Harness Engineering 원칙에 맞춰 **증거 기반 대응 프로토콜**로 재설계한다.

### 해결하려는 문제

| 문제 | 현재 상태 | 목표 |
|------|-----------|------|
| 맹목적 동의 | 에이전트가 리뷰 피드백에 "You're absolutely right!" 등 성과주의적 반응 | 기술적 검증 후 증거 기반 대응 |
| 검증 없는 구현 | 피드백을 그대로 구현하여 기존 기능 파괴 | VERIFY → evidence 첨부 → 구현 |
| YAGNI 무시 | 리뷰어 제안이 실제 사용되지 않는 기능 추가로 이어짐 | 사용처 grep 결과를 증거로 첨부 |
| 반박 회피 | 기술적으로 틀린 피드백에도 반박하지 않음 | 코드 증거로 반박 근거 제시 |
| 대응 기록 부재 | 어떤 항목을 왜 수락/반박했는지 추적 불가 | response 리포트에 판단 근거 기록 |

---

## 2. 설계 원칙

### Harness Engineering 배치

```
                    Guide (feedforward)     Sensor (feedback)
Computational       —                       response evidence 필수 필드 검증
Inferential         receiving-review skill  대응 후 re-review 비교
```

- **Inferential Guide**: skill 텍스트가 대응 프로토콜을 가이드
- **Computational Sensor**: response 리포트의 필수 필드(evidence, verdict_ref)를 구조적으로 검증

### Superpowers 원본에서 가져오는 것

| 항목 | 적응 방식 |
|------|-----------|
| READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT 6단계 | 그대로 채용 + 각 단계에 evidence 필드 추가 |
| 금지 표현 ("You're absolutely right!" 등) | 그대로 채용 |
| Source-specific handling (Human vs External) | 4분류로 확장 (Human, Opus, Codex, PR comment) |
| YAGNI check (grep 사용처) | grep 결과를 response 리포트에 첨부 의무화 |
| Push Back 가이드라인 | 코드 증거(테스트 결과, git blame) 첨부 의무화 |
| 구현 순서 (Blocking → Simple → Complex) | deep-review verdict의 🔴/🟡 분류와 연동 |
| Graceful correction (반박 철회 시) | 그대로 채용 |

### Superpowers에 없는 deep-suite 고유 추가

| 항목 | 설명 |
|------|------|
| Response 리포트 | `.deep-review/responses/{날짜}-response.md`에 대응 기록 |
| Cross-model disagreement 처리 | Opus와 Codex 의견 불일치 시 분기 전략 |
| Verdict 연동 | Stage 4 verdict의 🔴/🟡/🟢 + 확신도를 대응 우선순위에 자동 매핑 |
| Re-review 흐름 | 대응 완료 후 `/deep-review`를 재실행하여 delta 확인 |
| Recurring findings 연동 | 같은 카테고리 피드백이 반복되면 근본 원인 분석 유도 |

---

## 3. 아키텍처

### 현재 파이프라인 (v1.1.2)

```
Stage 1: Collect → Stage 2: Contract → Stage 3: Review → Stage 4: Verdict
                                                               ↓
                                                         리포트 저장
                                                         (여기서 끝)
```

### 추가 후 파이프라인 (v1.3.0)

```
Stage 1: Collect → Stage 2: Contract → Stage 3: Review → Stage 4: Verdict
                                                               ↓
                                                         리포트 저장
                                                               ↓
                                              ┌── APPROVE → 완료
                                              ├── CONCERN → 사용자 에스컬레이션
                                              └── REQUEST_CHANGES
                                                         ↓
                                                   Stage 5: Respond (NEW)
                                                         ↓
                                                   항목별 대응 루프
                                                   ├── VERIFY (증거 수집)
                                                   ├── EVALUATE (판단)
                                                   ├── ACT (구현 or 반박)
                                                   └── RECORD (response 리포트)
                                                         ↓
                                                   Re-review (선택)
```

### 트리거 경로

Stage 5는 세 가지 경로로 진입한다:

1. **자동 진입**: `/deep-review` 실행 후 verdict가 `REQUEST_CHANGES`일 때 자동 제안
2. **수동 진입**: `/deep-review --respond` 플래그로 직접 호출 (기존 리포트 기반)
3. **외부 피드백**: `/deep-review --respond --source=pr` (GitHub PR 코멘트 기반)

---

## 4. Skill 상세 설계

### 4.1 파일 구조

```
skills/
  deep-review-workflow/          ← 기존 (변경 없음)
    SKILL.md
    references/
      review-criteria.md
      codex-integration.md
      contract-schema.md
      report-format.md
  receiving-review/              ← NEW
    SKILL.md
    references/
      response-protocol.md      ← 6단계 대응 프로토콜 상세
      forbidden-patterns.md     ← 금지 표현 + 합리화 차단 테이블
      response-format.md        ← response 리포트 형식
```

### 4.2 SKILL.md Frontmatter

```yaml
---
name: receiving-review
description: |
  코드 리뷰 피드백 수신 시 증거 기반 대응 프로토콜.
  맹목적 동의를 차단하고, 기술적 검증 후 증거와 함께 수락/반박/구현한다.
  deep-review verdict 또는 외부 리뷰(PR 코멘트, 동료 리뷰) 모두에 적용.
user-invocable: false
---
```

### 4.3 대응 프로토콜 (Response Protocol)

#### Phase 1: READ — 전체 피드백 읽기

```
입력: deep-review 리포트 또는 외부 피드백
출력: 항목 목록 (item_id, severity, description, source)

규칙:
- 반응하지 않고 전체를 먼저 읽는다
- 항목 간 관계를 파악한다 (A를 수정하면 B도 해결되는지)
- 불명확한 항목이 하나라도 있으면 전체 구현을 보류한다
```

#### Phase 2: UNDERSTAND — 요구사항 재진술

```
각 항목에 대해:
- 기술적 요구사항을 자신의 말로 재진술
- 재진술 불가 시: 명확화 요청 (구현 보류)

금지:
- "You're absolutely right!"
- "Great point!" / "Excellent feedback!"
- "Thanks for catching that!"
- ANY gratitude expression
- "Let me implement that now" (검증 전)

대신:
- 기술적 요구사항을 재진술하거나
- 명확화 질문을 하거나
- 바로 행동 (코드로 보여주기)
```

#### Phase 3: VERIFY — 코드베이스 대조 검증

```
각 항목에 대해 반드시 실행:
1. 관련 코드 읽기 (Read)
2. 사용처 검색 (Grep) — YAGNI check
3. 기존 테스트 확인 (Glob + Read)
4. git blame으로 원래 의도 확인 (필요 시)

출력 (evidence 객체):
  verification:
    files_read: ["src/foo.ts:42-60"]
    grep_results: "bar() — 3 call sites found"
    test_status: "existing test covers happy path only"
    git_context: "introduced in abc123 for backward compat"
```

#### Phase 4: EVALUATE — 기술적 판단

```
Source별 신뢰도 매트릭스:

| Source | 기본 신뢰도 | 검증 수준 |
|--------|-------------|-----------|
| Human (사용자) | 높음 | 이해 후 구현, 범위 불명확 시만 질문 |
| deep-review Opus | 중간 | 코드베이스 대조 검증 필수 |
| Codex review | 중간 | 코드베이스 대조 검증 필수 |
| Codex adversarial | 낮음 | 철저한 코드 근거 검증 필수 |
| PR comment (외부) | 낮음 | 5-point 외부 리뷰어 체크리스트 적용 |

Cross-model disagreement 처리:
- Opus + Codex 일치 → 높은 확신, 수락 우선
- Opus만 지적 → 코드 검증 후 판단
- Codex만 지적 → 회의적 검증 (false positive 비율 높음)
- Adversarial만 지적 → 참고 수준, 근거 불충분하면 기각
```

#### Phase 5: RESPOND — 수락 또는 반박

```
수락 시:
  ✅ "Fixed. [변경 내용 요약]"
  ✅ "Good catch — [구체적 이슈]. Fixed in [위치]."
  ✅ [코드로 보여주기, 말 없이]

반박 시 (evidence 필수):
  형식:
    "이 항목은 구현하지 않습니다.
     근거: [기술적 이유]
     증거: [grep 결과 / 테스트 출력 / git blame]
     대안: [있으면]"

  반박 가능 조건:
  - 제안이 기존 기능을 파괴 (테스트 증거)
  - 리뷰어가 전체 컨텍스트를 모름 (git blame 증거)
  - YAGNI 위반 (grep 사용처 0건 증거)
  - 기술적으로 부정확 (공식 문서/실행 결과 증거)
  - 사용자의 아키텍처 결정과 충돌

반박 철회 시:
  ✅ "확인 결과 맞습니다 — [X]를 검증했더니 [Y]. 구현합니다."
  ❌ 긴 사과
  ❌ 왜 반박했는지 변명
```

#### Phase 6: IMPLEMENT — 항목별 구현

```
우선순위 (verdict 연동):
  1. 🔴 Critical (전원 일치) → 즉시 수정
  2. 🔴 Critical (부분 일치) → 검증 후 수정
  3. 🟡 Warning (전원 일치) → 수정
  4. 🟡 Warning (부분 일치) → YAGNI 체크 후 판단
  5. ℹ️ Info → 선택적

구현 규칙:
  - 한 항목씩 구현
  - 각 항목 구현 후 테스트 실행
  - 회귀 발생 시 즉시 중단
  - 모든 🔴 항목 완료 후에야 🟡 진행
```

### 4.4 Response 리포트 형식

```markdown
# Response Report — {YYYY-MM-DD HH:mm:ss}

## Summary
- **Source Review**: {리포트 파일 또는 PR URL}
- **Original Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Items**: {수락 N건, 반박 N건, 보류 N건}

## Item Responses

### ITEM-1: {제목}
- **Severity**: 🔴 Critical
- **Source**: Opus + Codex (일치)
- **Decision**: ACCEPT
- **Evidence**:
  - files_read: `src/foo.ts:42-60`
  - grep_results: `bar()` — 3 call sites
- **Action**: Fixed in `src/foo.ts:45` — null check 추가
- **Test**: `npm test -- --grep "bar"` → PASS

### ITEM-2: {제목}
- **Severity**: 🟡 Warning
- **Source**: Codex only
- **Decision**: REJECT
- **Evidence**:
  - grep_results: `legacyHandler()` — 0 call sites
  - git_blame: introduced in abc123 for backward compat (removed in def456)
- **Reason**: YAGNI — 사용처 없음. 해당 코드는 이미 삭제된 호환성 레이어의 잔여물.

## Re-review Recommendation
- 🔴 수정 {N}건 완료 — `/deep-review` 재실행 권장
```

저장 위치: `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`

---

## 5. 커맨드 변경

### `/deep-review --respond` 추가

```
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--respond [REPORT_PATH]]"
```

#### `--respond` 동작

1. **리포트 탐색**:
   - `--respond {path}` → 지정된 리포트 로드
   - `--respond` (경로 없음) → `.deep-review/reports/` 에서 가장 최근 리포트 로드
   - 리포트가 없으면: "대응할 리뷰 리포트가 없습니다. 먼저 `/deep-review`를 실행하세요."

2. **receiving-review skill 로드** → Phase 1~6 실행

3. **response 리포트 저장** → `.deep-review/responses/{날짜}-response.md`

4. **Re-review 제안**: "대응이 완료되었습니다. `/deep-review`를 재실행하여 변경사항을 검증하시겠습니까?"

#### `--respond --source=pr` 동작

1. GitHub PR 코멘트를 `gh api`로 수집
2. 코멘트를 항목 목록으로 파싱
3. 각 항목에 Phase 1~6 적용 (source 신뢰도: "PR comment (외부)")
4. 인라인 코멘트에는 스레드 답글로 응답 (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`)

---

## 6. Stage 4 Verdict 연동

### 현재 (v1.1.2)

```
Verdict: REQUEST_CHANGES
  → "codex:rescue로 수정을 위임하시겠습니까?"
```

### 변경 후 (v1.3.0)

```
Verdict: REQUEST_CHANGES
  → "대응 방법을 선택하세요:"
  → (1) 증거 기반 대응 시작 (/deep-review --respond)  ← NEW, 기본 추천
  → (2) codex:rescue로 수정 위임
  → (3) 수동으로 처리
```

---

## 7. Recurring Findings 연동

`.deep-review/recurring-findings.json`에 같은 카테고리가 3회 이상 등장하면, receiving-review 단계에서 자동 경고:

```
⚠️ Recurring Pattern Detected
카테고리: error-handling (5회 발생)
이 항목은 반복적으로 지적되고 있습니다.
개별 수정보다 근본 원인 분석을 권장합니다:
- 에러 핸들링 패턴이 프로젝트에 정의되어 있는가? (rules.yaml 확인)
- 공통 유틸리티가 필요한가?
```

---

## 8. 합리화 차단 테이블 (Superpowers에서 차용 + 확장)

| 합리화 | 왜 위험한가 | 올바른 대응 |
|--------|-------------|-------------|
| "리뷰어가 맞겠지" | 검증 없는 수용은 버그 유입 | VERIFY 단계를 건너뛰지 마라 |
| "간단한 수정이니 검증 불필요" | 간단한 변경이 연쇄 파괴를 유발 | 모든 항목에 테스트 실행 |
| "시간이 없으니 일단 구현" | 기술 부채 누적 | 🔴만 먼저 처리, 🟡는 별도 커밋 |
| "반박하면 분위기가 나빠질까" | 틀린 피드백 수용이 더 나쁨 | 증거와 함께 기술적으로 반박 |
| "이전에도 이렇게 했으니" | 반복된 패턴 = 근본 원인 미해결 | recurring findings 확인 |
| "Codex가 지적했으니 맞겠지" | Codex adversarial은 false positive 높음 | source 신뢰도 매트릭스 참조 |
| "전부 수락하면 빨리 끝남" | 불필요한 변경이 엔트로피 증가 | YAGNI 체크 필수 |

---

## 9. 구현 범위

### 파일 변경 목록

| 파일 | 작업 | 설명 |
|------|------|------|
| `skills/receiving-review/SKILL.md` | **CREATE** | 핵심 skill 정의 |
| `skills/receiving-review/references/response-protocol.md` | **CREATE** | 6단계 대응 프로토콜 상세 |
| `skills/receiving-review/references/forbidden-patterns.md` | **CREATE** | 금지 표현 + 합리화 차단 테이블 |
| `skills/receiving-review/references/response-format.md` | **CREATE** | response 리포트 형식 |
| `commands/deep-review.md` | **MODIFY** | `--respond` 플래그 추가, Stage 5 연동 |
| `skills/deep-review-workflow/SKILL.md` | **MODIFY** | Stage 4에 receiving-review 연동 문단 추가 |
| `.claude-plugin/plugin.json` | **MODIFY** | version: 1.1.2 → 1.3.0 |
| `package.json` | **MODIFY** | version: 1.2.0 → 1.3.0 |
| `CHANGELOG.md` | **MODIFY** | v1.3.0 항목 추가 |
| `CHANGELOG.ko.md` | **MODIFY** | v1.3.0 항목 추가 (한국어) |
| `README.md` | **MODIFY** | receiving-review 기능 설명 추가 |
| `README.ko.md` | **MODIFY** | receiving-review 기능 설명 추가 (한국어) |

### 변경하지 않는 파일

| 파일 | 이유 |
|------|------|
| `agents/code-reviewer.md` | 리뷰 생성 에이전트는 변경 불필요 |
| `hooks/hooks.json` | receiving-review는 hook 불필요 (수동/자동 트리거) |
| `skills/deep-review-workflow/references/*` | 기존 리뷰 기준은 그대로 유지 |

---

## 10. 마이그레이션 고려사항

- **하위 호환**: `--respond` 플래그가 없으면 기존 동작과 동일
- **디렉토리**: `.deep-review/responses/`는 `--respond` 최초 실행 시 자동 생성
- **config.yaml**: 스키마 변경 없음 (response는 별도 리포트 파일로 관리)

---

## 11. 향후 확장 가능성

| 항목 | 설명 | 우선순위 |
|------|------|----------|
| Hook 기반 자동 트리거 | deep-work Phase 4에서 REQUEST_CHANGES 시 자동 호출 | 중간 |
| GitHub Actions 연동 | CI에서 PR review 코멘트 자동 대응 | 낮음 |
| Response 이력 분석 | 반박/수락 비율 트렌드 → Assumption Engine 연동 | 낮음 |
| deep-wiki 연동 | 반복 패턴을 wiki에 자동 축적 | 낮음 |
