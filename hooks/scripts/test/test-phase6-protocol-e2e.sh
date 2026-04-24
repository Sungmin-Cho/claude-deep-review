#!/usr/bin/env bash
# test-phase6-protocol-e2e.sh — Phase 6 protocol end-to-end executable tests
#
# 임시 git repo에서 Phase 6 main 프로토콜의 핵심 shell 로직을 실제 실행하여
# 11개 Critical 시나리오를 검증 (E1~E11).
#
# 검증 시나리오:
#   E1. files_changed suffix 정규화 (subagent output "(+A -B)" strip)
#   E2. Content-aware delta (이미 dirty한 파일의 content 변경 감지)
#   E3. :(exclude) bash 확장 버그 회피 (multi-file CHANGED_FILES)
#   E4. Allowlist + modifiable_paths — companion files 허용
#   E5. Dirty recovery — pre-existing user WIP 보존
#   E6. log_path shell quoting — 공백/특수문자 경로 생존
#   E7. Rename detection — --name-status -M 로 new path 추출
#   E8. Binary hash — git hash-object 로 binary content 변경 감지
#   E9. Allowlist bypass block — pre-existing dirty outside path 재수정 감지
#   E10. Recovery index sync — subagent git add 후 recovery 시 index 도 PRE 로 복원
#   E11. Recovery preserves tracked-but-deleted WIP — pre_tracked=true + baseline absent
#
# exit 0 = 11개 모두 PASS, exit 1 = 1건 이상 FAIL.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_PASS=0
E2E_FAIL=0
e2e_pass() { echo "E2E PASS [$1] $2"; E2E_PASS=$((E2E_PASS+1)); }
e2e_fail() { echo "E2E FAIL [$1] $2"; E2E_FAIL=$((E2E_FAIL+1)); }

# Create an isolated temporary git repo for each test
mk_tmp_repo() {
  local d
  d=$(mktemp -d "${TMPDIR:-/tmp}/p6-e2e.XXXXXX")
  (
    cd "$d"
    git init -q
    git config user.email "test@example.com"
    git config user.name "e2e test"
    git config commit.gpgsign false
  )
  echo "$d"
}

cleanup_tmp_repo() {
  rm -rf "$1"
}

# ============================================================================
# E1. files_changed suffix 정규화
# ============================================================================
# 기대: subagent가 "path/to/file.ts (+5 -2)" 형식으로 반환해도 main이 suffix를
# 벗겨서 path-only로 정규화. delta와 비교 가능해야 함.

test_e1_suffix_strip() {
  local name="E1"
  local input=$'src/auth/login.ts (+5 -2)\nsrc/auth/types.ts (+0 -3)'
  local expected=$'src/auth/login.ts\nsrc/auth/types.ts'
  local actual
  actual=$(printf '%s\n' "$input" | sed -E 's/ \(\+[0-9]+ -[0-9]+\)$//')

  if [[ "$actual" == "$expected" ]]; then
    e2e_pass "$name" "suffix stripped correctly"
  else
    e2e_fail "$name" "expected:\n$expected\n---\nactual:\n$actual"
  fi
}

# ============================================================================
# E2. Content-aware delta (dirty tree 지원)
# ============================================================================
# 시나리오:
#   1. a.txt 추적·커밋 ("v1")
#   2. 사용자가 a.txt를 "v2"로 수정 (dirty)
#   3. 서브에이전트가 a.txt를 "v3"로 추가 수정
#   4. path-membership delta: POST - PRE = {} (잘못 — a.txt는 이미 dirty였음)
#   5. content-aware delta (hash 기반): hash(v2) != hash(v3) → a.txt in DELTA

