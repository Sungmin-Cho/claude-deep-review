#!/usr/bin/env bash
# hooks/scripts/test/test-detect-environment.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT=$(git rev-parse --show-toplevel)
DETECT_SCRIPT="$REPO_ROOT/hooks/scripts/detect-environment.sh"

echo "=== detect-environment.sh tests ==="

# Test: F1 sanity — openai-codex marketplace plugin detection (v1.3.2 retains fixed path)
MOCK_HOME=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-mock-home.XXXXXX")
mkdir -p "$MOCK_HOME/.claude/plugins/cache/openai-codex/codex/9.9.9/scripts"
cat > "$MOCK_HOME/.claude/plugins/cache/openai-codex/codex/9.9.9/scripts/codex-companion.mjs" <<'EOF'
// mock companion
EOF

repo=$(setup_test_repo)
cd "$repo"
output=$(HOME="$MOCK_HOME" bash "$DETECT_SCRIPT")
echo "$output" | grep -q "codex_plugin=true" && echo "  ✅ openai-codex plugin detected" \
  || { echo "  ❌ plugin should be detected"; TEST_FAILURES=$((TEST_FAILURES + 1)); }
TEST_COUNT=$((TEST_COUNT+1))
companion_path=$(echo "$output" | grep "^codex_companion_path=" | cut -d= -f2-)
assert_equal "$MOCK_HOME/.claude/plugins/cache/openai-codex/codex/9.9.9/scripts/codex-companion.mjs" \
  "$companion_path" "companion path is correct"
teardown_test_repo
rm -rf "$MOCK_HOME"

# Test: non-openai-codex marketplace → NOT detected (CR5: supply-chain boundary)
MOCK_HOME=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-mock-home.XXXXXX")
mkdir -p "$MOCK_HOME/.claude/plugins/cache/some-other-source/codex/9.9.9/scripts"
cat > "$MOCK_HOME/.claude/plugins/cache/some-other-source/codex/9.9.9/scripts/codex-companion.mjs" <<'EOF'
// mock
EOF
repo=$(setup_test_repo)
cd "$repo"
output=$(HOME="$MOCK_HOME" bash "$DETECT_SCRIPT")
echo "$output" | grep -q "codex_plugin=false" && echo "  ✅ non-openai-codex rejected (CR5 boundary)" \
  || { echo "  ❌ non-openai-codex must not be trusted"; TEST_FAILURES=$((TEST_FAILURES + 1)); }
TEST_COUNT=$((TEST_COUNT+1))
teardown_test_repo
rm -rf "$MOCK_HOME"

# === F2: node_available 테스트 ===
echo ""
echo "=== F2 node_available tests ==="

# Test: node_available field emitted in main branch (git + commits)
repo=$(setup_test_repo)
cd "$repo"
output=$(bash "$DETECT_SCRIPT")
echo "$output" | grep -q "^node_available=" && echo "  ✅ node_available field emitted" \
  || { echo "  ❌ node_available field missing in main branch"; TEST_FAILURES=$((TEST_FAILURES + 1)); }
TEST_COUNT=$((TEST_COUNT+1))
# Actual node presence
expected_node=$(command -v node >/dev/null 2>&1 && echo "true" || echo "false")
node_line=$(echo "$output" | grep "^node_available=")
assert_equal "node_available=$expected_node" "$node_line" "main branch reflects real node presence"
teardown_test_repo

# Test (CR7): node_available must appear in no-commits branch with real detection
initial_repo=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-initial.XXXXXX")
(cd "$initial_repo" && git init -q)
cd "$initial_repo"
output=$(bash "$DETECT_SCRIPT")
node_line=$(echo "$output" | grep "^node_available=")
assert_equal "node_available=$expected_node" "$node_line" "CR7: no-commits branch uses real detection (not hardcoded)"
rm -rf "$initial_repo"

# Test (CR7): non-git directory also emits node_available with real detection
nongit=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-nongit.XXXXXX")
cd "$nongit"
output=$(bash "$DETECT_SCRIPT")
node_line=$(echo "$output" | grep "^node_available=")
assert_equal "node_available=$expected_node" "$node_line" "CR7: non-git branch uses real detection"
rm -rf "$nongit"

# === F4: codex_installed deprecation comment ===
echo ""
echo "=== F4 deprecation ==="

# Deprecation note must be present in source
grep -q "DEPRECATED" "$DETECT_SCRIPT" && echo "  ✅ F4 deprecation note present" \
  || { echo "  ❌ F4 deprecation note missing"; TEST_FAILURES=$((TEST_FAILURES + 1)); }
TEST_COUNT=$((TEST_COUNT+1))

# codex_installed field still emitted (backward-compat)
repo=$(setup_test_repo)
cd "$repo"
output=$(bash "$DETECT_SCRIPT")
echo "$output" | grep -q "^codex_installed=" && echo "  ✅ codex_installed still emitted (backward-compat)" \
  || { echo "  ❌ codex_installed must remain until v1.4.0"; TEST_FAILURES=$((TEST_FAILURES + 1)); }
TEST_COUNT=$((TEST_COUNT+1))
teardown_test_repo

# === agy detection tests ===
echo ""
echo "=== agy detection tests ==="

assert_agy_present() {
  local context="$1"
  local out="$2"
  local ok=0
  for key in agy_cli agy_cli_path agy_version; do
    if ! echo "$out" | grep -q "^${key}="; then
      echo "  ❌ $context: missing $key" >&2
      TEST_FAILURES=$((TEST_FAILURES + 1))
      ok=1
    fi
  done
  TEST_COUNT=$((TEST_COUNT + 1))
  [ "$ok" -eq 0 ] && echo "  ✅ $context: agy_cli / agy_cli_path / agy_version all emitted"
  return 0
}

# Path 1: normal commits (this repo itself)
repo=$(setup_test_repo)
cd "$repo"
out=$(bash "$DETECT_SCRIPT" 2>&1)
assert_agy_present "normal-commits" "$out"
teardown_test_repo

# Path 2: non-git directory
tmp=$(mktemp -d)
(
  cd "$tmp"
  out=$(bash "$DETECT_SCRIPT" 2>&1)
  assert_agy_present "non-git" "$out"
)
rm -rf "$tmp"

# Path 3: initial-repo (git init only, no commits)
tmp=$(mktemp -d)
(
  cd "$tmp"
  git init -q
  out=$(bash "$DETECT_SCRIPT" 2>&1)
  assert_agy_present "initial-repo" "$out"
)
rm -rf "$tmp"

# Path 4: agy absent (PATH stripped) → expect agy_cli=false
out=$(PATH="/usr/bin:/bin" bash "$DETECT_SCRIPT" 2>&1)
if echo "$out" | grep -q '^agy_cli=false'; then
  echo "  ✅ agy absent: agy_cli=false correctly emitted"
else
  echo "  ❌ agy absent path did not emit agy_cli=false"
  TEST_FAILURES=$((TEST_FAILURES + 1))
fi
TEST_COUNT=$((TEST_COUNT + 1))

test_summary
