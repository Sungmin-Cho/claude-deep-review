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
  # BLOCKER-1 fix: shift $seconds BEFORE fork so child's @ARGV is the actual command,
  # not the numeric timeout string. Parent installs SIGALRM, waits, exits 124 on alarm.
  perl -e '
    my $seconds = shift @ARGV;
    my $pid = fork;
    if (!defined $pid) { die "fork: $!" }
    if (!$pid) { exec @ARGV; die "exec: $!" }
    alarm $seconds;
    $SIG{ALRM} = sub { kill 15, $pid; exit 124 };
    wait;
    exit ($? >> 8)
  ' "$seconds" "$@"
}

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else openssl dgst -sha256 -r | cut -d' ' -f1
  fi
}

# ---------- symlink-resolving helper (v1.7.1) ----------
# BASH_SOURCE[0] alone does NOT auto-resolve symlinks for executed scripts.
# Walk the chain explicitly via readlink until we hit the real file.
_resolve_symlink() {
  local p="$1" t
  while [ -L "$p" ]; do
    t="$(readlink "$p")" || return 1
    case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac
  done
  printf '%s' "$p"
}

_REAL_BRIDGE="$(_resolve_symlink "${BASH_SOURCE[0]}" 2>/dev/null)" || _REAL_BRIDGE="${BASH_SOURCE[0]}"
_LIB_DIR="$(cd "$(dirname "$_REAL_BRIDGE")/lib" 2>/dev/null && pwd)" || _LIB_DIR=""

# ---------- argv parsing ----------
binary=""
project_root=""
prompt_file=""
output_file=""
timeout="900"
mode=""   # v1.7.1: hybrid | full-walk | git-status | off (default: hybrid)

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)            binary="$2"; shift 2 ;;
    --project-root)      project_root="$2"; shift 2 ;;
    --prompt-file)       prompt_file="$2"; shift 2 ;;
    --output)            output_file="$2"; shift 2 ;;
    --timeout-seconds)   timeout="$2"; shift 2 ;;
    --mode)              mode="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default + validate mode (v1.7.1)
mode="${mode:-hybrid}"
case "$mode" in
  hybrid|full-walk|git-status|off) ;;
  *) echo "Invalid mode: $mode (expected: hybrid|full-walk|git-status|off)" >&2; exit 2 ;;
esac

# ---------- stderr-tail initialization (v1.7.1) ----------
# Initialize empty so probes + degrade warnings (below + later) survive the
# post-spawn agy-stderr append (line ~190 — also changed from > to >>).
: > "${output_file}.stderr-tail"

# ---------- startup degrade probes ----------
# 1. lib/sensitive-patterns.list — hybrid ONLY (git-status doesn't read it).
if [ "$mode" = "hybrid" ]; then
  if [ -z "$_LIB_DIR" ] || [ ! -r "$_LIB_DIR/sensitive-patterns.list" ]; then
    msg="agy bridge: lib/sensitive-patterns.list missing — degrading hybrid → full-walk"
    echo "$msg" >&2
    echo "$msg" >> "${output_file}.stderr-tail"
    mode="full-walk"
  fi
fi

# 2. _sha256 backend probe — length check on empty-input digest (64 hex chars).
#    A bare `if ! _sha256 < /dev/null` returns 0 even with no backend because
#    the function's tail-pipeline `cut` exits 0; the length check is reliable.
if [ "$mode" = "hybrid" ] || [ "$mode" = "git-status" ] || [ "$mode" = "full-walk" ]; then
  _probe_hash=$(_sha256 < /dev/null 2>/dev/null || true)
  if [ "${#_probe_hash}" -ne 64 ]; then
    msg="agy bridge: no sha256 backend (sha256sum/shasum/openssl all absent) — mutation detection cannot run; emitting conservative mutation-warning"
    echo "$msg" >&2
    echo "$msg" >> "${output_file}.stderr-tail"
    mode="off"
    echo "mutated (no sha256 backend available — conservative)" > "${output_file}.mutation-warning"
  fi
  unset _probe_hash
fi

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

# ---------- capture_status_with_hashes (v1.7.1, decision 12.1-A) ----------
# git status -z + per-dirty-file SHA-256, hex-encoded paths.
# Uses temp-file intermediate so git status's exit code is propagated
# (process substitution would swallow it).
# Rename/copy entries: in -z mode, dest path comes first, source second.
# We hash dest and discard source.
capture_status_with_hashes() {
  local out="$1" git_tmp git_rc record code path expect_source=0 h path_hex
  git_tmp=$(mktemp "${TMPDIR:-/tmp}/agy-git-status.XXXXXX") || return 1
  ( cd "$project_root" && git status -z --porcelain --untracked-files=all 2>/dev/null ) > "$git_tmp"
  git_rc=$?
  if [ "$git_rc" -ne 0 ]; then
    rm -f "$git_tmp"
    return 1
  fi
  while IFS= read -r -d '' record; do
    if [ "$expect_source" = 1 ]; then
      expect_source=0
      continue
    fi
    code="${record:0:2}"
    path="${record:3}"
    case "$code" in R?|C?) expect_source=1 ;; esac
    # Hex-encode path bytes so newline/tab/backslash do not corrupt sort/diff.
    path_hex=$(printf '%s' "$path" | od -An -tx1 | tr -d ' \n')
    if [ -f "$project_root/$path" ]; then
      h=$(_sha256 < "$project_root/$path" 2>/dev/null || echo "unavailable")
      printf '%s\t%s\t%s\n' "$code" "$path_hex" "$h"
    else
      printf '%s\t%s\t-\n' "$code" "$path_hex"
    fi
  done < "$git_tmp" > "$out"
  rm -f "$git_tmp"
  return 0
}

