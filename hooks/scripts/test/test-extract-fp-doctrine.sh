#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/test-helpers.sh"
SCRIPT="$HERE/../extract-fp-doctrine.sh"

mkfix() { # $1=dest file ; writes a review-criteria fixture from stdin
  cat > "$1"
}

# 1) happy path: both blocks present → exit 0, contains a doctrine bullet + the conservative phrase
F=$(mktemp); mkfix "$F" <<'EOF'
intro
<!-- fp-conservative:start -->
**보수적 기본값**: 도달 가능성을 diff만으로 확정할 수 없으면 강등하지 않는다.
<!-- fp-conservative:end -->
mid
<!-- fp-doctrine:start -->
- 변경과 무관한 pre-existing 이슈: ...
- 린터/포매터가 자동 수정하는 스타일: ...
- 근거 없는 추측: ...
- 단순 취향: ...
<!-- fp-doctrine:end -->
> ⚠️ VOICE-6 note must be excluded
EOF
out=$("$SCRIPT" "$F"); rc=$?
assert_equal "0" "$rc" "happy path exits 0"
assert_success "printf '%s' \"\$(\"$SCRIPT\" \"$F\")\" | grep -q '근거 없는 추측'" "output contains a doctrine bullet"
assert_success "printf '%s' \"\$(\"$SCRIPT\" \"$F\")\" | grep -q '강등하지 않는다'" "output contains conservative phrase"
assert_failure "\"$SCRIPT\" \"$F\" | grep -q 'VOICE-6'" "VOICE-6 note is excluded"

# 2) missing doctrine markers → fail-closed (non-zero, empty stdout)
F2=$(mktemp); mkfix "$F2" <<'EOF'
no markers here
EOF
assert_failure "\"$SCRIPT\" \"$F2\"" "missing markers fails closed"
assert_equal "" "$("$SCRIPT" "$F2" 2>/dev/null || true)" "fail-closed emits nothing on stdout"

# 3) duplicate doctrine markers → fail-closed
F3=$(mktemp); mkfix "$F3" <<'EOF'
<!-- fp-conservative:start -->
x 강등하지 않는다
<!-- fp-conservative:end -->
<!-- fp-doctrine:start -->
- a
<!-- fp-doctrine:end -->
<!-- fp-doctrine:start -->
- b
<!-- fp-doctrine:end -->
EOF
assert_failure "\"$SCRIPT\" \"$F3\"" "duplicate doctrine markers fail closed"

# 4) empty doctrine body → fail-closed
F4=$(mktemp); mkfix "$F4" <<'EOF'
<!-- fp-conservative:start -->
강등하지 않는다
<!-- fp-conservative:end -->
<!-- fp-doctrine:start -->
<!-- fp-doctrine:end -->
EOF
assert_failure "\"$SCRIPT\" \"$F4\"" "empty doctrine body fails closed"

# 5) real repo file extracts successfully
REAL="$HERE/../../../skills/deep-review-workflow/references/review-criteria.md"
assert_success "\"$SCRIPT\" \"$REAL\"" "real review-criteria.md extracts"

rm -f "$F" "$F2" "$F3" "$F4"
test_summary
