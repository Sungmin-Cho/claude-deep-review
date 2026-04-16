---
name: receiving-review
description: |
  코드 리뷰 피드백 수신 시 증거 기반 대응 프로토콜.
  맹목적 동의를 차단하고, 기술적 검증 후 증거와 함께 수락/반박/구현한다.
  deep-review verdict 또는 외부 리뷰(PR 코멘트, 동료 리뷰) 모두에 적용.
user-invocable: false
---

# Receiving Review Protocol

이 스킬은 `/deep-review --respond`에서 로드되어 리뷰 피드백 대응 프로세스를 가이드합니다.

## 참조 문서

- `references/response-protocol.md` — 6단계 대응 프로토콜 상세
- `references/forbidden-patterns.md` — 금지 표현 + 합리화 차단 테이블
- `references/response-format.md` — Response 리포트 형식

## 대응 원칙

1. **증거 우선**: 모든 판단(수락/반박)에 코드 증거를 첨부한다
2. **맹목적 동의 금지**: 감사 표현, 즉각 동의 등 성과주의적 반응을 차단한다
3. **검증 선행**: VERIFY 단계를 건너뛰지 않는다 — "간단한 수정"도 예외 없음
4. **기술적 반박 권장**: 증거가 있으면 반박한다. 분위기 보다 정확성이 우선
5. **기록 의무**: 모든 대응을 response 리포트에 기록한다

## Source 신뢰도 매트릭스

피드백 출처에 따라 기본 신뢰도와 검증 수준이 달라진다:

| Source | 기본 신뢰도 | 검증 수준 |
|--------|-------------|-----------|
| Human (사용자) | 높음 | 이해 후 구현, 범위 불명확 시만 질문 |
| deep-review Opus | 중간 | 코드베이스 대조 검증 필수 |
| Codex review | 중간 | 코드베이스 대조 검증 필수 |
| Codex adversarial | 낮음 | 철저한 코드 근거 검증 필수 |
| PR comment (외부) | 낮음 | 5-point 외부 리뷰어 체크리스트 적용 |

### Cross-model Disagreement 처리

- Opus + Codex 일치 → 높은 확신, 수락 우선
- Opus만 지적 → 코드 검증 후 판단
- Codex만 지적 → 회의적 검증 (false positive 비율 높음)
- Adversarial만 지적 → 참고 수준, 근거 불충분하면 기각

## 6단계 대응 프로토콜 (요약)

각 단계의 상세 절차는 `references/response-protocol.md` 참조.

### Phase 1: READ — 전체 피드백 읽기
반응하지 않고 전체를 먼저 읽는다. 항목 간 관계를 파악한다.

### Phase 2: UNDERSTAND — 요구사항 재진술
기술적 요구사항을 자신의 말로 재진술한다. 금지 표현 사용 불가.

### Phase 3: VERIFY — 코드베이스 대조 검증
관련 코드 읽기, 사용처 검색(YAGNI), 기존 테스트 확인, git blame 확인.

### Phase 4: EVALUATE — 기술적 판단
Source별 신뢰도 매트릭스에 따라 판단. Cross-model disagreement 처리.

### Phase 5: RESPOND — 수락 또는 반박
수락 시 간결하게, 반박 시 evidence 필수. 반박 철회 시 사과 없이 인정.

### Phase 6: IMPLEMENT — 항목별 구현
verdict 심각도 순서로 구현. 한 항목씩, 매번 테스트 실행, 회귀 시 즉시 중단.

## 구현 우선순위 (Verdict 연동)

1. 🔴 Critical (전원 일치) → 즉시 수정
2. 🔴 Critical (부분 일치) → 검증 후 수정
3. 🟡 Warning (전원 일치) → 수정
4. 🟡 Warning (부분 일치) → YAGNI 체크 후 판단
5. ℹ️ Info → 선택적

## Recurring Findings 연동

리뷰 항목과 `recurring-findings.json`을 대조하기 위해, Phase 1(READ)에서 각 항목을 taxonomy 카테고리로 LLM 분류한다 (Stage 5.5와 동일한 7개 카테고리: `error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`).

분류된 카테고리가 `.deep-review/recurring-findings.json`에 3회 이상 등장하면 자동 경고:

```
⚠️ Recurring Pattern Detected
카테고리: {category} ({count}회 발생)
이 항목은 반복적으로 지적되고 있습니다.
개별 수정보다 근본 원인 분석을 권장합니다:
- 해당 패턴이 프로젝트에 정의되어 있는가? (rules.yaml 확인)
- 공통 유틸리티가 필요한가?
```

## Response 리포트

대응 완료 후 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 기록.
형식은 `references/response-format.md` 참조.

## Re-review 제안

🔴 항목 수정이 1건 이상 완료되면:
"대응이 완료되었습니다. `/deep-review`를 재실행하여 변경사항을 검증하시겠습니까?"
