# Response Report Format

## 파일 위치

`.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`

타임스탬프는 response 리포트 생성 시점 기준.
같은 날 여러 번 `--respond`를 실행해도 파일이 충돌하지 않는다.

## 디렉토리

`.deep-review/responses/`는 `--respond` 최초 실행 시 자동 생성:

```bash
mkdir -p .deep-review/responses
```

## 구조

```markdown
# Response Report — {YYYY-MM-DD HH:mm:ss}

## Summary
- **Source Review**: {리포트 파일 경로 또는 PR URL}
- **Original Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Items**: {수락 N건, 반박 N건, 보류 N건}

## Item Responses

### ITEM-1: {제목}
- **Severity**: {🔴 Critical | 🟡 Warning | ℹ️ Info}
- **Source**: {Opus + Codex (일치) | Opus only | Codex only | Adversarial only | PR comment}
- **Decision**: {ACCEPT | REJECT | DEFER}
- **Evidence**:
  - files_read: `{파일:라인범위}`
  - grep_results: `{함수/패턴}` — {N} call sites
  - test_status: {테스트 상태 요약}
  - git_context: {필요 시 blame 결과}
- **Action**: {수정 내용 요약 + 위치} | {반박 사유} | {보류 사유}
- **Test**: {테스트 명령어} → {PASS | FAIL}

### ITEM-2: {제목}
...

## Recurring Pattern Alerts
{recurring-findings.json에서 감지된 경고가 있으면 표시}

## Re-review Recommendation
- 🔴 수정 {N}건 완료 — `/deep-review` 재실행 권장
```

## Decision 값 정의

| Decision | 의미 | evidence 필수 |
|----------|------|---------------|
| ACCEPT | 지적을 수용하고 수정함 | Yes — files_read 최소 필수 |
| REJECT | 지적을 반박함 (증거 기반) | Yes — 반박 근거 + grep/test/blame 중 1개 이상 |
| DEFER | 지금 처리하지 않음 (보류) | Yes — 보류 사유 (Human 에스컬레이션 등) |

## PR Source 리포트 (`--source=pr`)

`--source=pr`로 진입한 경우, Source Review 필드에 PR URL을 기록:

```markdown
- **Source Review**: https://github.com/{owner}/{repo}/pull/{number}
```

각 ITEM의 Source 필드:
```markdown
- **Source**: PR comment (@{author}, #{comment_id})
```
