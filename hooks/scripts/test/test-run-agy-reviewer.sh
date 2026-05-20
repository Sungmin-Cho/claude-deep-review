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
run_a() {
  local behavior="$1"
  > "$ARGS_LOG"
  PATH="$WORK/mock-bin:$PATH" MOCK_BEHAVIOR="$behavior" MOCK_ARGS_LOG="$ARGS_LOG" \
    "$BRIDGE" --project-root "$REPO" --prompt-file "$PROMPT" --output "$OUT" --timeout-seconds 5
}

# --- Mechanism B: --binary override ---
run_b() {
  local behavior="$1"
  > "$ARGS_LOG"
  MOCK_BEHAVIOR="$behavior" MOCK_ARGS_LOG="$ARGS_LOG" \
    "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" --prompt-file "$PROMPT" --output "$OUT" --timeout-seconds 5
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

echo "ALL PASS"
