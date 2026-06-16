# Review Report Format

## 파일 위치

`.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`

타임스탬프는 리뷰 완료(또는 합성 직전) 시점 기준. 같은 날 여러 번 실행해도
파일이 충돌하지 않는다. 파일명 생성 예: `date "+%Y-%m-%d-%H%M%S"` → `2026-04-17-115156-review.md`.

## 구조

# Deep Review Report — {날짜}

## Summary
- **Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Review Mode**: {Claude Opus Only | Claude=ultracode(6-lens[, verified]) | 2-way Cross-Model | 3-way Cross-Model | 4-way Cross-Model | 1-way (codex-only) | 2-way (codex-only + agy) | 1-way (agy only) | (… agent-fanout fallback / UNVERIFIED fallback)}
- **Issues**: {🔴 N건, 🟡 N건, ℹ️ N건}

## Sprint Contract: {SLICE-ID} (있을 때만)
| 기준 | 상태 | 근거 |
|------|------|------|
| {description} | {✅ PASS / ❌ FAIL / ⚠️ PARTIAL / ⏭️ SKIP} | {evidence} |

## Cross-Model Verification (Codex 사용 시)
| 항목 | Claude (Opus) | Codex Review | Codex Adversarial | agy | Agreement |
|---|---|---|---|---|---|
| (issue) | ✓ / – | ✓ / – | ✓ / – | ✓ / – | unanimous_4 / majority_3_of_4 / split_2_of_4 / solo_1_of_4 |

> For N < 4 modes, the agy column is omitted (or shown as `(not run)`).
> **XF-1**: When `claude_reviewer = ultracode-fanout`, render the "Claude (Opus)" column header as **"Claude (ultracode)"** — the cell holds the single collapsed voice (1 Anthropic vote; see [`ultracode-integration.md`](./ultracode-integration.md) §4).

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
- 🔴/🟡 판정은 `review-criteria.md`의 "severity 부여 원칙"(영향×도달 가능성, 보수적 기본값)을 따른다.

### Per-finding annotations (4-way mode)

When `Review Mode: 4-way Cross-Model`, each finding includes:
- `agreement: unanimous_4 | majority_3_of_4 | split_2_of_4 | solo_1_of_4`
- For `majority_3_of_4`: `dissenter: <reviewer-name>`, `dissenter_family: anthropic | openai | google`, `dissent_summary: <one line>`

This preserves cross-vendor-family signal even when the majority threshold (3/4) is met — a dissent from the sole Google reviewer (agy) is treated as informationally distinct from intra-family dissent.

### Degraded mode marker

When `opus_status != success AND N_actual_external ≤ 1`, the Summary records:

```
Verdict: CONCERN
Summary.degraded: opus_failed_low_confidence
```

This is deterministic (no AskUserQuestion at synthesis) — see spec §4.3.1 for the rationale.

### `opus_status` under ultracode fan-out (CONS-10)

ultracode 모드에서 "opus"는 6샤드이므로 degraded 마커가 키로 쓰는 단일 `opus_status` 를 샤드 성공 수 K 의 **disjoint quorum 밴드**(우선순위 failed→partial→success)로 collapse 한다: **`failed` iff K=0; `partial` iff 1 ≤ K < 쿼럼(=4); `success` iff K ≥ 쿼럼(=4).** degraded 마커(`opus_status != success AND N_actual_external ≤ 1`)는 이 collapse 값(K<4 이면 success 아님)으로 평가되어 결정성을 유지한다. 정의 단일 출처는 [`ultracode-integration.md`](./ultracode-integration.md) §2(B).
