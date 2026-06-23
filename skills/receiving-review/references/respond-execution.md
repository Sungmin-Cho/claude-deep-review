# respond-execution — `/deep-review --respond` 절차 (라우터에서 on-demand Read)

<!-- commands/deep-review.md 의 --respond 분기에서 Read 되어 그대로 수행된다. 동작 SSOT. -->

## Steps (대응 모드 — `--respond` 인수)

### 0. 자동 복원 + tmp 회전

리뷰 모드 §0.1 과 동일한 mutation 자동 복원 후, Phase 6 tmp 로그를 1단계 회전.

```bash
source ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/mutation-protocol.sh
auto_recover

# Phase 6 tmp artifact 1단계 회전 — 직전 세션은 prev/로 보존, 2회 이전은 자동 소멸.
# v1.3.4 N2 교정: .log 외에도 TSV (C4) + baseline/ (W4/C5) 디렉토리를 함께 회전.
mkdir -p .deep-review/tmp/prev
if compgen -G ".deep-review/tmp/phase6-*.log" > /dev/null 2>&1; then
  rm -f .deep-review/tmp/prev/phase6-*.log 2>/dev/null || true
  mv .deep-review/tmp/phase6-*.log .deep-review/tmp/prev/ 2>/dev/null || true
fi
if compgen -G ".deep-review/tmp/phase6-*.tsv" > /dev/null 2>&1; then
  rm -f .deep-review/tmp/prev/phase6-*.tsv 2>/dev/null || true
  mv .deep-review/tmp/phase6-*.tsv .deep-review/tmp/prev/ 2>/dev/null || true
fi
if compgen -G ".deep-review/tmp/phase6-*-baseline" > /dev/null 2>&1; then
  rm -rf .deep-review/tmp/prev/phase6-*-baseline 2>/dev/null || true
  mv .deep-review/tmp/phase6-*-baseline .deep-review/tmp/prev/ 2>/dev/null || true
fi
```

회전 근거와 상세 정책은 스펙 §6.9 참조.

### Prerequisites

`receiving-review` 스킬을 **다음 순서대로** 로드한다 (`user-invocable: false` 스킬이 Skill tool로 안정적으로 로드되지 않는 환경에 대비한 fallback 경로):

1. 1차 시도: `Skill({ skill: "deep-review:receiving-review" })` — 플러그인 네임스페이스 포함
2. 1차 실패 시 2차 시도: `Skill({ skill: "receiving-review" })` — 네임스페이스 없이
3. 2차도 실패 시 Read fallback:
   - `Read({ file_path: "${CLAUDE_PLUGIN_ROOT}/skills/receiving-review/SKILL.md" })`
   - 필요한 references도 Read로 로드: `references/response-protocol.md`, `references/forbidden-patterns.md`, `references/response-format.md`
4. 어떤 경로든 성공하면 Phase 1~6을 실행한다. 실패 경로는 Response 리포트의 Summary에 "skill load method: Skill | Read fallback" 으로 기록.

### 1. 리포트 로딩

- `--respond {path}` → 지정된 리포트 로드 (경로 그대로 사용)
- `--respond` (경로 없음) → `.deep-review/reports/` 내 **mtime 기준 가장 최근** `*-review.md` 로드:
  ```bash
  latest=$(ls -1t .deep-review/reports/*-review.md 2>/dev/null | head -1)
  ```
  `-ultrareview.md` 같은 비표준 접미사 파일은 `*-review.md` glob에서 제외되어 수동 리뷰와 일상 리뷰가 섞이지 않는다.
  mtime 정렬이므로 파일명 포맷이 변경되어도(과거 `{date}-review.md` ↔ 현재 `{date}-{time}-review.md`) 안전.
- `--respond --source=pr` → GitHub PR 코멘트를 `gh api`로 수집 (`--pr=NNN`로 수동 지정 가능)
- 리포트가 여러 개인데 사용자가 원하는 파일이 mtime 최신이 아닐 수 있으므로, 최근 3개 리포트의 Summary를 나열하고 AskUserQuestion으로 선택을 제공하는 것을 **권장**(필수 아님).
- 리포트가 없으면: "대응할 리뷰 리포트가 없습니다. 먼저 `/deep-review`를 실행하세요."

