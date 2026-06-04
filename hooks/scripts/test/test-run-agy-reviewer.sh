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
  # v1.9.0: simulate an older agy / renamed tier — fail when --model is present,
  # succeed (default tier) when it is absent, so the bridge's fail-open retry path is exercised.
  reject-model)
    for a in "$@"; do [ "$a" = "--model" ] && { echo "error: unknown flag --model" >&2; exit 3; }; done
    printf 'ok review output (default tier)\n'; exit 0 ;;
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

echo "Test 1b (read-only preamble prepended to agy prompt — v1.8.1)"
# agy CLI has NO read-only mode: `-p` auto-approves Edit/Write even without
# --dangerously-skip-permissions (verified empirically). The only reliable
# pre-spawn guard is a prompt-level directive prepended by the bridge.
# mock agy logs each argv element (one per line) to ARGS_LOG; a multi-line
# prompt_content lands as a single argv element split across lines, so grep
# matches the preamble's signature lines.
run_a success || true
if grep -q "READ-ONLY REVIEW MODE" "$ARGS_LOG" && grep -q "MUST NOT modify" "$ARGS_LOG"; then
  echo "  ✓ read-only preamble present in agy prompt"
else
  echo "FAIL: read-only preamble NOT prepended to agy prompt" >&2
  exit 1
fi
# The original prompt body must still be present (not replaced by the preamble).
grep -q "test prompt" "$ARGS_LOG" || { echo "FAIL: original prompt body lost" >&2; exit 1; }
echo "  ✓ original prompt body preserved"

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
  PATH="$WORK/mock-bin:$stripped_path" MOCK_BEHAVIOR="timeout" MOCK_ARGS_LOG="$ARGS_LOG" \
    "$BRIDGE" --project-root "$REPO" --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 2 \
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
# v1.9.0 — model tier (--model charset guard + pass-through)
# ============================================================
echo ""
echo "=== v1.9.0 model tier ==="

# Reset args log + bridge output sidecars before EACH model-tier case. A case that
# ABORTS during arg parsing (e.g. a stray empty argv → "Unknown arg:" exit 2) never
# rewrites $OUT.status, so without this clear, assert_status could read a stale
# "success" from the prior case and false-pass (Codex round-4 review P3 + adversarial).
_mt_reset() { : > "$ARGS_LOG"; rm -f "$OUT.status" "$OUT.stderr-tail" "$OUT.mutation-warning" 2>/dev/null; }

# Test M-A: a charset-clean model is passed through to agy verbatim.
_mt_reset
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 \
    --model "Gemini 3.5 Flash (High)" >/dev/null 2>&1 || true
assert_status success
assert_arg "--model"
assert_arg "Gemini 3.5 Flash (High)"
echo "  ✓ M-A: clean model passed through verbatim"

# Test M-B: no --model → bridge omits the flag (agy uses its own default tier).
_mt_reset
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 >/dev/null 2>&1 || true
assert_status success
if grep -q '^--model$' "$ARGS_LOG"; then
  echo "FAIL: M-B — --model unexpectedly passed when no model requested" >&2; exit 1
fi
echo "  ✓ M-B: --model omitted when not requested"

# Test M-C (security regression — Codex P1): a --model containing shell
# metacharacters is rejected by the charset guard → flag dropped + warning, the
# review still proceeds, and NO injection side-effect (the bridge passes argv,
# never builds a shell string from the value).
_mt_reset
CANARY="${WORK}/dr-agy-inject-canary"
rm -f "$CANARY" 2>/dev/null
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 \
    --model "\"; touch ${CANARY}; #" >/dev/null 2>&1 || true
assert_status success
if grep -q '^--model$' "$ARGS_LOG"; then
  echo "FAIL: M-C — shell-metacharacter --model was NOT rejected" >&2; exit 1
fi
[ ! -e "$CANARY" ] || { echo "FAIL: M-C — injection canary fired (shell injection!)" >&2; rm -f "$CANARY"; exit 1; }
grep -q "unsupported characters" "$OUT.stderr-tail" \
  || { echo "FAIL: M-C — missing charset-guard warning in stderr-tail" >&2; exit 1; }
echo "  ✓ M-C: shell-metacharacter model rejected + warning + no injection"

# Test M-D: a clean-but-unknown tier passes the charset guard and is forwarded as-is
# (the bridge does NOT pre-call `agy models`; if agy rejects it, the fail-open retry
# in M-F re-runs without --model so agy still participates).
_mt_reset
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 \
    --model "Bogus Model 9000" >/dev/null 2>&1 || true
