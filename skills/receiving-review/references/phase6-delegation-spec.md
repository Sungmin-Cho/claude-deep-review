# Phase 6 Subagent Delegation — Design Spec

- **Date**: 2026-04-24
- **Status**: Draft (브레인스토밍 합의 반영)
- **Scope**: `/deep-review --respond` Phase 6 구현 단계를 전용 서브에이전트(Sonnet)로 위임하여 main 세션 context 소비를 감축
- **Non-goals**: Phase 1~5(READ/UNDERSTAND/VERIFY/EVALUATE/RESPOND) 변경, `/deep-review` 리뷰 모드 변경, `codex:rescue` 경로 변경, PR comment posting 로직 변경

---

## 1. 문제 정의

`/deep-review --respond`는 현재 main 세션에서 `receiving-review` 스킬의 Phase 1~6을 전부 실행한다. Phase 6(IMPLEMENT)는 수락된 리뷰 항목을 실제로 코드에 반영하는 단계로, 파일 Read/Edit + 테스트 Bash 실행이 항목 수만큼 반복된다. 이로 인해 main 세션의 context 창이 빠르게 소모되며, 사용자가 한 세션에서 다른 작업을 이어가기 어렵다.

Phase 1~5(판단 단계)는 Opus의 정교한 평가가 필요하므로 main에 남겨야 하지만, Phase 6(실행 단계)는 이미 판단이 확정된 항목의 기계적 적용이다. 이 단계를 전용 서브에이전트(model=sonnet)에 위임하면 main context는 "서브에이전트의 구조화 결과 요약 + 테스트 로그 tail"만 보유하게 되어 context 소비가 크게 줄어든다.

---

## 2. 결정 요약

브레인스토밍 단계에서 확정한 설계 선택:

| # | 결정 사항 | 선택 |
|---|----------|------|
| 1 | 호출 세분성 | 심각도 그룹별 배치 (🔴 → 🟡 → ℹ️, 최대 3회 dispatch) |
| 2 | 서브에이전트 정의 | 전용 플러그인 에이전트 `agents/phase6-implementer.md` (`model: sonnet`) |
| 3 | 리포트 작성 | 서브에이전트는 구조화 결과만 반환, main이 `response.md` 작성 |
| 4 | Main 재검증 | 서브에이전트가 테스트 로그를 `.deep-review/tmp/phase6-{severity}.log`에 저장, main이 tail Read |
| 5A | Dispatch 실패 | Main으로 graceful degradation (response.md에 `execution_path: main_fallback` 기록) |
| 5B | 부분 실패 | 해당 그룹에서 중단, 다음 그룹 진행 안 함 |

---

## 3. 아키텍처

### 3.1 현재 흐름

```
/deep-review --respond
  ↓
  [main 세션] receiving-review 스킬 Phase 1~6 전부 실행
  - Phase 1~5: 리포트 읽기·검증·판단
  - Phase 6: 수락 항목을 main이 직접 구현 (Edit + Bash 테스트 반복)
  ↓
  response.md 작성
```

### 3.2 새 흐름

```
/deep-review --respond
  ↓
  [main] 자동 복원 (mutation-protocol) + .deep-review/tmp/ 정리
  ↓
  [main] receiving-review 스킬 Phase 1~5 실행
  - ACCEPT/REJECT/DEFER 판단까지 main
  - 각 ACCEPT 항목에 "구현 가이드"를 simple sketch로 남김
  ↓
  [Phase 6] Severity-group 배치 dispatch
    ├─ 🔴 Critical 그룹 → Agent(deep-review:phase6-implementer)
    │   ├─ 서브에이전트: 항목별 Edit + 테스트 실행, 로그 .deep-review/tmp/phase6-critical.log에 저장
    │   └─ 완료 후 labeled-markdown 결과 반환
    ├─ [main 재검증] git diff --stat + log tail Read
    │   ├─ 전원 PASS → 그룹 커밋 → 🟡 그룹 dispatch
    │   └─ 부분 FAIL → response.md에 기록, 🟡/ℹ️ skip
    ├─ 🟡 그룹 → (동일 패턴)
    └─ ℹ️ 그룹 → (동일 패턴)
  ↓
  [main] response.md 작성 (검증된 사실만)
  ↓
  [main] --source=pr 시 gh api로 코멘트 게시
```

### 3.3 책임 분리

서브에이전트가 하는 것:
- 해당 그룹의 항목별 Edit (파일 수정)
- 항목별 테스트 실행 (Bash)
- 테스트 로그를 지정된 log_path에 저장
- 구조화 결과 반환

Main이 하는 것 (서브에이전트에 절대 위임 안 함):
- 서브에이전트 결과 검증 (`git diff --stat`, 로그 tail Read)
- `.deep-review/responses/*-response.md` 작성
- Git 커밋 (심각도 그룹 완료 시)
- PR 코멘트 게시 (`--source=pr` 시, `gh api`)
- Dispatch 실패 시 fallback 결정 및 실행
- `.deep-review/tmp/` 정리

### 3.4 Context 절감 원리

Phase 6에서 발생하던 세 종류의 누적이 서브에이전트 context로 이동한다:

