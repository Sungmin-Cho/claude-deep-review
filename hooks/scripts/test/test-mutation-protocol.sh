#!/usr/bin/env bash
# hooks/scripts/test/test-mutation-protocol.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
source "$SCRIPT_DIR/../mutation-protocol.sh"

echo "=== is_our_ita_entry tests ==="

# Test 1: intent-to-add file returns true
repo=$(setup_test_repo)
cd "$repo"
echo "gitignored" > .gitignore-test
git add -f -N .gitignore-test
assert_success "is_our_ita_entry .gitignore-test" "intent-to-add file → 0"
teardown_test_repo

# Test 2: genuinely staged file returns false (non-empty content)
repo=$(setup_test_repo)
cd "$repo"
echo "content" > staged.md
git add staged.md
assert_failure "is_our_ita_entry staged.md" "real staged file → 1"
teardown_test_repo

# Test 3: file not in index returns false
repo=$(setup_test_repo)
cd "$repo"
echo "untracked" > untracked.md
assert_failure "is_our_ita_entry untracked.md" "untracked file → 1"
teardown_test_repo

# Test 4: initial repo (no HEAD) with intent-to-add
repo=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-test-initial.XXXXXX")
(cd "$repo" && git init -q)
cd "$repo"
echo "foo" > bar.md
git add -f -N bar.md
assert_success "is_our_ita_entry bar.md" "intent-to-add in initial repo → 0"
rm -rf "$repo"

echo ""
echo "=== mutation lock tests ==="

# Test 5: acquire_mutation_lock on fresh dir succeeds
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
assert_success "acquire_mutation_lock" "first lock acquisition"
assert_success "[ -d .deep-review/.mutation.lock ]" "lock dir exists"
release_mutation_lock
assert_failure "[ -d .deep-review/.mutation.lock ]" "lock released"
teardown_test_repo

# Test 6: second acquire fails while first holds
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
acquire_mutation_lock
assert_failure "acquire_mutation_lock" "second acquire fails"
release_mutation_lock
teardown_test_repo

# Test 7: stale lock (>3600s) auto-cleaned
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review/.mutation.lock
# Simulate stale: set mtime to 2 hours ago
touch -t $(date -u -v-2H +%Y%m%d%H%M 2>/dev/null || date -u -d '2 hours ago' +%Y%m%d%H%M) .deep-review/.mutation.lock
assert_success "acquire_mutation_lock" "stale lock auto-recovered"
assert_success "[ -d .deep-review/.mutation.lock ]" "fresh lock acquired after stale cleanup"
release_mutation_lock
teardown_test_repo

test_summary
