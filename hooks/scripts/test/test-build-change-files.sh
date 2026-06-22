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

# --- Finding B (out-of-scope exclusions): change_files must mirror commands/deep-review.md:172.
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

teardown_test_repo
rm -rf "$weird" "$init" "$ffz" "$excl" "$wip"
test_summary