1. 대상 파일의 **full Read** (리뷰 항목이 지목한 파일 + 연관 호출부·테스트)
2. **Edit 전후 diff**의 세션 내 누적 (항목이 많을수록 큼)
3. 테스트 **stdout/stderr 로그**의 세션 내 누적 (실패 시 특히 큼)

Main은 (a) 서브에이전트의 구조화 결과 요약(수 KB)과 (b) tmp 로그의 tail만 Read하므로, 위 세 누적분이 main 세션에서 제거된다. 단, **리뷰 항목 메타데이터**(`implementation_guide` 등)는 Phase 5에서 이미 main에 적재된 상태이며 Phase 6 dispatch에도 그대로 전달되므로 이 부분은 절감 대상이 아니다. 즉 "항목 수 N에 비례"하던 모든 비용이 사라지는 것이 아니라, **파일/diff/log 누적분**이 사라지는 것이다.

---

## 4. 컴포넌트 및 파일 변경

### 4.1 신규 파일 (1개)

#### `agents/phase6-implementer.md`

**Frontmatter**:
```yaml
---
name: phase6-implementer
model: sonnet
color: blue
description: |
  /deep-review --respond Phase 6의 구현 실행자. Main이 확정한 수락 항목을
  심각도 그룹 단위로 받아 한 항목씩 Edit + 테스트하고 구조화 결과를 반환한다.
whenToUse: |
  /deep-review --respond Phase 6에서 자동 dispatch된다. 직접 호출하지 않는다.
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---
```

**제외된 tools 근거**:
- `Agent`: 재귀 dispatch 방지
- `Skill`: Phase 6는 main이 이미 완료한 판단의 **실행 단계**이므로 스킬 로드 불필요 (I6)
- `ExitPlanMode`: 해당 없음
- `NotebookEdit`: 해당 없음
- `WebFetch`/`WebSearch`: 이 단계에 불필요, 외부 네트워크 축소

**시스템 프롬프트 구성 (마크다운 본문)**:
- 정체성: "Phase 6 구현 실행자, 판단자가 아님"
- 입력 계약 (§5.1)
- 구현 원칙:
  1. 입력 `accepted_items`을 item_id 순서로 하나씩 처리
  2. 각 항목: Edit → 테스트 실행 → 결과를 `log_path`에 append. 로그 포맷(W9):
     - 항목 시작: `===== ITEM-{id} START {ISO8601-timestamp} =====`
     - 항목 끝: `===== ITEM-{id} END exit={code} =====`
     - stdout/stderr 합성: Main 이 전달한 절대경로를 outer `'...'` single-quote 안에 **literal 치환**하여 `tee -a` 한 번만 append. 정확한 계약(공백/특수문자 경로 escape, `printf '%q'` 금지, `$log_path` 변수 참조 금지)은 `agents/phase6-implementer.md:58-71` 를 단일 소스로 한다 — C2 교정 전의 `bash -c 'cmd 2>&1 \| tee -a "$log_path"'` 패턴은 single-quote 내부에서 `$log_path` 가 빈 문자열로 확장되어 로그 파일 미생성 → group error 로 귀결되므로 **금지**.
     - 백그라운드 실행 금지 — 순서·라인 번호 일관성 보장. (main 재검증은 라인 번호가 아닌 `ITEM-{id}` 문자열 검색으로 수행 가능)
  3. `test_exit_code != 0`이면 해당 그룹 즉시 중단, 이후 항목은 `status: skipped_due_to_halt`
  4. `max_files_per_item` 초과 시 해당 항목 `status: error`로 표시, 다음 항목 진행 여부는 halt 규칙 적용.
     **기준**: "서브에이전트가 실제로 Edit한 **고유 파일** 수"(같은 파일 여러 번 수정은 1회로 카운트). `file_refs`가 10개 이상이면 main이 Phase 5에서 해당 항목을 DEFER로 분류하여 Phase 6 dispatch 대상에서 제외 가능. 기본값 10은 하드코딩이며, 향후 릴리스에서 config.yaml로 조정 가능하도록 열어둔다.
- 테스트 명령 탐지 절차 (첫 항목 시작 전, 우선순위) — **주 프로젝트 러너 우선, hooks smoke 는 보조**. `agents/phase6-implementer.md:46-52` 가 normative source; 본 목록은 그 복사본 (W8 교정: v1.3.3 에서 순서가 반전돼 있던 drift 해소):
  1. **escape hatch (최우선)**: `.deep-review/config.yaml`의 `test_command` 필드 존재 시 그대로 사용 (사용자 명시 지정).
  2. `package.json` scripts.test → `npm test` 또는 `pnpm test` (lockfile 로 구분).
  3. `pyproject.toml [tool.pytest.*]` → `pytest`.
  4. `Cargo.toml` → `cargo test`.
  5. `Makefile` test target → `make test`.
  6. 주 러너 모두 부재 시에만 fallback: `hooks/scripts/test/test-*.sh` 존재하면 전체 실행. 주 러너가 **있으면 hooks 는 실행하지 않음** (smoke test 가 실제 스위트를 숨기지 않도록).
  7. 그 외: `execution_status: error`, `error_reason: "no test command detected"`로 즉시 반환. 사용자는 (1)의 escape hatch로 수동 지정 가능.
- 출력 계약 (§5.2)
- Prompt Injection 면역 조항 (code-reviewer.md의 조항을 참고)

