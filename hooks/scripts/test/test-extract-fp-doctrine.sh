#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/test-helpers.sh"
SCRIPT="$HERE/../extract-fp-doctrine.sh"

mkfix() {
  cat > "$1"
}

# 1) happy path: both blocks present, with the conservative block first.
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
first_section=$(printf '%s' "$("$SCRIPT" "$F")" | grep '^###' | head -1)
assert_equal "### Severity — conservative default" "$first_section" "conservative-balance block emitted first (W9)"

# 2) missing doctrine markers fail closed with no stdout.
F2=$(mktemp); mkfix "$F2" <<'EOF'
no markers here
EOF
assert_failure "\"$SCRIPT\" \"$F2\"" "missing markers fails closed"
assert_equal "" "$("$SCRIPT" "$F2" 2>/dev/null || true)" "fail-closed emits nothing on stdout"

# 3) duplicate doctrine markers fail closed.
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

# 3b) duplicate conservative markers fail closed symmetrically.
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

# 4) empty doctrine body fails closed.
F4=$(mktemp); mkfix "$F4" <<'EOF'
<!-- fp-conservative:start -->
강등하지 않는다
<!-- fp-conservative:end -->
<!-- fp-doctrine:start -->
<!-- fp-doctrine:end -->
EOF
assert_failure "\"$SCRIPT\" \"$F4\"" "empty doctrine body fails closed"

# 5) missing argument and nonexistent path fail closed.
assert_failure "\"$SCRIPT\"" "no-arg invocation fails closed"
assert_failure "\"$SCRIPT\" /nonexistent/path/file.md" "nonexistent file fails closed"

# 6) the real source remains byte-extractable by the Unix parity oracle.
ROOT="$HERE/../../.."
REAL="$ROOT/skills/deep-review-workflow/references/review-criteria.md"
assert_success "\"$SCRIPT\" \"$REAL\"" "real review-criteria.md extracts"
rm -f "$F" "$F2" "$F3" "$F3b" "$F4"

# Supported-runtime ownership moved to the Node builder/change manifest.
REVEXEC="$ROOT/skills/deep-review-workflow/references/review-execution.md"
WFSK="$ROOT/skills/deep-review-workflow/SKILL.md"
CODEX="$ROOT/skills/deep-review-workflow/references/codex-integration.md"
ULTRA="$ROOT/skills/deep-review-workflow/references/ultracode-integration.md"
AGY="$ROOT/skills/deep-review-workflow/references/agy-integration.md"
REPORT="$ROOT/skills/deep-review-workflow/references/report-format.md"

assert_success "grep -q 'build-change-files.mjs' \"$REVEXEC\"" "review execution uses native change manifest"
assert_success "grep -q 'build-reviewer-payload.mjs' \"$REVEXEC\"" "review execution uses native shared payload builder"
assert_success "grep -q 'sole doctrine injector' \"$REVEXEC\"" "Node builder is the sole supported doctrine injector"
assert_success "grep -q 'builder warning in the final report' \"$REVEXEC\"" "builder warnings remain visible"
assert_failure "grep -Eq 'extract-fp-doctrine.sh|build-change-files.sh|build-reviewer-payload.sh' \"$REVEXEC\"" "supported review path rejects shell-era helpers"
assert_success "grep -q 'extract-fp-doctrine.sh.*Unix parity oracle' \"$REAL\"" "criteria labels the shell extractor parity-only"
assert_success "grep -q 'build-reviewer-payload.mjs' \"$WFSK\"" "workflow pipeline names the shared Node builder"

builder_line=$(grep -n 'Build one shared reviewer payload with.*build-reviewer-payload.mjs' "$WFSK" | head -1 | cut -d: -f1)
dispatch_line=$(grep -n 'Enumerate independent roles' "$WFSK" | head -1 | cut -d: -f1)
assert_success "[ -n \"$builder_line\" ] && [ -n \"$dispatch_line\" ] && [ \"$builder_line\" -lt \"$dispatch_line\" ]" "shared payload is built before reviewer enumeration"

assert_success "grep -q 'shared payload file built by.*build-reviewer-payload.mjs' \"$CODEX\"" "Codex generic role consumes shared Node payload"
assert_success "grep -q 'Operate in read-only mode' \"$CODEX\"" "Codex generic role retains read-only guard"
assert_failure "grep -Eq 'extract-fp-doctrine|fp-doctrine:start' \"$CODEX\"" "Codex adversarial focus does not receive doctrine injection"
assert_success "grep -q 'identical doctrine' \"$ULTRA\"" "ultracode lenses receive identical doctrine"
assert_success "grep -q 'bridge uses the shared payload' \"$AGY\"" "agy consumes the shared payload"
assert_success "grep -q 'Warnings' \"$REPORT\"" "report format preserves operational warnings"

# Decisive mutants: shell-helper restoration and loss of sole-injector wording
# must both break the migrated structural contract.
mutant_shell=$(mktemp)
sed -e 's/build-change-files\.mjs/build-change-files.sh/g' \
    -e 's/build-reviewer-payload\.mjs/build-reviewer-payload.sh/g' \
    "$REVEXEC" > "$mutant_shell"
assert_failure "grep -q 'build-reviewer-payload.mjs' \"$mutant_shell\"" "shell-helper mutant loses Node payload authority"
assert_success "grep -Eq 'build-change-files.sh|build-reviewer-payload.sh' \"$mutant_shell\"" "shell-helper mutant is detected"

mutant_owner=$(mktemp)
sed 's/sole doctrine injector/non-authoritative helper/' "$REVEXEC" > "$mutant_owner"
assert_failure "grep -q 'sole doctrine injector' \"$mutant_owner\"" "doctrine-owner mutant loses fail-closed authority"
rm -f "$mutant_shell" "$mutant_owner"

test_summary