**참고**: `--source=pr`과 `REPORT_PATH`는 상호 배타적이다. 둘 다 지정하면 `--source=pr`이 우선하고 `REPORT_PATH`는 무시된다.

**리포트 확인 (같은 날 덮어쓰기 방지)**:
리포트 로드 후, 사용자에게 Summary(Verdict, Review Mode, Issues 요약)를 표시하고 "이 리포트에 대응하시겠습니까?" 확인을 받는다. 리포트 파일명은 이제 `{YYYY-MM-DD}-{HHmmss}-review.md` 타임스탬프 기반이므로 덮어쓰기는 발생하지 않지만, 같은 날 여러 리뷰가 있을 경우 사용자가 어떤 리포트에 대응할지 혼동할 수 있다. 확인 단계를 통해 잘못된 리포트에 대응하는 것을 방지한다.

### 2. receiving-review Phase 1~5 (main)

로드된 `receiving-review` 스킬의 Phase 1~5를 main 세션에서 실행합니다.
- Phase 1~5: READ / UNDERSTAND / VERIFY / EVALUATE / RESPOND — ACCEPT/REJECT/DEFER 판단까지.
- 각 ACCEPT 항목에 `implementation_guide` 6개 필드(`target_location`/`modifiable_paths`/`intent`/`change_shape`/`non_goals`/`acceptance`)를 기록.
- Accepted Items를 5단계 우선순위(🔴 전원일치 → 🔴 부분일치 → 🟡 전원일치 → 🟡 부분일치 → ℹ️)로 정렬, `confidence: agreed | partial` 필드 세팅.
- Recurring findings 분류 및 경고는 Phase 1(READ) 내부에서 처리.

### 2.5 Phase 6 — subagent dispatch (심각도 그룹 loop)

Phase 6 구현은 `phase6-implementer` 서브에이전트에 그룹 dispatch. 상세 스펙: `skills/receiving-review/references/phase6-delegation-spec.md` §3, §5, §6.

**심각도 그룹 loop** (🔴 → 🟡 → ℹ️):

**실행 가능한 e2e 테스트**: 아래 각 Step의 핵심 shell 로직은 `hooks/scripts/test/test-phase6-protocol-e2e.sh`의 12개 테스트(E1~E12)에서 실증 검증됨. pseudocode가 문서로 drift하지 않도록 **CI에서 e2e도 함께 실행**.

**Step ↔ spec 매핑** (단일 mental map 유지용):

| Step | Spec 섹션 | 역할 |
|---|---|---|
| 1. Skip (0건) | §6.1 | 엣지 케이스 |
| 2. 로그 경로 | §5.4 (preamble) | prelim |
| 3. Pre-dispatch snapshot | §5.4.1 | allowlist + baseline |
| 4. Dispatch (2단계 fallback) | §5.4.2 (dispatch 부분) | agent 호출 |
| 5. 결과 검증 | §5.4.2~§5.4.7 | 파싱·DELTA·violation·claim·REVERTED·log |
| 6. 그룹 커밋 | §5.4.8 | pathspec-limited 커밋 |
| 7. Dirty recovery | §5.4.9 | per-file baseline 복원 |
| 8. 중단 판정 | §6.3 | 후속 그룹 dispatch 차단 |
| (본 Steps 외) Response 리포트 | §5.4.10 | 본 파일 §3 "Response 리포트 저장" |
| (본 Steps 외) PR 코멘트 게시 | §5.4.11 | `--source=pr` 경로 |

