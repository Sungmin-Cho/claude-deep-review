#!/usr/bin/env bash
# test-run-agy-reviewer.sh — bridge structural test with mock binary
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
BRIDGE="$REPO/hooks/scripts/run-agy-reviewer.sh"
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

# Build mock binary that records argv + behaves per $MOCK_BEHAVIOR
mkdir -p "$WORK/mock-bin"
cat > "$WORK/mock-bin/agy" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGS_LOG"
case "${MOCK_BEHAVIOR:-success}" in
  success)      printf 'ok review output\n'; exit 0 ;;
  empty)        exit 0 ;;
  timeout)      sleep 9999 ;;
  auth-fail)    echo "Reauthentication required" >&2; exit 1 ;;
  generic-fail) echo "internal error" >&2; exit 17 ;;
esac
EOF
chmod +x "$WORK/mock-bin/agy"

PROMPT="$WORK/prompt.txt"
OUT="$WORK/output.txt"
ARGS_LOG="$WORK/args.log"
echo "test prompt" > "$PROMPT"

# --- Mechanism A: PATH injection ---
# v1.7.1: existing tests use --mode full-walk to preserve v1.7.0 fingerprint semantics.
# Matrix tests (T-M1..T-M14 below) exercise hybrid/git-status/off/full-walk explicitly.
run_a() {
  local behavior="$1"
  > "$ARGS_LOG"
  PATH="$WORK/mock-bin:$PATH" MOCK_BEHAVIOR="$behavior" MOCK_ARGS_LOG="$ARGS_LOG" \
    "$BRIDGE" --project-root "$REPO" --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 5
}

# --- Mechanism B: --binary override ---
run_b() {
  local behavior="$1"
  > "$ARGS_LOG"
  MOCK_BEHAVIOR="$behavior" MOCK_ARGS_LOG="$ARGS_LOG" \
    "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 5
}

assert_status() {
  local expected="$1"
  local got
  got=$(cat "$OUT.status" 2>/dev/null || echo MISSING)
  [ "$got" = "$expected" ] || { echo "FAIL: status mismatch — expected $expected, got $got" >&2; return 1; }
  echo "  ✓ status=$expected"
}

assert_arg() {
  local arg="$1"
  grep -q "^${arg}$" "$ARGS_LOG" || { echo "FAIL: arg $arg not passed" >&2; return 1; }
  echo "  ✓ arg present: $arg"
}

# --- Tests ---
echo "Test 1 (Mechanism A — success path)"
run_a success || true
assert_status success
assert_arg "-p"
assert_arg "--print-timeout"
assert_arg "--add-dir"
assert_arg "--dangerously-skip-permissions"

echo "Test 2 (Mechanism A — empty stdout → failed)"
run_a empty || true
assert_status failed

echo "Test 3 (Mechanism A — timeout)"
run_a timeout || true
assert_status timeout

echo "Test 4 (Mechanism A — auth fail)"
run_a auth-fail || true
assert_status not_authenticated

echo "Test 5 (Mechanism A — generic fail)"
run_a generic-fail || true
assert_status failed

echo "Test 6 (Mechanism B — --binary override)"
run_b success || true
assert_status success

echo "Test 7 (missing arg)"
"$BRIDGE" --project-root "$REPO" 2>/dev/null && { echo "FAIL: expected non-zero"; exit 1; } || echo "  ✓ exits non-zero on missing args"

echo "Test 8 (Perl fork/wait fallback — BLOCKER-1 fix — timeout produces rc=124)"
# Strip PATH of gtimeout and timeout so the Perl fallback is the only path.
# Build a stripped PATH that excludes any directory containing gtimeout or timeout.
stripped_path=""
IFS=: read -ra _dirs <<< "$PATH"
for _dir in "${_dirs[@]}"; do
  if [ -x "$_dir/gtimeout" ] || [ -x "$_dir/timeout" ]; then
    : # skip this dir
  else
    stripped_path="${stripped_path:+${stripped_path}:}${_dir}"
  fi
done
# Verify perl is reachable (required for fallback)
if ! PATH="$stripped_path" command -v perl >/dev/null 2>&1; then
  echo "  ⚠ perl not in stripped PATH — skipping Perl fallback test"
