#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/test-helpers.sh"
BUILD="$HERE/../build-reviewer-payload.sh"
AGY_BODY_LIMIT=198000   # must equal run-agy-reviewer.sh:671

doc=$(mktemp);  printf '===== DOCTRINE =====\nDOCTRINE_SENTINEL\n' > "$doc"
cf=$(mktemp);   printf '{"status":"M","path":"x"}\n' > "$cf"
ctx=$(mktemp);  printf 'RULES\n' > "$ctx"
big=$(mktemp);  { printf 'DIFF_SENTINEL\n'; head -c 250000 /dev/zero | tr '\0' 'x'; } > "$big"

pf=$(mktemp)
"$BUILD" --doctrine-file "$doc" --change-files-file "$cf" --context-file "$ctx" --diff-file "$big" > "$pf"

# The bridge keeps only the first AGY_BODY_LIMIT bytes; doctrine must be inside that window.
head -c "$AGY_BODY_LIMIT" "$pf" > "$pf.head"
assert_success "grep -q 'DOCTRINE_SENTINEL' \"$pf.head\"" "doctrine within first 198KB of assembled payload (ordering)"
# Sanity: the diff really is large enough to be after the doctrine (diff-last ordering).
doc_off=$(grep -abo 'DOCTRINE_SENTINEL' "$pf" | head -1 | cut -d: -f1)
diff_off=$(grep -abo 'DIFF_SENTINEL' "$pf" | head -1 | cut -d: -f1)
assert_success "[ \"$doc_off\" -lt \"$diff_off\" ]" "doctrine byte-offset precedes diff"

rm -f "$doc" "$cf" "$ctx" "$big" "$pf" "$pf.head"
test_summary
