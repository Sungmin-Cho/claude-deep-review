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
# W9: conservative-balance block must come BEFORE the suppression block
first_section=$(printf '%s' "$("$SCRIPT" "$F")" | grep '^###' | head -1)
assert_equal "### Severity — conservative default" "$first_section" "conservative-balance block emitted first (W9)"

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

# 3b) duplicate conservative markers → fail-closed (symmetric to 3)
F3b=$(mktemp); mkfix "$F3b" <<'EOF'
<!-- fp-conservative:start -->
강등하지 않는다
<!-- fp-conservative:end -->
<!-- fp-conservative:start -->
강등하지 않는다 again
<!-- fp-conservative:end -->
<!-- fp-doctrine:start -->
- pre-existing
- 린터
- 추측
- 취향
<!-- fp-doctrine:end -->
EOF
assert_failure "\"$SCRIPT\" \"$F3b\"" "duplicate conservative markers fail closed"

# 4) empty doctrine body → fail-closed
F4=$(mktemp); mkfix "$F4" <<'EOF'
<!-- fp-conservative:start -->
강등하지 않는다
<!-- fp-conservative:end -->
<!-- fp-doctrine:start -->
<!-- fp-doctrine:end -->
EOF
assert_failure "\"$SCRIPT\" \"$F4\"" "empty doctrine body fails closed"

# 5) missing argument / nonexistent file → fail-closed
assert_failure "\"$SCRIPT\"" "no-arg invocation fails closed"
assert_failure "\"$SCRIPT\" /nonexistent/path/file.md" "nonexistent file fails closed"

# 6) real repo file extracts successfully
REAL="$HERE/../../../skills/deep-review-workflow/references/review-criteria.md"
assert_success "\"$SCRIPT\" \"$REAL\"" "real review-criteria.md extracts"

rm -f "$F" "$F2" "$F3" "$F3b" "$F4"

# doc-structure: orchestrator wires the extractor + builder + warnings render, and adversarial is NOT injected
CMD="$HERE/../../../commands/deep-review.md"
assert_success "grep -q 'extract-fp-doctrine.sh' \"$CMD\"" "command wires extract-fp-doctrine.sh"
assert_success "grep -q 'build-change-files.sh' \"$CMD\"" "command wires build-change-files.sh"
assert_success "grep -q 'build-reviewer-payload.sh' \"$CMD\"" "command wires shared payload builder"
assert_success "grep -q 'Summary.Warnings' \"$CMD\"" "command renders helper-failure warnings into Summary"
assert_success "grep -q 'adversarial 에는 주입하지 않는다' \"$CMD\"" "adversarial not injected (documented)"
# Finding 1 lock: shared payload assembly is HOISTED above the reviewer branch (not single-opus-gated).
# The payload marker (build-reviewer-payload.sh) must appear at an earlier line than the
# 'claude_reviewer == single-opus' header — i.e. the block runs for ultracode/agy too, not just single-opus.
payload_line=$(grep -n 'build-reviewer-payload.sh' "$CMD" | head -1 | cut -d: -f1)
singleopus_line=$(grep -n 'claude_reviewer == single-opus' "$CMD" | head -1 | cut -d: -f1)
assert_success "[ -n \"$payload_line\" ] && [ -n \"$singleopus_line\" ]" "payload + single-opus markers both present"
assert_success "[ \"$payload_line\" -lt \"$singleopus_line\" ]" "shared payload assembly hoisted ABOVE the reviewer-branch (not single-opus-gated)"
# Finding 3: Stage-4 explicitly renders captured OCR_WARNINGS into Summary.Warnings (distinct from the :470 capture comment).
assert_success "grep -q 'OCR_WARNINGS render step' \"$CMD\"" "Stage-4 renders OCR_WARNINGS into Summary.Warnings (explicit step)"
# focus_text negative (W7): the adversarial focus_text builder must NOT pull in the doctrine
CI="$HERE/../../../skills/deep-review-workflow/references/codex-integration.md"
assert_failure "grep -Eq 'extract-fp-doctrine|fp-doctrine:start' \"$CI\"" "codex-integration does not inject fp-doctrine into adversarial focus_text"
CR="$HERE/../../../agents/code-reviewer.md"
assert_success "grep -q 'cross-file 컨텍스트' \"$CR\"" "code-reviewer has Strict-Focus guard"

test_summary
