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

RUNTIME_STATE_SYMLINK_TARGET_MAX_BYTES=16384

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

# ---------- symlink helpers ----------
# BASH_SOURCE[0] alone does NOT auto-resolve symlinks for executed scripts.
# Walk the chain explicitly via readlink until we hit the real file.
_resolve_symlink() {
  local p="$1" t
  local i=0
  local max=40
  while [ -L "$p" ]; do
    if [ "$i" -ge "$max" ]; then
      printf 'agy bridge: _resolve_symlink: cycle or chain > %d (kernel MAXSYMLINKS bound) at %s\n' "$max" "$1" >&2
      return 1
    fi
    t="$(readlink "$p")" || return 1
    case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac
    i=$((i + 1))
  done
  printf '%s' "$p"
}

_inside_project_root() {
  local target="$1"
  local target_abs target_canon
  case "$target" in
    /*) target_abs="$target" ;;
    *)  target_abs="$PROJECT_ROOT_CANON/$target" ;;
  esac
  if target_canon=$(cd "$(dirname "$target_abs")" 2>/dev/null && pwd -P); then
    target_canon="$target_canon/$(basename "$target_abs")"
  else
    target_canon="$target_abs"
  fi
  case "$target_canon/" in "${PROJECT_ROOT_CANON%/}/"*) return 0 ;; esac
  return 1
}

_stat_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
}

_hex_encode() {
  if command -v xxd >/dev/null 2>&1; then
    xxd -p -c 0
  else
    od -An -tx1 | tr -d ' \n'
  fi
}

_has_utf8_bom() {
  local file="$1" prefix
  [ -r "$file" ] || return 1
  prefix=$(LC_ALL=C dd if="$file" bs=3 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
  [ "$prefix" = "efbbbf" ]
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
model=""  # v1.9.0: optional agy --model tier (orchestrator-resolved). Empty → agy default.

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)            binary="$2"; shift 2 ;;
    --project-root)      project_root="$2"; shift 2 ;;
    --prompt-file)       prompt_file="$2"; shift 2 ;;
    --output)            output_file="$2"; shift 2 ;;
    --timeout-seconds)   timeout="$2"; shift 2 ;;
    --mode)              mode="$2"; shift 2 ;;
    --model)             model="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default + validate mode (v1.7.1)
mode="${mode:-hybrid}"
case "$mode" in
  hybrid|full-walk|git-status|off) ;;
  *) echo "Invalid mode: $mode (expected: hybrid|full-walk|git-status|off)" >&2; exit 2 ;;
esac

# Required-argument validation FIRST — round-impl-1 W1 (Opus + Codex review P2 +
# Codex adv MED): pre-validation stderr-tail init would write `.stderr-tail` in
# the caller's cwd when --output is missing, polluting the user's repo.
[ -z "$project_root" ] && { echo "Missing --project-root" >&2; exit 2; }
[ -z "$prompt_file" ]  && { echo "Missing --prompt-file" >&2; exit 2; }
[ -z "$output_file" ]  && { echo "Missing --output" >&2; exit 2; }
[ -f "$prompt_file" ]  || { echo "Prompt file not found: $prompt_file" >&2; exit 2; }

PROJECT_ROOT_CANON=$(cd "$project_root" 2>/dev/null && pwd -P) || {
  echo "agy bridge: project_root unresolvable: $project_root" >&2
  exit 2
}

# ---------- stderr-tail initialization (v1.7.1) ----------
# Initialize empty so probes + degrade warnings (below + later) survive the
# post-spawn agy-stderr append (also changed from > to >>).
: > "${output_file}.stderr-tail"

# Initialize mutation_detected here so the sha256-probe fallback can set it
# without being clobbered by the mode-dispatcher's later 0-init. Otherwise
# the conservative .mutation-warning written by the probe + AGY_STATUS=success
# (from agy's exit 0) would disagree (impl-r3 Codex review P3).
mutation_detected=0
DIR_MATCH_LIST_DISABLED=0

# ---------- startup degrade probes ----------
# 1. lib/sensitive-patterns.list — hybrid ONLY (git-status doesn't read it).
if [ "$mode" = "hybrid" ]; then
  if [ -z "$_LIB_DIR" ] || [ ! -r "$_LIB_DIR/sensitive-patterns.list" ]; then
    msg="agy bridge: lib/sensitive-patterns.list missing — degrading hybrid → full-walk"
    echo "$msg" >&2
    echo "$msg" >> "${output_file}.stderr-tail"
    mode="full-walk"
  elif _has_utf8_bom "$_LIB_DIR/sensitive-patterns.list"; then
    msg="agy bridge: lib/sensitive-patterns.list has UTF-8 BOM — degrading hybrid → full-walk"
    echo "$msg" >&2
    echo "$msg" >> "${output_file}.stderr-tail"
    mode="full-walk"
  elif [ -r "$_LIB_DIR/sensitive-patterns-dir-match.list" ] && _has_utf8_bom "$_LIB_DIR/sensitive-patterns-dir-match.list"; then
    msg="agy bridge: lib/sensitive-patterns-dir-match.list has UTF-8 BOM — disabling directory-name sidecar opt-ins"
    echo "$msg" >&2
    echo "$msg" >> "${output_file}.stderr-tail"
    DIR_MATCH_LIST_DISABLED=1
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
    mutation_detected=1   # impl-r3 Codex review P3: keep status/sidecar consistent
  fi
  unset _probe_hash
fi

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
  local out="$1" git_tmp git_rc record code path expect_source=0 h path_hex head_sha
  git_tmp=$(mktemp "${TMPDIR:-/tmp}/agy-git-status.XXXXXX") || return 1
  ( cd "$project_root" && git status -z --porcelain --untracked-files=all 2>/dev/null ) > "$git_tmp"
  git_rc=$?
  if [ "$git_rc" -ne 0 ]; then
    rm -f "$git_tmp"
    return 1
  fi
  # Capture HEAD sha so agy mutations that commit/reset are detected even when
  # the working tree is clean before and after. Round-impl-2 Codex review P2:
  # without this, "modify + git add + git commit" leaves git status empty both
  # pre and post, hybrid sees no drift, agy gets counted as success despite
  # changing HEAD. v1.7.0 full-walk caught this because it hashed file CONTENTS
  # regardless of git state.
  head_sha=$(cd "$project_root" && git rev-parse HEAD 2>/dev/null || echo "no-head")
  printf 'HEAD\t%s\n' "$head_sha" > "$out"
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
  done < "$git_tmp" >> "$out"
  rm -f "$git_tmp"
  return 0
}

# ---------- build_find_expr (v1.8.0): sensitive-pattern accumulator ----------
# Reads lib/sensitive-patterns.list and emits a flat `find` OR-chain. The
# sidecar list controls directory-name matching for selected non-bilateral
# patterns without changing sensitive-patterns.list's literal pattern contract.
_normalize_pattern_line() {
  local pat="$1"
  # v1.9.0 de-fork: pure bash parameter expansion replaces the `tr -d '\r'` +
  # `sed` trim, which forked 3 external processes per call. With 52 patterns plus
  # per-pattern sidecar normalization this was the dominant cost of the hybrid
  # sensitive scan (~4.5 s per build, run twice). Output is byte-identical.
  pat="${pat//$'\r'/}"                    # strip CR (was: tr -d '\r')
  pat="${pat#"${pat%%[![:space:]]*}"}"    # ltrim leading whitespace (was: sed)
  pat="${pat%"${pat##*[![:space:]]}"}"    # rtrim trailing whitespace (was: sed)
  case "$pat" in '#'*) return 1 ;; esac
  [ -n "$pat" ] || return 1
  pat="${pat#\*\*/}"
  [ -n "$pat" ] || return 1
  printf '%s' "$pat"
}

