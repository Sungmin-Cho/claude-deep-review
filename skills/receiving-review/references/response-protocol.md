# Response Protocol — 6단계 대응 절차

## Phase 1: READ — 전체 피드백 읽기

```
입력: deep-review 리포트 또는 외부 피드백
출력: 항목 목록 (item_id, severity, description, source)
```

### 규칙

1. 반응하지 않고 전체를 먼저 읽는다
2. 항목 간 관계를 파악한다 (A를 수정하면 B도 해결되는지)
3. 불명확한 항목이 하나라도 있으면 전체 구현을 보류한다

### 리포트 로딩

- `--respond {path}` → 지정된 리포트 로드
- `--respond` (경로 없음) → `.deep-review/reports/`에서 가장 최근 리포트 로드
- `--respond --source=pr` → GitHub PR 코멘트를 `gh api`로 수집
- 리포트가 없으면: "대응할 리뷰 리포트가 없습니다. 먼저 `/deep-review`를 실행하세요."

### PR 코멘트 수집 (`--source=pr`)

```bash
# PR 번호 자동 감지
gh pr view --json number -q .number

# top-level 리뷰 본문 수집 (REQUEST_CHANGES 본문 등)
gh api --paginate repos/{owner}/{repo}/pulls/{pr_number}/reviews

# 인라인 리뷰 코멘트 수집
gh api --paginate repos/{owner}/{repo}/pulls/{pr_number}/comments

# 일반 이슈 코멘트 수집
gh api --paginate repos/{owner}/{repo}/issues/{pr_number}/comments
```

코멘트를 항목 목록으로 파싱:
- 각 코멘트 → item_id (코멘트 ID), severity (추론), description, source: "PR comment (외부)"
- 인라인 코멘트(diff_hunk 있음)는 파일:라인 정보 포함
- 봇 코멘트(`user.type == "Bot"`)는 제외
- 인증된 사용자 자신의 답글(`user.login` == 현재 사용자)은 제외
- top-level 리뷰 본문(body가 비어있지 않은 review)은 별도 항목으로 추가

### 비-리뷰 코멘트 필터링

`/issues/{pr}/comments`에는 리뷰 피드백 외에 일반 대화(승인 메시지, 머지 조율 등)도 포함된다. 다음 기준으로 비-리뷰 코멘트를 제외한다:
- 코멘트 본문이 코드 변경에 대한 기술적 피드백인지 LLM으로 판단
- "LGTM", "Approved", "Thanks", 머지 관련 메시지 등은 제외
- 의심스러운 경우 포함 (false negative보다 false positive가 나음)

### 재실행 멱등성 (Idempotency)

`--source=pr` 재실행 시 이전에 처리한 코멘트에 중복 답글을 방지한다:
1. Response 리포트에 처리된 `comment_id` 목록을 기록
2. 재실행 시 `.deep-review/responses/` 내 기존 response 리포트를 검색
3. 이전 리포트에 기록된 `comment_id`는 수집 대상에서 제외
4. 새로 추가된 코멘트만 항목 목록에 포함

### Recurring Findings 분류

리포트에서 수집한 항목들을 taxonomy 7개 카테고리로 LLM 분류한다:
`error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`

분류된 카테고리를 `.deep-review/recurring-findings.json`과 대조하여 recurring 경고를 생성한다.

---

## Phase 2: UNDERSTAND — 요구사항 재진술

각 항목에 대해:
1. 기술적 요구사항을 자신의 말로 재진술
2. 재진술이 불가하면 명확화 요청 (구현 보류)

### 금지 표현

`references/forbidden-patterns.md` 참조. 금지 표현 사용 시 즉시 정정.

### 허용 표현

- 기술적 요구사항 재진술
- 명확화 질문
- 바로 행동 (코드로 보여주기, 말 없이)

---

## Phase 3: VERIFY — 코드베이스 대조 검증

각 항목에 대해 **반드시** 다음을 실행:

### 검증 절차

1. **관련 코드 읽기** (Read tool)
   - 지적된 파일과 주변 컨텍스트 읽기
   - 호출자/피호출자 확인

2. **사용처 검색** (Grep tool) — YAGNI check
   - `Grep({ pattern: "functionName", output_mode: "count" })`
   - 0건이면 YAGNI 위반 가능성

3. **기존 테스트 확인** (Glob + Read)
   - `Glob({ pattern: "**/*test*/**/*{filename}*" })`
   - 테스트가 있으면 해당 테스트의 커버리지 범위 확인

4. **git blame으로 원래 의도 확인** (필요 시)
   - `Bash({ command: "git blame -L {start},{end} {file}" })`
   - 코드 도입 이유와 맥락 파악

### Evidence 객체 스키마

각 항목의 검증 결과를 evidence 객체로 구조화:

