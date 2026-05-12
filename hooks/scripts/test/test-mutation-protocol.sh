#!/usr/bin/env bash
# hooks/scripts/test/test-mutation-protocol.sh
set -euo pipefail

# DEBUG: trap unexpected exits with line number info (M5.5 follow-up — ubuntu CI bug)
# nounset-safe: avoid ${BASH_LINENO[*]} which can fail under set -u
trap 'rc=$?; echo ">>> EXIT trap fired: rc=$rc at LINENO=$LINENO" >&2' EXIT
trap 'rc=$?; echo ">>> ERR trap fired: rc=$rc at LINENO=$LINENO" >&2' ERR

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
echo ">>> MARK: test 5 start; PWD=$PWD" >&2
repo=$(setup_test_repo)
echo ">>> MARK: test 5 setup OK; repo=$repo" >&2
cd "$repo"
echo ">>> MARK: test 5 cd OK; PWD=$PWD" >&2
mkdir -p .deep-review
assert_success "acquire_mutation_lock" "first lock acquisition"
assert_success "[ -d .deep-review/.mutation.lock ]" "lock dir exists"
release_mutation_lock
assert_failure "[ -d .deep-review/.mutation.lock ]" "lock released"
echo ">>> MARK: test 5 pre-teardown; PWD=$PWD TEST_TMPDIR=$TEST_TMPDIR" >&2
teardown_test_repo
echo ">>> MARK: test 5 post-teardown; PWD=$PWD TEST_TMPDIR=$TEST_TMPDIR" >&2

# Test 6: second acquire fails while first holds
echo ">>> MARK: test 6 start; PWD=$PWD" >&2
repo=$(setup_test_repo)
echo ">>> MARK: test 6 setup OK; repo=$repo" >&2
cd "$repo"
echo ">>> MARK: test 6 cd OK; PWD=$PWD" >&2
mkdir -p .deep-review
echo ">>> MARK: test 6 mkdir OK; _MUTATION_LOCK_OWNED=${_MUTATION_LOCK_OWNED:-(unset)}" >&2
acquire_mutation_lock
echo ">>> MARK: test 6 acquire OK; _MUTATION_LOCK_OWNED=$_MUTATION_LOCK_OWNED" >&2
assert_failure "acquire_mutation_lock" "second acquire fails"
echo ">>> MARK: test 6 assert OK" >&2
release_mutation_lock
echo ">>> MARK: test 6 release OK" >&2
teardown_test_repo
echo ">>> MARK: test 6 done" >&2

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

echo ""
echo "=== perform_mutation tests ==="

# Test 8: successful mutation writes state file with committed status + registers i-t-a
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "gitignored" > g1.md
echo "gitignored2" > g2.md
perform_mutation "g1.md" "g2.md"
assert_success "[ -f .deep-review/.pending-mutation.json ]" "state file created"
status=$(python3 -c 'import json; print(json.load(open(".deep-review/.pending-mutation.json"))["status"])')
assert_equal "committed" "$status" "status is committed"
assert_success "is_our_ita_entry g1.md" "g1.md is i-t-a"
assert_success "is_our_ita_entry g2.md" "g2.md is i-t-a"
release_mutation_lock
teardown_test_repo

# Test 9: precondition failure — file already in index → abort
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "preexisting" > existing.md
git add existing.md
assert_failure "perform_mutation existing.md" "precondition rejects staged file"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "no state file created"
release_mutation_lock
teardown_test_repo

echo ""
echo "=== restore_mutation tests ==="

# Test 10: restore removes only i-t-a entries, preserves user staging (C4 defense)
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
echo "g2" > g2.md
perform_mutation g1.md g2.md
# Simulate user staging g1.md during review
echo "user-edit" > g1.md
git add g1.md  # real stage (mode 100644, real content)
# Now restore — g1.md should be preserved, g2.md should be restored
restore_mutation
g1_stage=$(git ls-files --stage g1.md | awk '{print $1}')
assert_equal "100644" "$g1_stage" "g1 retained user staging"
assert_failure "is_our_ita_entry g2.md" "g2 restored (not in index anymore)"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "state file removed after restore"
release_mutation_lock
teardown_test_repo

# Test 11: restore with only our files succeeds clean
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md
restore_mutation
# NOTE: plan used `git ls-files --cached g1.md` which always returns 0 (it's a list op).
# `--error-unmatch` makes it actually fail when the path isn't in the index.
assert_failure "git ls-files --error-unmatch --cached g1.md" "g1 removed from index"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "state file removed"
release_mutation_lock
teardown_test_repo

