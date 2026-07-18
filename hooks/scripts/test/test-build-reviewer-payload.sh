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

# M-2 carry-over: negative assertion — skip-empty guard omits doctrine header from diff-only payload
assert_failure "printf '%s' \"$out2\" | grep -q 'REVIEW SUPPRESSION DOCTRINE'" "diff-only payload omits doctrine header (skip-empty)"

# Supported-runtime doc assertions. The shell implementation above remains a
# Unix parity oracle; orchestration must use the Node builder.
UC="$HERE/../../../skills/deep-review-workflow/references/ultracode-integration.md"
assert_success "grep -q 'build-reviewer-payload.mjs' \"$UC\"" "ultracode shards use shared Node builder"
assert_success "grep -Eq 'identical doctrine|동일한 doctrine' \"$UC\"" "ultracode shards receive shared doctrine"
assert_failure "grep -q 'build-reviewer-payload.sh' \"$UC\"" "supported ultracode path rejects shell-era builder"
RF="$HERE/../../../skills/deep-review-workflow/references/report-format.md"
assert_success "grep -q 'Warnings' \"$RF\"" "report-format has Warnings line"

# Decisive mutant: replacing the Node authority with the old shell name must
# break the positive contract and trip the shell-only negative guard.
mutant=$(mktemp)
sed 's/build-reviewer-payload\.mjs/build-reviewer-payload.sh/' "$UC" > "$mutant"
assert_failure "grep -q 'build-reviewer-payload.mjs' \"$mutant\"" "shell-name mutant loses Node builder authority"
assert_success "grep -q 'build-reviewer-payload.sh' \"$mutant\"" "shell-name mutant is detected"
rm -f "$mutant"

test_summary