### 4.2 수정 파일 (4개)

| 파일 | 변경 요지 |
|------|----------|
| `commands/deep-review.md` | (a) `--respond` Steps 2("receiving-review 스킬 실행")를 개정: Phase 1~5는 main, Phase 6는 서브에이전트 dispatch. 0단계에 `.deep-review/tmp/phase6-*.log` 정리 한 줄 추가. (b) init 모드 Step 8의 `.gitignore` 권장 블록에 `.deep-review/tmp/` 라인 추가 (사용자 프로젝트용). |
| `skills/receiving-review/SKILL.md` | Phase 6 개요를 "심각도 그룹별 phase6-implementer dispatch"로 갱신. 기존 구현 원칙은 서브에이전트 정의로 이동했다고 주석. |
| `skills/receiving-review/references/response-protocol.md` | **Phase 6 절(249~295행) 중 "구현 규칙" 서브섹션만 재작성** — 그룹 dispatch 절차, main 재검증 절차, 부분 실패 처리, dispatch 실패 fallback. **유지**되는 서브섹션: 우선순위(§5단계 confidence 기반), Response 리포트 생성, Re-review 제안. **조건 수정**되는 서브섹션: PR 코멘트 게시("서브에이전트가 PASS 반환 + main 검증 통과한 항목에 대해서만"). (W6) |
| `skills/receiving-review/references/response-format.md` | Summary에 `execution_path: subagent \| main_fallback \| mixed \| n/a` 필드 추가. 각 Item의 Evidence에 `test_log: .deep-review/tmp/phase6-{severity}.log` 필드 추가 (ephemeral 주석). |
| `CHANGELOG.md` / `CHANGELOG.ko.md` | v1.3.3 후보 항목 추가 (§9 초안 반영). (I2) |

**이 플러그인 repo 자체의 `.gitignore`는 변경하지 않는다** — 본 repo는 `.deep-review/` 전체를 blanket ignore하고 있어 `.deep-review/tmp/`도 이미 커버됨. 추가 라인은 사용자 프로젝트 시나리오에만 해당되므로 위 (b)에 포함.

### 4.3 검토 후 변경될 수도 있는 파일 (1개)

- `README.md` / `README.ko.md`: Phase 6 세부를 설명하는 섹션이 있다면 갱신. 구현 시 grep 확인.

---

## 5. 데이터 플로우 — 입력/출력 계약

### 5.1 Main → Subagent: 입력 프롬프트

Main이 Agent tool을 호출할 때 **2단계 네임스페이스 fallback**을 적용한다 (Skill 로드 패턴 `commands/deep-review.md:478-485`과 symmetry):

1. 1차: `Agent({ subagent_type: "deep-review:phase6-implementer", prompt: <below> })`
2. 1차가 "subagent_type not found" 또는 유사 에러 반환 시 2차: `Agent({ subagent_type: "phase6-implementer", prompt: <below> })`
3. 2차도 실패하거나 permission refusal 등 dispatch 자체 실패 시 → §6.2 main fallback 경로 진입

입력 프롬프트:

```markdown
# Phase 6 Group Implementation Request

## Group
- severity: critical | warning | info
- items_total: 3

## Source Review
- path: .deep-review/reports/2026-04-24-120000-review.md
- verdict: REQUEST_CHANGES

## Constraints
- log_path: /abs/path/to/.deep-review/tmp/phase6-critical.log
- halt_on_regression: true
- max_files_per_item: 10

## Accepted Items

**정렬 규칙**: main이 Accepted Items를 `receiving-review` 5단계 우선순위(🔴 전원일치 → 🔴 부분일치 → 🟡 전원일치 → 🟡 부분일치 → ℹ️) 순으로 정렬하여 전달. 서브에이전트는 전달받은 순서 그대로 `item_id` 순으로 처리한다 (§3.2 의 "item_id 순서"는 정렬 후 부여된 식별자 기준). 정렬 근거를 각 항목의 `confidence` 필드로 전달한다.

### ITEM-3
- title: Null pointer risk in login handler
- severity: critical
- confidence: agreed           # agreed | partial — 전원일치/부분일치 (W4)
- source: Opus + Codex (일치)
- file_refs:
  - src/auth/login.ts:45-60
- issue_summary: user.profile.email 접근 전 null 체크 부재
- implementation_guide:          # 필수 6개 필드 (C6 + iter-3 companion files)
    target_location: src/auth/login.ts:52   # `file:line-range`, comma/newline 분리로 복수 가능
    modifiable_paths:              # iter-3 추가 — companion 파일 (test/fixture/helper). acceptance 충족용. Main이 allowlist에 union으로 포함.
      - tests/auth/login.test.ts
    intent: 로그인 핸들러에서 user.profile이 undefined여도 500 에러 없이 AuthError로 반환
    change_shape: optional chaining + null 가드 early-return (기존 함수 시그니처 유지)
    non_goals:                     # 건드리지 말아야 할 것 (회귀 방지 힌트)
      - 기존 에러 코드(401/403) 변경 금지
      - user.profile 타입 정의 수정 금지
    acceptance:                    # 판정 기준 (테스트/assert)
      - login.test.ts의 기존 'handles valid profile' 케이스가 여전히 PASS
      - 신규 케이스 'handles null profile': null profile 입력 시 401 AuthError 반환

### ITEM-5
...

## Protocol
See system prompt for authoritative protocol (agents/phase6-implementer.md). Prompt 블록은 계약 참조용이며 프로토콜의 본문은 에이전트 정의에만 존재한다 (drift 방지, I1).
```

