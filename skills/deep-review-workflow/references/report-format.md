# Review Report Format

## 파일 위치

`.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`

타임스탬프는 리뷰 완료(또는 합성 직전) 시점 기준. 같은 날 여러 번 실행해도
파일이 충돌하지 않는다. 파일명 생성 예: `date "+%Y-%m-%d-%H%M%S"` → `2026-04-17-115156-review.md`.

## 구조

# Deep Review Report — {날짜}

## Summary
- **Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Review Mode**: {Claude Opus Only | 3-way Cross-Model}
- **Issues**: {🔴 N건, 🟡 N건, ℹ️ N건}

## Sprint Contract: {SLICE-ID} (있을 때만)
| 기준 | 상태 | 근거 |
|------|------|------|
| {description} | {✅ PASS / ❌ FAIL / ⚠️ PARTIAL / ⏭️ SKIP} | {evidence} |

## Cross-Model Verification (Codex 사용 시)
| 항목 | Claude | Codex | Codex Adversarial | 확신도 |
|------|--------|-------|-------------------|--------|
| {issue} | {🔴/🟡/—} | {🔴/🟡/—} | {🔴/🟡/—} | {높음/중간/낮음} |

## Code Review
### 🔴 Critical
{구체적 이슈, 파일:라인, 수정 제안}

### 🟡 Warning
{구체적 이슈, 파일:라인, 수정 제안}

### 🟢 Passed
{통과한 관점 목록}

## Entropy Scan (--entropy 사용 시)
{중복 코드, 패턴 불일치, ad-hoc 헬퍼 목록}

## Verdict 결정 규칙

- 🔴 이슈가 1건 이상 → REQUEST_CHANGES
- 🟡만 있고 전원 일치 → REQUEST_CHANGES
- 🟡만 있고 의견 분리 → CONCERN (사람에게 에스컬레이션)
- 🟢만 → APPROVE
