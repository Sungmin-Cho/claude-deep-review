#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/test-helpers.sh"
SCRIPT="$HERE/../build-change-files.sh"

# Assert every non-empty stdout line is valid JSON (skip if no python3).
jsonl_valid() { python3 -c $'import sys,json\nfor ln in sys.stdin:\n ln=ln.rstrip("\\n")\n if ln: json.loads(ln)'; }

repo=$(setup_test_repo)
( cd "$repo"
  printf 'line\n' > a.txt; git add a.txt; git commit -q -m a
  git mv a.txt b.txt                       # staged rename
  printf 'new\n' > untracked.txt )         # untracked
out=$("$SCRIPT" --repo "$repo" --change-state staged)
assert_success "printf '%s' \"\$out\" | jsonl_valid" "staged output is valid JSONL"
assert_success "printf '%s\\n' \"\$out\" | grep -q '\"old_path\": *\"a.txt\"'" "rename old_path present"
assert_success "printf '%s\\n' \"\$out\" | grep -q '\"score\"'" "rename score field present (split from R085)"
assert_success "printf '%s\\n' \"\$out\" | grep -q 'untracked.txt'" "untracked unioned into staged"

# control-byte (0x01) + embedded-newline paths must still yield valid JSON
weird=$(setup_test_repo)
( cd "$weird"; printf 'x\n' > "$(printf 'a\001b.txt')"; printf 'y\n' > "$(printf 'c\nd.txt')"; git add -A )
outw=$("$SCRIPT" --repo "$weird" --change-state staged)
assert_success "printf '%s' \"\$outw\" | jsonl_valid" "0x01 + newline paths still valid JSON"
assert_success "[ -n \"\$outw\" ]" "control-byte manifest is non-empty (not silently dropped)"
# Parse JSON and compare DECODED path values to the actual control-char paths
# (python comparison avoids all shell/grep backslash-escaping ambiguity).
pathcheck() { python3 -c $'import sys,json\nwant={"a\\x01b.txt","c\\nd.txt"}\ngot=set()\nfor ln in sys.stdin:\n ln=ln.rstrip("\\n")\n if ln: got.add(json.loads(ln).get("path"))\nsys.exit(0 if want<=got else 1)'; }
assert_success "printf '%s' \"\$outw\" | pathcheck" "0x01 and newline paths present and correctly round-trip via JSON"

# clean state without --review-base must fail (no silent HEAD..HEAD)
assert_failure "\"$SCRIPT\" --repo \"$repo\" --change-state clean" "clean without --review-base fails"

# initial state includes untracked files
init=$(mktemp -d "${TMPDIR:-/tmp}/dr-init.XXXXXX"); ( cd "$init"; git init -q; printf 'z\n' > only.txt )
assert_success "\"$SCRIPT\" --repo \"$init\" --change-state initial | grep -q only.txt" "initial includes untracked"

# non-git uses --files-from-z for manual targets
ffz=$(mktemp); printf 'man1.txt\0man2.txt\0' > "$ffz"
assert_success "\"$SCRIPT\" --repo \"$repo\" --change-state non-git --files-from-z \"$ffz\" | grep -q man1.txt" "non-git uses files-from-z"

# --- Finding B (out-of-scope exclusions): change_files must mirror review-execution.md SSOT:diff-exclusion-set.
# Stage a normal src file alongside vendored/build/generated/lock/.DS_Store + a binary;
# only the real source file must survive (rest are out of the review DIFF target set).
excl=$(setup_test_repo)
( cd "$excl"
  mkdir -p vendor node_modules dist build .next target .venv __pycache__ .pytest_cache src
  printf 'a\n' > vendor/x.js;        printf 'b\n' > node_modules/y.js
  printf 'c\n' > a.min.js;           printf 'd\n' > b.generated.ts
  printf 'e\n' > c.lock;             printf 'real\n' > src/real.ts
  printf 'z\n' > dist/z.js;          printf 'z\n' > build/z.js
  printf 'z\n' > .next/z.js;         printf 'z\n' > target/z.js
  printf 'z\n' > .venv/z.py;         printf 'z\n' > __pycache__/z.pyc
  printf 'z\n' > .pytest_cache/z;    printf 'x\n' > src/.DS_Store
  printf '\000\001\002BIN' > src/img.bin                       # binary blob
  git add -A )
oute=$("$SCRIPT" --repo "$excl" --change-state staged)
assert_success "printf '%s\\n' \"\$oute\" | grep -q '\"path\": *\"src/real.ts\"'" "exclusion: src/real.ts kept"
for bad in 'vendor/x.js' 'node_modules/y.js' 'a.min.js' 'b.generated.ts' 'c.lock' \
           'dist/z.js' 'build/z.js' '.next/z.js' 'target/z.js' '.venv/z.py' \
           '__pycache__/z.pyc' '.pytest_cache/z' 'src/.DS_Store' 'src/img.bin'; do
  assert_failure "printf '%s\\n' \"\$oute\" | grep -q '\"path\": *\"$bad\"'" "exclusion: $bad dropped"
