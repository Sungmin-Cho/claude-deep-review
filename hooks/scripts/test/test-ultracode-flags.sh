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

t_sec1(){
  assert_grep S1 "$CMD" 'agy_included.*Stage 3\.5|Stage 3\.5.*agy_included|--no-agy.*Stage 3\.5.*(skip|건너)' "SEC-1: Stage 3.5 gated on agy_included"
  assert_grep S2 "$CMD" '\-\-no-agy.*fingerprint.*(변경하지|미변경|not).*|fingerprint.*변경하지 않' "SEC-1: --no-agy does not mutate fingerprint"
}

t_ultra_ref(){
  assert_grep U1 "$ULTRA" '정확성|Correctness' "5 dimensions listed"
  assert_grep U2 "$ULTRA" 'Workflow 가 .*문자 그대로 존재할 때만|도구 목록에 .Workflow' "ARCH-2 deterministic selection rule"
  assert_grep U3 "$ULTRA" 'join 계약|codex/agy.*먼저.*spawn' "ARCH-1 join contract"
  assert_grep U4 "$ULTRA" 'run-claude-reviewer\.sh' "path B bridge fallback"
  assert_grep U5 "$ULTRA" 'floor\(line ?/ ?7\)|line_bucket' "VOICE-4 fixed bucket"
  assert_absent U6 "$ULTRA" '\{severity\}:\{file\}:\{line ?.3\}:\{category\}' "VOICE-1/2: old dedup key NOT present"
  assert_grep U7 "$ULTRA" 'confidence *= *.?low|강등.*보존|무음(삭제|삭제)' "VOICE-6 demote-not-drop"
  assert_grep U8 "$ULTRA" 'partial-failure|K/5|≥1 샤드' "ARCH-8 partial-failure semantics"
  assert_grep U9 "$WF_SKILL" 'ultracode-integration\.md' "SKILL points to new reference"
  assert_grep U10 "$ULTRA" '최댓값 severity|severity 승격' "VOICE-1 max-severity promotion documented"
}

t_cmd_ultracode(){
  assert_grep C1 "$CMD" 'ultracode-integration\.md' "command references ultracode SSOT"
  assert_grep C2 "$CMD" 'codex/agy.*먼저.*spawn|먼저 codex/agy' "ARCH-1 ordering in command"
  assert_grep C3 "$CMD" 'Claude\(ultracode\)|단일.*보이스|single.*voice' "single-voice collapse referenced"
  assert_grep C4 "$CMD" 'opus_status.*(success|쿼럼|quorum)|≥1 샤드 성공' "CONS-10 opus_status fan-out collapse"
  assert_grep C5 "$CMD" 'Claude=ultracode|ultracode\(5-lens' "Review Mode ultracode label"
  assert_grep C6 "$CMD" 'agent-fanout fallback|UNVERIFIED fallback' "SC-4: fallback label present"
}

t_reportfmt(){
  assert_grep RF1 "$REPORTFMT" 'Claude=ultracode|ultracode\(5-lens' "report-format ultracode label"
  assert_grep RF2 "$REPORTFMT" 'agy only|agy-only' "agy-only label (CONS-10)"
  assert_grep RF3 "$REPORTFMT" 'opus_status.*(≥1 샤드|쿼럼|partial)' "opus_status fan-out collapse documented"
}

# === main ===
t_parse_validation
t_precedence
t_sec1
t_ultra_ref
t_cmd_ultracode
t_reportfmt
echo "----"
echo "ultracode-flags: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
