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
- **Source**: {Human | Opus + Codex (일치) | Opus only | Codex only | Adversarial only | PR comment}
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

## PR 코멘트 게시 실패 추적 (`--source=pr` 시)

PR 코멘트 게시(`gh api .../replies`)는 rate limit / 네트워크 오류 / 권한 문제로 실패할 수 있다.
실패한 posting은 리포트 말미에 기록하여 다음 `--respond --source=pr` 실행 시 재시도한다.

```markdown
## Failed Postings

| comment_id | item_id | attempted_at | error |
|-----------|---------|--------------|-------|
| 123456 | ITEM-3 | 2026-04-17T12:03:11Z | 403 resource not accessible |
| 123457 | ITEM-5 | 2026-04-17T12:03:12Z | rate limit (retry-after: 60) |
```

**재시도 규칙** (멱등성 유지):
- 기존 멱등성 로직(`comment_id` 중복 제거)은 **게시 성공한 것만** 제외 대상으로 삼는다.
- `Failed Postings` 목록의 comment_id는 다음 실행 시 반드시 재시도 대상에 포함.
- 3회 연속 실패 시 사용자 에스컬레이션: "comment #{id} 게시가 3회 실패했습니다. 수동 확인 필요."

## PR Source 리포트 (`--source=pr`)

`--source=pr`로 진입한 경우, Source Review 필드에 PR URL을 기록:

```markdown
- **Source Review**: https://github.com/{owner}/{repo}/pull/{number}
```

각 ITEM의 Source 필드:
```markdown
- **Source**: PR comment (@{author}, #{comment_id})
```