test_e2_content_aware_delta() {
  local name="E2"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    echo "v2" > a.txt   # 사용자 WIP

    # PRE snapshot — candidate: a.txt
    local pre_hash
    pre_hash=$(git hash-object -- a.txt)

    # dispatch 시뮬레이션: 서브에이전트가 a.txt를 v3로 수정
    echo "v3" > a.txt

    # POST
    local post_hash
    post_hash=$(git hash-object -- a.txt)

    # path-only delta — dirty였으므로 a.txt는 PRE에도 POST에도 존재
    local path_delta
    path_delta=$(comm -13 \
      <(git diff --name-only 2>/dev/null | sort -u) \
      <(git diff --name-only 2>/dev/null | sort -u))
    # (PRE snapshot을 위 디지털로 정확히 재현하려면 별도 저장 필요. 여기선 단순화:
    # path-based delta는 동일 세트 비교로 "비어있다"고 증명)

    # content-aware delta — hash 비교
    if [[ "$pre_hash" != "$post_hash" ]]; then
      echo "__CONTENT_DELTA_DETECTED__"
    fi
  ) > "$repo/.out" 2>&1

  if grep -q "__CONTENT_DELTA_DETECTED__" "$repo/.out"; then
    e2e_pass "$name" "content-aware delta detected a.txt change despite dirty PRE state"
  else
    e2e_fail "$name" "content-aware delta missed the change"
  fi

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# E3. :(exclude) bash expansion 버그 회피
# ============================================================================
# 기대: CHANGED_FILES=(a.txt b.txt) 에 대해 pathspec 배열이 올바르게 구성됨.
# 잘못된 패턴: ":(exclude)${CHANGED_FILES[@]}" — 첫 요소에만 prefix
# 올바른 패턴: for 루프로 EXCL=(:(exclude)a.txt :(exclude)b.txt)

test_e3_exclude_expansion() {
  local name="E3"
  local CHANGED_FILES=("a.txt" "b.txt")

  # WRONG — bash concatenation applies to first element only
  local -a WRONG_EXCL
  # shellcheck disable=SC2145
  WRONG_EXCL=(":(exclude)${CHANGED_FILES[@]}")
  # Verify WRONG_EXCL has ":(exclude)a.txt" but also "b.txt" separately (2 elements, second unprefixed)
  # The array expands to ":(exclude)a.txt" "b.txt" — so length 2, [1] = "b.txt"
  local wrong_second="${WRONG_EXCL[1]}"

  # CORRECT — explicit loop
  local -a CORRECT_EXCL=()
  for f in "${CHANGED_FILES[@]}"; do
    CORRECT_EXCL+=(":(exclude)$f")
  done
  local correct_second="${CORRECT_EXCL[1]}"

  if [[ "$wrong_second" == "b.txt" && "$correct_second" == ":(exclude)b.txt" ]]; then
    e2e_pass "$name" "explicit loop fix produces correctly-prefixed pathspec array"
  else
    e2e_fail "$name" "wrong_second='$wrong_second' correct_second='$correct_second'"
  fi
}

# ============================================================================
# E4. Allowlist + modifiable_paths (companion files)
# ============================================================================
# 기대: target_location=src/auth/login.ts + modifiable_paths=tests/auth/login.test.ts
# 일 때 양쪽 모두 allowlist 통과. 제3의 경로(src/unrelated.ts)는 violation.

test_e4_allowlist_companion() {
  local name="E4"
  local -a TARGET_LOCATIONS=("src/auth/login.ts")
  local -a MODIFIABLE_PATHS=("tests/auth/login.test.ts")
  local -a DELTA=("src/auth/login.ts" "tests/auth/login.test.ts")
  local -a DELTA_WITH_VIOLATION=("src/auth/login.ts" "src/unrelated.ts")

  # ALLOWED = target_location ∪ modifiable_paths
  local ALLOWED
  ALLOWED=$(printf '%s\n' "${TARGET_LOCATIONS[@]}" "${MODIFIABLE_PATHS[@]}" | sort -u)

  # Check 1: DELTA (companion 포함) 통과해야 함
  local outside1
  outside1=$(comm -23 <(printf '%s\n' "${DELTA[@]}" | sort -u) <(echo "$ALLOWED"))

  # Check 2: DELTA_WITH_VIOLATION (무관 파일 포함) 차단해야 함
  local outside2
  outside2=$(comm -23 <(printf '%s\n' "${DELTA_WITH_VIOLATION[@]}" | sort -u) <(echo "$ALLOWED"))

  if [[ -z "$outside1" && "$outside2" == "src/unrelated.ts" ]]; then
    e2e_pass "$name" "allowlist accepts companion + rejects unauthorized path"
  else
    e2e_fail "$name" "check1 outside='$outside1' (should be empty), check2 outside='$outside2' (should be 'src/unrelated.ts')"
  fi
}

