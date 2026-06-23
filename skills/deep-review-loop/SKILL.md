---
name: deep-review-loop
description: Use when the user wants /deep-review and /deep-review --respond to alternate automatically until convergence — e.g. after seeing REQUEST_CHANGES and wanting auto-apply + re-review without manually toggling commands. Triggers on phrases like "keep reviewing until clean", "auto-iterate review", "loop until APPROVE", "리뷰↔대응 반복", "수렴까지 자동 반복", "ultracode 1회 + codex 루프", "codex-only 루프", "codex 2-way 반복 검증".
user-invocable: true
---

# deep-review-loop — Review ↔ Respond Iteration Loop

`/deep-review` (리뷰) 와 `/deep-review --respond` (대응) 을 같은 세션에서 반복 실행해, 더 이상의 리뷰/대응이 무의미해질 때까지 자동으로 수렴시킵니다.

수렴은 명시적 max iteration 이 아니라 **메인 에이전트의 판단** 으로 멈춥니다. (휴리스틱은 §3 종료 조건 참조.)

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL 의 §1 ~ §9 절차를 그대로 실행합니다:

1. **Claude Code 슬래시 진입** — 사용자가 `/deep-review-loop [args]` 를 입력 (skill 의 `user-invocable: true` 가 슬래시 진입을 허용).
2. **타 에이전트 / Codex / SDK** — `Skill({ skill: "deep-review:deep-review-loop", args: "..." })` 형태로 명시적 invoke (Codex 마이그레이션을 포함한 cross-platform 표준 경로).

두 경로 모두 args 는 동일한 토큰 문자열로 전달됩니다.

## Inputs (skill args)

- `--contract [SLICE-NNN]` / `--entropy` — 매 라운드 `/deep-review` 호출에 전달(§2.0 2단 전달 규약에 따라 라운드별 파생).
- `--max=N` (선택, 기본 5) — **안전장치**. 의도치 않은 무한 루프 방지. **단위 = Review 호출 횟수** (한 라운드 = Review 한 번 + 필요 시 Respond 한 번. Respond 는 카운팅 단위가 아니다). N 양의 정수 (≥1, 비정수/0/음수 입력 시 안내 후 종료). N 도달 시 §4 통합 요약에 `종료 사유: max_reached` 로 기록 후 종료. 일반적인 종료는 §3 의 verdict/잔여 ACCEPT/변화 판단으로 발생.
- `--respond` / `init` / `--qa` — **거부** (loop 의 의미와 충돌). 입력에 포함되면 즉시 안내 후 종료.

## 0. Argument 사전 검증

```text
입력에 --respond, init, --qa 중 하나라도 있으면 종료:
  "deep-review-loop 는 리뷰↔대응을 묶어 반복하는 wrapper 입니다.
   --respond / init / --qa 가 필요하면 /deep-review 를 직접 호출하세요."
```

신규 reviewer 구성 플래그(`--ultracode` / `--codex` / `--no-codex` / `--no-opus` / `--no-agy` / `--codex-only`)는 **수용**한다. 단, 매 라운드 `/deep-review` 전달은 "그대로 전달"이 아니라 **§2.0 의 2단 전달 규약**으로 라운드별 파생한다. `--codex-only` 는 commands/deep-review.md §0.5 규약대로 `--codex --no-opus --no-agy` 로 전개한 뒤 다룬다.

## 1. 루프 진입 안내

사용자에게 한 줄 안내:

> "리뷰와 대응을 자동 반복합니다. 매 라운드 종료 시 verdict / 잔여 ACCEPT / 변화 추이를 보고하고, 더 이상 진행이 무의미하다고 판단되면 루프를 중단합니다. 안전장치: 최대 {max} 라운드."

(기본 `--max=5`. 명시되지 않으면 5 사용.)

## 2. 루프 본체 (라운드 단위)

**라운드 = Review 호출 한 번을 단위로 한다**. 한 라운드는 다음 **3 sub-step** 으로 구성:

1. `2.1 Review` — `--max` 가 카운팅하는 유일한 단위.
2. `2.2 Respond` (조건부) — 직전 Review 의 verdict 에 따라 같은 라운드 안에서 이어 수행. 라운드 카운터를 증가시키지 않는다.
3. `2.3 Metrics` — 라운드 종료 직후 메모리 수집.