1. 해당 그룹의 ACCEPT 항목이 0건이면 skip.
2. 로그 경로 결정: `log_path="$(pwd)/.deep-review/tmp/phase6-${severity}.log"` (절대 경로). `mkdir -p .deep-review/tmp`.
3. **Pre-dispatch snapshot** (spec §5.4.1) — allowlist + content-aware baseline:
   ```bash
   # Allowlist = target_location 경로 union modifiable_paths (스펙 §5.1 계약)
   # TARGET_LOCATIONS_OF_GROUP, MODIFIABLE_PATHS_OF_GROUP = Accepted Items 파싱 결과
   # target_location은 "src/a.ts:45-60" 형식 또는 comma-separated 다중 경로 허용 — line-range strip
   ALLOWED=$(printf '%s\n' "${TARGET_LOCATIONS_OF_GROUP[@]}" "${MODIFIABLE_PATHS_OF_GROUP[@]}" \
     | tr ',' '\n' \
     | sed -E 's/:[0-9][0-9,\-]*\s*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
     | sort -u | sed '/^$/d')

   # Path set baseline (violation 검출용)
   # --name-status -M: rename(R)/copy(C) 감지 시 new path를 채택 (E7 검증).
   # **staged + unstaged 합집합** — `git mv`는 자동 staged이므로 `--cached` 없이는 감지 불가.
   # subagent는 Bash tool을 보유해 임의 시점에 rename을 staged 상태로 둘 수 있으므로
   # 두 diff를 모두 스캔해야 trust boundary가 성립한다 (v1.3.4 review C1 교정).
   # Binary 파일은 --name-status도 경로 단위로 나열되며 DELTA는 아래
   # `git hash-object`(binary 대응 가능)로 계산되므로 별도 분기 없음 (E8 검증).
   PRE_MODIFIED=$( { git -c core.quotepath=false diff --name-status -M;
                     git -c core.quotepath=false diff --cached --name-status -M; } \
     | awk -F'\t' '
         $1 ~ /^[RC]/ { print $3; next }
         $1 != "" { print $2 }
       ' | sort -u)
   PRE_UNTRACKED=$(git -c core.quotepath=false ls-files --others --exclude-standard | sort -u)
   PRE_STATUS=$(git -c core.quotepath=false status --porcelain=v1 -uall)

   # Content snapshot — ALLOWED 각 파일에 대해 per-file 복사 (Dirty recovery 용)
   # v1.3.4 review C4 교정: bash 3.2 호환을 위해 associative array 대신 TSV temp file 사용
   # (macOS 기본 `/bin/bash` 3.2 에서 `declare -A` 는 invalid option).
   mkdir -p ".deep-review/tmp/phase6-${severity}-baseline"
   PRE_HASH_FILE=".deep-review/tmp/phase6-${severity}-pre-hash.tsv"
   PRE_TRACKED_FILE=".deep-review/tmp/phase6-${severity}-pre-tracked.tsv"  # C5 교정
   : > "$PRE_HASH_FILE"
   : > "$PRE_TRACKED_FILE"
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     # C5 교정: "worktree 존재 ≠ tracked 여부". git ls-files 로 명시적 구분.
     if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
       tracked="true"
     else
       tracked="false"
     fi
     printf '%s\t%s\n' "$f" "$tracked" >> "$PRE_TRACKED_FILE"

     if [[ -f "$f" ]]; then
       printf '%s\t%s\n' "$f" "$(git hash-object -- "$f")" >> "$PRE_HASH_FILE"
       # per-file baseline copy (preserves user WIP content)
       mkdir -p ".deep-review/tmp/phase6-${severity}-baseline/$(dirname "$f")"
       cp -p "$f" ".deep-review/tmp/phase6-${severity}-baseline/$f"
     else
       printf '%s\tabsent\n' "$f" >> "$PRE_HASH_FILE"
     fi
   done <<< "$ALLOWED"

   # W7 교정: ALLOWED 각 경로의 pre-existing staged hunk 여부 기록.
   # Recovery 시 git restore --staged 가 사용자 partial-hunk staging 을 un-stage 하므로
   # 해당 경로 목록을 미리 확보해 warning + response.md 복원 로그에 활용.
   PRE_STAGED_FILE=".deep-review/tmp/phase6-${severity}-pre-staged.tsv"
   : > "$PRE_STAGED_FILE"
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     if git diff --cached --quiet -- "$f" 2>/dev/null; then
       printf '%s\tfalse\n' "$f" >> "$PRE_STAGED_FILE"
     else
       printf '%s\ttrue\n' "$f" >> "$PRE_STAGED_FILE"
     fi
   done <<< "$ALLOWED"

   # Pre-existing outside hash snapshot (C3 교정: allowlist bypass via pre-dirty files).
   # PRE_MODIFIED ∪ PRE_UNTRACKED 중 ALLOWED 에 없는 경로의 content hash 를 기록.
   # Subagent 가 "이미 dirty 였던 non-ALLOWED 경로"를 추가 수정하면 POST 에서 hash
   # 차이로 감지해 VIOLATIONS 에 포함시킨다 (path-membership 만으로는 놓치는 케이스).
   PRE_OUTSIDE_HASH_FILE=".deep-review/tmp/phase6-${severity}-pre-outside-hash.tsv"
   : > "$PRE_OUTSIDE_HASH_FILE"
   PRE_ALL=$(printf '%s\n%s\n' "$PRE_MODIFIED" "$PRE_UNTRACKED" | sort -u | sed '/^$/d')
   while IFS= read -r f; do
     [[ -z "$f" ]] && continue
     # ALLOWED 에 이미 있으면 skip — DELTA 로직이 관장
     grep -Fxq "$f" <<< "$ALLOWED" && continue
     if [[ -f "$f" ]]; then
       printf '%s\t%s\n' "$f" "$(git hash-object -- "$f")" >> "$PRE_OUTSIDE_HASH_FILE"
     else
       printf '%s\tabsent\n' "$f" >> "$PRE_OUTSIDE_HASH_FILE"
     fi
   done <<< "$PRE_ALL"
   ```