# ============================================================================
# E5. Dirty recovery — pre-existing user WIP 보존
# ============================================================================
# 시나리오:
#   1. a.txt HEAD="v1"
#   2. 사용자 WIP: a.txt = "v2" (uncommitted)
#   3. Pre-dispatch baseline snapshot: .deep-review/tmp/phase6-baseline/a.txt = "v2"
#   4. 서브에이전트 a.txt = "v3"
#   5. Recovery: snapshot에서 복원 → a.txt 가 "v2"로 돌아가야 함 (HEAD "v1"이 아님)
#
# 잘못된 방식: git restore --source=HEAD → "v1"로 돌아가 사용자 WIP 손실
# 올바른 방식: per-file content snapshot 사용

test_e5_restore_preserves_wip() {
  local name="E5"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    echo "v2" > a.txt   # 사용자 WIP

    # Pre-dispatch baseline: content snapshot (allowed paths에 대해서만)
    mkdir -p .deep-review/tmp/phase6-baseline
    cp a.txt .deep-review/tmp/phase6-baseline/a.txt

    # Dispatch 시뮬레이션
    echo "v3" > a.txt

    # Recovery (올바른 방식): snapshot 복원
    cp .deep-review/tmp/phase6-baseline/a.txt a.txt

    # 검증: a.txt 내용이 "v2" (사용자 WIP) 여야 함
    cat a.txt
  ) > "$repo/.out" 2>&1

  local restored
  restored=$(cat "$repo/a.txt")
  if [[ "$restored" == "v2" ]]; then
    e2e_pass "$name" "content-snapshot restore preserved user WIP (v2), not HEAD (v1)"
  else
    e2e_fail "$name" "expected v2, got '$restored'"
  fi

  # Demonstration that git restore --source=HEAD destroys WIP (educational)
  local repo2
  repo2=$(mk_tmp_repo)
  (
    cd "$repo2" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    echo "v2" > a.txt  # WIP
    echo "v3" > a.txt  # subagent
    git restore --source=HEAD -- a.txt
    cat a.txt
  ) > "$repo2/.out" 2>&1

  local head_restored
  head_restored=$(cat "$repo2/a.txt")
  if [[ "$head_restored" == "v1" ]]; then
    echo "  (verified negative: git restore --source=HEAD discarded WIP → '$head_restored')"
  fi
  cleanup_tmp_repo "$repo2"

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# E6. log_path shell quoting — 공백/특수문자 경로 생존
# ============================================================================
# 시나리오:
#   1. 공백 포함 log_path: "<repo>/my log dir/phase6-critical.log"
#   2. Agent가 literal + single-quote wrap 패턴으로 tee 실행 → 경로 보존
#   3. 같은 경로에 unquoted로 전달 시 tee가 path를 split → 의도한 파일 미생성 (negative)
#
# 실행 의미론 검증: 최종 bash 명령이 path를 single-quoted arg로 받아야 한다.