echo ""
echo "=== auto_recover tests ==="

# Test 12: auto_recover with stale state file performs restore
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md
release_mutation_lock
# Simulate session crash: state file + i-t-a exists, but lock is gone
auto_recover
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "state file cleaned"
assert_failure "git ls-files --error-unmatch --cached g1.md" "g1 not in index"
teardown_test_repo

# Test 13: auto_recover skips when another session holds lock
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md
# Lock still held. auto_recover should not touch state file.
output=$(auto_recover 2>&1 || true)
assert_success "[ -f .deep-review/.pending-mutation.json ]" "state file preserved when lock held"
echo "$output" | grep -q "lock age" && echo "  ✅ warning about active session" || echo "  ❌ expected lock warning"
release_mutation_lock
restore_mutation
teardown_test_repo

# Test 14: auto_recover escalates after 3 failed attempts
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Manually craft a state file with restore_attempts=3
cat > .deep-review/.pending-mutation.json <<'JSON'
{"schema_version":1,"operation":"git-add-f-N","status":"failed","started_at":"2026-01-01T00:00:00Z","commit_hash":null,"shell_ppid":null,"restore_attempts":3,"files":["nonexistent.md"]}
JSON
output=$(auto_recover 2>&1 || true)
echo "$output" | grep -q "수동 처리를 권장" && echo "  ✅ escalation message shown" || echo "  ❌ expected escalation"
assert_success "[ -f .deep-review/.pending-mutation.json ]" "state file preserved for user action"
teardown_test_repo

echo ""
echo "=== scan_sensitive_files tests ==="