4. **Dispatch 2단계 네임스페이스 fallback** (spec §5.4.2 dispatch):
   - 환경변수 `DEEP_REVIEW_FORCE_FALLBACK=1` 이 설정되면 dispatch 건너뛰고 즉시 main fallback 경로로 분기 (단, baseline 보존 상태).
   - 1차: `Agent({ subagent_type: "deep-review:phase6-implementer", prompt: <§5.1 계약> })`
   - 1차가 "subagent_type not found" 또는 유사 에러 반환 시 2차: `Agent({ subagent_type: "phase6-implementer", prompt: <§5.1 계약> })`
   - 2차도 실패 또는 permission refusal 등 dispatch 자체 실패 시 → main fallback 분기.
5. **결과 검증 (dispatch 성공 시) — fail-closed + content-aware delta + allowlist** (spec §5.4.2~§5.4.7):
   - 반환 메시지에 `## Group Result` 블록이 **없거나 파싱 불가능**하면 dispatch 실패로 재분류 → Step 7 "Dirty recovery"로 분기.
   - **Content-aware DELTA** (E2 검증): ALLOWED 각 경로의 hash를 post-dispatch와 비교. content 변경된 경로만 포함:
     ```bash
     # bash 3.2 호환: associative array 대신 TSV file iterate (C4)
     DELTA=()
     while IFS=$'\t' read -r f pre_hash; do
       [[ -z "$f" ]] && continue
       post=$([[ -f "$f" ]] && git hash-object -- "$f" || echo "absent")
       [[ "$post" != "$pre_hash" ]] && DELTA+=("$f")
     done < "$PRE_HASH_FILE"
     ```
   - **Path-set violation** — ALLOWED 외부 경로가 수정/생성됐는지 별도 체크 (trust boundary):
     ```bash
     # PRE와 동일한 --name-status -M 정규화 (rename/copy → new path)
     # staged + unstaged 합집합 (C1 교정 — `git mv`는 staged-only로 나타남)
     POST_MODIFIED=$( { git -c core.quotepath=false diff --name-status -M;
                        git -c core.quotepath=false diff --cached --name-status -M; } \
       | awk -F'\t' '
           $1 ~ /^[RC]/ { print $3; next }
           $1 != "" { print $2 }
         ' | sort -u)
     POST_UNTRACKED=$(git -c core.quotepath=false ls-files --others --exclude-standard | sort -u)
     NEW_PATHS=$(printf '%s\n%s\n' \
       "$(comm -13 <(echo "$PRE_MODIFIED") <(echo "$POST_MODIFIED"))" \
       "$(comm -13 <(echo "$PRE_UNTRACKED") <(echo "$POST_UNTRACKED"))" \
       | sort -u | sed '/^$/d')
     VIOLATIONS=$(comm -23 <(echo "$NEW_PATHS") <(echo "$ALLOWED"))
     [[ -n "$VIOLATIONS" ]] && { execution_status=error; error_reason="outside allowlist: $VIOLATIONS"; }

     # C3 교정: pre-existing outside path content 변경 검사 (E9 검증)
     # path-membership 만으로는 "이미 dirty 였던 non-ALLOWED 경로 재수정" 을 못 잡는다.
     # bash 3.2 호환: associative array 대신 TSV file iterate (C4)
     OUTSIDE_VIOLATIONS=()
     while IFS=$'\t' read -r f pre_hash; do
       [[ -z "$f" ]] && continue
       post=$([[ -f "$f" ]] && git hash-object -- "$f" || echo "absent")
       [[ "$post" != "$pre_hash" ]] && OUTSIDE_VIOLATIONS+=("$f")
     done < "$PRE_OUTSIDE_HASH_FILE"
     if [[ ${#OUTSIDE_VIOLATIONS[@]} -gt 0 ]]; then
       execution_status=error
       error_reason="pre-existing outside paths mutated by subagent: ${OUTSIDE_VIOLATIONS[*]}"
     fi
     ```
   - **서브에이전트 claim 정규화 + delta 일치 검증** (E1 검증):
     ```bash
     # subagent emits "path/to/file (+A -B)" — suffix strip before compare
     CLAIM=$(printf '%s\n' "${CHANGED_FILES_CLAIM_RAW[@]}" \
       | sed -E 's/ \(\+[0-9]+ -[0-9]+\)$//' \
       | sort -u)
     DELTA_SORTED=$(printf '%s\n' "${DELTA[@]}" | sort -u)
     if [[ "$CLAIM" != "$DELTA_SORTED" ]]; then
       execution_status=error
       error_reason="files_changed claim != content-aware delta"
     fi
     ```
   - **REVERTED symmetric check** — 서브에이전트가 기존 파일 revert 시 감지:
     ```bash
     # PRE_ALL에 있었는데 POST_ALL에서 사라진 파일 (content-aware가 DELTA에 안 잡음)
     REVERTED=$(comm -23 \
       <(printf '%s\n' "$PRE_MODIFIED" "$PRE_UNTRACKED" | sort -u | sed '/^$/d') \
       <(printf '%s\n' "$POST_MODIFIED" "$POST_UNTRACKED" | sort -u | sed '/^$/d'))
     [[ -n "$REVERTED" ]] && { execution_status=error; error_reason="subagent reverted pre-existing changes: $REVERTED"; }
     ```
   - `log_path` 존재 가드:
     ```bash
     [[ ! -f "$log_path" ]] && { log_unavailable=true; execution_status=error; }
     ```
   - 실패 항목은 `Read(log_path)` — `ITEM-{id}` 구분자로 구간 확인.
   - **검증 통과 시**: `CHANGED_FILES=("${DELTA[@]}")` 확정.
