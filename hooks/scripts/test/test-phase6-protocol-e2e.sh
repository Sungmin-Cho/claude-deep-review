#!/usr/bin/env bash
# test-phase6-protocol-e2e.sh — Phase 6 protocol end-to-end executable tests
#
# 임시 git repo에서 Phase 6 main 프로토콜의 핵심 shell 로직을 실제 실행하여
# 8개 Critical 시나리오를 검증 (E1~E8).
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
#
# exit 0 = 8개 모두 PASS, exit 1 = 1건 이상 FAIL.

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

  if grep -qE '^R[0-9]+\ta.txt\tb.txt' "$repo2/.out"; then
    echo "  (verified negative: raw --name-status -M contains 'R100\ta.txt\tb.txt' — awk R/C branch is required to select new path)"
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

echo "---"
echo "E2E Total: $E2E_PASS passed, $E2E_FAIL failed"
[[ $E2E_FAIL -eq 0 ]] && exit 0 || exit 1