```yaml
verification:
  files_read:
    - "src/foo.ts:42-60"
    - "src/bar.ts:10-25"
  grep_results: "functionName() — 3 call sites found in src/a.ts, src/b.ts, tests/c.test.ts"
  test_status: "existing test covers happy path only, no error path"
  git_context: "introduced in abc123 for backward compat (commit message: 'add legacy support')"
```

---

## Phase 4: EVALUATE — 기술적 판단

### Source별 판단 기준

| Source | 판단 기준 |
|--------|-----------|
| Human (사용자) | 이해 후 구현. 범위가 불명확할 때만 질문 |
| deep-review Opus | evidence와 대조. 코드가 지적과 다르면 반박 가능 |
| Codex review | evidence와 대조. 코드가 지적과 다르면 반박 가능 |
| Codex adversarial | 회의적 검증. false positive 가능성 항상 고려 |
| PR comment (외부) | 5-point 체크리스트 적용 (아래 참조) |

### 외부 리뷰어(PR comment) 5-Point 체크리스트

1. 리뷰어가 전체 컨텍스트를 보고 있는가? (단일 파일 vs 전체 PR)
2. 제안이 기존 아키텍처 결정과 충돌하지 않는가?
3. 제안된 변경이 실제로 사용되는 코드 경로에 영향을 주는가?
4. 제안이 프로젝트의 기술 스택/버전과 호환되는가?
5. 제안이 YAGNI를 위반하지 않는가? (grep으로 사용처 확인)

### Cross-model Disagreement 해결

| 패턴 | 확신도 | 행동 |
|------|--------|------|
| Opus + Codex 일치 | 높음 | 수락 우선. 반박하려면 강한 코드 증거 필요 |
| Opus만 지적 | 중간 | VERIFY 결과에 따라 판단 |
| Codex만 지적 | 낮음 | 회의적 검증. 코드 증거 없으면 기각 가능 |
| Adversarial만 지적 | 매우 낮음 | 참고 수준. 기각이 기본, 수락하려면 증거 필요 |

---

## Phase 5: RESPOND — 수락 또는 반박

### 수락 형식

```
✅ "Fixed. [변경 내용 한 줄 요약]"
✅ "Good catch — [구체적 이슈]. Fixed in [위치]."
✅ [코드 변경만 보여주기, 설명 없이]
```

### 반박 형식 (evidence 필수)

```
이 항목은 구현하지 않습니다.
근거: [기술적 이유]
증거: [grep 결과 / 테스트 출력 / git blame]
대안: [있으면]
```

### 반박 가능 조건

- 제안이 기존 기능을 파괴 (테스트 증거)
- 리뷰어가 전체 컨텍스트를 모름 (git blame 증거)
- YAGNI 위반 (grep 사용처 0건 증거)
- 기술적으로 부정확 (공식 문서/실행 결과 증거)
- 사용자의 아키텍처 결정과 충돌

### 반박 철회

반박했으나 재검증에서 리뷰어가 맞다고 확인된 경우:

```
✅ "확인 결과 맞습니다 — [X]를 검증했더니 [Y]. 구현합니다."
```

금지:
- 긴 사과
- 왜 처음에 반박했는지 변명

---

## Phase 6: IMPLEMENT — 항목별 구현

### 우선순위 (Verdict 연동)

1. 🔴 Critical (전원 일치) → 즉시 수정
2. 🔴 Critical (부분 일치) → 검증 후 수정
3. 🟡 Warning (전원 일치) → 수정
4. 🟡 Warning (부분 일치) → YAGNI 체크 후 판단
5. ℹ️ Info → 선택적

### 구현 규칙

1. 한 항목씩 구현한다
2. 각 항목 구현 후 테스트를 실행한다
3. 회귀가 발생하면 즉시 중단하고 원인을 파악한다
4. 모든 🔴 항목 완료 후에야 🟡 항목에 진행한다
5. 각 심각도 그룹 완료 시 커밋한다

### Response 리포트 생성

구현 완료 후 `references/response-format.md` 형식으로 리포트를 생성하여
`.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 저장한다.

### PR 코멘트 게시 (`--source=pr` 시, 구현 성공 후에만)

**중요**: PR 코멘트 게시는 구현+테스트 성공 이후에 수행한다. 구현 전에 "Fixed" 등을 게시하면, 실패 시 거짓 답글이 남는다.

각 ACCEPT 항목의 구현+테스트가 성공한 후에만 해당 코멘트에 답글:

인라인 코멘트:
```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies \
  -f body="[응답 내용]"
```

일반 코멘트:
```bash
gh api repos/{owner}/{repo}/issues/{pr_number}/comments \
  -f body="[응답 내용]"
```

REJECT 항목은 구현이 필요 없으므로 Phase 5(RESPOND) 결정 직후 바로 게시 가능.

### Re-review 제안

🔴 항목 수정이 1건 이상 완료되면:
"대응이 완료되었습니다. `/deep-review`를 재실행하여 변경사항을 검증하시겠습니까?"