6. **그룹 커밋 — pathspec-limited** (spec §5.4.8): 전원 PASS AND Step 5 검증 통과 시에만:
   - 빈 배열 가드: `[[ ${#CHANGED_FILES[@]} -eq 0 ]]`면 이상 상태 → `execution_status=error`.
   - **Untracked 신규 파일 명시적 add** (NUL-safe, E5-adjacent):
     ```bash
     # bash 3.2 호환: PRE_HASH_FILE TSV lookup (C4)
     while IFS= read -r f; do
       [[ -z "$f" ]] && continue
       pre_hash=$(awk -F'\t' -v p="$f" '$1 == p { print $2; exit }' "$PRE_HASH_FILE")
       # 신규 untracked 파일 (PRE에 없었음) 에만 git add
       if [[ -z "$pre_hash" || "$pre_hash" == "absent" ]]; then
         git add -- "$f"
       fi
     done < <(printf '%s\n' "${CHANGED_FILES[@]}")
     ```
   - **Pre-staged 경고** (E3 fix — 올바른 `:(exclude)` 확장):
     ```bash
     # EXCL 배열을 for 루프로 구성 (":(exclude)${arr[@]}"는 첫 요소에만 prefix 붙는 버그 회피)
     EXCL=()
     for f in "${CHANGED_FILES[@]}"; do EXCL+=(":(exclude)$f"); done
     if ! git diff --cached --quiet -- . "${EXCL[@]}" 2>/dev/null; then
       echo "⚠ Phase 6 범위 외에 pre-staged 파일이 감지됐습니다:"
       git -c core.quotepath=false diff --cached --name-only -- . "${EXCL[@]}" || true
       echo "→ 이 파일들은 인덱스에 staged로 남지만 이 커밋에는 포함되지 않습니다 (git commit --only 의미론)."
     fi
     ```
   - **Same-file pre-staged hunk 경고** — `git commit --only path`는 path 전체를 커밋하므로 사용자가 미리 staged한 hunk가 같은 path에 있으면 auto-commit에 섞임:
     ```bash
     SAMEFILE_PRESTAGED=()
     for f in "${CHANGED_FILES[@]}"; do
       if git diff --cached --quiet -- "$f" 2>/dev/null; then :; else
         SAMEFILE_PRESTAGED+=("$f")
       fi
     done
     if [[ ${#SAMEFILE_PRESTAGED[@]} -gt 0 ]]; then
       echo "⚠ CHANGED_FILES 내 파일에 pre-staged hunk가 있습니다 — auto-commit에 pre-staged 변경과 Phase 6 수정이 함께 포함됩니다:"
       printf '  %s\n' "${SAMEFILE_PRESTAGED[@]}"
       # AskUserQuestion: continue (merge) / abort (skip commit, user 수동 판단)
     fi
     ```
   - **커밋** — `-m`은 `--` **앞에**:
     ```bash
     git commit --only -m "fix(review-response): resolve {severity} items from {report_basename}" -- "${CHANGED_FILES[@]}"
     ```
   - **금지**: `git add -A`, `git commit` (pathspec 없이), `git commit --only -- <paths> -m <msg>` (`-m`이 pathspec으로 파싱됨).
   - 부분 실패/halted/error 그룹은 커밋 건너뜀. response.md에 "워킹 트리에 passed 항목 수정 남음" 경고 기록.
