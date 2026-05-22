#!/usr/bin/env bash
# test-sensitive-patterns-lib.sh
# Verifies the lib/sensitive-patterns.list data file is consumable by both
# Python (the scan_sensitive_files heredoc) AND Bash (the run-agy-reviewer.sh
# build_find_expr), and that the normalized pattern set matches the canonical
# count of 52 (round-1 plan-review I2/I4 fixed-point check).

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIST_FILE="$PROJECT_ROOT/hooks/scripts/lib/sensitive-patterns.list"

PASS_COUNT=0
FAIL_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT+1)); echo "  PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); echo "  FAIL: $1"; }

echo "=== sensitive-patterns.list parity tests ==="

# T1: list file exists and is readable
[ -r "$LIST_FILE" ] && pass "T1: list file readable" \
  || fail "T1: list file missing or unreadable ($LIST_FILE)"

# T2: list file has ≥35 non-comment entries (covers all families)
non_comment_count=$(grep -vE '^\s*#|^\s*$' "$LIST_FILE" | wc -l | tr -d ' ')
[ "$non_comment_count" -ge 35 ] && pass "T2: ≥35 patterns ($non_comment_count)" \
  || fail "T2: too few patterns ($non_comment_count)"

# T3: Python can read the file (mimic scan_sensitive_files's loader)
py_patterns=$(python3 -c "
with open('$LIST_FILE') as f:
    pats = [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith('#')]
for p in pats: print(p)
")
[ -n "$py_patterns" ] && pass "T3: Python read succeeds" \
  || fail "T3: Python could not read patterns"

# T4: Bash can read the file (mimic build_find_expr's loader)
bash_patterns=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in '#'*) continue ;; esac
  bash_patterns="${bash_patterns}${line}"$'\n'
done < "$LIST_FILE"
[ -n "$bash_patterns" ] && pass "T4: Bash read succeeds" \
  || fail "T4: Bash could not read patterns"

# T5: Python and Bash see the same normalized set (no drift)
py_set=$(printf '%s\n' "$py_patterns" | sort)
bash_set=$(printf '%s\n' "$bash_patterns" | grep -v '^$' | sort)
if [ "$py_set" = "$bash_set" ]; then
  pass "T5: Python and Bash normalized sets match"
else
  fail "T5: Python/Bash set drift"
  echo "    diff:"; diff <(echo "$py_set") <(echo "$bash_set") | head -20
fi

# T6: pattern families present (5 critical)
for fam in "id_rsa*" "firebase-adminsdk*.json" "bearer_*" "*password*" ".htpasswd"; do
  if echo "$py_patterns" | grep -qF "$fam"; then
    pass "T6: family '$fam' present"
  else
    fail "T6: family '$fam' missing"
  fi
done

# T7: hard-coded pattern count (52). After Task 2, the in-source PATTERNS
# literal in mutation-protocol.sh is replaced by a file read, so an extraction-
# based parity check would be vacuously empty. Instead, assert the .list file
# has exactly 52 non-comment lines — the canonical count for v1.7.1.
expected_count=52
actual_count=$(printf '%s\n' "$py_patterns" | wc -l | tr -d ' ')
if [ "$actual_count" -eq "$expected_count" ]; then
  pass "T7: lib/sensitive-patterns.list has exactly $expected_count patterns (canonical count)"
else
  fail "T7: pattern count drift — expected $expected_count, got $actual_count"
fi

echo
echo "=========================="
echo "PASS: $PASS_COUNT"
echo "FAIL: $FAIL_COUNT"
echo "=========================="
[ "$FAIL_COUNT" -eq 0 ] || exit 1