# v1.9.0: load+normalize the directory-match opt-in sidecar ONCE per
# build_find_expr call into _DIR_MATCH_ENTRIES. Previously _is_dir_match_opted_in
# re-opened AND re-normalized the entire sidecar for EVERY pattern — an
# O(patterns × sidecar_lines) subshell/fork storm that dominated the hybrid scan.
# Now membership (below) is a fork-free string compare against this precomputed set.
_DIR_MATCH_ENTRIES=()
_load_dir_match_set() {
  _DIR_MATCH_ENTRIES=()
  [ "${DIR_MATCH_LIST_DISABLED:-0}" = "0" ] || return 0
  local sidecar line normalized
  sidecar="${_LIB_DIR:-}/sensitive-patterns-dir-match.list"
  [ -r "$sidecar" ] || return 0
  while IFS= read -r line; do
    normalized=$(_normalize_pattern_line "$line" 2>/dev/null || true)
    [ -n "$normalized" ] || continue
    _DIR_MATCH_ENTRIES+=("$normalized")
  done < "$sidecar"
  return 0
}

_is_dir_match_opted_in() {
  local pat="$1" e
  [ "${DIR_MATCH_LIST_DISABLED:-0}" = "0" ] || return 1
  # Empty-array guard: under `set -u` on bash 3.2, "${arr[@]}" on an empty array
  # raises "unbound variable". Short-circuit when nothing is opted in.
  [ "${#_DIR_MATCH_ENTRIES[@]}" -gt 0 ] || return 1
  for e in "${_DIR_MATCH_ENTRIES[@]}"; do
    [ "$e" = "$pat" ] && return 0
  done
  return 1
}