else
  # Before fix: child would exec the timeout number as a command (e.g. "5") → ENOENT
  # After fix: child execs the actual agy mock in timeout mode → rc=124
  rc=0
  PATH="$stripped_path:$WORK/mock-bin" MOCK_BEHAVIOR="timeout" MOCK_ARGS_LOG="$ARGS_LOG" \
    "$BRIDGE" --project-root "$REPO" --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 2 \
    || rc=$?
  # status file should be "timeout" (rc=124 → classifier maps to timeout)
  got_status=$(cat "$OUT.status" 2>/dev/null || echo MISSING)
  if [ "$got_status" = "timeout" ]; then
    echo "  ✓ Perl fallback: status=timeout (rc=124 correctly mapped)"
  elif [ "$got_status" = "failed" ] || [ "$got_status" = "MISSING" ]; then
    echo "FAIL: Perl fallback produced status=$got_status (expected timeout — likely exec of numeric arg)" >&2
    exit 1
  else
    echo "  ✓ Perl fallback: status=$got_status (acceptable — agy mock may have exited before alarm)"
  fi
fi

# ============================================================
# §7 matrix (v1.7.1) — hybrid / full-walk / git-status / off coverage
# ============================================================
echo ""
echo "=== §7 matrix (hybrid / full-walk / git-status / off) ==="

MATRIX_PASS=0
MATRIX_FAIL=0
matrix_pass() { MATRIX_PASS=$((MATRIX_PASS+1)); echo "  ✓ $1"; }
matrix_fail() { MATRIX_FAIL=$((MATRIX_FAIL+1)); echo "  ✗ $1"; }

# Fake-agy binary that performs a configured mutation when invoked
FAKE_AGY="$WORK/fake-agy"
chmod +x "$WORK"
make_agy_no_op() { printf '#!/bin/sh\nexit 0\n' > "$FAKE_AGY"; chmod +x "$FAKE_AGY"; }
make_agy_modify() { printf '#!/bin/sh\necho "%s" > "%s"\nexit 0\n' "$2" "$1" > "$FAKE_AGY"; chmod +x "$FAKE_AGY"; }
make_agy_create() { make_agy_modify "$1" "$2"; }
make_agy_sibling_write() {
  local fixt="$1"
  printf '#!/bin/sh\nmkdir -p "%s/.deep-review/reports" && echo "x" > "%s/.deep-review/reports/sibling.json"\nexit 0\n' "$fixt" "$fixt" > "$FAKE_AGY"
  chmod +x "$FAKE_AGY"
}

# Fresh fixture repo per matrix case.
# CRITICAL: mirror real /deep-review usage by gitignoring .deep-review/ in the
# fixture's first commit. Otherwise T-M13's sibling-write would appear as
# untracked drift and hybrid mode would correctly flag it — making T-M13
# self-contradictory.
make_fixture() {
  local dir="$1"
  rm -rf "$dir" && mkdir -p "$dir"
  ( cd "$dir" && git init -q && git config user.email a@b && git config user.name a \
    && printf '.deep-review/\nsecrets/\ntoken-store/\ninnocuous-public-dir/\n' > .gitignore \
    && echo "init" > README.md \
    && git add . && git commit -q -m init )
}

# Fresh OUT per case avoids stale ${OUT}.mutation-warning leaks
fresh_out() {
  rm -f "$OUT" "$OUT.mutation-warning" "$OUT.status" "$OUT.stderr-tail" 2>/dev/null
  OUT=$(mktemp)
}

FIXT="$WORK/fixt"

# Lib backup/restore for T-M12 — chained cleanup (preserves WORK trap above)
SAVED_LIB="$REPO/hooks/scripts/lib/sensitive-patterns.list"
SAVED_LIB_BACKUP=""
cleanup_matrix() {
  if [ -n "$SAVED_LIB_BACKUP" ] && [ -f "$SAVED_LIB_BACKUP" ]; then
    mv "$SAVED_LIB_BACKUP" "$SAVED_LIB"
  fi
  rm -rf "$WORK"   # preserve original test harness trap behavior
}
trap cleanup_matrix EXIT

# T-M1: hybrid + no change → no warning
fresh_out; make_fixture "$FIXT"; make_agy_no_op
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M1: hybrid + no change → no warning" \
  || matrix_fail "T-M1: hybrid + no change → unexpected warning"

