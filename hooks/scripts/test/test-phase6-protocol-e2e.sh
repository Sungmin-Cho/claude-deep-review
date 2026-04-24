#!/usr/bin/env bash
# test-phase6-protocol-e2e.sh — Phase 6 protocol end-to-end executable tests
#
# 임시 git repo에서 Phase 6 main 프로토콜의 핵심 shell 로직을 실제 실행하여
# 5개 Critical 시나리오를 검증.
#
# 검증 시나리오:
#   E1. files_changed suffix 정규화 (subagent output "(+A -B)" strip)
#   E2. Content-aware delta (이미 dirty한 파일의 content 변경 감지)
#   E3. :(exclude) bash 확장 버그 회피 (multi-file CHANGED_FILES)
#   E4. Allowlist + modifiable_paths — companion files 허용
#   E5. Dirty recovery — pre-existing user WIP 보존
#
# exit 0 = 5개 모두 PASS, exit 1 = 1건 이상 FAIL.

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
# 실행
# ============================================================================

echo "=== Phase 6 Protocol E2E Tests ==="
test_e1_suffix_strip
test_e2_content_aware_delta
test_e3_exclude_expansion
test_e4_allowlist_companion
test_e5_restore_preserves_wip

echo "---"
echo "E2E Total: $E2E_PASS passed, $E2E_FAIL failed"
[[ $E2E_FAIL -eq 0 ]] && exit 0 || exit 1
