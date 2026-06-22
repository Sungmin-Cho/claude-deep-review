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

# --- Finding 1 (codex R3): the agy reviewer's {prompt_file} MUST be the captured shared PROMPT_FILE
# from the "공유 reviewer payload 조립" block (carries fp-doctrine + change_files), NOT a fresh
# agy-only mktemp — otherwise v1.12.0 #2 (doctrine reaches every reviewer) silently misses agy.
assert_success "grep -q 'NOT a fresh agy-only mktemp' \"$CMD\"" "agy {prompt_file} = captured shared PROMPT_FILE (not a fresh agy mktemp)"
assert_success "grep -q '공유 PROMPT_FILE 소비' \"$CMD\"" "agy section has the shared-PROMPT_FILE-consumption directive"
# The agy section's {prompt_file} substitution example must tie it to the shared payload-assembly
# block by name. This phrasing is unique to the agy section (the single-opus tie at :493 uses
# different wording), so head -1 cannot collide with the single-opus block.
agy_line=$(grep -n '^4\. \*\*agy reviewer\*\*' "$CMD" | head -1 | cut -d: -f1)
sharedref_line=$(grep -n 'captured .PROMPT_FILE. literal path from the .공유 reviewer payload 조립. block above' "$CMD" | head -1 | cut -d: -f1)
assert_success "[ -n \"$agy_line\" ] && [ -n \"$sharedref_line\" ]" "agy section + agy {prompt_file} shared-PROMPT_FILE reference both present"
assert_success "[ \"$sharedref_line\" -gt \"$agy_line\" ]" "agy {prompt_file} shared-PROMPT_FILE reference lives inside the agy reviewer section"

# --- Finding 3 (codex R3): the Stage-1 'diff에서 제외' list (commands/deep-review.md:172, the SoT)
# must contain EXACTLY the same exclusion tokens as build-change-files.sh's EXCLUDE_SEGMENTS +
# EXCLUDE_BASENAME_GLOBS. Token-by-token cross-check (membership must be textually identical) so
# the diff-collection rule and the change_files manifest target the same set (spec §4.1).
BCF="$HERE/../build-change-files.sh"
# Isolate ONLY the Stage-1 ':172' exclusion block: from the 'diff에서 제외' line to the FIRST
# blank line. Must terminate at the blank line (not at 'best-effort') so it cannot sweep in the
# §2.1 session-inference exclusion list at :183-188, which legitimately repeats many of the same
# tokens — making the cross-check discriminate the SoT bullets specifically (RED-meaningful: the
# old one-liner :172 lacks dist/.next/target/.DS_Store, so those assertions fail pre-fix).
excl_block=$(awk '/diff에서 제외/{f=1} f&&/^[[:space:]]*$/{exit} f{print}' "$CMD")
for tok in node_modules dist build .next target .venv __pycache__ .pytest_cache vendor .git \
           '*.min.js' '*.generated.*' '*.lock' .DS_Store; do
  # token must be present in BOTH the helper source AND the doc SoT block
  assert_success "grep -Fq -- '$tok' \"$BCF\"" "helper EXCLUDE set contains '$tok'"
  assert_success "printf '%s\\n' \"\$excl_block\" | grep -Fq -- '$tok'" "deep-review.md:172 SoT list contains '$tok'"
done
# Reverse direction: the helper must not silently carry an excluded segment the doc SoT omits.
# (EXCLUDE_SEGMENTS membership lock — extract the python set literals and confirm each is in the doc.)
helper_segs=$(awk '/EXCLUDE_SEGMENTS=\{/{f=1} f{print} f&&/\}/{exit}' "$BCF" | grep -oE '"[^"]+"' | tr -d '"')
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  assert_success "printf '%s\\n' \"\$excl_block\" | grep -Fq -- '$seg'" "doc SoT covers helper segment '$seg' (no helper-only exclusion)"
done <<EOF
$helper_segs
EOF
# focus_text negative (W7): the adversarial focus_text builder must NOT pull in the doctrine
CI="$HERE/../../../skills/deep-review-workflow/references/codex-integration.md"
assert_failure "grep -Eq 'extract-fp-doctrine|fp-doctrine:start' \"$CI\"" "codex-integration does not inject fp-doctrine into adversarial focus_text"
CR="$HERE/../../../agents/code-reviewer.md"
assert_success "grep -q 'cross-file 컨텍스트' \"$CR\"" "code-reviewer has Strict-Focus guard"