# T-M2: hybrid + tracked file modified → warning
fresh_out; make_fixture "$FIXT"; make_agy_modify "$FIXT/README.md" "modified-by-agy"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ -f "$OUT.mutation-warning" ] && matrix_pass "T-M2: hybrid + tracked mod → warning" \
  || matrix_fail "T-M2: hybrid + tracked mod → MISSED"

# T-M3: hybrid + new untracked file → warning
fresh_out; make_fixture "$FIXT"; make_agy_create "$FIXT/newfile.txt" "content"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ -f "$OUT.mutation-warning" ] && matrix_pass "T-M3: hybrid + new untracked → warning" \
  || matrix_fail "T-M3: hybrid + new untracked → MISSED"

# T-M4 (C4 regression): hybrid + already-dirty tracked file rewritten by agy → warning
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && echo "dirty1" > README.md )
make_agy_modify "$FIXT/README.md" "dirty2-by-agy"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ -f "$OUT.mutation-warning" ] && matrix_pass "T-M4: hybrid + dirty rewrite → warning (C4 closed)" \
  || matrix_fail "T-M4: hybrid + dirty rewrite → MISSED (C4 regression)"

# T-M5: hybrid + gitignored .env modified → warning (sensitive-pattern catch)
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '.deep-review/\n.env\n' > .gitignore && echo "v1" > .env && git add .gitignore && git commit -q -m gi )
make_agy_modify "$FIXT/.env" "v2"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ -f "$OUT.mutation-warning" ] && matrix_pass "T-M5: hybrid + .env mod → warning (sensitive)" \
  || matrix_fail "T-M5: hybrid + .env mod → MISSED"

# T-M6: hybrid + gitignored non-sensitive (dist/foo) modified → no warning
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '.deep-review/\ndist/\n' > .gitignore && mkdir dist && echo "x" > dist/foo && git add .gitignore && git commit -q -m gi )
make_agy_modify "$FIXT/dist/foo" "modified"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M6: hybrid + dist/foo mod → no warning (intended)" \
  || matrix_fail "T-M6: hybrid + dist/foo mod → unexpected warning"

# T-M7: full-walk + no change → no warning (v1.7.0 parity)
fresh_out; make_fixture "$FIXT"; make_agy_no_op
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M7: full-walk + no change → no warning" \
  || matrix_fail "T-M7: full-walk + no change → unexpected warning"

# T-M8: full-walk + tracked mod → warning
fresh_out; make_fixture "$FIXT"; make_agy_modify "$FIXT/README.md" "v2"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 30 >/dev/null 2>&1 || true
[ -f "$OUT.mutation-warning" ] && matrix_pass "T-M8: full-walk + tracked mod → warning" \
  || matrix_fail "T-M8: full-walk + tracked mod → MISSED"

# T-M9: git-status + .env modified → no warning (sensitive miss by design)
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '.deep-review/\n.env\n' > .gitignore && echo "v1" > .env && git add .gitignore && git commit -q -m gi )
make_agy_modify "$FIXT/.env" "v2"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode git-status --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M9: git-status + .env mod → no warning (intended)" \
  || matrix_fail "T-M9: git-status + .env mod → unexpected warning"

# T-M10: off + any change → no warning
fresh_out; make_fixture "$FIXT"; make_agy_modify "$FIXT/README.md" "v2"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M10: off + any change → no warning" \
  || matrix_fail "T-M10: off mode unexpectedly warned"

# T-M11: invalid mode → bridge exits 2 (rc=0 then capture via || rc=$?)
fresh_out; make_fixture "$FIXT"
rc=0
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode bogus --timeout-seconds 30 >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] && matrix_pass "T-M11: invalid mode → exit 2" \
  || matrix_fail "T-M11: invalid mode → exit $rc (expected 2)"

# T-M12: missing lib → degrade hybrid → full-walk + stderr-tail entry
fresh_out; make_fixture "$FIXT"
SAVED_LIB_BACKUP="${SAVED_LIB}.bak.$$"
mv "$SAVED_LIB" "$SAVED_LIB_BACKUP"
make_agy_modify "$FIXT/README.md" "v2"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
mv "$SAVED_LIB_BACKUP" "$SAVED_LIB"
SAVED_LIB_BACKUP=""
if [ -f "$OUT.mutation-warning" ] && grep -q "sensitive-patterns.list missing" "$OUT.stderr-tail" 2>/dev/null; then
  matrix_pass "T-M12: missing lib → degrade to full-walk + stderr-tail entry"