assert_status success
assert_arg "--model"
assert_arg "Bogus Model 9000"
echo "  ✓ M-D: clean-but-unknown tier forwarded (no agy models pre-call)"

# Test M-E: explicit empty --model "" (the documented opt-out form) → flag omitted,
# no warning, review proceeds. Locks in the opt-out invocation form directly (M-B
# covers the equivalent flag-absent branch, but not the literal `--model ""` form).
_mt_reset
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 \
    --model "" >/dev/null 2>&1 || true
assert_status success
if grep -q '^--model$' "$ARGS_LOG"; then
  echo "FAIL: M-E — --model passed despite empty opt-out value" >&2; exit 1
fi
if grep -q "unsupported characters" "$OUT.stderr-tail" 2>/dev/null; then
  echo "FAIL: M-E — empty model wrongly tripped the charset guard" >&2; exit 1
fi
echo "  ✓ M-E: empty --model \"\" opt-out → flag omitted, no warning"

# Test M-F (fail-open retry — Codex round-5 high): when agy rejects --model (older
# agy without the flag, or a renamed tier), the bridge retries ONCE without --model
# so the 4th reviewer still participates with agy's default tier instead of being
# dropped. Final argv must NOT contain --model, status=success, retry warning present.
_mt_reset
MOCK_BEHAVIOR=reject-model MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 \
    --model "Gemini 3.5 Flash (High)" >/dev/null 2>&1 || true
assert_status success
if grep -q '^--model$' "$ARGS_LOG"; then
  echo "FAIL: M-F — retry still passed --model (should drop it on the retry)" >&2; exit 1
fi
grep -q "retrying once without --model" "$OUT.stderr-tail" \
  || { echo "FAIL: M-F — missing fail-open retry warning in stderr-tail" >&2; exit 1; }
echo "  ✓ M-F: --model rejection → retry without --model → agy participates (success)"

# Test M-G: an AUTH failure with --model is NOT retried (re-running cannot fix auth);
# status stays not_authenticated and no fail-open retry warning is emitted.
_mt_reset
MOCK_BEHAVIOR=auth-fail MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off --timeout-seconds 5 \
    --model "Gemini 3.5 Flash (High)" >/dev/null 2>&1 || true
assert_status not_authenticated
if grep -q "retrying once without --model" "$OUT.stderr-tail" 2>/dev/null; then
  echo "FAIL: M-G — auth failure must NOT trigger the model retry" >&2; exit 1
fi
echo "  ✓ M-G: auth failure with --model is not retried (stays not_authenticated)"

# Test M-O1/M-O2 (orchestrator invocation form regression — Codex round-2/3): the
# command contract in commands/deep-review.md builds an `agy_model_args` array and
# expands it as `${agy_model_args[@]+"${agy_model_args[@]}"}` (quotes INSIDE). The
# wrong form `"${agy_model_args[@]+${agy_model_args[@]}}"` (quotes outside) passes a
# stray empty argv element on the opt-out path → the bridge aborts with "Unknown arg:"
# (exit 2) and silently drops the 4th reviewer. Replicate the documented expansion
# against the REAL bridge to lock in the safe form. M-O1 asserts the bridge rc=0 (NOT
# masked with `|| true`) AND a freshly-cleared status, so the abort is actually caught
# (Codex round-4 P3) — a stray empty arg would make rc=2 and fail here.
echo "--- orchestrator invocation form (array expansion) ---"
_mt_reset
agy_model_args=()
mo1_rc=0
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off \
    ${agy_model_args[@]+"${agy_model_args[@]}"} \
    --timeout-seconds 5 >/dev/null 2>&1 || mo1_rc=$?
[ "$mo1_rc" -eq 0 ] || { echo "FAIL: M-O1 — bridge exited $mo1_rc (stray empty argv from wrong array expansion?)" >&2; exit 1; }
assert_status success   # empty array → ZERO extra args → bridge runs (not "Unknown arg:")
echo "  ✓ M-O1: empty agy_model_args expansion → bridge rc=0, no stray argv"
_mt_reset
agy_model_args=(--model "Gemini 3.5 Flash (High)")
MOCK_BEHAVIOR=success MOCK_ARGS_LOG="$ARGS_LOG" \
  "$BRIDGE" --binary "$WORK/mock-bin/agy" --project-root "$REPO" \
    --prompt-file "$PROMPT" --output "$OUT" --mode off \
    ${agy_model_args[@]+"${agy_model_args[@]}"} \
    --timeout-seconds 5 >/dev/null 2>&1 || true