# --- Fix-propagation (codex R4): the v1.12.0 contract must not survive in stale duplicate copies.
SK="$HERE/../../../skills/deep-review-workflow/SKILL.md"

# F1 (command SSOT): the Stage-1 collection prose in commands/deep-review.md must ALSO carry the
# dirty-states-only union (clean excluded) — the earlier rounds fixed build-change-files.sh + the
# §4.1 exclusion doc but left the :169 collection prose saying the stale all-states union, which an
# executor follows directly. Lock it: no stale all-states union, and the dirty-only rule present.
assert_failure "grep -q '모든 git 상태에서 untracked' \"$CMD\"" "command Stage-1 prose dropped the stale 'all git states' untracked union"
assert_success "grep -q 'dirty working-tree 상태' \"$CMD\"" "command Stage-1 union is dirty-working-tree-states-only"
assert_success "grep -Eq 'clean .* union에서 제외|union에서 제외' \"$CMD\"" "command Stage-1 documents clean is excluded from the untracked union"

# F1: SKILL.md Stage-1 must NOT carry the OLD "모든 git 상태" all-states union (clean was excluded
# from the union when build-change-files made it dirty-states-only). Regression-trip if it returns.
assert_failure "grep -q '모든 git 상태에서 untracked' \"$SK\"" "SKILL.md Stage-1 dropped the stale 'all git states' untracked union"
# It must instead state the dirty-only union (clean excluded) AND defer the exclusion list to the SSOT.
assert_success "grep -q 'dirty working-tree 상태' \"$SK\"" "SKILL.md Stage-1 union is dirty-working-tree-states-only"
assert_success "grep -Eq 'clean .* union에서 제외|union에서 제외' \"$SK\"" "SKILL.md Stage-1 documents clean is excluded from the untracked union"
assert_success "grep -q 'commands/deep-review.md:172' \"$SK\"" "SKILL.md Stage-1 defers the exclusion set to the commands SSOT (no 4th divergent copy)"
# And it must NOT restate the OLD short exclusion list verbatim (the divergent 5-token copy).
assert_failure "grep -q 'diff에서 제외: 바이너리, vendor/, node_modules/, \*.min.js, \*.generated.\*, \*.lock' \"$SK\"" "SKILL.md Stage-1 no longer restates the stale short exclusion list"

# F2: codex-integration.md claude-bridge must NOT mint a fresh prompt mktemp — it must consume the
# captured shared PROMPT_FILE literal (carrying fp-doctrine + change_files), same as commands SSOT.
assert_failure "grep -q 'prompt_file=\$(mktemp' \"$CI\"" "codex-integration claude-bridge no longer mints a fresh prompt mktemp"
assert_success "grep -q -- \"--prompt-file '<captured PROMPT_FILE literal>'\" \"$CI\"" "codex-integration claude-bridge passes the captured PROMPT_FILE literal"
assert_success "grep -q '공유 PROMPT_FILE 소비' \"$CI\"" "codex-integration claude-bridge has the shared-PROMPT_FILE-consumption directive"
assert_success "grep -q 'commands/deep-review.md:505-508' \"$CI\"" "codex-integration claude-bridge points to the commands SSOT call form"

# Repo-wide lock: the ONLY sanctioned place that mints the reviewer prompt_file is the single
# "공유 reviewer payload 조립" block in commands/deep-review.md (the SSOT — asserted hoisted above).
# No reference skill or agent may re-mint a reviewer-prompt mktemp (that would bypass the captured
# shared PROMPT_FILE carrying fp-doctrine + change_files). Scope: skills/ + agents/ only.
ROOT="$HERE/../../.."
assert_failure "grep -rIl --include='*.md' --include='*.sh' 'prompt_file=\$(mktemp' \"$ROOT/skills\" \"$ROOT/agents\"" "no reference skill/agent re-mints a reviewer-prompt mktemp (shared PROMPT_FILE only)"
# And commands/deep-review.md mints it EXACTLY ONCE — the canonical shared-payload assembly. More
# than one would mean a reviewer branch re-minted its own prompt instead of consuming the shared one.
mktemp_count=$(grep -c 'prompt_file=$(mktemp' "$CMD" || true)
assert_equal "1" "$mktemp_count" "commands SSOT mints the shared prompt_file exactly once (canonical assembly block)"

test_summary