done

# --- Finding A (effective post-WIP target): simulate the orchestrator's WIP-accepted path.
# Changes are COMMITTED in BASE..HEAD; calling with --change-state clean --review-base BASE
# (the effective target the block fills after a Stage-1 WIP commit) must yield a NON-EMPTY
# manifest for those committed files — proving the effective-target call is not silent-empty.
wip=$(setup_test_repo)
( cd "$wip"
  base=$(git rev-parse HEAD)
  printf 'wip-change\n' > committed.ts
  git add committed.ts; git commit -q -m "wip: deep-review checkpoint"
  echo "$base" > "$wip/.base" )
base=$(cat "$wip/.base")
outwip=$("$SCRIPT" --repo "$wip" --change-state clean --review-base "$base")
assert_success "[ -n \"\$outwip\" ]" "WIP effective-target: manifest non-empty (not silent-empty)"
assert_success "printf '%s\\n' \"\$outwip\" | grep -q '\"path\": *\"committed.ts\"'" "WIP effective-target: committed file present in review_base..HEAD"

# --- Finding 2 (clean state must NOT union leftover untracked): the WIP-accepted tracked-only
# path calls `--change-state clean --review-base BASE`; its effective target is committed
# base..HEAD ONLY. A leftover untracked file in the worktree is NOT part of that diff, so the
# manifest must list the committed file but MUST NOT list the untracked file (spec §4.1 — clean
# is excluded from the untracked union; unioning it would leak out-of-scope files).
cleanu=$(setup_test_repo)
( cd "$cleanu"
  base=$(git rev-parse HEAD)
  printf 'in-scope\n' > committed.ts
  git add committed.ts; git commit -q -m "wip: deep-review checkpoint"
  printf 'leftover\n' > leftover-untracked.txt   # untracked, NOT in base..HEAD
  echo "$base" > "$cleanu/.base" )
base=$(cat "$cleanu/.base")
outcu=$("$SCRIPT" --repo "$cleanu" --change-state clean --review-base "$base")
assert_success "printf '%s\\n' \"\$outcu\" | grep -q '\"path\": *\"committed.ts\"'" "clean+leftover: committed in-scope file present"
assert_failure "printf '%s\\n' \"\$outcu\" | grep -q 'leftover-untracked.txt'" "clean+leftover: out-of-scope untracked file NOT unioned"

# --- Fix 3 (spec §4.1 byte budget): the manifest is capped by BYTES, not just rows. A repo with
# many long-path untracked files staged must, under a small OCR_CHANGE_FILES_MAX_BYTES, emit the
# {omitted,truncated} trailer once the cumulative serialized size would exceed the budget — and
# the surviving emitted bytes must stay within (≈) the budget.
bytecap=$(setup_test_repo)
( cd "$bytecap"
  mkdir -p src
  i=0
  while [ "$i" -lt 60 ]; do
    printf 'x\n' > "src/this-is-a-deliberately-long-path-segment-to-burn-bytes-file-$i.ts"
    i=$((i+1))
  done
  git add -A )
# Budget 512 bytes: each row's JSON is ~90+ bytes, so well under 60 rows fit → trailer emitted.
outbc=$(OCR_CHANGE_FILES_MAX_BYTES=512 "$SCRIPT" --repo "$bytecap" --change-state staged)
assert_success "printf '%s\\n' \"\$outbc\" | grep -q '\"truncated\": *true'" "byte budget: truncation trailer emitted when manifest exceeds OCR_CHANGE_FILES_MAX_BYTES"
assert_success "printf '%s\\n' \"\$outbc\" | grep -q '\"omitted\":'" "byte budget: trailer reports omitted count"
# omitted count must be positive and the non-trailer rows must be FEWER than the 60 staged files.
emitted_rows=$(printf '%s\n' "$outbc" | grep -c '"status"' || true)
assert_success "[ \"\$emitted_rows\" -lt 60 ]" "byte budget: fewer rows emitted than total (some omitted by byte cap)"
assert_success "[ \"\$emitted_rows\" -ge 1 ]" "byte budget: at least one row still emitted (not a bare trailer)"
# A generous budget over the same repo must emit ALL 60 rows and NO trailer (cap is not spurious).
outbc2=$(OCR_CHANGE_FILES_MAX_BYTES=1000000 "$SCRIPT" --repo "$bytecap" --change-state staged)
all_rows=$(printf '%s\n' "$outbc2" | grep -c '"status"' || true)
assert_equal "60" "$all_rows" "byte budget: generous budget emits all rows"
assert_failure "printf '%s\\n' \"\$outbc2\" | grep -q '\"truncated\"'" "byte budget: generous budget emits no trailer"