§8 의 예시 표기 "라운드 1=Review, 라운드 2=Respond, 라운드 3=Re-review" 는 **단계 표기** 이지 라운드 카운터가 아니다. `round_number` 는 §2.1 진입 시점에만 증가한다 (`round_number = previous_round_number + 1`).

### 2.0 reviewer 플래그 전달 & ultracode 캐던 (v1.10.0)

**ultracode 1회 + codex 매 라운드.** loop 는 매 라운드 `/deep-review` 인자를 **파생**한다("그대로 전달" 아님). 본 §2.0 이 단일 출처(SSOT)다.

- **never-forward 집합**: `{--max, --respond, init, --qa}` — 절대 전달 안 함(loop 전용).
- **라운드 1**: 사용자 reviewer 플래그(`--ultracode`/`--codex`/`--no-codex`/`--no-opus`/`--no-agy`; `--codex-only` 는 commands/deep-review.md §0.5 에서 `--codex --no-opus --no-agy` 로 전개된 형태) + `--contract`/`--entropy` 를 전달. 라운드 1 완료 후, **사용자가 `--ultracode` 를 줬을 때만** `ultracode_consumed = true`.
- **라운드 2+ — `ultracode_consumed` 로 분기 (RLC-1/REG-1: 무조건 주입 금지)**:
  - **`ultracode_consumed == true`** (통합 `--ultracode …` 루프): 전달 집합에서 **`--ultracode` 토큰을 제거**하고 `--no-opus` + `--no-agy` 를 주입(`--codex` 유지). → ultracode 는 라운드 1만, 이후는 codex 전용 재검증("ultracode 1회 + codex 루프"). `--ultracode` 를 제거하지 않으면 `--ultracode`+`--no-opus` 가 commands/deep-review.md §0.5 모순 에러로 루프가 abort 된다(LOOP-3).
  - **`ultracode_consumed == false`** (plain `/deep-review-loop`, `--codex`, `--codex-only`, `--no-opus` 등 — `--ultracode` 미지정): 사용자 R1 reviewer 플래그를 **그대로 유지**(loop 전용만 제거). **`--no-opus`/`--no-agy` 를 주입하지 않는다.** → plain 루프 = 매 라운드 single-opus + auto codex/agy(v1.10.0 이전과 동일), `--codex` 루프 = 매 라운드 opus+codex, `--codex-only` 루프 = 매 라운드 codex-only. (이전 버전 default-loop 회귀 방지 — RLC-1/REG-1.)

이 2단 전달 규약이 v1.10.0 이전의 단순 argument 전달 규칙(구 §2.1 step 2)을 **대체**한다.

**codex-unavailable 분기 (LOOP-1) — 라운드 종료 후 판별**: codex 가용성은 라운드 진행 중(Stage 1 preflight) 에야 알 수 있으므로, 각 라운드 리포트 Summary 의 codex 상태(`not_authenticated`/`timeout`/`failed`)를 읽어 판별한다:
- `ultracode_consumed == true` 인데 그 라운드 codex 가 불가했다면 → 다음 라운드부터 `--no-opus` 주입을 보류(= 단일 Opus)해 **리뷰어 ≥1 보장**. ultracode fan-out 으로는 폴백 안 함(비용).
- `ultracode_consumed == false` 의 `--codex-only` 루프에서 codex 불가 → **리뷰어 0 → 루프 중단(§3.A 운영오류)**. 사용자의 "Claude off" 의도 존중.
- 그 외(`ultracode_consumed == false` 이고 single-opus 가 살아있는 plain/`--codex` 루프)는 codex 불가여도 Claude 리뷰어가 있으므로 정상 진행.

### 2.1 Review 단계

`/deep-review` 본문의 "리뷰 모드" 절차를 인라인으로 수행합니다 (skill 은 다른 슬래시 커맨드를 다시 dispatch 할 수 없으므로 본문을 Read 해서 따라간다):