**입력 조립 책임**: Main의 Phase 5 종료 직후 Phase 6 dispatch 직전 단계. `implementation_guide`는 main의 Phase 4/5 평가 과정에서 축적된 결정의 요약.

### 5.2 Subagent → Main: 출력 계약

서브에이전트는 반환 메시지에 다음 구조의 블록을 반드시 포함:

```markdown
## Group Result
- severity: critical
- execution_status: completed | halted_on_regression | error
- items_total: 3              # invariant: total == passed + failed + skipped
- items_passed: 1
- items_failed: 1
- items_skipped: 1            # halt_on_regression 으로 스킵된 항목 수
- halt_item: ITEM-5           # halted_on_regression 시에만

## Items

### ITEM-3
- status: passed
- files_changed:
  - src/auth/login.ts (+5 -2)
- test_command: npm test -- --filter=login
- test_exit_code: 0
- log_range: 1-47
- action_summary: "login.ts:52에 optional chaining 추가, user.profile가 undefined일 때 AuthError 던지도록 수정"

### ITEM-5
- status: failed
- files_changed:
  - src/auth/login.ts (+3 -1)
- test_command: npm test -- --filter=login
- test_exit_code: 1
- log_range: 48-120
- action_summary: "재시도 로직 추가 시도"
- failure_note: "login.test.ts:89 — expected 401, got 500. 원인은 기존 에러 핸들러가 500으로 덮어씀."

### ITEM-7
- status: skipped_due_to_halt

## Notes (optional)
tech-debt로 기록할 새 리뷰 항목 후보만 bullet 형식으로. **Soft cap: ~500자**. context 절감 원칙에 위배되지 않도록 장문 감상·회고 작성 금지. (I3)
```

### 5.3 형식 선택 근거

JSON 대신 labeled markdown을 선택한 이유:
- JSON은 LLM의 따옴표·이스케이프 실수에 취약
- Labeled markdown은 Claude에게 생성·파싱 모두 친화적
- tmp 로그와 함께 디스크에 남겨도 사람 친화적
- 파싱을 패턴 매칭이 아니라 LLM 독해에 맡길 수 있어 오류 내성 확보

### 5.4 Main의 후처리 절차 (fail-closed + content-aware delta + allowlist)

각 그룹 dispatch 완료 시 (정식 구현은 `commands/deep-review.md` Step 2.5 단일 소스, 실행 검증은 `hooks/scripts/test/test-phase6-protocol-e2e.sh`).

**Spec ↔ commands 매핑** (이 §5.4의 11개 sub-item은 commands Step 2.5의 8-step 중 3~7번 step + 후처리(§3)에 분산 배치됨):

| Spec §5.4 | Commands | 주제 |
|---|---|---|
| §5.4.1 | Step 3 | Pre-dispatch snapshot (allowlist + baseline) |
| §5.4.2 | Step 4 + Step 5 preamble | Dispatch + 결과 파싱 |
| §5.4.3 | Step 5 | Content-aware DELTA |
| §5.4.4 | Step 5 | Path-set violation |
| §5.4.5 | Step 5 | Claim 정규화 |
| §5.4.6 | Step 5 | REVERTED symmetric check |
| §5.4.7 | Step 5 | 실패 항목 log tail |
| §5.4.8 | Step 6 | 전원 PASS 그룹 커밋 |
| §5.4.9 | Step 7 | Dirty recovery |
| §5.4.10 | commands §3 "Response 리포트 저장" | response.md |
| §5.4.11 | `--source=pr` 경로 | PR 코멘트 |