test_e6_log_path_quoting() {
  local name="E6"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    mkdir -p "my log dir"
    local log_path="$repo/my log dir/phase6-critical.log"

    # Agent 패턴 재현: log_path를 single-quote로 감싸 literal substitute.
    # Bash parameter substitution으로 경로 내 `'`를 `'\''`로 이스케이프
    # (이 테스트의 path엔 없지만 agent 계약의 일반 규칙과 정합).
    local escaped="${log_path//\'/\'\\\'\'}"
    bash -c "echo 'START' 2>&1 | tee -a '$escaped'" >/dev/null
    bash -c "echo 'END'   2>&1 | tee -a '$escaped'" >/dev/null
  ) > "$repo/.out" 2>&1

  if [[ -f "$repo/my log dir/phase6-critical.log" ]]; then
    local line_count
    line_count=$(wc -l < "$repo/my log dir/phase6-critical.log" | tr -d ' ')
    if [[ "$line_count" == "2" ]]; then
      e2e_pass "$name" "single-quote wrap preserved log_path with spaces"
    else
      e2e_fail "$name" "log file created but line count=$line_count (expected 2)"
    fi
  else
    e2e_fail "$name" "log file not created at '$repo/my log dir/phase6-critical.log'"
  fi

  # Negative: unquoted path → tee가 3개 인자로 split, 의도한 파일 미생성
  local repo2
  repo2=$(mk_tmp_repo)
  (
    cd "$repo2" || exit 1
    mkdir -p "my log dir"
    local log_path="$repo2/my log dir/phase6-critical.log"
    bash -c "echo hi 2>&1 | tee -a $log_path" >/dev/null 2>&1 || true
  ) > "$repo2/.out" 2>&1

  if [[ ! -f "$repo2/my log dir/phase6-critical.log" ]]; then
    echo "  (verified negative: unquoted path did not create intended file under 'my log dir/')"
  fi
  cleanup_tmp_repo "$repo2"

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# E7. Rename detection — --name-status -M 로 new path 추출
# ============================================================================
# 기대: staged rename (git mv) 시 --name-status -M 결과의 R status 라인에서
# new path가 정상 추출. PRE_MODIFIED 정규화 awk 로직이 old path 대신 new path를
# 채택해야 함.

test_e7_rename_detection() {
  local name="E7"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    git mv a.txt b.txt   # git mv는 자동 staged. unstaged diff에는 안 보임.

    # commands Step 3/5의 PRE_MODIFIED/POST_MODIFIED 정규화 로직 재현.
    # staged + unstaged 합집합 — production과 동일 명령 조합 (C1 교정).
    { git -c core.quotepath=false diff --name-status -M;
      git -c core.quotepath=false diff --cached --name-status -M; } \
    | awk -F'\t' '
        $1 ~ /^[RC]/ { print $3; next }
        $1 != "" { print $2 }
      ' | sort -u
  ) > "$repo/.out" 2>&1

  local detected
  detected=$(grep -v "^$" "$repo/.out" | head -1)
  local count
  count=$(grep -cv "^$" "$repo/.out")

  # 정확히 'b.txt' 1개만 출력되어야 — 'a.txt' (old path)도 섞이면 계약 위반
  if [[ "$detected" == "b.txt" && "$count" == "1" ]]; then
    e2e_pass "$name" "staged rename 'git mv' detected as new path 'b.txt' via --cached union (staged + unstaged)"
  else
    e2e_fail "$name" "expected 1 line 'b.txt', got count=$count first='$detected'"
  fi

  # Negative: awk R/C 분기 제거 시 old path 'a.txt'도 포함되는지 확인 (계약 차별성)
  local repo2
  repo2=$(mk_tmp_repo)
  (
    cd "$repo2" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    git mv a.txt b.txt
    # awk 미적용 raw 출력
    { git -c core.quotepath=false diff --name-status -M;
      git -c core.quotepath=false diff --cached --name-status -M; }
  ) > "$repo2/.out" 2>&1

  # Portability: GNU grep -E 는 `\t` 를 literal backslash-t 로 해석하지만
  # BSD grep (macOS) 는 tab 으로 해석 → awk -F'\t' 로 구분해 양쪽에서 동일 동작.
  if awk -F'\t' '$1 ~ /^R[0-9]+$/ && $2 == "a.txt" && $3 == "b.txt" { found=1 } END { exit !found }' "$repo2/.out"; then
    echo "  (verified negative: raw --name-status -M contains 'R100<TAB>a.txt<TAB>b.txt' — awk R/C branch is required to select new path)"
  else
    e2e_fail "$name-neg" "raw --name-status -M should contain R-line with old→new but did not; awk R/C branch contract cannot be proven"
  fi
  cleanup_tmp_repo "$repo2"

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# E8. Binary content hash
# ============================================================================
# 기대: binary 파일(NUL byte 포함)도 git hash-object가 content hash를 반환하므로
# 내용 변경 시 PRE/POST hash 차이 → DELTA 검출 흐름이 그대로 동작.