1. `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/commands/deep-review.md" })` — 첫 라운드에서만 1회 (이후 라운드는 이미 컨텍스트에 있음). `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/receiving-review/references/respond-execution.md" })` — 첫 라운드에서 Respond 전 1회 로드 (respond 절차는 respond-execution.md가 SSOT).
2. 그 본문의 **§0 "Auto-create .deep-review/"** + **§0.1 "자동 복원 (stale mutation recovery)"** + **"## Steps (리뷰 모드)"** 섹션 (Stage 1 ~ Stage 5.5 + Stage 6 `--entropy` 있을 때) 절차를 그대로 수행. §0.1 의 `auto_recover` 호출은 **매 라운드 진입 시 반드시 실행** — 본문 인용 범위의 시작점을 `## Steps` 헤딩이 아닌 §0 으로 명시한다 (R-006 회귀 방지). argument 전달은 **§2.0 의 2단 전달 규약**을 따른다(라운드별 파생 — loop 전용 플래그 제거, reviewer 플래그는 라운드에 따라 파생).
3. `deep-review-workflow` 스킬은 본문 §Prerequisites 에 명시된 3단계 fallback 순서대로 로드 — 변경 없음.
4. Stage 1 ~ Stage 5.5 까지 완료될 때까지 대기. 백그라운드 리뷰어 완료 알림은 런타임이 자동 전달하므로 polling 금지.

라운드별 리포트는 `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md` 에 저장됨.

**중요 — 라운드 식별 invariant (set-difference 기반)**: review 단계 종료 직후, **이번 라운드가 방금 생성한 리포트의 절대 경로** 를 `round_review_report_path` 로 메모리에 캡처한다. 동일-초 race 도 결정적으로 봉인하기 위해 **pre-set 스냅샷 + post-set delta** 방식을 사용한다 (mtime 비교 단독 금지 — 정수 초 해상도 race 회귀 방지):

```bash
# review 단계 시작 직전: 기존 리포트 set 을 스냅샷
pre_round_existing=$(ls .deep-review/reports/*-review.md 2>/dev/null | sort -u)

# … review 단계 수행 (Stage 1~5.5) …

# 종료 직후: 새로 나타난 리포트의 set-difference
post_round_existing=$(ls .deep-review/reports/*-review.md 2>/dev/null | sort -u)
new_reports=$(comm -23 <(echo "$post_round_existing") <(echo "$pre_round_existing") | sed '/^$/d')
new_count=$(echo "$new_reports" | grep -c .)

# 정확히 1개의 새 리포트여야 함
if [ "$new_count" -eq 0 ]; then
  echo "⚠ 라운드가 새 리포트를 만들지 않음 — review 단계 실패 의심. 루프 중단."
  exit 1
elif [ "$new_count" -gt 1 ]; then
  echo "⚠ 라운드 안에 ${new_count}개 새 리포트 — 동시 세션 또는 사용자 수동 생성 가능. 루프 중단."
  echo "$new_reports" >&2
  exit 1
fi

round_review_report_path=$(echo "$new_reports" | head -1)
round_review_report_path=$(cd "$(dirname "$round_review_report_path")" && pwd)/$(basename "$round_review_report_path")  # absolute
```

이 set-difference 가드는 mtime 비교의 동일-초 race 를 완전히 닫는다 (file system 의 directory entry 차원에서 결정적). 가드 실패 시 §3.A.4 운영 오류로 분류해 즉시 루프 종료. 캡처된 `round_review_report_path` 는 §2.2 Respond 단계에 **명시적 경로 인자** 로 전달된다.

### 2.2 Respond 단계 (조건부)

직전 Review 의 verdict 와 ACCEPT 항목 수에 따라 분기:

- `verdict=APPROVE` + 🔴/🟡 항목 모두 0 건 → **대응 단계 스킵**. §3 으로 진행 (자연 수렴).
- `verdict=CONCERN` + 🔴 0 건 AND 🟡 모두 partial (의견 분리만 존재) → **대응 단계 스킵**. §3 에서 종료 판단.
- 그 외 (`REQUEST_CHANGES`, 또는 ACCEPT 후보 항목 ≥ 1) → 대응 진행.

대응 진행은 다음과 같이:

1. wrapper 변수 `respond_arg_path="$round_review_report_path"` 를 설정. 아래 Read 구문으로 respond 절차를 로드한 뒤 그대로 수행. argument 는 **`--respond ${respond_arg_path}`** — §2.1 에서 캡처한 절대 경로를 **명시 전달** (mtime fallback 의존 금지, race 회귀 방지). `receiving-review` 스킬은 respond-execution.md §Prerequisites 의 3단계 fallback 으로 로드.

   `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/receiving-review/references/respond-execution.md" })`