build_find_term() {
  local pat="$1"
  local dir_match="${2:-0}"
  local inner q_name q_path
  # v1.9.0 de-fork: `printf -v` writes the %q-escaped form into a variable with NO
  # command-substitution subshell. Output is byte-identical to the prior
  # `$(printf '%q' …)` form (same %q escaping, same spacing).
  case "$pat" in
    '*'*'*')
      inner="${pat#\*}"
      inner="${inner%\*}"
      printf -v q_name '%q' "$pat"
      printf -v q_path '%q' "*/*${inner}*"
      printf '%s' "-iname $q_name -o -ipath $q_path"
      ;;
    *)
      if [ "$dir_match" = "1" ]; then
        printf -v q_name '%q' "$pat"
        printf -v q_path '%q' "*/$pat*/*"
        printf '%s' "-iname $q_name -o -ipath $q_path"
      else
        printf -v q_name '%q' "$pat"
        printf '%s' "-iname $q_name"
      fi
      ;;
  esac
}

build_find_expr() {
  local list_file="$1"
  local pat expr="" term dm normalized
  # v1.9.0: read+normalize the dir-match sidecar ONCE for this call (was re-read
  # per pattern inside _is_dir_match_opted_in). Membership checks below are now
  # fork-free string compares against _DIR_MATCH_ENTRIES.
  _load_dir_match_set
  while IFS= read -r pat; do
    normalized=$(_normalize_pattern_line "$pat" 2>/dev/null || true)
    [ -n "$normalized" ] || continue
    pat="$normalized"
    if _is_dir_match_opted_in "$pat"; then dm=1; else dm=0; fi
    term=$(build_find_term "$pat" "$dm")
    if [ -z "$expr" ]; then expr="$term"; else expr="$expr -o $term"; fi
  done < "$list_file"
  printf '%s' "$expr"
}

_hash_path_with_symlink_handling() {
  local path="$1"
  local hex_path
  hex_path=$(printf '%s' "$path" | _hex_encode)

  if [ -L "$path" ]; then
    local raw_link readlink_rc link_hex resolved size
    # impl-r3 P3 closure (CR): wrap the readlink in a guarded `if ... ; then`
    # branch. The previous form `raw_link=$(readlink ... 2>/dev/null); readlink_rc=$?`
    # treats the assignment as a simple command under `set -Eeuo pipefail`, so a
    # readlink failure (symlink deleted/replaced mid-call) would abort the bridge
    # BEFORE reaching the rc capture — silently bypassing arm-1c sentinel emission.
    if raw_link=$(readlink "$path" 2>/dev/null); then
      readlink_rc=0
    else
      readlink_rc=$?
    fi
    if [ "$readlink_rc" -ne 0 ]; then
      printf '%s\tsymlink-readlink-failed\n' "$hex_path"
      return 0
    fi
    link_hex=$(printf '%s' "$raw_link" | _hex_encode)

    if resolved=$(_resolve_symlink "$path") \
       && [ -f "$resolved" ] \
       && _inside_project_root "$resolved" \
       && size=$(_stat_size "$resolved" 2>/dev/null) \
       && [ -n "$size" ] \
       && [ "$size" -ge 0 ] \
       && [ "$size" -le "$RUNTIME_STATE_SYMLINK_TARGET_MAX_BYTES" ]; then
      local target_sha
      target_sha=$(_sha256 < "$resolved" 2>/dev/null || echo unavailable)
      printf '%s\tsymlink:%s:%s\n' "$hex_path" "$target_sha" "$link_hex"
    else
      printf '%s\tsymlink-unbounded:%s\n' "$hex_path" "$link_hex"
    fi
  elif [ -f "$path" ]; then
    local h
    h=$(_sha256 < "$path" 2>/dev/null || echo unavailable)
    printf '%s\t%s\n' "$hex_path" "$h"
  elif [ -e "$path" ]; then
    printf '%s\tother-non-regular\n' "$hex_path"
  fi
  return 0
}

