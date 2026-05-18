#!/usr/bin/env bash
# Regression tests for the Codex -> Claude reviewer bridge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT=$(git rev-parse --show-toplevel)
DETECT_SCRIPT="$REPO_ROOT/hooks/scripts/detect-environment.sh"
RUNNER="$REPO_ROOT/hooks/scripts/run-claude-reviewer.sh"

echo "=== Codex Claude reviewer bridge tests ==="

expected_claude="false"
expected_claude_path=""
if command -v claude >/dev/null 2>&1; then
  expected_claude="true"
  expected_claude_path="$(command -v claude)"
fi

repo=$(setup_test_repo)
cd "$repo"
output=$(bash "$DETECT_SCRIPT")
claude_line=$(echo "$output" | grep "^claude_cli=" || true)
assert_equal "claude_cli=$expected_claude" "$claude_line" "detect emits claude_cli"
claude_path_line=$(echo "$output" | grep "^claude_cli_path=" || true)
assert_equal "claude_cli_path=$expected_claude_path" "$claude_path_line" "detect emits claude_cli_path"
teardown_test_repo

TEST_COUNT=$((TEST_COUNT + 1))
if [ -x "$RUNNER" ]; then
  echo "  PASS runner script is executable"
else
  TEST_FAILURES=$((TEST_FAILURES + 1))
  echo "  FAIL runner script must exist and be executable: $RUNNER"
fi

if [ -x "$RUNNER" ]; then
  fake_home=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-fake-claude.XXXXXX")
  mkdir -p "$fake_home/bin"
  fake_claude="$fake_home/bin/claude"
  cat > "$fake_claude" <<'SH'
#!/usr/bin/env bash
printf 'cwd=%s\n' "$PWD"
printf 'args=%s\n' "$*"
SH
  chmod +x "$fake_claude"

  repo=$(setup_test_repo)
  repo_real="$(cd "$repo" && pwd)"
  prompt_file="$repo/prompt.txt"
  output_file="$repo/review.out"
  printf '%s\n' 'Review this synthetic diff.' > "$prompt_file"

  dry_run=$(PATH="$fake_home/bin:$PATH" "$RUNNER" \
    --dry-run \
    --project-root "$repo" \
    --plugin-root "$REPO_ROOT" \
    --prompt-file "$prompt_file" \
    --output "$output_file")

  assert_equal "claude_cli_path=$fake_claude" "$(echo "$dry_run" | grep '^claude_cli_path=')" "dry-run uses claude from PATH"
  assert_equal "agent=code-reviewer" "$(echo "$dry_run" | grep '^agent=')" "runner selects code-reviewer agent"
  assert_equal "model=opus" "$(echo "$dry_run" | grep '^model=')" "runner defaults to opus"
  assert_equal "plugin_root=$REPO_ROOT" "$(echo "$dry_run" | grep '^plugin_root=')" "runner passes plugin root"
  assert_equal "project_root=$repo_real" "$(echo "$dry_run" | grep '^project_root=')" "runner passes project root"

  caller=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-runner-caller.XXXXXX")
  (cd "$caller" && PATH="$fake_home/bin:$PATH" "$RUNNER" \
    --project-root "$repo" \
    --plugin-root "$REPO_ROOT" \
    --prompt-file "$prompt_file" \
    --output "$output_file")
  assert_equal "cwd=$repo_real" "$(grep '^cwd=' "$output_file")" "runner executes claude from project root"

  rm -rf "$caller" "$fake_home"
  teardown_test_repo
fi

for doc in \
  "$REPO_ROOT/commands/deep-review.md" \
  "$REPO_ROOT/skills/deep-review-workflow/SKILL.md" \
  "$REPO_ROOT/skills/deep-review-workflow/references/codex-integration.md"
do
  TEST_COUNT=$((TEST_COUNT + 1))
  if grep -q "run-claude-reviewer.sh" "$doc"; then
    echo "  PASS $(basename "$doc") documents Codex Claude reviewer bridge"
  else
    TEST_FAILURES=$((TEST_FAILURES + 1))
    echo "  FAIL $(basename "$doc") must document run-claude-reviewer.sh"
  fi
done

test_summary