test_e8_binary_hash() {
  local name="E8"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    # NUL byte + non-printable 포함 binary
    printf 'binary\0content\x01' > bin.dat
    git add bin.dat && git commit -q -m "init bin"
    local pre_hash
    pre_hash=$(git hash-object -- bin.dat)

    # 내용 변경
    printf 'binary\0content\x02' > bin.dat
    local post_hash
    post_hash=$(git hash-object -- bin.dat)

    if [[ "$pre_hash" != "$post_hash" ]]; then
      echo "__BINARY_HASH_CHANGED__"
    else
      echo "__UNCHANGED__ pre=$pre_hash post=$post_hash"
    fi
  ) > "$repo/.out" 2>&1

  if grep -q "__BINARY_HASH_CHANGED__" "$repo/.out"; then
    e2e_pass "$name" "git hash-object detected binary content mutation"
  else
    e2e_fail "$name" "binary hash unchanged: $(cat "$repo/.out")"
  fi

  # Negative: 같은 값 overwrite 시 hash 동일 → DELTA 미포함 (계약 차별성)
  local repo2
  repo2=$(mk_tmp_repo)
  (
    cd "$repo2" || exit 1
    printf 'binary\0content\x01' > bin.dat
    git add bin.dat && git commit -q -m "init bin"
    local pre_hash post_hash
    pre_hash=$(git hash-object -- bin.dat)
    printf 'binary\0content\x01' > bin.dat   # 동일 값 overwrite
    post_hash=$(git hash-object -- bin.dat)
    [[ "$pre_hash" == "$post_hash" ]] && echo "__SAME_HASH__"
  ) > "$repo2/.out" 2>&1

  if grep -q "__SAME_HASH__" "$repo2/.out"; then
    echo "  (verified negative: identical binary content yields identical hash → excluded from DELTA)"
  else
    e2e_fail "$name-neg" "identical overwrite should yield identical hash; contract differentiation cannot be proven"
  fi
  cleanup_tmp_repo "$repo2"

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# E9. Allowlist bypass block — pre-existing dirty outside path 재수정 감지
# ============================================================================
# 시나리오 (v1.3.4 review C3 재현 후 교정 실증):
#   1. allowed.ts, outside.ts 모두 커밋된 상태
#   2. outside.ts 를 pre-existing dirty (w2) — ALLOWED 에는 allowed.ts 만 있음
#   3. 서브에이전트가 allowed.ts 를 정상 수정 + outside.ts 를 추가 수정 (w3)
#   4. Path-membership 만으로는 NEW_PATHS=POST-PRE 에 outside.ts 가 안 잡힘
#      (이미 PRE 에 있었으므로). Content-hash 기반 PRE_OUTSIDE_HASH 로는 변화 감지.
#
# 기대: PRE_OUTSIDE_HASH[outside.ts] != POST hash → OUTSIDE_VIOLATIONS 에 추가.