# --- Fix 4 (spec §4.1 untracked-binary exclusion): `git diff --numstat` never sees untracked
# files, so an untracked binary (NUL byte in first chunk) must be dropped by the content-sniff,
# while an untracked text file beside it survives. Covers BOTH the dirty-state union and `initial`.
ubin=$(setup_test_repo)
( cd "$ubin"
  printf 'hello\nworld\n' > untracked-text.txt          # untracked text → kept
  printf 'PK\003\004\000\000bin' > untracked.bin         # untracked binary (has NUL) → dropped
  printf 'no-nul-just-bytes\xff\xfe' > untracked-hi.dat ) # high bytes but NO NUL → kept (git heuristic)
outub=$("$SCRIPT" --repo "$ubin" --change-state unstaged)
assert_success "printf '%s\\n' \"\$outub\" | grep -q '\"path\": *\"untracked-text.txt\"'" "untracked-binary: untracked text file kept"
assert_failure "printf '%s\\n' \"\$outub\" | grep -q '\"path\": *\"untracked.bin\"'" "untracked-binary: untracked NUL-containing binary dropped"
assert_success "printf '%s\\n' \"\$outub\" | grep -q '\"path\": *\"untracked-hi.dat\"'" "untracked-binary: high-byte-but-no-NUL file kept (NUL heuristic only)"
# initial state (no commits yet) routes untracked through the same add() → binary still dropped.
ibin=$(mktemp -d "${TMPDIR:-/tmp}/dr-ibin.XXXXXX")
( cd "$ibin"; git init -q
  printf 'plain text\n' > init-text.txt
  printf '\000\001\002BIN' > init.bin )
outib=$("$SCRIPT" --repo "$ibin" --change-state initial)
assert_success "printf '%s\\n' \"\$outib\" | grep -q '\"path\": *\"init-text.txt\"'" "untracked-binary(initial): text file kept"
assert_failure "printf '%s\\n' \"\$outib\" | grep -q '\"path\": *\"init.bin\"'" "untracked-binary(initial): NUL binary dropped"
# Unreadable/missing path must be fail-open (recorded), not a crash: feed a non-git manual path
# that does not exist on disk — the sniff returns False (non-binary) and the row is kept.
ffz_missing=$(mktemp); printf 'ghost-does-not-exist.txt\0' > "$ffz_missing"
outmiss=$("$SCRIPT" --repo "$ubin" --change-state non-git --files-from-z "$ffz_missing")
assert_success "printf '%s\\n' \"\$outmiss\" | grep -q 'ghost-does-not-exist.txt'" "untracked-binary: missing path fails open (recorded, no crash)"

# --- Fix 5 (codex R5 — special-file hang): looks_binary_untracked must NOT block on a FIFO,
# socket, device, or symlink-to-one passed via --files-from-z / --change-state non-git.
# Before the lstat-before-open guard was added, open(fp,"rb") on a FIFO blocks forever (the
# reader waits for a writer). The guard makes the script return promptly; this test asserts exit 0
# (non-hang). A timeout wrapper is used when portably available (gtimeout/timeout); without one
# the test still asserts exit 0 — the lstat fix ensures it returns immediately.
fifo_repo=$(setup_test_repo)
fifo_path="$fifo_repo/test.fifo"
mkfifo "$fifo_path"
# Feed the FIFO path as a manual file via --files-from-z + --change-state non-git.
# The committed plain file (a.txt from setup_test_repo) is not in scope here; we only care
# that the script completes (does not block) and exits 0.
ffz_fifo=$(mktemp); printf '%s\0' "$fifo_path" > "$ffz_fifo"
# Use a timeout guard if available; without one, the lstat fix guarantees prompt return.
_timeout_wrap() {
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 10 "$@"
  elif command -v timeout >/dev/null 2>&1; then
    timeout 10 "$@"
  else
    "$@"
  fi
}
assert_success "_timeout_wrap \"$SCRIPT\" --repo \"$fifo_repo\" --change-state non-git --files-from-z \"$ffz_fifo\" >/dev/null" \
  "special-file(FIFO): script completes without hanging (lstat guard)"
# Also confirm a normal text file in the same repo still survives a regular staged run.
( cd "$fifo_repo"; printf 'normal\n' > normal.txt; git add normal.txt )
outfifo=$("$SCRIPT" --repo "$fifo_repo" --change-state staged)
assert_success "printf '%s\\n' \"\$outfifo\" | grep -q '\"path\": *\"normal.txt\"'" "special-file(FIFO): normal staged file unaffected by FIFO in worktree"

teardown_test_repo
rm -rf "$weird" "$init" "$ffz" "$excl" "$wip" "$cleanu" "$bytecap" "$ubin" "$ibin" "$ffz_missing" "$fifo_repo" "$ffz_fifo"
test_summary