# ---------- capture_sensitive_hashes (v1.8.0) ----------
# Walks the project tree for files matching lib/sensitive-patterns.list, emits
# sorted "hex_path\tfingerprint" lines. Pipeline wrapped in `if ! ... then`
# to shield from `set -Eeuo pipefail`'s errexit; with `pipefail` set, any
# stage failure makes the pipeline non-zero and the if-body cleans up + returns
# 1. Caller degrades hybrid → full-walk on failure.
#
# v1.9.0 memoization: build_find_expr produces an identical, repo-state-independent
# expression every call, yet hybrid invokes capture_sensitive_hashes TWICE (pre-
# and post-spawn). Compute the expression once and reuse it for the post snapshot.
# Safe because sensitive-patterns.list lives in the plugin install dir (outside
# agy's --add-dir project_root in normal use); in the self-review meta case it is
# git-tracked, so any mutation to it is independently caught by the git-status arm.
_SENS_FIND_EXPR_CACHE=""
_SENS_FIND_EXPR_CACHED=0
capture_sensitive_hashes() {
  local out_file="$1" tmp_file find_expr orig_pwd
  orig_pwd=$(pwd)
  tmp_file=$(mktemp "${TMPDIR:-/tmp}/agy-sens-tmp.XXXXXX") || return 1
  if [ "$_SENS_FIND_EXPR_CACHED" = "1" ]; then
    find_expr="$_SENS_FIND_EXPR_CACHE"
  else
    find_expr=$(build_find_expr "$_LIB_DIR/sensitive-patterns.list")
  fi
  if [ -z "$find_expr" ]; then
    rm -f "$tmp_file"
    return 1
  fi
  _SENS_FIND_EXPR_CACHE="$find_expr"
  _SENS_FIND_EXPR_CACHED=1
  # Round-impl-1 C1 (Opus + Codex review P2): cd was leaking into the caller's
  # shell because removing the outer subshell (for PIPESTATUS) also removed
  # the auto-restoration. Save+restore cwd explicitly here.
  cd "$project_root" || { rm -f "$tmp_file"; return 1; }
  # If agy mutates the pattern libs during its spawn window, pre/post may use
  # different match sets; the lib mutation itself remains visible as drift.
  # shellcheck disable=SC2086   # intentional word-split of $find_expr
  if ! eval "find . \\( -type f -o -type l \\) \\( $find_expr \\) \
    -not -path './.git/*' -not -path './node_modules/*' -not -path './.venv/*' \
    -not -path './dist/*' -not -path './build/*' -not -path './target/*' \
    -not -path './.next/*' -not -path './.svelte-kit/*' -not -path './coverage/*' \
    -not -path './out/*' -not -path './.gradle/*' -not -path './.cargo/*' \
    -not -path './vendor/*' -not -path './.terraform/*' \
    -not -path './__pycache__/*' -not -path './.pytest_cache/*' \
    -print0 2>/dev/null" \
    | while IFS= read -r -d '' path; do
        _hash_path_with_symlink_handling "$path"
      done \
    | LC_ALL=C sort > "$tmp_file"
  then
    rm -f "$tmp_file"
    cd "$orig_pwd"
    return 1
  fi

  # Append plugin self-state hashes to tmp_file. These names are generic, are
  # usually gitignored, and are not covered by sensitive-pattern -iname.
  local rt
  for rt in ".deep-review/config.yaml" ".deep-review/.pending-mutation.json"; do
    _hash_path_with_symlink_handling "$rt" >> "$tmp_file"
  done

  # Re-sort in place after the append (tmp_file was sorted by the prior
  # pipeline; appended lines could be unsorted).
  LC_ALL=C sort -o "$tmp_file" "$tmp_file" || {
    rm -f "$tmp_file"
    cd "$orig_pwd"
    return 1
  }

  mv "$tmp_file" "$out_file"
  cd "$orig_pwd"
  return 0
}

