#!/usr/bin/env bash
# run-agy-reviewer.sh — agy CLI bridge for deep-review (4-way pipeline)
#
# Standalone script. Has own _timeout + _sha256 shims (NOT sourced from
# commands/deep-review.md). Carries Round 7 review fixes:
#   - C-R7-2: || rc=$? pattern (set -e would kill before classifier)
#   - C-R7-3: command -v ... || true (set -e safe)
#   - C-R7-4: Perl SIGALRM trap → exit 124 (not signal 142)
#   - W-R7-5: _sha256 portability shim (Linux + macOS)
set -Eeuo pipefail

# ---------- shims ----------
_timeout() {
  local seconds="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" "$@"; return; fi
  if command -v timeout  >/dev/null 2>&1; then  timeout  "$seconds" "$@"; return; fi
  # C-R7-4: trap SIGALRM to exit 124 explicitly; default Perl alarm dies with signal 142.
  perl -e '$SIG{ALRM}=sub{exit 124}; alarm shift; exec @ARGV' "$seconds" "$@"
}

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

# ---------- argv parsing ----------
binary=""
project_root=""
prompt_file=""
output_file=""
timeout="900"

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)            binary="$2"; shift 2 ;;
    --project-root)      project_root="$2"; shift 2 ;;
    --prompt-file)       prompt_file="$2"; shift 2 ;;
    --output)            output_file="$2"; shift 2 ;;
    --timeout-seconds)   timeout="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -z "$project_root" ] && { echo "Missing --project-root" >&2; exit 2; }
[ -z "$prompt_file" ]  && { echo "Missing --prompt-file" >&2; exit 2; }
[ -z "$output_file" ]  && { echo "Missing --output" >&2; exit 2; }
[ -f "$prompt_file" ]  || { echo "Prompt file not found: $prompt_file" >&2; exit 2; }

# C-R7-3: command -v exits non-zero if agy is absent; under set -e that would kill
# the script before reaching the intended exit 127. Wrap with `|| true`.
resolved_binary="${binary:-${AGY_BINARY:-$(command -v agy 2>/dev/null || true)}}"
[ -z "$resolved_binary" ] && exit 127

# ---------- AGY_AUTH_REGEX (single source) ----------
# Conservative — to be refined from real unauthenticated agy stderr at first
# integration test. REJECTED candidates: 'unauthor' partial match (too broad).
AGY_AUTH_REGEX='Reauthentication required|do not currently have an active account|OAuth token expired|Please run.*agy.*login|Not signed in|Authentication failed'

# ---------- invocation ----------
stderr_log=$(mktemp "${TMPDIR:-/tmp}/agy-stderr.XXXXXX")

# C-R7-2: bare `_timeout ... agy ...` under `set -e` would kill the script on failure
# before `rc=$?` could capture the exit code. Use `|| rc=$?` to ensure rc is captured.
rc=0
_timeout "$timeout" "$resolved_binary" -p "$(cat "$prompt_file")" \
    --print-timeout "${timeout}s" \
    --add-dir "$project_root" \
    --dangerously-skip-permissions \
    > "$output_file" 2> "$stderr_log" || rc=$?

# ---------- classifier (same logic as §4.2 standalone — single source of truth) ----------
if [ "$rc" -eq 124 ]; then
    AGY_STATUS="timeout"
elif [ "$rc" -ne 0 ] && grep -qE "$AGY_AUTH_REGEX" "$stderr_log"; then
    AGY_STATUS="not_authenticated"
elif [ "$rc" -ne 0 ]; then
    AGY_STATUS="failed"
elif [ ! -s "$output_file" ]; then
    AGY_STATUS="failed"   # empty output despite rc=0
else
    AGY_STATUS="success"
fi

# Terminal status file — atomic rename mirrors classified AGY_STATUS (not raw rc).
# Orchestrator can read this file alone to derive UX hints.
status_file="${output_file}.status"
echo "$AGY_STATUS" > "${status_file}.tmp"
mv "${status_file}.tmp" "$status_file"

rm -f "$stderr_log"
exit "$rc"