# ---------- build_find_expr (v1.7.1): sensitive-pattern accumulator ----------
# Reads lib/sensitive-patterns.list and emits a `-iname A -o -iname B ...`
# expression for `find -type f \( <expr> \)`. Strips '**/' prefix (find walks
# recursively by default). Uses -iname for case-insensitive matching to mirror
# scan_sensitive_files's .lower() semantics. Bash 3.2 portable (no declare -A,
# no mapfile).
build_find_expr() {
  local list_file="$1"
  local pat expr=""
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in '#'*) continue ;; esac
    pat="${pat#\*\*/}"
    if [ -z "$expr" ]; then
      expr="-iname $(printf '%q' "$pat")"
    else
      expr="$expr -o -iname $(printf '%q' "$pat")"
    fi
  done < "$list_file"
  printf '%s' "$expr"
}

# ---------- _walk_hash: whole-tree SHA-256 fingerprint (v1.7.0 full-walk recipe) ----------
# Called twice in full-walk mode: once before agy spawn, once after. Same recipe.
# agy runs with --dangerously-skip-permissions, so mutations would be undetected
# without this. COARSE (races, large trees) but detects most accidental writes.
# Standard exclusion list — common build/cache/vendor dirs.
_walk_hash() {
  cd "$project_root" && find . -type f \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -path './.venv/*' \
    -not -path './__pycache__/*' \
    -not -path './.pytest_cache/*' \
    -not -path './dist/*' \
    -not -path './build/*' \
    -not -path './target/*' \
    -not -path './.next/*' \
    -not -path './.svelte-kit/*' \
    -not -path './coverage/*' \
    -not -path './out/*' \
    -not -path './.gradle/*' \
    -not -path './.cargo/*' \
    -not -path './vendor/*' \
    -not -path './.terraform/*' \
    -print0 2>/dev/null | sort -z | xargs -0 -n 100 sh -c 'for f in "$@"; do cat "$f" 2>/dev/null; done' _ \
    | _sha256 2>/dev/null || echo "unavailable"
}

# ---------- pre-spawn snapshot (full-walk mode for now; mode dispatch added in later tasks) ----------
pre_walk_hash=$(_walk_hash)

# ---------- invocation ----------
stderr_log=$(mktemp "${TMPDIR:-/tmp}/agy-stderr.XXXXXX")

# C-R7-2: bare `_timeout ... agy ...` under `set -e` would kill the script on failure
# before `rc=$?` could capture the exit code. Use `|| rc=$?` to ensure rc is captured.
# W3: Guard against ARG_MAX overflow and process listing exposure.
# `agy -p "$(cat ...)"` expands the prompt into argv — visible in `ps` and limited by ARG_MAX
# (~2MB on Linux, ~256KB on macOS). Truncate at 200KB with a warning.
# TODO: if agy supports stdin prompt (e.g. `agy -p -` or `--prompt-file`), switch to that.
prompt_size=$(wc -c < "$prompt_file")
truncated=0
if [ "$prompt_size" -gt 200000 ]; then
  echo "⚠️ Prompt size ${prompt_size} bytes exceeds 200KB argv safety limit. Truncating to 200KB." >&2
  prompt_content=$(head -c 200000 "$prompt_file")
  truncated=1
else
  prompt_content=$(cat "$prompt_file")
fi
rc=0
_timeout "$timeout" "$resolved_binary" -p "$prompt_content" \
    --print-timeout "${timeout}s" \
    --add-dir "$project_root" \
    --dangerously-skip-permissions \
    > "$output_file" 2> "$stderr_log" || rc=$?

# ---------- post-spawn snapshot ----------
post_walk_hash=$(_walk_hash)
mutation_detected=0
if [ "$pre_walk_hash" != "unavailable" ] && [ "$post_walk_hash" != "unavailable" ] \
   && [ "$pre_walk_hash" != "$post_walk_hash" ]; then
  echo "⚠️  agy mutated workspace files. Investigate before trusting review output." >&2
  # BLOCKER-3: write mutation-warning sidecar so orchestrator Stage 5.1 can detect it
  # via .mutation-warning file check (independent of .status). Set flag for classifier.
  echo "mutated" > "${output_file}.mutation-warning"
  mutation_detected=1
fi

# ---------- classifier (same logic as §4.2 standalone — single source of truth) ----------
# BLOCKER-3: mutation_detected takes priority — agy output is untrusted regardless of rc.
# BLOCKER-4: prompt_too_large is checked second — partial review is not trustworthy.
if [ "$mutation_detected" = "1" ]; then
    AGY_STATUS="mutated"
elif [ "$truncated" = "1" ]; then
    AGY_STATUS="prompt_too_large"
elif [ "$rc" -eq 124 ]; then
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
  tail -5 "$stderr_log" >> "${output_file}.stderr-tail"
fi
rm -f "$stderr_log"
exit "$rc"