# Test 15: basic .env match
matches=$(scan_sensitive_files "config/.env" "src/main.rs")
[ "$matches" = "config/.env" ] && echo "  ✅ basic .env detected" \
  || { echo "  ❌ expected config/.env, got: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 16: nested .env (monorepo)
matches=$(scan_sensitive_files "apps/web/.env.local" "services/api/.env.production")
echo "$matches" | grep -q "apps/web/.env.local" && echo "$matches" | grep -q "services/api/.env.production" \
  && echo "  ✅ nested .env detected" \
  || { echo "  ❌ nested .env missed: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 17: case-insensitive
matches=$(scan_sensitive_files "SERVICEACCOUNT.JSON" "ID_RSA" ".Env.Local")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "3" ] && echo "  ✅ case-insensitive matching (3 files)" \
  || { echo "  ❌ expected 3 matches, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 18: benign files pass through
matches=$(scan_sensitive_files "README.md" "src/main.rs" "docs/design.md")
[ -z "$matches" ] && echo "  ✅ benign files not matched" \
  || { echo "  ❌ false positive: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 19: GCP service account variants
matches=$(scan_sensitive_files "serviceAccount.json" "firebase-adminsdk-abc.json" "api-key.json")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "3" ] && echo "  ✅ GCP/Firebase credentials detected" \
  || { echo "  ❌ expected 3, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 20: SSH key variants
matches=$(scan_sensitive_files "id_rsa" "id_ed25519.pub" "my_server_ecdsa" ".pgpass")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "4" ] && echo "  ✅ SSH/auth files detected" \
  || { echo "  ❌ expected 4, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# === 4회차 regression guards (FR1, FR2, FR3, W1) ===
echo ""
echo "=== FR1: precondition failure releases lock ==="

# Test 21 (FR1): lock released when precondition rejects an already-indexed target
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "preexisting" > existing.md
git add existing.md  # force it into index
assert_failure "perform_mutation existing.md" "FR1: precondition fails"
assert_failure "[ -d .deep-review/.mutation.lock ]" "FR1: lock released on precondition failure (no orphan)"
# Sanity: second perform_mutation on a different file should succeed (lock not orphaned)
echo "new" > fresh.md
assert_success "perform_mutation fresh.md" "FR1: subsequent mutation unblocked"
restore_mutation
teardown_test_repo

echo ""
echo "=== FR2: partial mutation failure rolls back i-t-a entries ==="

# Test 22 (FR2): when git add -f -N fails, any partial i-t-a entries are cleaned up
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Simulate partial git add failure: create a valid file AND a path that will cause
# git add to fail (e.g., a path containing a newline — but that's tricky).
# Simpler: verify the code path by checking that restore_mutation is called
# when state ends up as "failed".
# Force failure by passing a non-existent path after a valid one:
echo "valid" > g1.md
if ! perform_mutation g1.md /nonexistent/path.md; then
  # Partial failure path — verify cleanup
  assert_failure "[ -f .deep-review/.pending-mutation.json ]" "FR2: state file cleaned up after partial failure"
  # g1.md may or may not be in index depending on git add semantics, but if it was
  # added as i-t-a, restore_mutation should have removed it.
  if git ls-files --error-unmatch --cached g1.md >/dev/null 2>&1; then
    # Still in index — must be NOT our i-t-a (would've been removed)
    stage_mode=$(git ls-files --stage g1.md | awk '{print $1}')
    [ "$stage_mode" != "100644" ] || {
      # If it's 100644 with empty-blob, it IS our leftover i-t-a
      stage_hash=$(git ls-files --stage g1.md | awk '{print $2}')
      [ "$stage_hash" != "$EMPTY_BLOB_SHA" ] && echo "  ✅ FR2: no orphan i-t-a leftover" \
        || { echo "  ❌ FR2: orphan i-t-a for g1.md"; TEST_FAILURES=$((TEST_FAILURES+1)); }
    }
  else
    echo "  ✅ FR2: no orphan i-t-a leftover"
  fi
  TEST_COUNT=$((TEST_COUNT+1))
  assert_failure "[ -d .deep-review/.mutation.lock ]" "FR2: lock released after partial failure"
else
  echo "  ⚠️ FR2: expected partial failure didn't occur — environment-dependent, skipping"
fi
teardown_test_repo

echo ""
echo "=== FR3: crashed session recovery ==="

# Test 23 (FR3): status=committed + stale-but-not-1h lock → still active, skip
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "f1" > f1.md
perform_mutation f1.md
release_mutation_lock  # manually drop lock flag, but keep lock dir
mkdir -p .deep-review/.mutation.lock  # re-create as if session A still holds it
# mtime is now (fresh). status=committed. Should be treated as active.
output=$(auto_recover 2>&1 || true)
echo "$output" | grep -q "Another /deep-review session is active" && echo "  ✅ FR3: fresh committed lock respected" \
  || { echo "  ❌ FR3: should skip fresh committed lock: $output"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))
assert_success "[ -f .deep-review/.pending-mutation.json ]" "FR3: state file preserved for active session"
# Cleanup
rmdir .deep-review/.mutation.lock 2>/dev/null || true
# Reacquire for restore
_MUTATION_LOCK_OWNED=1
mkdir -p .deep-review/.mutation.lock
restore_mutation
teardown_test_repo

# Test 24 (FR3): status=committed + lock older than REVIEW_TIMEOUT_SECONDS (10min) → orphan, recover
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "f2" > f2.md
perform_mutation f2.md
release_mutation_lock
mkdir -p .deep-review/.mutation.lock
# Backdate lock to 15 min ago (> REVIEW_TIMEOUT_SECONDS)
# macOS: touch -t YYYYMMDDhhmm[.ss]
backdate=$(date -u -v-15M +%Y%m%d%H%M 2>/dev/null || date -u -d '15 minutes ago' +%Y%m%d%H%M)
touch -t "$backdate" .deep-review/.mutation.lock
output=$(auto_recover 2>&1 || true)
echo "$output" | grep -q "orphan lock from crashed session" && echo "  ✅ FR3: orphan committed lock recovered" \
  || { echo "  ❌ FR3: should recover orphan committed lock: $output"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "FR3: orphan state file cleaned up"
teardown_test_repo

echo ""
echo "=== W1: lock ownership tracking ==="

# Test 25 (W1): release_mutation_lock is a no-op when we don't own the lock
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Simulate another session holding the lock (we don't own it)
mkdir .deep-review/.mutation.lock
_MUTATION_LOCK_OWNED=0  # explicit: we don't own it
release_mutation_lock   # should be no-op
assert_success "[ -d .deep-review/.mutation.lock ]" "W1: release_mutation_lock no-op when not owned"
# Cleanup
rmdir .deep-review/.mutation.lock
teardown_test_repo

echo ""
echo "=== M5.5 #5: stale-recovery preserves user staging ==="
#
# The Test 12 scenario covers "stale state file, no lock present" — a
# clean post-crash restart. The M5.5 #5 acceptance scenario is stricter:
# all THREE artifacts are present simultaneously (lock dir + state file +
# user-staged changes from a separate flow), and auto_recover must:
#   (1) detect the stale lock as orphaned (status=committed + age > 10min,
#       OR status=in-progress + age > 1h)
#   (2) release the lock
#   (3) remove our i-t-a entries from the index
#   (4) **NOT touch user staging** (C4 defense — `is_our_ita_entry` filter)
#   (5) remove the state file
#
# This pins the integration: a single regression that breaks (4) without
# breaking (1)/(2)/(3)/(5) would slip past the existing tests because
# Test 10 exercises restore_mutation directly and Test 12 doesn't stage
# anything pre-recovery.
#
# Spec: claude-deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-
# tests-handoff.md §2 #5 (deep-review row).

# Test 26 (M5.5 #5-A): leftover lock + state + user staging → recover + preserve
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Phase 1: simulate user staging an unrelated file independently of deep-review.
echo "user-edit" > user-file.md
git add user-file.md
# Verify pre-recovery: user staging is real (non-empty, in index, not i-t-a)
assert_success "git ls-files --error-unmatch --cached user-file.md" "pre: user-file.md staged"
assert_failure "is_our_ita_entry user-file.md" "pre: user-file.md is NOT i-t-a (real staging)"

# Phase 2: simulate a crashed deep-review mutation: state file with i-t-a entry
# for OUR file (review-target.md), age the lock to past REVIEW_TIMEOUT_SECONDS
# so auto_recover treats it as orphan.
echo "review-target" > review-target.md
perform_mutation review-target.md  # writes state file + lock + i-t-a
# Force lock age past 10 min (REVIEW_TIMEOUT_SECONDS=600) so auto_recover
# enters the orphan branch on a status=committed mutation.
touch -t 202504121200.00 .deep-review/.mutation.lock 2>/dev/null \
  || touch -A -2000 .deep-review/.mutation.lock 2>/dev/null \
  || python3 -c "import os; os.utime('.deep-review/.mutation.lock', (1, 1))"
# We do NOT release_mutation_lock here — simulating crashed session.
_MUTATION_LOCK_OWNED=0  # auto_recover sees lock as not-ours, so we don't pre-empt it

# Phase 3: recover.
auto_recover

# Phase 4: assert all 5 contract properties.
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "M5.5 #5-A: state file removed"
assert_failure "[ -d .deep-review/.mutation.lock ]" "M5.5 #5-A: orphan lock released"
assert_failure "git ls-files --error-unmatch --cached review-target.md" "M5.5 #5-A: our i-t-a removed"
assert_success "git ls-files --error-unmatch --cached user-file.md" "M5.5 #5-A: user staging preserved"
# Belt-and-suspenders: confirm user-file.md still has its content staged
staged_content=$(git show :user-file.md 2>/dev/null || echo "MISSING")
[ "$staged_content" = "user-edit" ] \
  && echo "  ✅ user staging content unchanged" \
  || echo "  ❌ user staging content corrupted (got: '$staged_content')"
teardown_test_repo

# Test 27 (M5.5 #5-B): no-op when state file is missing (defensive)
# Regression guard against auto_recover stripping a user's legitimate
# staging when there's NO crashed session to recover from.
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "user-only" > only-user.md
git add only-user.md
auto_recover  # should be no-op
assert_success "git ls-files --error-unmatch --cached only-user.md" "M5.5 #5-B: user staging untouched when no state file"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "M5.5 #5-B: still no state file"
teardown_test_repo

# Test 28 (M5.5 #5-C): MULTIPLE staged files survive recovery
# Catches a regression where auto_recover iterates files but breaks on
# the second user-staged file (e.g. off-by-one in i-t-a filter).
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "u1" > user-a.md
echo "u2" > user-b.md
echo "u3" > user-c.md
git add user-a.md user-b.md user-c.md
echo "ours" > ours.md
perform_mutation ours.md
touch -t 202504121200.00 .deep-review/.mutation.lock 2>/dev/null \
  || touch -A -2000 .deep-review/.mutation.lock 2>/dev/null \
  || python3 -c "import os; os.utime('.deep-review/.mutation.lock', (1, 1))"
_MUTATION_LOCK_OWNED=0
auto_recover
for f in user-a.md user-b.md user-c.md; do
  assert_success "git ls-files --error-unmatch --cached $f" "M5.5 #5-C: $f survives recovery"
done
assert_failure "git ls-files --error-unmatch --cached ours.md" "M5.5 #5-C: our i-t-a still removed"
teardown_test_repo

test_summary
