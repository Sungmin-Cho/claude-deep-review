#!/usr/bin/env bash
# hooks/scripts/test/test-helpers.sh
# 공통 테스트 유틸 — tmpdir 격리 repo 생성/해제, assertion 함수

set -euo pipefail

TEST_TMPDIR=""
TEST_FAILURES=0
TEST_COUNT=0

setup_test_repo() {
  echo ">>> setup_test_repo: enter; PWD=$PWD" >&2
  TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-test.XXXXXX")
  echo ">>> setup_test_repo: mktemp OK; TEST_TMPDIR=$TEST_TMPDIR" >&2
  (
    cd "$TEST_TMPDIR"
    git init -q
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "initial" > seed.md
    git add seed.md
    git commit -q -m "init"
  )
  local sub_rc=$?
  echo ">>> setup_test_repo: subshell rc=$sub_rc" >&2
  echo "$TEST_TMPDIR"
}

teardown_test_repo() {
  echo ">>> teardown_test_repo: enter; PWD=$PWD TEST_TMPDIR=${TEST_TMPDIR:-(unset)}" >&2
  [ -n "${TEST_TMPDIR:-}" ] && [ -d "$TEST_TMPDIR" ] && rm -rf "$TEST_TMPDIR"
  local rc=$?
  echo ">>> teardown_test_repo: rm rc=$rc; PWD=$PWD (may be deleted)" >&2
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