test_e9_outside_dirty_mutation() {
  local name="E9"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    echo "v1" > allowed.ts
    echo "w1" > outside.ts
    git add . && git commit -q -m "init"
    echo "w2" > outside.ts   # pre-existing dirty, NOT in ALLOWED

    local ALLOWED="allowed.ts"

    # PRE: ALLOWED 밖 경로의 content hash 저장 (commands Step 3의 PRE_OUTSIDE_HASH)
    local pre_outside_hash
    pre_outside_hash=$(git hash-object -- outside.ts)

    # Subagent simulation: allowed.ts 정상 수정 + outside.ts 추가 수정
    echo "v2" > allowed.ts
    echo "w3" > outside.ts

    # POST: content hash 재계산 (commands Step 5의 OUTSIDE_VIOLATIONS 계산)
    local post_outside_hash
    post_outside_hash=$(git hash-object -- outside.ts)

    # Path-membership 은 놓친다 (positive control)
    local path_delta
    path_delta=$(comm -13 \
      <(git -c core.quotepath=false diff --name-only | sort -u) \
      <(git -c core.quotepath=false diff --name-only | sort -u))
    # (비어있을 수밖에 없지만 — 형식상 "NEW_PATHS 는 0 건" 을 보여주기 위함)

    # Content-hash diff 는 잡는다 (C3 교정)
    if [[ "$pre_outside_hash" != "$post_outside_hash" ]]; then
      echo "__OUTSIDE_VIOLATION_DETECTED__"
    fi
  ) > "$repo/.out" 2>&1

  if grep -q "__OUTSIDE_VIOLATION_DETECTED__" "$repo/.out"; then
    e2e_pass "$name" "pre-dirty outside path mutation flagged via content-hash (allowlist bypass blocked)"
  else
    e2e_fail "$name" "C3 regression: outside mutation not detected"
  fi

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# E10. Recovery — subagent git add 후 index 도 PRE 상태로 복원
# ============================================================================
# 시나리오 (v1.3.4 re-review W4 교정 실증):
#   1. a.txt=v1 committed, 사용자 WIP: a.txt=v2 (uncommitted, unstaged)
#   2. Pre-dispatch: baseline copy, PRE_HASH[a.txt]=hash(v2)
#   3. Subagent: a.txt=v3 + `git add a.txt` (index 에 v3 staged)
#   4. Recovery:
#      - `git restore --staged a.txt` → index 가 HEAD (v1) 로
#      - `cp baseline/a.txt a.txt` → worktree = v2
#   5. 기대: worktree=v2 (WIP 보존), index=v1 (HEAD), `git diff --cached` empty.

test_e10_recovery_index_sync() {
  local name="E10"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    echo "v2" > a.txt   # 사용자 WIP, unstaged

    # Pre-dispatch baseline
    mkdir -p .deep-review/tmp/phase6-baseline
    cp a.txt .deep-review/tmp/phase6-baseline/a.txt
    local pre_hash
    pre_hash=$(git hash-object -- a.txt)

    # Subagent simulation: v3 로 수정 + git add (index 에 staged v3)
    echo "v3" > a.txt
    git add -- a.txt

    # Recovery (W4 교정 경로): index 우선 PRE 상태로, 그 다음 worktree 복원
    # tracked 였던 파일 (PRE_HASH != "absent") → git restore --staged
    git restore --staged -- a.txt 2>/dev/null || true
    cp .deep-review/tmp/phase6-baseline/a.txt a.txt
  ) > "$repo/.out" 2>&1

  local worktree_content index_clean
  worktree_content=$(cat "$repo/a.txt")
  # a.txt 의 index 내용과 HEAD 내용 비교
  index_clean=$(cd "$repo" && git diff --cached --quiet -- a.txt && echo "yes" || echo "no")

  if [[ "$worktree_content" == "v2" && "$index_clean" == "yes" ]]; then
    e2e_pass "$name" "recovery restored worktree=v2 (WIP) and index=HEAD (subagent git add undone)"
  else
    e2e_fail "$name" "worktree='$worktree_content' (expect v2), index_clean='$index_clean' (expect yes)"
  fi

  cleanup_tmp_repo "$repo"
}