2. **Invariant check**: 본문 §1 이 로드한 리포트 경로가 wrapper 캡처값과 일치하는지 확인. skill 이 본문을 inline 수행하므로 sub-process argv (`$1`) 가 아닌 skill-context 변수로 직접 비교한다 (W1 회귀 방지):
   ```bash
   # 본문 §1 의 path-load 결과를 명시적으로 변수에 복사 (skill context).
   # 본문이 mtime fallback 으로 다른 경로를 골랐다면 여기서 즉시 발각된다.
   loaded_path_from_respond=$(realpath "${respond_arg_path:-}")
   captured_path=$(realpath "$round_review_report_path")
   [ -n "$loaded_path_from_respond" ] && [ "$loaded_path_from_respond" = "$captured_path" ] \
     || { echo "⚠ Respond 단계가 다른 리포트를 로드함 (${loaded_path_from_respond:-<unset>} ≠ ${captured_path}). 동시 세션 / 수동 touch / 본문 mtime fallback drift 가능. 루프 중단."; exit 1; }
   ```
3. 사용자에게 보여주는 "이 리포트에 대응하시겠습니까?" 확인 단계는 loop 안내(§1) 로 이미 합의된 것으로 간주하고 자동 진행 — 단, 다음 가드는 그대로 유지:
   - 민감 파일 패턴 감지 시 사용자 경고는 항상 표시.
   - mutation lock 점유 시 즉시 종료 + 사용자 보고 (다른 세션 진행 중).
   - **위 §2.2 step 2 의 invariant check** 가 통과한 경우에만 자동 진행 — 실패 시 무조건 사용자에게 보고하고 중단.
