#!/usr/bin/env bash
# run-agy-reviewer.sh — agy CLI bridge for deep-review (4-way pipeline)
#
# Standalone script. Has own _timeout + _sha256 shims (NOT sourced from
# commands/deep-review.md). Carries fixes from Rounds 7 + L2R2:
#   - C-R7-2: || rc=$? pattern (set -e would kill before classifier)
#   - C-R7-3: command -v ... || true (set -e safe)
#   - C1/C-R7-4: Perl fork/wait pattern → exit 124 (bare exec drops SIGALRM → rc=142)
#   - W-R7-5: _sha256 portability shim (Linux + macOS)
#   - C3: pre/post worktree fingerprint for agy mutation detection
#   - W3: argv size guard (200KB cap, ARG_MAX + ps-exposure mitigation)
#   - I3: preserve stderr tail-5 before cleanup
set -Eeuo pipefail

# ---------- shims ----------
_timeout() {
  local seconds="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" "$@"; return; fi
  if command -v timeout  >/dev/null 2>&1; then  timeout  "$seconds" "$@"; return; fi
  # C1 fix (fork/wait pattern): bare `exec` resets signal disposition in the child,
  # so SIGALRM kills with rc=142 (signal 14), not 124. Fork first; exec only in child.
  # Parent installs SIGALRM trap, calls alarm; on SIGALRM kills child with SIGTERM, exits 124.
  perl -e 'my $pid = fork; if (!$pid) { exec @ARGV } alarm shift; $SIG{ALRM} = sub { kill 15, $pid; exit 124 }; wait; exit ($? >> 8)' "$seconds" "$@"
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

# ---------- C3: pre-spawn worktree snapshot (coarse mutation detection) ----------
# agy runs with --dangerously-skip-permissions, giving it filesystem write capability.
# mutation-protocol.sh only gates Codex mutations, so agy mutations would be undetected.
# This snapshot is a sha256 fingerprint of all non-git/non-nodemodules files. It is
# COARSE (not perfect — races, large trees), but detects most accidental mutations.
# NOTE: this adds measurable latency on large repos; a future release may make it optional.
pre_walk_hash=$(cd "$project_root" && find . -type f \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -path './.venv/*' \
  -not -path './__pycache__/*' \
  -not -path './dist/*' \
  -not -path './build/*' \
  -not -path './target/*' \
  -print0 2>/dev/null | sort -z | xargs -0 -n 100 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "unavailable")

# ---------- invocation ----------
stderr_log=$(mktemp "${TMPDIR:-/tmp}/agy-stderr.XXXXXX")

# C-R7-2: bare `_timeout ... agy ...` under `set -e` would kill the script on failure
# before `rc=$?` could capture the exit code. Use `|| rc=$?` to ensure rc is captured.
# W3: Guard against ARG_MAX overflow and process listing exposure.
# `agy -p "$(cat ...)"` expands the prompt into argv — visible in `ps` and limited by ARG_MAX
# (~2MB on Linux, ~256KB on macOS). Truncate at 200KB with a warning.
# TODO: if agy supports stdin prompt (e.g. `agy -p -` or `--prompt-file`), switch to that.
prompt_size=$(wc -c < "$prompt_file")
if [ "$prompt_size" -gt 200000 ]; then
  echo "⚠️ Prompt size ${prompt_size} bytes exceeds 200KB argv safety limit. Truncating to 200KB." >&2
  prompt_content=$(head -c 200000 "$prompt_file")
else
  prompt_content=$(cat "$prompt_file")
fi

rc=0
_timeout "$timeout" "$resolved_binary" -p "$prompt_content" \
    --print-timeout "${timeout}s" \
    --add-dir "$project_root" \
    --dangerously-skip-permissions \
    > "$output_file" 2> "$stderr_log" || rc=$?

# ---------- C3: post-spawn mutation check ----------
post_walk_hash=$(cd "$project_root" && find . -type f \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -path './.venv/*' \
  -not -path './__pycache__/*' \
  -not -path './dist/*' \
  -not -path './build/*' \
  -not -path './target/*' \
  -print0 2>/dev/null | sort -z | xargs -0 -n 100 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "unavailable")
if [ "$pre_walk_hash" != "unavailable" ] && [ "$post_walk_hash" != "unavailable" ] \
   && [ "$pre_walk_hash" != "$post_walk_hash" ]; then
  echo "⚠️  agy mutated workspace files. Investigate before trusting review output." >&2
  echo "mutated" > "${output_file}.mutation-warning"
fi

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

# I3: Preserve last 5 stderr lines for caller (per agy-integration.md Status Matrix —
# AGY_STATUS=failed shows stderr tail-5 to user). Caller reads ${output_file}.stderr-tail.
if [ -s "$stderr_log" ]; then
  tail -5 "$stderr_log" > "${output_file}.stderr-tail"
fi
rm -f "$stderr_log"
exit "$rc"