1. **Pre-dispatch snapshot** (→ commands Step 3):
   - `ALLOWED` = `target_location` ∪ `modifiable_paths` (comma/newline split + line-range strip).
   - Path-set baseline (violation 검출용): `PRE_MODIFIED`, `PRE_UNTRACKED`, `PRE_STATUS`.
     - `PRE_MODIFIED`는 `git diff --name-status -M` (unstaged) **와** `git diff --cached --name-status -M` (staged) 의 **합집합**을 awk로 후처리하여 rename(R)/copy(C) 라인의 new path만 채택 (E7). `git mv`는 자동 staged로 분류되므로 `--cached`를 함께 읽지 않으면 subagent가 Bash tool로 연 staged rename을 baseline이 놓치고 `NEW_PATHS`/`REVERTED` 계산이 false-negative가 된다 (v1.3.4 review C1 교정).
     - Binary 파일도 `--name-status`가 path 단위로 나열하고, 아래의 `git hash-object`가 content hash를 반환하므로 DELTA 계산이 text와 동일하게 작동 (E8). 별도 분기 없음.
   - Content-aware baseline (`ALLOWED` 각 파일): `PRE_HASH_FILE` (`<path>\t<hash>` TSV) 에 기록 + per-file content를 `.deep-review/tmp/phase6-{severity}-baseline/<path>`에 복사. Dirty recovery의 restore source로 사용 (E5).
   - **Pre-tracking state** (C5 교정, E11): `PRE_TRACKED_FILE` 에 `<path>\t<true|false>` 로 ALLOWED 각 경로의 "Phase 6 진입 시점 git tracked 여부" 기록. Worktree 존재 ≠ tracked 이므로 (예: 사용자가 tracked 파일을 `rm` 한 unstaged-delete WIP) 명시적으로 구분해 recovery 가 원본 상태를 재구성.
   - **Pre-staged state** (W7 교정): `PRE_STAGED_FILE` 에 ALLOWED 각 경로의 "Phase 6 진입 전부터 staged hunk 존재 여부" (`<path>\t<true|false>`). Recovery 시 사용자 partial-hunk staging 영향 경고용.
   - **Pre-existing outside content snapshot** (C3 교정, E9): `PRE_MODIFIED ∪ PRE_UNTRACKED` 중 ALLOWED 에 없는 경로의 `PRE_OUTSIDE_HASH_FILE` 도 저장. path-membership 만으로는 "pre-existing dirty 상태의 non-ALLOWED 경로를 subagent 가 추가 수정하는" 케이스를 감지할 수 없으므로 content hash 로 보강한다.
   - **Bash 3.2 호환** (C4 교정): 위 네 종 snapshot 모두 `declare -A` (associative array, bash 4+) 대신 TSV temp file 사용 — macOS 기본 `/bin/bash` 3.2 에서도 작동.
2. **Agent dispatch + 결과 파싱** (→ commands Step 4 + Step 5 preamble). 반환 `Group Result`가 `halted_on_regression` | `error` | 파싱 불가 → §5.4.9 Dirty recovery로 분기.
3. **Content-aware DELTA 산출** (→ commands Step 5; E2 — dirty-tree에서 path-membership 비교는 false-negative):
   - `DELTA = { f ∈ ALLOWED | git hash-object f (POST) != PRE_HASH[f] }`.
4. **Path-set violation check** (→ commands Step 5; trust boundary):
   - `NEW_PATHS = (POST_MODIFIED ∪ POST_UNTRACKED) - (PRE_MODIFIED ∪ PRE_UNTRACKED)`.
   - `VIOLATIONS = NEW_PATHS - ALLOWED`. 비어있지 않으면 `execution_status=error`.
   - **Pre-existing outside content check** (C3, E9): 각 `PRE_OUTSIDE_HASH[path]` 에 대해 POST hash 를 비교. 변경 시 `OUTSIDE_VIOLATIONS` 에 추가하고 `execution_status=error`, `error_reason="pre-existing outside paths mutated by subagent"`. path-set 비교만으로는 놓치는 allowlist bypass 를 막는다.
5. **Claim 정규화 + 비교** (→ commands Step 5; E1 — subagent `files_changed: - path (+A -B)`):
   - `CLAIM = files_changed | sed -E 's/ \(\+[0-9]+ -[0-9]+\)$//'`.
   - `CLAIM != DELTA` → error.
6. **REVERTED symmetric check** (→ commands Step 5):
   - `REVERTED = (PRE_MODIFIED ∪ PRE_UNTRACKED) - (POST_MODIFIED ∪ POST_UNTRACKED)`. 비어있지 않으면 error (서브에이전트 revert).
7. **실패 항목 log tail** (→ commands Step 5): `Read(log_path)`로 `ITEM-{id}` 구분자 tail. `log_path` 부재 → `log_unavailable=true`, error.
8. **전원 PASS 그룹만 커밋 — pathspec-limited** (→ commands Step 6):
   - 신규 untracked(`PRE_HASH[f] == "absent"`) → `git add -- <path>` (NUL-safe 루프, not `xargs`).
   - Pre-staged 경고는 `EXCL=(":(exclude)$f" for f)` 배열 (E3 fix) 로 검출.
   - Same-file pre-staged hunk 검출 → AskUserQuestion으로 사용자 확인.
   - `git commit --only -m "fix(review-response): ..." -- "${CHANGED_FILES[@]}"` — **`-m`은 `--` 앞**.
   - **금지**: `git add -A`, `git commit` (no pathspec), `git commit --only -- <paths> -m <msg>`.
9. **Dirty recovery — per-file content baseline + index 동기 복원** (→ commands Step 7; E5, W4, C5, W7):
   - (2) 선택 시: **`git restore --source=HEAD` 사용 금지** (user WIP 파괴). §5.4.1에서 저장한 `.deep-review/tmp/phase6-{severity}-baseline/<path>`에서 `cp`로 worktree 복원.
   - **Index 동기 복원 (W4) + Tracking state 분기 (C5)**: worktree 복원 전에 `PRE_TRACKED_FILE` 을 iterate. `pre_tracked=true` 면 `git restore --staged` (HEAD 로 index 리셋), `pre_tracked=false` 면 `git rm --cached --ignore-unmatch` (untracked 복원). 이렇게 해야 "tracked-but-deleted WIP" 가 `git rm --cached` 경로로 들어가 staged delete 로 변질되는 v1.3.4 C5 edge case 를 방지 (E11).
   - **Baseline 존재 여부로 worktree 상태 결정**: baseline 이 있으면 `cp` 로 content 복원. 없으면 PRE 에 worktree 파일이 없었다는 뜻 (tracked-deleted 또는 untracked-absent) — 현재 worktree 에 파일이 있으면 `rm -f` 로 제거 → 원본 "파일 없음" 상태 재구성.
   - **Partial-hunk staging 경고 (W7)**: `PRE_STAGED_FILE` 에서 had_staged=true 경로 목록을 출력 — `git restore --staged` 가 사용자의 `git add -p` hunk-selection state 까지 un-stage 하므로 response.md 에 기록 + 사용자에게 재-stage 권고. 완전한 staged-blob 단위 복원은 v1.3.5 후보.
   - 파일 단위 복원은 binary/text 무관하게 동작.