4. Phase 6 dispatch (또는 main fallback) 완료까지 대기. Response 리포트는 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md` 에 저장.
5. **대응 단계가 dispatch 실패로 `main_fallback` 분기 가드 (spec `phase6-delegation-spec.md §6.2 "Dispatch 실패 (5A = main fallback)"` Step 2) 에서 사용자에게 묻는 경우**: 사용자가 (1) "DEFER 후 종료" 를 선택하면 loop 도 즉시 §3 종료 경로로. (2) "계속 진행" 을 선택하면 그 안내를 존중하고 같은 라운드 안에서 fallback 으로 계속.

### 2.3 라운드 메트릭 수집

라운드 종료 직후 다음을 수집해 메모리(루프 내 변수)에 보관:

```
round_number,
round_review_report_path (= §2.1 set-difference 검증 캡처값, absolute path),
response_report_path (있으면, absolute path),
verdict, count_red, count_yellow, count_info,
accepted_count, rejected_count, deferred_count,
implemented_count, halted (boolean), execution_path,
findings_signature (Set<"{severity}:{file}:{floor(line/7)}:{taxonomy_category}">) — §3.A.3 정체 감지용. line 버킷은 ultracode 내부 합성(§4.3 `ultracode-integration.md`)과 동일한 고정 버킷 `floor(line/7)` 을 써서 라운드 간 정체 판정을 일관시킨다(VOICE-4).
```

**`taxonomy_category` 출처 (W6 명시)**: `report-format.md` 의 리포트 행에는 taxonomy 컬럼이 없으므로 skill 은 두 단계로 채운다:

1. **Stage 5.5 Recurring Findings Export** 가 매 라운드 끝에 갱신하는 `.deep-review/recurring-findings.json` 의 `payload.findings[].category` 와 본 라운드 issue 의 `file:line` 을 매칭. 매칭되면 그 카테고리를 사용 (7개 taxonomy: `error-handling | naming-convention | type-safety | test-coverage | security | performance | architecture`).
2. 매칭 실패 시 `taxonomy_category = "untagged"` 로 채운다.

이 fallback 으로 signature 의 4번째 component 가 결정적으로 정의되어, 같은 line 의 두 다른 issue 가 잘못 정체로 판정되는 것을 방지한다. `recurring-findings.json` 가 아직 생성되지 않은 첫 라운드(`.deep-review/reports/` 가 2개 미만) 에서는 모든 항목이 `untagged` 가 되며, signature 비교는 단일-카테고리 안에서 file:line 만 사용한다 (race 없음 — 첫 라운드는 비교 대상이 없음).

이 값들은 §3 의 종료 판단에 입력으로 들어가며, 루프 종료 시 요약 보고에도 사용.

## 3. 종료 조건 (메인 에이전트 판단)

라운드 종료 직후 아래 신호를 종합해 **계속 / 중단** 을 결정합니다. 명시적 임계값보다 종합 판단을 우선하되, 다음 패턴은 **즉시 중단** 입니다:

### 3.A 즉시 중단 (hard stop)

다음 중 하나라도 충족되면 추가 라운드 진입 금지:

1. `verdict == APPROVE` AND `count_red == 0` AND `count_yellow == 0` — 자연 수렴.
2. 라운드 수 ≥ `--max` — 안전장치 한계.
3. 직전 라운드와 **동일한 findings_signature 집합** (§2.3 정의: `{severity}:{file}:{floor(line/7)}:{taxonomy_category}` 의 set) 이 절반 이상 재출현하고, 추가 변경(`implemented_count == 0` 또는 `halted == true`) 도 없음 — **수렴 정체**. 그 상태로 한 번 더 반복해도 진전 가능성 없음. (라운드 N 의 signature 집합 ∩ 라운드 N-1 의 signature 집합 의 크기가 max(|N|, |N-1|) 의 50% 이상일 때 정체로 판정. report-format.md 에 explicit issue id 컬럼이 없으므로 issue id 비교는 fallback 으로만 사용 — 본 signature 가 단일 정체 비교 키이다.)
4. mutation 복원 실패, lock 점유, dispatch 전면 실패 등 **운영 오류** 가 같은 라운드 안에 누적 ≥ 2 — 사람의 개입이 필요한 상태.
5. 사용자가 어떤 가드 (`AskUserQuestion`) 에서 "중단" 또는 "DEFER 후 종료" 를 선택.

### 3.B 계속 진행 (soft continue)

다음이 모두 성립하면 다음 라운드 진입:

- `verdict in (REQUEST_CHANGES, CONCERN)`.
- 직전 라운드에서 **새로운 변경이 발생함** (`implemented_count >= 1` AND `halted == false`).
- 직전 라운드의 issue 와 이번 라운드의 issue 가 **유의미하게 다름** — 같은 카테고리(`recurring-findings.json` taxonomy) 안에서도 file:line 이 바뀌거나 새로운 카테고리가 등장하면 진전.
- `--max` 미달.

### 3.C 메인 에이전트 자유 판단 영역

3.A / 3.B 어디에도 명확히 떨어지지 않는 회색 지대에서는 메인이 다음을 종합해 결정:

- 잔여 🔴 / 🟡 의 "수정 가능성" — 외부 의존(상위 패키지 버그, 미배포 변경, 사람의 설계 결정) 으로 보이면 종료 + DEFER 권고.
- 직전 대응이 **너무 빨리 dispatch 실패** 로 끝났는데, 같은 실패가 반복될 가능성이 보이면 종료 + 사용자에게 진단 위임.
- 사용자가 사전에 부여한 컨텍스트 (커밋 freeze, 시간 제약 등) 가 있으면 그에 맞춰 조기 종료.

종료 판단 결과는 사용자에게 한 단락으로 보고:

> "라운드 {N} 종료 — verdict={…}, 잔여 🔴/🟡/ℹ️={…}/{…}/{…}, 직전 라운드 대비 변화={…}. {계속 진행 / 종료} 사유: {짧은 한 문장}."

## 4. 루프 종료 보고

루프가 끝나면 통합 요약을 출력 + 저장:

1. 화면 출력:
   - 라운드별 한 줄 요약 (round / verdict / red / yellow / implemented / halted).
   - 최종 verdict + 잔여 🔴/🟡.
   - 종료 사유 (§3 의 어떤 조건이 발동했는지).
   - 후속 권고 (사람 개입 항목, 외부 의존 항목 등).
2. 저장: `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-loop-summary.md`
   - 매 라운드의 `review_report_path` / `response_report_path` 를 링크 형태로 나열.
   - 마지막 라운드의 verdict 와 잔여 항목을 그대로 인용.
   - 이 파일은 `.deep-review/responses/` 디렉토리 규칙(respond-execution.md Step 3) 을 따르며, `.gitignore` 정책상 untracked.

## 5. 동시성 / 안전성

- 동일 세션 안에서 직렬 실행 — 한 라운드의 모든 백그라운드 리뷰어가 완료될 때까지 다음 라운드 진입 금지.
- `auto_recover` 는 **각 라운드 진입 시점에 매번 호출** (이미 `/deep-review` 와 respond-execution.md 가 각각 호출하므로 skill 이 따로 호출할 필요 없음 — 단, Read fallback 으로 본문을 인라인 수행할 때는 본문이 이 호출을 포함하는지 확인).
- mutation lock 이 다른 세션에 의해 점유된 경우: 즉시 §3.A.4 로 중단 + 사용자에게 안내.
- 루프 도중 사용자가 `Ctrl-C` 등으로 인터럽트 → 직전까지 저장된 리포트는 보존, 진행 중이던 mutation 은 다음 세션의 `auto_recover` 가 복원.

## 6. 멱등성 / 재진입

- deep-review-loop 는 **상태를 별도 파일에 저장하지 않는다**. 라운드 메트릭은 세션 메모리에만 보관. 세션이 끊기면 다시 호출하면 그 시점부터 새 루프가 시작됨 (이미 적용된 변경은 다음 라운드 review 에 자연스럽게 반영).
- 단, 마지막 라운드의 review / response 리포트는 디스크에 남아 있으므로 사용자는 `/deep-review --respond {path}` 로 임의 시점 리포트에 명시적으로 재대응 가능.

## 7. 비교 — 언제 무엇을 쓰나

| 시나리오 | 권장 |
|---|---|
| 1회만 리뷰 받고 사람이 직접 판단 | `/deep-review` |
| 리뷰 결과 받은 후 대응만 따로 | `/deep-review --respond` |
| "리뷰 → 대응 → 재리뷰" 를 끝까지 자동화 | `deep-review-loop` ← 본 skill |
| 외부 리뷰어 (PR) 코멘트 단발 대응 | `/deep-review --respond --source=pr` |

## 8. 출력 예시 (참고)

```
[deep-review-loop] 시작 — max=5
=== 라운드 1 ===
... (Stage 1~5.5)
라운드 1 종료 — verdict=REQUEST_CHANGES, 잔여 🔴/🟡/ℹ️=2/4/1, 변화=신규. 계속 진행 사유: 🔴 2건 + 변경 가능 영역.

