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
