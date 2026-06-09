#!/usr/bin/env bash
# test-ultracode-flags.sh — structural assertions for v1.10.0 --ultracode/--codex flags.
# deep-review is markdown-spec-driven: these greps assert the runtime contracts exist
# in the command/skill/reference markdown. bash 3.2 compatible. exit 0 = all pass.
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CMD="$ROOT/commands/deep-review.md"
LOOP="$ROOT/skills/deep-review-loop/SKILL.md"
WF_SKILL="$ROOT/skills/deep-review-workflow/SKILL.md"
ULTRA="$ROOT/skills/deep-review-workflow/references/ultracode-integration.md"
CODEXREF="$ROOT/skills/deep-review-workflow/references/codex-integration.md"
REPORTFMT="$ROOT/skills/deep-review-workflow/references/report-format.md"
P6_PROMPT="$ROOT/skills/receiving-review/references/phase6-prompt-contract.md"
P6_DELEG="$ROOT/skills/receiving-review/references/phase6-delegation-spec.md"
RESP_FMT="$ROOT/skills/receiving-review/references/response-format.md"
CLAUDEMD="$ROOT/CLAUDE.md"

PASS=0; FAIL=0
ok(){ echo "PASS [$1] $2"; PASS=$((PASS+1)); }
no(){ echo "FAIL [$1] $2"; FAIL=$((FAIL+1)); }
# assert_grep ID FILE PATTERN DESC  — PATTERN must be present
assert_grep(){ if grep -qE -e "$3" "$2" 2>/dev/null; then ok "$1" "$4"; else no "$1" "$4 (missing /$3/ in ${2##*/})"; fi; }
# assert_absent ID FILE PATTERN DESC — PATTERN must be absent. -e: pattern may start with '--' (else grep treats it as an option, rc=2).
assert_absent(){ if grep -qE -e "$3" "$2" 2>/dev/null; then no "$1" "$4 (unexpected /$3/ in ${2##*/})"; else ok "$1" "$4"; fi; }

# ---------------------------------------------------------------------------
t_parse_validation(){
  # §2.2 — sugar expansion BEFORE validation, contradictions, parsing disambiguation
  assert_grep P1 "$CMD" 'codex-only.*(전개|expand).*(먼저|before)|슈가 전개.*먼저' "sugar expand-before-validate"
  assert_grep P2 "$CMD" '\-\-ultracode.*\-\-no-opus.*모순|\-\-no-opus.*\-\-ultracode.*모순' "--ultracode+--no-opus contradiction"
  assert_grep P3 "$CMD" '\-\-codex.*\-\-no-codex.*모순' "--codex+--no-codex contradiction"
  assert_grep P4 "$CMD" 'SLICE-\[0-9\]\+.*소비|다음 토큰이 .SLICE' "BC-4: --contract slice token disambiguation"
  assert_grep P5 "$CMD" '\-\-respond.*reviewer.*무시|reviewer 구성 플래그는 리뷰 모드 전용' "BC-5: --respond+reviewer notice"
  # SKILL-7 — frontmatter discoverability
  assert_grep P6 "$CMD" 'argument-hint:.*\-\-ultracode|argument-hint:.*\-\-codex' "SKILL-7: argument-hint exposes flags"
}

t_precedence(){
  # §2.3 precedence + BC-3 preservation + CONS-3 N=0
  assert_grep PR1 "$CMD" 'claude_reviewer *=' "claude_reviewer precedence resolver present"
  assert_grep PR2 "$CMD" 'none .*if .*\-\-no-opus' "no-opus -> none"
  assert_grep PR3 "$CMD" 'ultracode-fanout .*\-\-ultracode' "ultracode -> fanout"
  assert_grep PR4 "$CMD" 'single-opus .*else|single-opus.*기존 기본값' "else -> single-opus (BC-3 opus literal preserved)"
  assert_grep PR5 "$CMD" 'AGY_USER_DECLINED_THIS_RUN' "BC-3: per-run agy decline conjunct retained"
  assert_grep PR6 "$CMD" 'N_planned *=' "N_planned formula present"
  assert_grep PR7 "$CMD" 'N_planned *= *0|N=0.*검증.*에러|단발.*리뷰어가 없' "CONS-3: single-shot N=0 validation error"
}

# === main ===
t_parse_validation
t_precedence
echo "----"
echo "ultracode-flags: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
