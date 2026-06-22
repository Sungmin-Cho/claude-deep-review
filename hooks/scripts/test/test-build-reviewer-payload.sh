#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/test-helpers.sh"
SCRIPT="$HERE/../build-reviewer-payload.sh"

doc=$(mktemp); printf 'DOCTRINE_MARKER\n' > "$doc"
cf=$(mktemp);  printf '{"status":"M","path":"x"}\n' > "$cf"
ctx=$(mktemp); printf 'RULES_MARKER\n' > "$ctx"
diff=$(mktemp); printf 'DIFF_MARKER huge...\n' > "$diff"

out=$("$SCRIPT" --doctrine-file "$doc" --change-files-file "$cf" --context-file "$ctx" --diff-file "$diff")
# doctrine offset must be < diff offset (diff LAST — instruction-attention ordering)
doc_pos=$(printf '%s' "$out" | grep -bo 'DOCTRINE_MARKER' | head -1 | cut -d: -f1)
diff_pos=$(printf '%s' "$out" | grep -bo 'DIFF_MARKER' | head -1 | cut -d: -f1)
assert_success "[ \"$doc_pos\" -lt \"$diff_pos\" ]" "doctrine appears before diff"
cf_pos=$(printf '%s' "$out" | grep -bo 'status' | head -1 | cut -d: -f1)
assert_success "[ \"$cf_pos\" -lt \"$diff_pos\" ]" "change_files appears before diff"

# omitting optional parts still works and still puts diff last
out2=$("$SCRIPT" --diff-file "$diff")
assert_success "printf '%s' \"$out2\" | grep -q 'DIFF_MARKER'" "diff-only payload builds"

rm -f "$doc" "$cf" "$ctx" "$diff"
test_summary