7. **Dirty recovery — per-file content baseline** (spec §5.4.9, E5 검증):
   - `git status --porcelain=v1 -uall` 로 POST_STATUS 수집, `PRE_STATUS != POST_STATUS` 이면 dirty 상태 남음.
   - AskUserQuestion:
     > "서브에이전트가 dirty 상태로 중단됐습니다. 어떻게 할까요?
     > (1) 유지하고 main 계속 (partial edits 위에 쌓음 — 권장 안 함)
     > (2) baseline으로 restore (**per-file content snapshot 사용** — 사용자 WIP 보존)
     > (3) 중단, 사용자 수동 판단"
   - (2) 선택 시 — **`git restore --source=HEAD` 사용 금지** (pre-existing WIP 파괴). 대신 Step 3에서 저장한 per-file baseline 과 tracking-state 로 **worktree + index 양쪽**을 PRE 상태로 복원 (W4/C5 교정: subagent 가 `git add`/`git mv`/`git rm` 로 index 를 건드렸을 수 있고, PRE 상태가 "untracked" 와 "tracked-but-deleted" 두 가지가 있음 — 구분 필수):
     ```bash
     # W7 교정: Phase 6 진입 전부터 staged hunk 가 있던 ALLOWED 경로를 사용자에게 경고.
     # git restore --staged 는 partial-hunk staging state 까지 un-stage 하므로.
     PRE_STAGED_ALLOWED=()
     while IFS=$'\t' read -r f had_staged; do
       [[ -z "$f" ]] && continue
       [[ "$had_staged" == "true" ]] && PRE_STAGED_ALLOWED+=("$f")
     done < "$PRE_STAGED_FILE"
     if [[ ${#PRE_STAGED_ALLOWED[@]} -gt 0 ]]; then
       echo "⚠ 다음 ALLOWED 경로는 Phase 6 진입 전부터 staged hunk 가 있었습니다 — recovery 시 git restore --staged 로 함께 un-stage 됩니다:"
       printf '  %s\n' "${PRE_STAGED_ALLOWED[@]}"
       echo "→ response.md 복원 로그에 기록. 복구하려면 'git add' 또는 'git add -p' 로 재-stage 하세요."
     fi

     # bash 3.2 호환: PRE_TRACKED_FILE TSV iterate (C4)
     # C5 교정: PRE 의 "tracked 여부" 에 따라 index 복원 분기.
     while IFS=$'\t' read -r f pre_tracked; do
       [[ -z "$f" ]] && continue

       if [[ "$pre_tracked" == "true" ]]; then
         # tracked 였던 경로: index 를 HEAD 상태로 되돌림 (subagent 의 git add/rm 무효화).
         # PRE 가 "unstaged delete" 여도 이 후 worktree rm 으로 같은 상태 재구성.
         git restore --staged -- "$f" 2>/dev/null || true
       else
         # untracked 였던 경로: subagent 가 add 한 경우 index 에서 제거.
         git rm --cached --ignore-unmatch -- "$f" >/dev/null 2>&1 || true
       fi

       # 이어서 worktree 복원
       baseline=".deep-review/tmp/phase6-${severity}-baseline/$f"
       if [[ -f "$baseline" ]]; then
         mkdir -p "$(dirname "$f")"
         cp -p "$baseline" "$f"
       else
         # baseline 없음 = PRE 에 worktree 파일이 없었음.
         # 두 가지 경우: (a) tracked-but-deleted WIP, (b) untracked-absent.
         # 둘 다 "worktree 에 파일이 없는 상태" 가 원본이므로 현재 worktree 파일 제거.
         [[ -f "$f" ]] && rm -f "$f"
       fi
     done < "$PRE_TRACKED_FILE"
     ```
     - **주의 (W7)**: `git restore --staged` 는 사용자가 Phase 6 진입 전 `git add -p` 등으로 만든 partial-hunk staging state 도 함께 un-stage 한다. `$PRE_STAGED_ALLOWED` 목록으로 사전에 경고하고 response.md 에 기록하므로 사용자가 `git add -p` 를 재실행해 복구 가능. 완전한 staged-blob 단위 복원은 v1.3.5 후보 (W7 full snapshot).
   - (3) 선택 시 response.md에 현재 상태 snapshot 기록 후 종료.
