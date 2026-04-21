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

test_summary
