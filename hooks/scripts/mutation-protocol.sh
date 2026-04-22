#!/usr/bin/env bash
# mutation-protocol.sh — shared Bash library for deep-review mutation/restore/auto-R

# EMPTY_BLOB_SHA is git's well-known hash for an empty blob (0-byte file content)
# Identical across all git versions.
EMPTY_BLOB_SHA="e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

# EMPTY_TREE_SHA is git's well-known hash for an empty tree (used as HEAD fallback in initial repo)
# Canonical value: sha1("tree 0\0") = 4b825dc642cb6eb9a060e54bf8d69288fbee4904
# (This is a built-in constant in git; works without the object existing in the object DB.)
# NOTE: The plan had a typo (...bf899d69f7cb46617) which is not a real tree object. Fixed here.
EMPTY_TREE_SHA="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# is_our_ita_entry <file>
#   Returns 0 if the given file is in index as an intent-to-add entry (git add -N).
#   Returns 1 otherwise (not in index, or real staged content).
#
#   Detection: git diff-index --cached --raw outputs "src-mode dst-mode src-hash dst-hash status path"
#   For intent-to-add, src-mode is ":000000" and dst-hash is the empty-blob SHA.
is_our_ita_entry() {
  local file="$1"
  local tree="HEAD"
  git rev-parse --verify HEAD >/dev/null 2>&1 || tree="$EMPTY_TREE_SHA"

  local line
  line=$(git diff-index --cached --raw "$tree" -- "$file" 2>/dev/null | head -1)
  [ -z "$line" ] && return 1

  local src_mode dst_hash
  src_mode=$(awk '{print $1}' <<<"$line")
  dst_hash=$(awk '{print $4}' <<<"$line")

  if [ "$src_mode" = ":000000" ] && [ "$dst_hash" = "$EMPTY_BLOB_SHA" ]; then
    return 0
  fi
  return 1
}

# LOCK_DIR is the path to the mutation lock directory.
# Atomic `mkdir` is used as POSIX-portable mutual exclusion (no flock dependency).
LOCK_DIR=".deep-review/.mutation.lock"
LOCK_STALE_SECONDS=3600     # 1 hour; for status=in-progress
REVIEW_TIMEOUT_SECONDS=600  # 10 min; mid-review window for status=committed
                            # (Codex review + adversarial + Opus synthesis typically < 5 min;
                            # 10 min buffer accommodates slow networks / large diffs.)

# W1 (4회차 Opus): module-scoped ownership flag.
# `release_mutation_lock` and `restore_mutation` only act on locks this shell acquired,
# preventing accidental release of another concurrent session's lock.
_MUTATION_LOCK_OWNED=0

# acquire_mutation_lock
#   Returns 0 on success (lock acquired, sets _MUTATION_LOCK_OWNED=1).
#   Returns 1 on failure (another session holds lock).
#   Stale lock (mtime > LOCK_STALE_SECONDS) is auto-cleaned and re-acquired.
acquire_mutation_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    _MUTATION_LOCK_OWNED=1
    return 0
  fi

  local lock_mtime age now
  # macOS BSD stat: -f %m ; GNU Linux stat: -c %Y
  lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - lock_mtime))

  if [ "$age" -gt "$LOCK_STALE_SECONDS" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || return 1
    mkdir "$LOCK_DIR" 2>/dev/null || return 1
    _MUTATION_LOCK_OWNED=1
    return 0
  fi
  return 1
}

# release_mutation_lock
#   Silently removes the lock — but ONLY if this shell acquired it.
#   Protects against another concurrent session's lock being accidentally released (W1).
release_mutation_lock() {
  [ "${_MUTATION_LOCK_OWNED:-0}" -eq 1 ] || return 0
  rmdir "$LOCK_DIR" 2>/dev/null || true
  _MUTATION_LOCK_OWNED=0
}

STATE_FILE=".deep-review/.pending-mutation.json"

# perform_mutation <file> [<file> ...]
#   Acquires lock, validates preconditions, writes state file, runs git add -f -N,
#   and updates state file to committed status.
#   Returns 0 on success, 1 on any failure (lock / precondition / git add).
#
#   CR1: lock is NOT released here. Due to deep-review's call structure
#   (perform_mutation and Codex reviewers run in separate Bash subshells),
#   a `trap EXIT` would fire before Codex starts. Lock release is deferred to
#   `restore_mutation` (see Task 9) which runs after all reviewers complete.
perform_mutation() {
  local files=("$@")
  [ "${#files[@]}" -eq 0 ] && return 0

  # Acquire lock (no trap — see CR1 comment above)
  if ! acquire_mutation_lock; then
    echo "❌ Another /deep-review session is active. Aborting." >&2
    return 1
  fi

  # Precondition: no target file may be in index yet
  # FR1 (4회차 Codex): release lock on early-return failure so the next
  # `/deep-review` invocation isn't blocked for up to LOCK_STALE_SECONDS.
  local f
  for f in "${files[@]}"; do
    if git ls-files --error-unmatch --cached -- "$f" >/dev/null 2>&1; then
      echo "❌ $f is already in index. Mutation refused to avoid overwriting user work." >&2
      release_mutation_lock
      return 1
    fi
  done

  # Write state file (status=in-progress) via atomic temp→rename
  mkdir -p .deep-review
  umask 077
  python3 - "${files[@]}" > "$STATE_FILE.tmp" <<'PY'
import json, subprocess, sys, datetime
files = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
try:
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True
    ).strip() or None