# ---------- _walk_hash: whole-tree SHA-256 fingerprint (v1.7.0 full-walk recipe) ----------
# Called twice in full-walk mode: once before agy spawn, once after. Same recipe.
# agy runs with --dangerously-skip-permissions, so mutations would be undetected
# without this. COARSE (races, large trees) but detects most accidental writes.
# Standard exclusion list — common build/cache/vendor dirs.
_walk_hash() {
  (
    cd "$project_root" || exit 1
    {
      while IFS= read -r -d '' path; do
        _hash_path_with_symlink_handling "$path"
      done < <(find . \( -type f -o -type l \) \
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
        -print0 2>/dev/null)
    } | LC_ALL=C sort | _sha256
  ) || echo "unavailable"
}
# impl-r1 W1 closure: pipe sorted per-path listing through _sha256 to restore the
# v1.7.2 caller contract (single 64-char digest stored in $pre_walk_hash / $post_walk_hash;
# comparison via != stays O(64) instead of O(file_count × line_size)). Mutation
# detection is functionally equivalent: any per-file content drift or symlink
# linkhex change still alters the sorted listing → digest changes → !=. T-M8 /
# T-M7b / T-M25b all keep passing (the digest input now includes linkhex changes
# that the old `cat | _sha256` form missed — strictly stronger drift detection).

# ---------- hybrid mode (v1.7.1): split pre/post with degrade ----------
_HYBRID_PRE_STATUS=""
_HYBRID_PRE_SENS=""

_fingerprint_hybrid_pre() {
  _HYBRID_PRE_STATUS=$(mktemp "${TMPDIR:-/tmp}/agy-pre-status.XXXXXX") || return 1
  _HYBRID_PRE_SENS=$(mktemp "${TMPDIR:-/tmp}/agy-pre-sens.XXXXXX") || return 1
  if ! capture_status_with_hashes "$_HYBRID_PRE_STATUS"; then
    local m="agy bridge: git-status pre-snapshot failed — degrading hybrid → full-walk"
    echo "$m" >&2
    echo "$m" >> "${output_file}.stderr-tail"
    rm -f "$_HYBRID_PRE_STATUS" "$_HYBRID_PRE_SENS"
    _HYBRID_PRE_STATUS=""; _HYBRID_PRE_SENS=""
    mode="full-walk"
    pre_walk_hash=$(_walk_hash)
    return 0
  fi
  if ! capture_sensitive_hashes "$_HYBRID_PRE_SENS"; then
    local m="agy bridge: sensitive-pattern pre-snapshot failed — degrading hybrid → full-walk"
    echo "$m" >&2
    echo "$m" >> "${output_file}.stderr-tail"
    rm -f "$_HYBRID_PRE_STATUS" "$_HYBRID_PRE_SENS"
    _HYBRID_PRE_STATUS=""; _HYBRID_PRE_SENS=""
    mode="full-walk"
    pre_walk_hash=$(_walk_hash)
    return 0
  fi
  return 0
}

_fingerprint_hybrid_post() {
  if [ -z "$_HYBRID_PRE_STATUS" ]; then
    # Pre-snapshot failed and we already switched to full-walk
    post_walk_hash=$(_walk_hash)
    if [ "$pre_walk_hash" != "unavailable" ] && [ "$post_walk_hash" != "unavailable" ] \
       && [ "$pre_walk_hash" != "$post_walk_hash" ]; then
      mutation_detected=1
      echo "mutated (full-walk fallback after hybrid degrade)" > "${output_file}.mutation-warning"
    fi
    return 0
  fi
  local post_status post_sens reason=""
  post_status=$(mktemp "${TMPDIR:-/tmp}/agy-post-status.XXXXXX") || return 1
  post_sens=$(mktemp "${TMPDIR:-/tmp}/agy-post-sens.XXXXXX") || return 1
  if ! capture_status_with_hashes "$post_status" || ! capture_sensitive_hashes "$post_sens"; then
    local m="agy bridge: post-snapshot failed — conservative mutation-warning emitted"
    echo "$m" >&2
    echo "$m" >> "${output_file}.stderr-tail"
    mutation_detected=1
    echo "mutated (post-snapshot failed; conservative)" > "${output_file}.mutation-warning"
    rm -f "$_HYBRID_PRE_STATUS" "$_HYBRID_PRE_SENS" "$post_status" "$post_sens"
    return 0
  fi
  if ! diff -q "$_HYBRID_PRE_STATUS" "$post_status" >/dev/null 2>&1; then
    mutation_detected=1; reason="git-status-drift"
  fi
  if ! diff -q "$_HYBRID_PRE_SENS" "$post_sens" >/dev/null 2>&1; then
    mutation_detected=1; reason="${reason:+$reason,}sensitive-pattern-drift"
  fi
  if [ "$mutation_detected" = 1 ]; then
    echo "mutated ($reason)" > "${output_file}.mutation-warning"
  fi
  rm -f "$_HYBRID_PRE_STATUS" "$_HYBRID_PRE_SENS" "$post_status" "$post_sens"
}