10. **Response 리포트** (→ commands §3 "Response 리포트 저장"): 모든 그룹 완료 후 `response-format.md` 형식으로 response.md 작성.
11. **PR 코멘트 게시** (→ `--source=pr` 경로): **§5.4.3~§5.4.7 검증 통과한 PASS 항목만** `gh api` 로 코멘트 게시.

**`execution_path` 값 결정표** (W5):

| 시나리오 | execution_path |
|---------|---------------|
| 전 그룹 subagent 성공 | `subagent` |
| 첫 dispatch 시도부터 실패 → 모든 그룹 main이 직접 처리 | `main_fallback` |
| 일부 그룹 subagent + 일부 그룹 main fallback (중간 dispatch 실패) | `mixed` |
| ACCEPT 항목 0건 — Phase 6 전체 skip | `n/a` |

---

## 6. 에러 및 엣지 케이스

### 6.1 0개 항목

- 전체 ACCEPT 항목 0건 → Phase 6 전체 skip, response.md `execution_path: n/a (no accepted items)`.
- 특정 severity만 0건 (예: 🔴 0건, 🟡 2건) → 해당 그룹 dispatch 건너뛰기, 다음 그룹 진행. Summary에 `critical: 0/0, warning: 2/2, info: skipped` 식으로 기록.

### 6.2 Dispatch 실패 (5A = main fallback)

**감지 조건**:
- Agent tool 호출이 에러 반환 (subagent_type not found, permission refusal 등)
- 반환 메시지에 `Group Result` 블록이 없거나 파싱 불가

**처리 절차**:
1. Main에 경고 출력: `⚠ phase6-implementer dispatch 실패 ({reason}). 세션 내 fallback 실행으로 전환합니다.`
2. **Context 여력 안전장치** (중간 그룹에서 실패한 경우만): 남은 미처리 항목(현재 그룹 + 후속 그룹)이 **5건 이상**이면 AskUserQuestion:
   > "서브에이전트 dispatch 실패로 나머지 {N}건을 main 세션에서 직접 처리해야 합니다. main context가 부족할 수 있습니다. 어떻게 할까요?
   > (1) 이번 실행은 여기까지 — 남은 항목을 DEFER로 기록하고 종료 (다음 세션에서 재시도)
   > (2) 계속 진행 (context 소진 위험 감수)"
   - (1) 선택 시: 남은 항목을 `decision: DEFER`, `defer_reason: "dispatch failure, main context conservation"`로 기록하고 response.md 작성 후 종료.
   - (2) 선택 시: 3단계로 진행.
3. Main이 해당 그룹 항목을 직접 구현 (기존 Phase 6 로직 = receiving-review 원칙대로 한 항목씩 Edit + 테스트).
4. response.md Summary에 `execution_path: main_fallback (dispatch failed at {severity} group: {reason})` 기록.
5. 다음 그룹도 **재시도 없이 fallback 유지** — 같은 환경에서 반복 실패 가능성 높음.

**환경변수 기반 강제 fallback** (I4 테스트용):
- `DEEP_REVIEW_FORCE_FALLBACK=1`이 환경변수에 있으면 dispatch 시도 자체를 건너뛰고 즉시 fallback 경로로 진입.
- T5 dogfood 시나리오가 이 변수를 사용해 레포 파일을 오염시키지 않고 fallback 경로를 재현할 수 있다.

### 6.3 부분 실패 (5B = 중단)

**감지 조건**:
- `execution_status: halted_on_regression` 또는 `error`
- 혹은 `items_failed > 0`

**처리 절차**:
1. 다음 심각도 그룹 dispatch 안 함.
2. 실패 항목은 response.md에 `test_status: FAIL`, `failure_note: {서브에이전트 반환 사유}` 기록.
3. 스킵된 항목(halt 이후 항목 + 후속 그룹 전체)은 `decision: DEFER`, `defer_reason: "halted due to regression at ITEM-X ({severity} group)"` 기록.
4. **부분 실패 그룹은 커밋하지 않음** (§5.4 step 5와 일관). passed 항목의 파일 수정은 워킹 트리에 orphan 상태로 남는다.
5. response.md에 경고 명시:
   > "ITEM-{id} 등 passed 항목의 파일 수정이 워킹 트리에 커밋되지 않은 채 남아있습니다. `git diff`로 검토 후 수동 커밋 또는 `git restore`로 복구하세요."
6. Summary 말미에 명시적 안내:
   > "{severity} 그룹에서 회귀 발생, 이후 그룹 스킵됨. `git diff`로 현재 상태를 확인하고 수동 복구 후 `/deep-review --respond` 재실행을 권장."

