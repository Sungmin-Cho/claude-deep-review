#!/usr/bin/env bash
# hooks/scripts/test/test-helpers.sh
# 공통 테스트 유틸 — tmpdir 격리 repo 생성/해제, assertion 함수

set -euo pipefail

TEST_TMPDIR=""
TEST_FAILURES=0
TEST_COUNT=0

setup_test_repo() {
  TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-test.XXXXXX")
  (
    cd "$TEST_TMPDIR"
    git init -q
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "initial" > seed.md
    git add seed.md
    git commit -q -m "init"
  )
  echo "$TEST_TMPDIR"
}

teardown_test_repo() {
  [ -n "${TEST_TMPDIR:-}" ] && [ -d "$TEST_TMPDIR" ] && rm -rf "$TEST_TMPDIR"
  TEST_TMPDIR=""
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local msg="${3:-assertion}"
  TEST_COUNT=$((TEST_COUNT + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✅ $msg"
  else
    TEST_FAILURES=$((TEST_FAILURES + 1))
    echo "  ❌ $msg: expected '$expected', got '$actual'"
  fi
}

assert_success() {
  local cmd="$1"
  local msg="${2:-command should succeed}"
  TEST_COUNT=$((TEST_COUNT + 1))
  if eval "$cmd" >/dev/null 2>&1; then
    echo "  ✅ $msg"
  else
    TEST_FAILURES=$((TEST_FAILURES + 1))
    echo "  ❌ $msg: '$cmd' failed"
  fi
}

assert_failure() {
  local cmd="$1"
  local msg="${2:-command should fail}"
  TEST_COUNT=$((TEST_COUNT + 1))
  if eval "$cmd" >/dev/null 2>&1; then
    TEST_FAILURES=$((TEST_FAILURES + 1))
    echo "  ❌ $msg: '$cmd' unexpectedly succeeded"
  else
    echo "  ✅ $msg"
  fi
}

test_summary() {
  echo ""
  echo "======================================"
  echo "Ran $TEST_COUNT assertions, $TEST_FAILURES failure(s)"
  if [ "$TEST_FAILURES" -eq 0 ]; then
    echo "✅ All tests passed"
    return 0
  else
    echo "❌ Some tests failed"
    return 1
  fi
}

# extract_anchor <file> <name>
# Emit the content BETWEEN `<!-- SSOT:<name> START -->` and `<!-- SSOT:<name> END -->`
# (marker lines excluded). Enforces: exactly one START + one END, START before END,
# non-empty body. (Repo-wide singleton + unanchored-copy drift are enforced separately
# by per-test grep guards — see spec §5.1 R2-e; this helper is the per-file extractor.)
extract_anchor() {
  local file="$1" name="$2"
  [ -f "$file" ] || { echo "extract_anchor: no such file: $file" >&2; return 1; }
  awk -v name="$name" '
    $0 == "<!-- SSOT:" name " START -->" { s++; if (s==1 && e==0) capturing=1; next }
    $0 == "<!-- SSOT:" name " END -->"   { e++; capturing=0; next }
    capturing { body = body $0 "\n" }
    END {
      if (s != 1 || e != 1) { print "extract_anchor: " name ": need exactly 1 START + 1 END (got S=" s " E=" e ")" > "/dev/stderr"; exit 1 }
      if (length(body) == 0) { print "extract_anchor: " name ": empty block" > "/dev/stderr"; exit 1 }
      printf "%s", body
    }
  ' "$file" | { body="$(cat)"; [ -n "$body" ] || return 1; printf '%s' "$body"; }
}

# assert_anchor_singleton <root> <name>
# repo-wide singleton 게이트 (spec §5.1): 추적 + untracked(비-ignored) 파일 전수에서
# START·END 가 각각 정확히 1회·동일 파일이면 0, 아니면 1.
# --untracked 필수 (실증 확인): (1) Task 2 Step 11(커밋 전)의 untracked review-execution.md 도
# 본다 — 일반 git grep 은 untracked 를 놓쳐 singleton 이 거짓 실패함. (2) gitignored docs/
# (플랜·스펙의 예시 마커)는 자동 제외 → false-count 없음.
assert_anchor_singleton() {
  local root="$1" name="$2" scount ecount sfile efile
  scount=$(git -C "$root" grep --untracked -F -e "<!-- SSOT:${name} START -->" -- '*.md' '*.sh' '*.js' 2>/dev/null | wc -l | tr -d ' ')
  ecount=$(git -C "$root" grep --untracked -F -e "<!-- SSOT:${name} END -->"   -- '*.md' '*.sh' '*.js' 2>/dev/null | wc -l | tr -d ' ')
  sfile=$(git -C "$root" grep --untracked -lF -e "<!-- SSOT:${name} START -->"  -- '*.md' '*.sh' '*.js' 2>/dev/null)
  efile=$(git -C "$root" grep --untracked -lF -e "<!-- SSOT:${name} END -->"    -- '*.md' '*.sh' '*.js' 2>/dev/null)
  [ "$scount" = "1" ] && [ "$ecount" = "1" ] && [ -n "$sfile" ] && [ "$sfile" = "$efile" ]
}