except (subprocess.CalledProcessError, FileNotFoundError):
    head = None
json.dump({
    "schema_version": 1,
    "operation": "git-add-f-N",
    "status": "in-progress",
    "started_at": now,
    "commit_hash": head,
    "shell_ppid": None,
    "restore_attempts": 0,
    "files": files,
}, sys.stdout, indent=2)
PY
  mv "$STATE_FILE.tmp" "$STATE_FILE"

  # Execute mutation. On partial/full failure, clean up IMMEDIATELY in this run
  # instead of deferring to a future auto-recover call (FR2 — 4회차 Codex adversarial).
  # Strategy: mark state as "failed", then call restore_mutation which filters via
  # is_our_ita_entry — only removes i-t-a entries this protocol created, preserving
  # any user staging that may have existed before. restore_mutation also releases
  # the lock, so we return cleanly.
  if ! git add -f -N -- "${files[@]}"; then
    python3 - <<'PY'
import json, os
p = ".deep-review/.pending-mutation.json"
with open(p) as f:
    data = json.load(f)
data["status"] = "failed"
with open(p + ".tmp", "w") as f:
    json.dump(data, f, indent=2)
os.replace(p + ".tmp", p)
PY
    echo "⚠️ git add -f -N partial/full failure. Rolling back partial entries and releasing lock." >&2
    restore_mutation
    return 1
  fi

  # Success — flip status to committed
  python3 - <<'PY'
import json, os
p = ".deep-review/.pending-mutation.json"
with open(p) as f:
    data = json.load(f)
data["status"] = "committed"
try:
    data["shell_ppid"] = int(os.environ.get("BASHPID", os.getppid()))
except Exception:
    data["shell_ppid"] = None
with open(p + ".tmp", "w") as f:
    json.dump(data, f, indent=2)
os.replace(p + ".tmp", p)
PY
  return 0
}