# ============================================================================
# E11. Recovery preserves tracked-but-deleted WIP state (pre_tracked=true + no baseline)
# ============================================================================
# 시나리오 (v1.3.4 3차 review C5 교정 실증):
#   1. a.txt committed (v1), 사용자 WIP: rm a.txt (unstaged delete, git status " D a.txt")
#   2. Pre-dispatch: PRE_TRACKED_FILE 에 "a.txt\ttrue", baseline 은 없음 (worktree 에 파일 없으므로)
#   3. Subagent: echo v2 > a.txt + git add a.txt
#   4. Recovery (C5):
#      - pre_tracked=true → git restore --staged (index → HEAD v1)
#      - baseline 없음 + worktree 에 파일 존재 → rm -f (worktree 삭제)
#   5. 기대: git status = " D a.txt" (unstaged delete — 사용자 원본 WIP)
#
# 2차 W4 fix 의 단순 "PRE_HASH=absent → git rm --cached" 로직은 이 경로에서
# "D  a.txt" (staged delete) 로 오염 — C5 교정이 PRE_TRACKED 분기로 해결.

test_e11_recovery_preserves_deleted_tracked() {
  local name="E11"
  local repo
  repo=$(mk_tmp_repo)
  (
    cd "$repo" || exit 1
    echo "v1" > a.txt
    git add a.txt && git commit -q -m "init"
    rm a.txt   # 사용자 WIP: unstaged delete

    # Pre-dispatch: PRE_TRACKED 저장 (worktree 존재 여부와 무관하게 ls-files 로 판정)
    mkdir -p .deep-review/tmp/phase6-baseline
    local pre_tracked_file=".deep-review/tmp/phase6-pre-tracked.tsv"
    : > "$pre_tracked_file"
    if git ls-files --error-unmatch -- a.txt >/dev/null 2>&1; then
      printf '%s\t%s\n' "a.txt" "true" >> "$pre_tracked_file"
    else
      printf '%s\t%s\n' "a.txt" "false" >> "$pre_tracked_file"
    fi
    # baseline: 파일이 없으므로 cp 생략

    # Subagent: recreate + git add
    echo "v2" > a.txt
    git add a.txt

    # Recovery (C5 교정 경로)
    while IFS=$'\t' read -r f pre_tracked; do
      [[ -z "$f" ]] && continue
      if [[ "$pre_tracked" == "true" ]]; then
        git restore --staged -- "$f" 2>/dev/null || true
      else
        git rm --cached --ignore-unmatch -- "$f" >/dev/null 2>&1 || true
      fi
      baseline=".deep-review/tmp/phase6-baseline/$f"
      if [[ -f "$baseline" ]]; then
        mkdir -p "$(dirname "$f")"
        cp -p "$baseline" "$f"
      else
        [[ -f "$f" ]] && rm -f "$f"
      fi
    done < "$pre_tracked_file"

    git status --porcelain -- a.txt
  ) > "$repo/.out" 2>&1

  local status_out
  status_out=$(cat "$repo/.out")
  # expected: " D a.txt" (unstaged delete — 사용자 원본 WIP state)
  if [[ "$status_out" == " D a.txt" ]]; then
    e2e_pass "$name" "tracked-but-deleted WIP (unstaged delete) preserved through recovery"
  else
    e2e_fail "$name" "expected ' D a.txt', got '$status_out'"
  fi

  cleanup_tmp_repo "$repo"
}

# ============================================================================
# 실행
# ============================================================================

echo "=== Phase 6 Protocol E2E Tests ==="
test_e1_suffix_strip
test_e2_content_aware_delta
test_e3_exclude_expansion
test_e4_allowlist_companion
test_e5_restore_preserves_wip
test_e6_log_path_quoting
test_e7_rename_detection
test_e8_binary_hash
test_e9_outside_dirty_mutation
test_e10_recovery_index_sync
test_e11_recovery_preserves_deleted_tracked

echo "---"
echo "E2E Total: $E2E_PASS passed, $E2E_FAIL failed"
[[ $E2E_FAIL -eq 0 ]] && exit 0 || exit 1