### 6.4 Git 상태 오염

- Main이 그룹 dispatch 직전/직후 `git status`로 상태 캡처, 비교.
- 부분 실패 시 **자동 롤백 하지 않음** — **사용자 검토 우선 원칙**. 자동 롤백은 (a) 사용자가 워킹 트리의 passed 항목 수정을 그대로 커밋하려 할 수도 있고, (b) 복구 로직이 잘못되면 원본까지 훼손할 수 있어 위험하다. 복구는 `git diff` + `git restore` 같은 명시적 도구로 사용자가 수행.
- 실패 그룹의 커밋은 건너뛴다 (모든 항목 PASS한 그룹만 커밋, §5.4 step 5·§6.3 step 4와 일관).
- 참고: `hooks/scripts/mutation-protocol.sh`의 `restore_mutation`은 플러그인이 스테이징한 intent-to-add 엔트리 복원 전용이며 파일 내용 롤백과 범위가 다르므로 Phase 6 부분 실패 복구에 재사용하지 않는다. (W7)

### 6.5 PR 코멘트 게시 실패 (`--source=pr`)

- 기존 `response-format.md`의 `Failed Postings` 테이블 로직을 그대로 유지.
- 게시는 main 책임이므로 서브에이전트 도입과 무관.
- 단, 서브에이전트가 PASS로 반환하고 main 검증도 통과한 항목에 대해서만 게시 시도 (기존 "구현+테스트 성공 이후에만" 원칙의 연장).

### 6.6 테스트 명령 탐지 실패

서브에이전트가 test 명령을 찾지 못한 경우:
- `execution_status: error`, `error_reason: "no test command detected"` 반환.
- Main은 이를 6.2와 동일 fallback 경로로 처리. Main도 같은 문제를 만나면 사용자 상호작용으로 해결 가능.

### 6.7 로그 파일 미생성

서브에이전트가 `log_path`에 아무것도 쓰지 않고 반환 (에러 경로):
- Main의 `Read(log_path)` 실패.
- Main은 로그 대신 반환 메시지의 `failure_note`만 기록, response.md에 `log_unavailable: true` 명시.

### 6.8 동시 실행 방지

범위 밖. 현재 프로젝트는 특별한 lock을 두지 않고, 이번 설계에서도 추가하지 않는다.

### 6.9 `.deep-review/tmp/` 정리 — 1단계 회전

**원칙**: 직전 세션의 로그는 사용자가 검토할 때까지 보존, 2회 이전 세션 로그는 자동 삭제. 부분 실패 직후 `/deep-review --respond`를 한 번 더 실행해도 디버깅 증거가 소실되지 않도록 회전 방식을 사용한다.

- **성공/실패 완료 시**: tmp 파일 그대로 유지 (현재 세션 결과).
- **다음 `--respond` 시작 시** (`commands/deep-review.md`의 "0. 자동 복원" 바로 다음):
  ```bash
  # 이전 세션 로그를 prev/로 이동하여 한 세션 회전 유지
  if compgen -G ".deep-review/tmp/phase6-*.log" > /dev/null 2>&1; then
    mkdir -p .deep-review/tmp/prev
    rm -f .deep-review/tmp/prev/phase6-*.log 2>/dev/null || true
    mv .deep-review/tmp/phase6-*.log .deep-review/tmp/prev/ 2>/dev/null || true
  fi
  ```
- 결과: 현재 세션의 로그는 `.deep-review/tmp/phase6-{severity}.log`, 직전 세션의 로그는 `.deep-review/tmp/prev/phase6-{severity}.log`에 보존. 2회 이전은 자동 소멸.
- `.deep-review/tmp/` 전체를 blanket 삭제하지 않는 이유는 사용자가 halt 직후 `/deep-review --respond`를 실수로 또 실행해도 직전 증거를 잃지 않기 위함.

---

## 7. 테스트 및 검증 전략

### 7.1 구조적 검증 (자동)

**`hooks/scripts/test/test-phase6-subagent.sh`** 신설. 검증 항목:
1. `agents/phase6-implementer.md` 존재, YAML frontmatter 파싱 가능
2. frontmatter에 `name`, `model: sonnet`, `tools` 필드 존재
3. `tools` 목록에 `Agent`, `ExitPlanMode`, `NotebookEdit` 불포함 (화이트리스트 원칙)
4. `commands/deep-review.md`에 "phase6-implementer" 참조 문자열 존재
5. `commands/deep-review.md`의 init 모드 `.gitignore` 권장 블록에 `.deep-review/tmp/` 문자열 존재
6. `skills/receiving-review/references/response-format.md`에 `execution_path` 필드 언급 존재
7. `commands/deep-review.md`의 `--respond` Steps에 "subagent dispatch" 문구 또는 동급 섹션 제목 존재 (W8)
8. `skills/receiving-review/references/response-protocol.md` Phase 6 섹션에 "group dispatch" 키워드 존재 (W8)
9. `response-format.md`에 `execution_path`의 4개 값(`subagent`, `main_fallback`, `mixed`, `n/a`)이 모두 문서화 (W8)

스크립트 크기 목표: 40~60줄. exit 0 = PASS.

### 7.2 Dogfood 시나리오 (수동, 필수)