# restore_mutation
#   Reads state file, filters files via is_our_ita_entry, removes matching entries
#   from index via git rm --cached, then deletes state file AND releases lock.
#   Preserves user's real staged files (C4 defense).
#
#   IMPORTANT (CR1): Lock release is the responsibility of this function, NOT of
#   perform_mutation's trap EXIT (which fires on subshell boundary before Codex runs).
#
#   bash 3.2 compatible — uses `while IFS= read -r -d ''` instead of mapfile.
restore_mutation() {
  [ ! -f "$STATE_FILE" ] && { release_mutation_lock; return 0; }

  # Load file list from state (NUL-separated, bash 3.2 safe)
  local files=()
  local p
  while IFS= read -r -d '' p; do
    files+=("$p")
  done < <(python3 -c '
import json, sys
with open(".deep-review/.pending-mutation.json") as f:
    for p in json.load(f)["files"]:
        sys.stdout.write(p + "\0")
')

  # Filter: only our i-t-a entries; preserve user's actual staging
  local restore_list=()
  local f
  for f in "${files[@]}"; do
    if is_our_ita_entry "$f"; then
      restore_list+=("$f")
    elif git ls-files --error-unmatch --cached -- "$f" >/dev/null 2>&1; then
      echo "ℹ️ $f was staged by user during review — preserving, skipping restore." >&2
    fi
  done

  # Remove from index (NUL-separated paths)
  if [ "${#restore_list[@]}" -gt 0 ]; then
    printf '%s\0' "${restore_list[@]}" \
      | xargs -0 git rm --cached --force --ignore-unmatch --
  fi

  rm -f "$STATE_FILE"
  # CR1: explicit lock release on successful restore
  release_mutation_lock
  return 0
}

# auto_recover
#   Entry-point called by /deep-review Stage 0 and /deep-review --respond entry.
#   Checks for stale state file, performs silent recovery respecting other sessions' locks.
#   Increments restore_attempts; escalates after 3 failures.
auto_recover() {
  [ ! -f "$STATE_FILE" ] && return 0

  # FR3 (4회차 Codex): use state file status + lock age to distinguish
  # active mid-review from crashed session.
  #   - status=in-progress + fresh (<1h)       : active, skip
  #   - status=in-progress + stale (>1h)       : crashed early, recover
  #   - status=committed   + fresh (<10min)    : mid-review (Codex reviewers running), skip
  #   - status=committed   + older (>10min)    : crashed post-mutation, recover
  #   - status=failed      + any age           : partial-failure orphan, recover
  #
  # Without PID liveness checks, the 10-minute threshold is a pragmatic cutoff —
  # typical 3-way reviews complete within ~5 minutes. Users hitting this on
  # legitimate long reviews can extend REVIEW_TIMEOUT_SECONDS (session-scoped env).
  if [ -d "$LOCK_DIR" ]; then
    local lock_mtime age status
    lock_mtime=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
    age=$(( $(date +%s) - lock_mtime ))
    status=$(python3 -c 'import json,sys
try:
    print(json.load(open(".deep-review/.pending-mutation.json")).get("status",""))
except Exception:
    print("")' 2>/dev/null)

    if [ "$status" = "failed" ]; then
      echo "ℹ️ Detected failed mutation state. Recovering partial entries." >&2
      rmdir "$LOCK_DIR" 2>/dev/null || true
      _MUTATION_LOCK_OWNED=1
    elif [ "$status" = "committed" ] && [ "$age" -gt "$REVIEW_TIMEOUT_SECONDS" ]; then
      echo "ℹ️ Detected orphan lock from crashed session (status=committed, ${age}s > ${REVIEW_TIMEOUT_SECONDS}s). Recovering." >&2
      rmdir "$LOCK_DIR" 2>/dev/null || true
      _MUTATION_LOCK_OWNED=1
    elif [ "$age" -lt "$LOCK_STALE_SECONDS" ]; then
      echo "⚠️ Another /deep-review session is active (lock age: ${age}s, status=$status). Skipping auto-recovery." >&2
      return 0
    else
      echo "ℹ️ Stale lock detected (${age}s old, status=$status). Cleaning up." >&2
      rmdir "$LOCK_DIR" 2>/dev/null || true
      _MUTATION_LOCK_OWNED=1
    fi
  fi

  # Check restore_attempts
  local attempts
  attempts=$(python3 -c 'import json; print(json.load(open(".deep-review/.pending-mutation.json")).get("restore_attempts", 0))')
  if [ "$attempts" -ge 3 ]; then
    echo "⚠️ .deep-review/.pending-mutation.json 의 자동 복원이 3회 이상 실패했습니다. 수동 처리를 권장합니다:" >&2
    echo "   git ls-files --stage   # 현재 i-t-a entry 확인" >&2
    echo "   git rm --cached <file>  # 수동 복원" >&2
    echo "   rm .deep-review/.pending-mutation.json  # 카운터 리셋" >&2
    return 1
  fi

  # Increment restore_attempts
  python3 - <<'PY'
import json, os
p = ".deep-review/.pending-mutation.json"
with open(p) as f:
    data = json.load(f)
data["restore_attempts"] = data.get("restore_attempts", 0) + 1
with open(p + ".tmp", "w") as f:
    json.dump(data, f, indent=2)
os.replace(p + ".tmp", p)
PY

  # Attempt restore via shared logic
  restore_mutation
  return $?
}

# scan_sensitive_files <file> [<file> ...]
#   Prints paths that match known sensitive-file patterns (case-insensitive).
#   Uses Python fnmatch because bash 3.2 lacks globstar (**) support.
#   Patterns cover dotenv, credentials, SSH keys, GCP/Firebase, wrangler, etc.
scan_sensitive_files() {
  [ "$#" -eq 0 ] && return 0
  python3 - "$@" <<'PY'
import sys, fnmatch

PATTERNS = [
    # dotenv (nested for monorepos)
    ".env", ".env.*", ".envrc",
    "**/.env", "**/.env.*", "**/.envrc",
    # generic credential names
    "credentials*", "**/credentials*",
    "*secret*", "**/*secret*",
    "*password*", "**/*password*",
    "*token*", "**/*token*",
    "bearer_*", "**/bearer_*",
    # SSH / TLS keys
    "*.key", "*.pem", "*.pfx", "*.p12", "*.ovpn",
    "*_rsa", "*_dsa", "*_ecdsa",
    "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
    # cloud / service accounts
    "serviceAccount*.json", "**/serviceAccount*.json",
    "*-service-account*.json", "**/*-service-account*.json",
    "*-key.json", "**/*-key.json",
    "api-key*.json", "**/api-key*.json",
    "firebase-adminsdk*.json", "**/firebase-adminsdk*.json",
    "wrangler.toml", "wrangler.jsonc",
    "**/wrangler.toml", "**/wrangler.jsonc",
    # unix auth
    ".pgpass", ".netrc", ".htpasswd",
    "**/.pgpass", "**/.netrc", "**/.htpasswd",
    # JWT / OAuth
    "*.jwt", "*.token",
    "**/*.jwt", "**/*.token",
]

for f in sys.argv[1:]:
    fl = f.lower()
    bn = fl.rsplit("/", 1)[-1]
    matched = False
    for p in PATTERNS:
        pl = p.lower()
        if p.startswith("**/"):
            inner = pl[3:]
            if fnmatch.fnmatch(fl, pl) or fnmatch.fnmatch(bn, inner):
                matched = True
                break
        else:
            if fnmatch.fnmatch(bn, pl) or fnmatch.fnmatch(fl, pl):
                matched = True
                break
    if matched:
        print(f)
PY
}