# ---------- git-status mode (v1.7.1) ----------
_GS_PRE_STATUS=""

_fingerprint_git_status_pre() {
  _GS_PRE_STATUS=$(mktemp "${TMPDIR:-/tmp}/agy-gs-pre.XXXXXX") || return 1
  if ! capture_status_with_hashes "$_GS_PRE_STATUS"; then
    local m="agy bridge: git-status pre-snapshot failed — degrading git-status → full-walk"
    echo "$m" >&2
    echo "$m" >> "${output_file}.stderr-tail"
    rm -f "$_GS_PRE_STATUS"; _GS_PRE_STATUS=""
    mode="full-walk"
    pre_walk_hash=$(_walk_hash)
  fi
  return 0   # round-impl-1 W3: explicit return for consistency with _fingerprint_hybrid_pre
}

_fingerprint_git_status_post() {
  if [ -z "$_GS_PRE_STATUS" ]; then
    post_walk_hash=$(_walk_hash)
    if [ "$pre_walk_hash" != "unavailable" ] && [ "$post_walk_hash" != "unavailable" ] \
       && [ "$pre_walk_hash" != "$post_walk_hash" ]; then
      mutation_detected=1
      echo "mutated (full-walk fallback after git-status degrade)" > "${output_file}.mutation-warning"
    fi
    return 0
  fi
  local post_status
  post_status=$(mktemp "${TMPDIR:-/tmp}/agy-gs-post.XXXXXX") || return 1
  if ! capture_status_with_hashes "$post_status"; then
    mutation_detected=1
    echo "mutated (git-status post-snapshot failed; conservative)" > "${output_file}.mutation-warning"
    rm -f "$_GS_PRE_STATUS" "$post_status"
    return 0
  fi
  if ! diff -q "$_GS_PRE_STATUS" "$post_status" >/dev/null 2>&1; then
    mutation_detected=1
    echo "mutated (git-status-drift)" > "${output_file}.mutation-warning"
  fi
  rm -f "$_GS_PRE_STATUS" "$post_status"
}

# ---------- mode-driven pre-spawn dispatcher (v1.7.1) ----------
# mutation_detected initialized earlier (before probes) so probe-set value survives.
pre_walk_hash=""
post_walk_hash=""

case "$mode" in
  hybrid)     _fingerprint_hybrid_pre ;;
  git-status) _fingerprint_git_status_pre ;;
  full-walk)  pre_walk_hash=$(_walk_hash) ;;
  off)        : ;;
esac

# ---------- read-only enforcement preamble (v1.8.1) ----------
# agy CLI has NO read-only mode. Empirical probing shows `agy -p` auto-approves
# Edit/Write tool calls even with NO permission flag at all — neither removing
# --dangerously-skip-permissions nor adding --sandbox prevents file writes
# (--sandbox only restricts terminal/shell, not the filesystem-write tools).
# So the ONLY reliable PRE-spawn guard against agy mutating the workspace before
# synthesis is a prompt-level directive. We prepend it here at the single bridge
# choke point, regardless of what reviewer prompt the orchestrator wrote into
# prompt_file. The post-spawn worktree fingerprint (hybrid/full-walk/git-status)
# remains the defense-in-depth BACKSTOP: if agy ignores this preamble and writes
# anyway, the mutation is detected → AGY_STATUS=mutated → excluded from N-way
# synthesis. ASCII-only so it survives LANG=C / non-UTF-8 locales.
AGY_READONLY_PREAMBLE='============================================================
READ-ONLY REVIEW MODE - ABSOLUTE, NON-NEGOTIABLE CONSTRAINT
============================================================
You are a code reviewer running in STRICT READ-ONLY mode. You MUST NOT modify
the workspace in ANY way. You are FORBIDDEN from:
  - creating, editing, overwriting, deleting, moving, or renaming any file
  - running shell commands that mutate state (git add/commit/checkout/reset,
    rm, mv, cp into the tree, sed -i, output redirection into files, package
    installs, formatters, codemods, etc.)
  - staging, committing, or otherwise altering git state
