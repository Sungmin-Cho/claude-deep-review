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

teardown_test_repo
rm -rf "$weird" "$init" "$ffz"
test_summary