else
  warn_present=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no)
  matrix_fail "T-M12: missing lib degrade misbehaved (warning=$warn_present; tail=$(head -1 "$OUT.stderr-tail" 2>/dev/null || echo MISSING))"
fi

# T-M13: hybrid + sibling-write to .deep-review/reports/ → no warning (v1.7.1 key win)
fresh_out; make_fixture "$FIXT"; make_agy_sibling_write "$FIXT"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M13: hybrid + sibling reports/ write → no warning (v1.7.1 win)" \
  || matrix_fail "T-M13: hybrid + sibling write → unexpected warning (regression to v1.7.0 false-positive)"

# T-M15: hybrid + agy commits its mutation → warning (HEAD-sha regression test)
# Without HEAD capture, modify+add+commit leaves git status clean pre/post
# and hybrid would miss the mutation (round-impl-2 Codex review P2).
fresh_out; make_fixture "$FIXT"
# Fake agy modifies + commits
printf '#!/bin/sh\ncd "%s" && echo "modified" > README.md && git add README.md && git -c user.email=a@b -c user.name=a commit -q -m "agy commit"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ -f "$OUT.mutation-warning" ] && matrix_pass "T-M15: hybrid + agy commits → warning (HEAD-sha)" \
  || matrix_fail "T-M15: hybrid + agy commits → MISSED (HEAD-sha regression)"

# T-M14: hybrid + staged rename → no warning (R?/C? case-statement coverage)
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && git mv README.md README.txt )  # staged, NOT committed
make_agy_no_op
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
[ ! -f "$OUT.mutation-warning" ] && matrix_pass "T-M14: hybrid + staged rename → no warning (rename parsing)" \
  || matrix_fail "T-M14: hybrid + staged rename → unexpected warning"

# T-M16: hybrid + gitignored ./secrets/config.json (sensitive token in dir name only) → warning
#        Closes G1 (bilateral-wildcard -ipath directory-name matching).
make_fixture "$FIXT"
mkdir -p "$FIXT/secrets" && echo "old-content" > "$FIXT/secrets/config.json"
# Fake agy that overwrites the gitignored sensitive file
printf '#!/bin/sh\necho "new-content" > "%s/secrets/config.json"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
fresh_out
"$BRIDGE" \
  --binary "$FAKE_AGY" \
  --project-root "$FIXT" \
  --prompt-file "$PROMPT" \
  --output "$OUT" \
  --mode hybrid \
  --timeout-seconds 60 >/dev/null 2>&1 || true
