#!/usr/bin/env bash
# test-detect-environment.sh — verify agy_* emitted on all 3 detection paths
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DETECT="$REPO/hooks/scripts/detect-environment.sh"

assert_agy_present() {
  local context="$1"
  local out="$2"
  for key in agy_cli agy_cli_path agy_version; do
    if ! echo "$out" | grep -q "^${key}="; then
      echo "FAIL: $context: missing $key" >&2
      return 1
    fi
  done
  echo "PASS: $context"
}

# Path 1: normal commits (this repo itself)
out=$(bash "$DETECT" 2>&1)
assert_agy_present "normal-commits" "$out"

# Path 2: non-git directory
tmp=$(mktemp -d)
( cd "$tmp" && out=$(bash "$DETECT" 2>&1) && assert_agy_present "non-git" "$out" )
rm -rf "$tmp"

# Path 3: initial-repo (git init only, no commits)
tmp=$(mktemp -d)
( cd "$tmp" && git init -q && out=$(bash "$DETECT" 2>&1) && assert_agy_present "initial-repo" "$out" )
rm -rf "$tmp"

# Path 4 (bonus): agy absent (PATH stripped)
out=$(PATH="/usr/bin:/bin" bash "$DETECT" 2>&1)
if echo "$out" | grep -q '^agy_cli=false'; then
  echo "PASS: agy absent (agy_cli=false correctly emitted)"
else
  echo "FAIL: agy absent path did not emit agy_cli=false"
  exit 1
fi

echo "ALL PASS"