assert_status success
assert_arg "--model"
assert_arg "Gemini 3.5 Flash (High)"
echo "  ✓ M-O2: populated agy_model_args expansion forwards --model"
unset agy_model_args

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
make_agy_no_op_stdout() { printf '#!/bin/sh\necho "review: no issues found"\nexit 0\n' > "$FAKE_AGY"; chmod +x "$FAKE_AGY"; }
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
SAVED_DIR_MATCH_LIB="$REPO/hooks/scripts/lib/sensitive-patterns-dir-match.list"
SAVED_DIR_MATCH_LIB_BACKUP=""
cleanup_matrix() {
  if [ -n "$SAVED_LIB_BACKUP" ] && [ -f "$SAVED_LIB_BACKUP" ]; then
    mv "$SAVED_LIB_BACKUP" "$SAVED_LIB"
  fi
  if [ -n "$SAVED_DIR_MATCH_LIB_BACKUP" ] && [ -f "$SAVED_DIR_MATCH_LIB_BACKUP" ]; then
    mv "$SAVED_DIR_MATCH_LIB_BACKUP" "$SAVED_DIR_MATCH_LIB"
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

# T-M7b: full-walk + symlink + no change → no warning (deterministic sorted snapshot)
fresh_out; make_fixture "$FIXT"; make_agy_no_op_stdout
echo "payload" > "$FIXT/target.txt"
( cd "$FIXT" && ln -s target.txt credentials-link )
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M7B=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M7B" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M7b: full-walk symlink snapshot is deterministic when unchanged"
else
  matrix_fail "T-M7b: bad outcome (status=$AGY_STATUS_T_M7B, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

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
#         Locks in the §4.1 contract for bilateral patterns, sidecar-opted
#         non-bilateral patterns, and non-opted non-bilateral patterns.
_bridge_path="$BRIDGE"  # defined at test-run-agy-reviewer.sh:6 as "$REPO/hooks/scripts/run-agy-reviewer.sh"
_func_src=$(awk '
  /^_normalize_pattern_line\(\) \{/ {capture=1}
  /^_hash_path_with_symlink_handling\(\) \{/ {capture=0}
  capture {print}
' "$_bridge_path")
eval "$_func_src"
if ! type build_find_expr >/dev/null 2>&1; then
  matrix_fail "T-M16b: build_find_expr not callable after awk-extract + eval"
else
  _tmp_lib=$(mktemp -d "${TMPDIR:-/tmp}/v180-t-m16b-lib.XXXXXX")
  _LIB_DIR="$_tmp_lib"
  DIR_MATCH_LIST_DISABLED=0
  _tmp_list=$(mktemp "${TMPDIR:-/tmp}/v172-t-m16b-list.XXXXXX")
  echo '*secret*' > "$_tmp_list"
  _result=$(build_find_expr "$_tmp_list")
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
  printf 'credentials*\n' > "$_tmp_lib/sensitive-patterns-dir-match.list"
  echo 'credentials*' > "$_tmp_list"
  _result=$(build_find_expr "$_tmp_list")
  if ! echo "$_result" | grep -qE -- '-iname[[:space:]]+[^[:space:]]*credentials'; then
    matrix_fail "T-M16b-dm1: missing -iname arm in sidecar output: $_result"
  elif ! echo "$_result" | grep -qE -- '-ipath[[:space:]]+[^[:space:]]*credentials'; then
    matrix_fail "T-M16b-dm1: missing -ipath arm in sidecar output: $_result"
  else
    matrix_pass "T-M16b-dm1: sidecar-opted non-bilateral pattern emits -iname and -ipath"
  fi
  : > "$_tmp_lib/sensitive-patterns-dir-match.list"
  echo 'bearer_*' > "$_tmp_list"
  _result=$(build_find_expr "$_tmp_list")
  if echo "$_result" | grep -qE -- '-ipath[[:space:]]+'; then
    matrix_fail "T-M16b-dm0: non-opted non-bilateral pattern unexpectedly emitted -ipath: $_result"
  elif ! echo "$_result" | grep -qE -- '-iname[[:space:]]+[^[:space:]]*bearer'; then
    matrix_fail "T-M16b-dm0: missing -iname arm in non-opted output: $_result"
  else
    matrix_pass "T-M16b-dm0: non-opted non-bilateral pattern emits -iname only"
  fi
  rm -rf "$_tmp_list" "$_tmp_lib"
  # Defensive: clear the extracted function so it doesn't leak to later tests.
  unset -f _normalize_pattern_line _is_dir_match_opted_in build_find_term build_find_expr 2>/dev/null || true
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

# T-M19: hybrid + agy mutates .deep-review/.pending-mutation.json → warning
make_fixture "$FIXT"
mkdir -p "$FIXT/.deep-review"
echo '{}' > "$FIXT/.deep-review/.pending-mutation.json"
printf '#!/bin/sh\necho "{\\\"mutated\\\":true}" > "%s/.deep-review/.pending-mutation.json"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
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
  matrix_pass "T-M19: hybrid catches .deep-review/.pending-mutation.json mutation"
else
  matrix_fail "T-M19: no mutation warning for .pending-mutation.json"
fi

# T-M18b: hybrid + no .deep-review/ directory at all (first-run scenario) → no warning
#         Locks in the §4.2 arm-4 (else → continue) silent-skip behavior.
#         If a future refactor changes `[ -e ]` to `[ -f ]` (or breaks arm-4),
#         T-M18b would warn on every first-run agy invocation.
make_fixture "$FIXT"
# Explicitly remove .deep-review/ — the helper does NOT create it (only writes
# its name into .gitignore). Some prior test in the matrix might have left a
# stray .deep-review from make_agy_sibling_write; remove it defensively.
rm -rf "$FIXT/.deep-review"
# Fake agy emits stdout (required for AGY_STATUS=success — bridge classifier
# maps empty output to "failed"). Does NOT mutate anything.
printf '#!/bin/sh\necho "review: no issues found"\nexit 0\n' > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
fresh_out
"$BRIDGE" \
  --binary "$FAKE_AGY" \
  --project-root "$FIXT" \
  --prompt-file "$PROMPT" \
  --output "$OUT" \
  --mode hybrid \
  --timeout-seconds 60 >/dev/null 2>&1 || true
AGY_STATUS_T_M18B=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M18B" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M18b: hybrid silently skips runtime-state when .deep-review/ absent"
else
  matrix_fail "T-M18b: bad outcome (status=$AGY_STATUS_T_M18B, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi
# Note: status="success" assertion guards against bridge early-exit false-pass.

# T-M21: arm-1 pre-existing symlink at .deep-review/config.yaml, no mutation → no warning
fresh_out; make_fixture "$FIXT"; make_agy_no_op_stdout
mkdir -p "$FIXT/.deep-review"
echo "k: v" > "$FIXT/.deep-review/target.yaml"
( cd "$FIXT/.deep-review" && ln -s target.yaml config.yaml )
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M21=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M21" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M21: arm-1 symlink regression (no mutation → no warning)"
else
  matrix_fail "T-M21: bad outcome (status=$AGY_STATUS_T_M21, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M21b: arm-1 observes link-target swap even when target content is identical.
fresh_out; make_fixture "$FIXT"
mkdir -p "$FIXT/.deep-review"
echo "k: v" > "$FIXT/.deep-review/target_a.yaml"
echo "k: v" > "$FIXT/.deep-review/target_b.yaml"
( cd "$FIXT/.deep-review" && ln -s target_a.yaml config.yaml )
FAKE_AGY_SWAP=$(mktemp "$WORK/fake-agy-swap-XXXXXX")
cat > "$FAKE_AGY_SWAP" <<EOF
#!/bin/sh
echo "review: no issues found"
cd "${FIXT}/.deep-review" && rm config.yaml && ln -s target_b.yaml config.yaml
exit 0
EOF
chmod +x "$FAKE_AGY_SWAP"
"$BRIDGE" --binary "$FAKE_AGY_SWAP" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M21B=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M21B" = "mutated" ] && [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M21b: arm-1 link-target swap with identical content → warning"
else
  matrix_fail "T-M21b: bad outcome (status=$AGY_STATUS_T_M21B, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M22: sidecar-listed credentials* catches directory-name mutation.
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '\ncredentials-store/\n' >> .gitignore && git add .gitignore && git commit -q -m "ignore credentials-store" )
mkdir -p "$FIXT/credentials-store"
echo "old" > "$FIXT/credentials-store/value.txt"
printf '#!/bin/sh\necho "review: no issues found"\necho "new" > "%s/credentials-store/value.txt"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M22=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M22" = "mutated" ] && [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M22: sidecar credentials* catches directory-name mutation"
else
  matrix_fail "T-M22: bad outcome (status=$AGY_STATUS_T_M22, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M23: non-bilateral bearer_* is not auto-promoted when sidecar is empty.
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '\nbearer_store/\n' >> .gitignore && git add .gitignore && git commit -q -m "ignore bearer_store" )
mkdir -p "$FIXT/bearer_store"
echo "old" > "$FIXT/bearer_store/foo.txt"
SAVED_LIB_BACKUP=$(mktemp "$WORK/sensitive-patterns.XXXXXX")
cp "$SAVED_LIB" "$SAVED_LIB_BACKUP"
SAVED_DIR_MATCH_LIB_BACKUP=$(mktemp "$WORK/sensitive-patterns-dir-match.XXXXXX")
cp "$SAVED_DIR_MATCH_LIB" "$SAVED_DIR_MATCH_LIB_BACKUP"
printf 'bearer_*\n' > "$SAVED_LIB"
: > "$SAVED_DIR_MATCH_LIB"
printf '#!/bin/sh\necho "review: no issues found"\necho "new" > "%s/bearer_store/foo.txt"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
mv "$SAVED_LIB_BACKUP" "$SAVED_LIB"; SAVED_LIB_BACKUP=""
mv "$SAVED_DIR_MATCH_LIB_BACKUP" "$SAVED_DIR_MATCH_LIB"; SAVED_DIR_MATCH_LIB_BACKUP=""
AGY_STATUS_T_M23=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M23" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M23: non-opted bearer_* directory-name mutation is ignored"
else
  matrix_fail "T-M23: bad outcome (status=$AGY_STATUS_T_M23, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M24: runtime-state symlink target inside the repo is content-hashed.
fresh_out; make_fixture "$FIXT"
mkdir -p "$FIXT/.deep-review"
echo "k: v" > "$FIXT/.deep-review/target.yaml"
( cd "$FIXT/.deep-review" && ln -s target.yaml config.yaml )
printf '#!/bin/sh\necho "review: no issues found"\necho "k: changed" > "%s/.deep-review/config.yaml"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M24=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M24" = "mutated" ] && [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M24: runtime-state in-repo symlink target mutation → warning"
else
  matrix_fail "T-M24: bad outcome (status=$AGY_STATUS_T_M24, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M24-external: runtime-state symlink target outside the repo is linkhex-only.
fresh_out; make_fixture "$FIXT"; make_agy_no_op_stdout
mkdir -p "$FIXT/.deep-review" "$WORK/external-target"
echo "k: v" > "$WORK/external-target/external.yaml"
( cd "$FIXT/.deep-review" && ln -s "$WORK/external-target/external.yaml" config.yaml )
printf '#!/bin/sh\necho "review: no issues found"\necho "k: changed" > "%s/external-target/external.yaml"\nexit 0\n' "$WORK" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M24_EXT=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M24_EXT" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M24-external: external runtime-state target content drift is intentionally ignored"
else
  matrix_fail "T-M24-external: bad outcome (status=$AGY_STATUS_T_M24_EXT, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M25: sensitive-scan find path includes symlinks and hashes in-repo targets.
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '\ncredentials-link\ndata-store/\n' >> .gitignore && git add .gitignore && git commit -q -m "ignore credentials symlink" )
mkdir -p "$FIXT/data-store"
echo "secret" > "$FIXT/data-store/payload.txt"
( cd "$FIXT" && ln -s data-store/payload.txt credentials-link )
printf '#!/bin/sh\necho "review: no issues found"\necho "changed" > "%s/credentials-link"\nexit 0\n' "$FIXT" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M25=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M25" = "mutated" ] && [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M25: sensitive scan catches gitignored symlink target mutation"
else
  matrix_fail "T-M25: bad outcome (status=$AGY_STATUS_T_M25, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M25-external: sensitive-scan symlink to external target is linkhex-only when unchanged.
fresh_out; make_fixture "$FIXT"
( cd "$FIXT" && printf '\ncredentials-outside\n' >> .gitignore && git add .gitignore && git commit -q -m "ignore external credentials symlink" )
mkdir -p "$WORK/external-sensitive"
echo "outside" > "$WORK/external-sensitive/external.yaml"
echo "unrelated-old" > "$WORK/external-sensitive/unrelated.yaml"
( cd "$FIXT" && ln -s "$WORK/external-sensitive/external.yaml" credentials-outside )
printf '#!/bin/sh\necho "review: no issues found"\necho "unrelated-new" > "%s/external-sensitive/unrelated.yaml"\nexit 0\n' "$WORK" > "$FAKE_AGY"
chmod +x "$FAKE_AGY"
"$BRIDGE" --binary "$FAKE_AGY" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M25_EXT=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M25_EXT" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M25-external: sensitive-scan external symlink target is ignored when link target is stable"
else
  matrix_fail "T-M25-external: bad outcome (status=$AGY_STATUS_T_M25_EXT, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M25b: full-walk catches symlink link-target swap with identical content.
fresh_out; make_fixture "$FIXT"
echo "data" > "$FIXT/target_a.txt"
echo "data" > "$FIXT/target_b.txt"
( cd "$FIXT" && ln -s target_a.txt credentials-link )
FAKE_AGY_FULL_SWAP=$(mktemp "$WORK/fake-agy-full-swap-XXXXXX")
cat > "$FAKE_AGY_FULL_SWAP" <<EOF
#!/bin/sh
echo "review: no issues found"
cd "${FIXT}" && rm credentials-link && ln -s target_b.txt credentials-link
exit 0
EOF
chmod +x "$FAKE_AGY_FULL_SWAP"
"$BRIDGE" --binary "$FAKE_AGY_FULL_SWAP" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode full-walk --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M25B=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M25B" = "mutated" ] && [ -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M25b: full-walk catches symlink-target swap via linkhex"
else
  matrix_fail "T-M25b: bad outcome (status=$AGY_STATUS_T_M25B, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

# T-M26: _resolve_symlink self-loop is bounded and emits the cycle message.
_resolve_src=$(awk '/^_resolve_symlink\(\) \{/,/^\}$/' "$BRIDGE")
eval "$_resolve_src"
mkdir -p "$WORK/self-loop"
( cd "$WORK/self-loop" && ln -s a a )
_resolve_err="$WORK/resolve-loop.err"
rc=0
_resolve_symlink "$WORK/self-loop/a" >/dev/null 2>"$_resolve_err" || rc=$?
if [ "$rc" = "1" ] && grep -q "cycle or chain > 40" "$_resolve_err"; then
  matrix_pass "T-M26: _resolve_symlink self-loop is bounded at MAXSYMLINKS"
else
  matrix_fail "T-M26: bad outcome (rc=$rc, err=$(cat "$_resolve_err" 2>/dev/null || echo missing))"
fi
unset -f _resolve_symlink 2>/dev/null || true

# T-M27: >16KB runtime-state symlink target is downgraded to linkhex-only.
fresh_out; make_fixture "$FIXT"
mkdir -p "$FIXT/.deep-review"
perl -e 'print "a" x 17000' > "$FIXT/.deep-review/large-target.yaml"
( cd "$FIXT/.deep-review" && ln -s large-target.yaml config.yaml )
FAKE_AGY_LARGE=$(mktemp "$WORK/fake-agy-large-XXXXXX")
cat > "$FAKE_AGY_LARGE" <<EOF
#!/bin/sh
echo "review: no issues found"
perl -e 'print "b" x 17000' > "${FIXT}/.deep-review/config.yaml"
exit 0
EOF
chmod +x "$FAKE_AGY_LARGE"
"$BRIDGE" --binary "$FAKE_AGY_LARGE" --project-root "$FIXT" \
  --prompt-file "$PROMPT" --output "$OUT" --mode hybrid --timeout-seconds 30 >/dev/null 2>&1 || true
AGY_STATUS_T_M27=$(cat "$OUT.status" 2>/dev/null || echo "missing")
if [ "$AGY_STATUS_T_M27" = "success" ] && [ ! -f "$OUT.mutation-warning" ]; then
  matrix_pass "T-M27: >16KB runtime-state symlink target content drift is intentionally ignored"
else
  matrix_fail "T-M27: bad outcome (status=$AGY_STATUS_T_M27, warning=$([ -f "$OUT.mutation-warning" ] && echo yes || echo no))"
fi

echo "=========================="
echo "MATRIX PASS: $MATRIX_PASS"
echo "MATRIX FAIL: $MATRIX_FAIL"
echo "=========================="
[ "$MATRIX_FAIL" -eq 0 ] || exit 1

echo "ALL PASS"