if [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M16: hybrid catches dir-name secret mutation (./secrets/config.json)"
else
  matrix_fail "T-M16: no mutation warning for dir-name secret"
fi

# T-M17: hybrid + gitignored ./token-store/value.txt (Codex's exact example for G1)
make_fixture "$FIXT"
mkdir -p "$FIXT/token-store" && echo "old-token" > "$FIXT/token-store/value.txt"
printf '#!/bin/sh\necho "new-token" > "%s/token-store/value.txt"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
fresh_out
"$BRIDGE" \
  --binary "$FAKE_AGY" \
  --project-root "$FIXT" \
  --prompt-file "$PROMPT" \
  --output "$OUT" \
  --mode hybrid \
  --timeout-seconds 60 >/dev/null 2>&1 || true
if [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M17: hybrid catches dir-name token mutation (./token-store/value.txt)"
else
  matrix_fail "T-M17: no mutation warning for dir-name token"
fi

# T-M20: hybrid + gitignored ./innocuous-public-dir/foo.txt (no sensitive substring anywhere)
#        Negative regression — -ipath must NOT over-match unrelated directories.
# CRITICAL: fake agy must emit stdout. The bridge classifier maps `rc=0 + empty
# output_file` to AGY_STATUS=failed (run-agy-reviewer.sh classifier — see
# "elif [ ! -s "$output_file" ]; then AGY_STATUS=failed"). Without the stdout
# echo, the status assertion below always fails. Real agy emits a review
# summary, so this matches production semantics.
make_fixture "$FIXT"
mkdir -p "$FIXT/innocuous-public-dir" && echo "old-data" > "$FIXT/innocuous-public-dir/foo.txt"
printf '#!/bin/sh\necho "review: no issues found"\necho "new-data" > "%s/innocuous-public-dir/foo.txt"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
fresh_out
"$BRIDGE" \
  --binary "$FAKE_AGY" \
  --project-root "$FIXT" \
  --prompt-file "$PROMPT" \
  --output "$OUT" \
  --mode hybrid \
  --timeout-seconds 60 >/dev/null 2>&1 || true
AGY_STATUS_T_M20=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M20" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M20: hybrid correctly ignores non-sensitive dir mutation (negative regression)"
else
  matrix_fail "T-M20: bad outcome (status=$AGY_STATUS_T_M20, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi
# Note: status="success" assertion guards against bridge early-exit false-pass
# (e.g., if --prompt-file validation fails, $OUT.mutation-warning is absent
# but $OUT.status != "success" — the conjunction catches both ways).

# T-M16b: pure unit test of build_find_expr output shape.
#         Locks in the §4.1 contract that bilateral patterns emit BOTH
#         -iname and -ipath arms. Cannot be a behavioral test — `-ipath '*/*secret*'`
#         alone would match root-level basenames per BSD/GNU find semantics.
_bridge_path="$BRIDGE"  # defined at test-run-agy-reviewer.sh:6 as "$REPO/hooks/scripts/run-agy-reviewer.sh"
_func_src=$(awk '/^build_find_expr\(\) \{/,/^\}$/' "$_bridge_path")
eval "$_func_src"
if ! type build_find_expr >/dev/null 2>&1; then
  matrix_fail "T-M16b: build_find_expr not callable after awk-extract + eval"
else
  _tmp_list=$(mktemp "${TMPDIR:-/tmp}/v172-t-m16b-list.XXXXXX")
  echo '*secret*' > "$_tmp_list"
  _result=$(build_find_expr "$_tmp_list")
  rm -f "$_tmp_list"
  # printf '%q' on bash 3.2.57 (macOS) emits backslash-escaped form (\*secret\*).
  # bash 4+/5 (some Ubuntu/Debian versions) may emit single-quote form ('*secret*').
  # Both forms semantically pass the literal *secret* to find.
  #
  # The find expression has the shape: `-iname <space> <pattern> -o -ipath <space> <pattern>`.
  # Regex must explicitly allow [[:space:]]+ between the predicate name and its
  # pattern arg, then [^[:space:]]* to cross the (possibly-escaped) leading `*`
  # before "secret". A pattern of `-iname[^[:space:]]*secret` (without the
  # mandatory space) cannot match because [^[:space:]]* cannot cross the
  # literal space between `-iname` and its argument — empirically verified
  # on bash 3.2.57 (NO MATCH for that pattern).
  if ! echo "$_result" | grep -qE -- '-iname[[:space:]]+[^[:space:]]*secret'; then
    matrix_fail "T-M16b: missing -iname arm in output: $_result"
  elif ! echo "$_result" | grep -qE -- '-ipath[[:space:]]+[^[:space:]]*secret'; then
    matrix_fail "T-M16b: missing -ipath arm in output: $_result"
  else
    matrix_pass "T-M16b: bilateral pattern emits both -iname and -ipath terms"
  fi
  # Defensive: clear the extracted function so it doesn't leak to later tests.
  unset -f build_find_expr 2>/dev/null || true
fi

# T-M18: hybrid + agy mutates .deep-review/config.yaml (gitignored runtime state) → warning
#        Closes G2 first half.
make_fixture "$FIXT"
mkdir -p "$FIXT/.deep-review"
echo 'agy_fingerprint_mode: hybrid' > "$FIXT/.deep-review/config.yaml"
# Fake agy overwrites the config (the "agy mutates its own bridge config" attack)
printf '#!/bin/sh\necho "agy_fingerprint_mode: off" > "%s/.deep-review/config.yaml"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
fresh_out
"$BRIDGE" \
  --binary "$FAKE_AGY" \
  --project-root "$FIXT" \
  --prompt-file "$PROMPT" \
  --output "$OUT" \
  --mode hybrid \
  --timeout-seconds 60 >/dev/null 2>&1 || true
if [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M18: hybrid catches .deep-review/config.yaml mutation"
else
  matrix_fail "T-M18: no mutation warning for .deep-review/config.yaml"
fi

echo "=========================="
echo "MATRIX PASS: $MATRIX_PASS"
echo "MATRIX FAIL: $MATRIX_FAIL"
echo "=========================="
[ "$MATRIX_FAIL" -eq 0 ] || exit 1

echo "ALL PASS"