=== 라운드 2 (Respond) ===
... (Phase 1~6)
... (Phase 6 dispatch — 🔴 그룹 PASS, 🟡 그룹 1 항목 회귀로 halted)
라운드 2 Respond 완료 — implemented=3, halted=true(🟡 그룹).

=== 라운드 3 (Re-review) ===
... (Stage 1~5.5)
라운드 3 종료 — verdict=CONCERN, 잔여 🔴/🟡/ℹ️=0/3/1, 변화=감소. 계속 진행 사유: 🟡 3 건이 신규 file:line.

=== 라운드 4 (Respond) ===
... (Phase 1~6)
라운드 4 Respond 완료 — implemented=2, halted=false.

=== 라운드 5 (Re-review) ===
... (Stage 1~5.5)
라운드 5 종료 — verdict=APPROVE, 잔여 🔴/🟡/ℹ️=0/0/1.

[deep-review-loop] 종료 — 자연 수렴 (verdict=APPROVE, 🔴/🟡=0/0).
요약 저장: .deep-review/responses/2026-05-13-153012-loop-summary.md
```

## 9. 알려진 제한

- 한 라운드가 매우 길어지는 경우(대형 diff + 3-way Codex), skill 이 별도 timeout 을 부과하지 않습니다. 개별 호출의 `_timeout 900` (codex-integration.md) 가 유일한 안전장치입니다.
- `--source=pr` 모드는 한 라운드 안에서 PR 코멘트가 변하지 않으므로 의미 있는 반복이 어렵습니다. skill 은 이를 막지 않지만, 한 라운드만 의미가 있다고 안내합니다.