8. **중단 판정** (spec §6.3 참고): `execution_status in (halted_on_regression, error)` 또는 `items_failed > 0`이면 다음 그룹 dispatch 안 함. 스킵된 후속 항목은 `decision: DEFER, defer_reason: "halted at {severity} group"`로 기록.

**Main fallback 분기** (dispatch 실패):

1. 경고 출력: `⚠ phase6-implementer dispatch 실패 ({reason}). 세션 내 fallback 실행으로 전환합니다.`
2. **Context 여력 안전장치** — 남은 미처리 항목 수(현재 그룹 + 후속 그룹) ≥ 5 이면 AskUserQuestion:
   > (1) 여기까지 — 남은 항목을 DEFER로 기록 후 종료 / (2) 계속 진행 (context 소진 위험).
3. (1) 선택: 남은 항목 `decision: DEFER, defer_reason: "dispatch failure, main context conservation"`로 기록하고 Step 3으로.
4. (2) 또는 N < 5: main이 직접 receiving-review Phase 6 로직으로 구현 (한 항목씩, 매 항목 테스트, 회귀 시 즉시 중단).
5. response.md Summary `execution_path` 필드에 `main_fallback` 또는 `mixed` 기록 (스펙 §5.4 결정표 참조).

**`execution_path` 값 결정**:

| 시나리오 | 값 |
|---------|-----|
| 전 그룹 subagent 성공 | `subagent` |
| 1st dispatch 시도부터 실패 | `main_fallback` |
| 일부 subagent + 일부 fallback | `mixed` |
| ACCEPT 0건 | `n/a` |

### 3. Response 리포트 저장

`.deep-review/responses/` 디렉토리가 없으면 생성:
```bash
mkdir -p .deep-review/responses
```

Response 리포트를 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 저장.

### 4. Re-review 제안

"대응이 완료되었습니다. `/deep-review`를 재실행하여 변경사항을 검증하시겠습니까?"