| # | 시나리오 | 기대 경로 | 검증 포인트 |
|---|---------|-----------|------------|
| T1 | Accepted 0건 (전부 REJECT) | Phase 6 전체 skip | response.md `execution_path: n/a` |
| T2 | 🔴 1건만 accepted, 테스트 PASS | critical 그룹 dispatch → 완료 | 서브에이전트 호출됨, tmp 로그 생성, `execution_path: subagent` |
| T3 | 🔴 2건 + 🟡 1건 모두 PASS | 3 그룹 순차 dispatch | 각 그룹마다 tmp 로그, 그룹별 커밋 생성 |
| T4 | 🔴 그룹 중 1건 회귀 | critical halt, 🟡/ℹ️ skip | `halt_item`, DEFER 기록 |
| T5 | Dispatch 에러 시뮬레이션 | main fallback | `execution_path: main_fallback`, main 직접 구현 완료 |
| T6 | `--source=pr` + 🔴 1건 PASS | PR 코멘트 게시 성공 | gh api 호출 로그, Failed Postings 비어있음 |

T5 시뮬레이션 방법: **`DEEP_REVIEW_FORCE_FALLBACK=1` 환경변수**를 설정 후 `/deep-review --respond` 실행 (§6.2 강제 fallback 메커니즘). 레포 파일 오염 없이 fallback 경로 재현 가능. (I4)

### 7.3 Context 절감 효과 측정 (관찰, 의무 아님)

측정은 선택적이나, 기록할 경우 **두 수치를 함께 기록**하여 "전체 시스템 토큰이 아니라 main 토큰만 감소"라는 의도를 명확히 한다:
- (a) **Main 세션 토큰 사용량** — Phase 6 진입 전후 차이
- (b) **서브에이전트 누적 토큰** — 3 그룹 합계

T3 실행 전후에 이 두 값을 `.deep-review/reports/` 리포트나 릴리스 노트에 기록. 목표치로 두지 않음. (a)가 크게 줄고 (b)가 증가하는 것이 기대 동작이며, 전체 시스템 토큰은 소폭 증가할 수 있음을 명시해야 오해가 없다. (I5)

### 7.4 배제 사항 (YAGNI)

- 서브에이전트 프롬프트 회귀 테스트(LLM 출력 스냅샷 비교) — 비용 대비 가치 낮음.
- `.deep-review/tmp/` 파일 크기·개수 하드 리밋 — 당장 불필요.
- 언어별 테스트 명령 탐지 유닛 테스트 — 서브에이전트 판단에 위임.

### 7.5 출시 게이트

- 7.1 구조적 검증 스크립트 PASS
- 7.2 중 **T2·T3·T4 성공적 실행** (필수)
- T1·T5·T6은 권장이지만 필수 아님 (T6은 PR 워크플로 준비된 레포가 있어야 검증 가능)

---

## 8. 범위 밖

다음 항목은 이번 설계의 의도적 범위 밖이며, 별도 스펙에서 다룬다:

- Phase 1~5 단계의 서브에이전트 위임 (판단의 Opus 품질 유지를 위해 main에 남김)
- `codex:rescue` 경로와의 통합/중복 해소 (독립 경로로 공존)
- App QA (`--qa`) 기능 활성화
- `--respond` 이외 명령(`--contract`, `--entropy`)의 서브에이전트 위임
- 서브에이전트 병렬화 (현재는 순차 dispatch만)

---

## 9. 릴리스 노트 초안 (v1.3.3 후보)

### Added
- `agents/phase6-implementer.md` — Phase 6 구현 전용 서브에이전트 (`model: sonnet`).
- `hooks/scripts/test/test-phase6-subagent.sh` — Phase 6 위임 구조 회귀 방지 검증 스크립트.

### Changed
- `/deep-review --respond` Phase 6 실행이 심각도 그룹별로 `phase6-implementer` 서브에이전트에 위임됨 (기본 경로).
- `.deep-review/responses/*-response.md`의 Summary에 `execution_path` 필드 추가.
- Phase 6 테스트 로그를 `.deep-review/tmp/phase6-{severity}.log`에 저장 (ephemeral). 사용자 프로젝트용 `.gitignore` 권장 블록(`/deep-review init` Step 8)에 `.deep-review/tmp/` 라인 추가됨.

### Behavior notes
- Dispatch 실패 시 main 세션이 graceful fallback으로 Phase 6 직접 수행.
- 심각도 그룹 내 부분 실패 시 해당 그룹 기록 후 이후 그룹 스킵.

---

## 10. 구현 플랜 연결

이 스펙 승인 후 `superpowers:writing-plans` 스킬로 진행하여 실제 구현 플랜을 `docs/superpowers/plans/2026-04-24-phase6-subagent-delegation.md`에 작성한다.

**구현 플랜에 포함되어야 할 보류 항목** (본 스펙에서 DEFER):

- **init 모드 `.gitignore` 권장 블록 전수 점검** (I7): 본 스펙은 `.deep-review/tmp/` 추가만 다루지만, `commands/deep-review.md` Step 8의 .gitignore 블록이 현재 runtime 디렉토리 전체를 커버하는지 구현 시 grep으로 확인. 누락된 경로가 있으면 본 스펙 범위 외 별도 커밋으로 추가.