Your ONLY task is to ANALYZE and REPORT. Emit your findings as TEXT only.
When you find a problem, DESCRIBE the fix in prose - do NOT apply it. Any file
modification is a critical protocol violation that invalidates your entire
review. Fixes are applied by a SEPARATE step AFTER all reviewers are
synthesized - never during your run.
============================================================
The review request follows below.
============================================================

'

# ---------- invocation ----------
stderr_log=$(mktemp "${TMPDIR:-/tmp}/agy-stderr.XXXXXX")

# C-R7-2: bare `_timeout ... agy ...` under `set -e` would kill the script on failure
# before `rc=$?` could capture the exit code. Use `|| rc=$?` to ensure rc is captured.
# W3: Guard against ARG_MAX overflow and process listing exposure.
# `agy -p "$(cat ...)"` expands the prompt into argv — visible in `ps` and limited by ARG_MAX
# (~2MB on Linux, ~256KB on macOS). Truncate the BODY at 198KB (not 200KB) so the
# read-only preamble (< 2KB ASCII) fits inside the combined argv cap.
# TODO: if agy supports stdin prompt (e.g. `agy -p -` or `--prompt-file`), switch to that.
AGY_BODY_LIMIT=198000
prompt_size=$(wc -c < "$prompt_file")
truncated=0
if [ "$prompt_size" -gt "$AGY_BODY_LIMIT" ]; then
  echo "⚠️ Prompt size ${prompt_size} bytes exceeds ${AGY_BODY_LIMIT}B body limit (200KB argv cap minus read-only preamble headroom). Truncating." >&2
  prompt_body=$(head -c "$AGY_BODY_LIMIT" "$prompt_file")
  truncated=1
else
  prompt_body=$(cat "$prompt_file")
fi
# Prepend the read-only directive so it is the FIRST thing agy reads — single
# point of enforcement, independent of the orchestrator-supplied prompt body.
prompt_content="${AGY_READONLY_PREAMBLE}${prompt_body}"
# v1.9.0 model tier (attacks the dominant cost — agy's Gemini inference round-trip).
# The orchestrator resolves AGY_MODEL env > config agy_model > default and passes
# --model; empty → omit → agy uses its built-in default. --model reaches agy via
# argv (no shell injection at the bridge), but we keep a cheap charset allowlist as
# defense-in-depth so a malformed/hostile value never reaches agy. We deliberately
# do NOT pre-call `agy models` here — that hits the backend (~3 s per run, measured),
# which would re-add latency to the default path. A clean-but-unknown tier is passed
# through; if agy rejects it the reviewer is classified failed and excluded from
# synthesis (consistent with the other reviewers). set -u-safe empty-array form.
agy_model_args=()
if [ -n "$model" ]; then
  case "$model" in
    *[!A-Za-z0-9\ ._/\(\)-]*)
      model_warn="agy bridge: --model '$model' has unsupported characters — ignoring, using agy default tier"
      echo "$model_warn" >&2
      echo "$model_warn" >> "${output_file}.stderr-tail" ;;
    *)
      agy_model_args=(--model "$model") ;;
  esac
fi
rc=0
_timeout "$timeout" "$resolved_binary" -p "$prompt_content" \
    --print-timeout "${timeout}s" \
    --add-dir "$project_root" \
    ${agy_model_args[@]+"${agy_model_args[@]}"} \
    --dangerously-skip-permissions \
    > "$output_file" 2> "$stderr_log" || rc=$?

# ---------- mode-driven post-spawn dispatcher (v1.7.1) ----------
case "$mode" in
  hybrid)
    _fingerprint_hybrid_post
    ;;
  git-status)
    _fingerprint_git_status_post
    ;;
  full-walk)
    post_walk_hash=$(_walk_hash)
    if [ "$pre_walk_hash" != "unavailable" ] && [ "$post_walk_hash" != "unavailable" ] \
       && [ "$pre_walk_hash" != "$post_walk_hash" ]; then
      mutation_detected=1
      echo "mutated" > "${output_file}.mutation-warning"
    fi
    ;;
  off)
    : # explicit opt-out — no detection
    ;;
esac
if [ "$mutation_detected" = 1 ]; then
  echo "⚠️  agy mutated workspace files. Investigate before trusting review output." >&2
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
