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

t_codexref(){
  assert_grep X1 "$CODEXREF" 'ultracode-integration\.md' "codex-integration links to ultracode SSOT"
  assert_grep X2 "$CODEXREF" 'Claude\(ultracode\)|ultracode fan-out' "1-line note about ultracode voice"
  # SKILL-4: collapse mechanics must NOT be duplicated here
  assert_absent X3 "$CODEXREF" 'floor\(line ?/ ?7\)' "no duplicated collapse bucket here"
}

t_source_enum(){
  # T7 정정: delegation-spec 는 enum 줄이 없으므로(214=예시값) 제외. prompt-contract + response-format + CLAUDE.md 만.
  assert_grep E1 "$P6_PROMPT" 'Opus \(ultracode\)' "prompt-contract has Opus (ultracode)"
  assert_grep E3 "$RESP_FMT"  'Opus \(ultracode\)' "response-format has Opus (ultracode)"
  assert_grep E4 "$CLAUDEMD"  'opus-ultracode' "CLAUDE.md schema has opus-ultracode"
  # absent-guards (편집 전후 모두 PASS): phase6-implementer 엔 enum 없음, delegation-spec 도 건드리지 않음
  assert_absent E5 "$ROOT/agents/phase6-implementer.md" 'opus-ultracode|Opus \(ultracode\)' "phase6-implementer untouched (no enum there)"
}

t_loop(){
  assert_grep L1 "$LOOP" 'ultracode|codex-only' "SKILL-3: description/triggers mention ultracode/codex-only"
  assert_grep L2 "$LOOP" 'never-forward|전달 안 함.*--max|--max.*전달 안' "LOOP-2: never-forward set"
  assert_grep L3 "$LOOP" '--ultracode 토큰을 제거|라운드 2\+.*--ultracode.*제거|strip.*--ultracode' "LOOP-3: strip --ultracode in R2+"
  assert_grep L4 "$LOOP" 'ultracode_consumed' "ultracode_consumed gate"
  assert_grep L5 "$LOOP" 'ultracode_consumed == false.*중단|--codex-only.*중단|reviewer.*0.*중단' "LOOP-1: codex-only -> stop branch"
  assert_grep L6 "$LOOP" 'ultracode_consumed == true.*단일 Opus|통합 루프.*단일 Opus' "LOOP-1: integrated -> single-opus fallback"
  assert_grep L7 "$LOOP" '--no-agy.*주입|R2\+.*--no-agy|라운드 2\+.*agy' "CONS-4: agy off in R2+"
  assert_grep L8 "$LOOP" 'floor\(line ?/ ?7\)' "VOICE-4: signature uses fixed bucket"
  assert_absent L8b "$LOOP" 'line ±3' "VOICE-4: no stale ±3 bucket remains"
  assert_absent L9 "$LOOP" '\-\-contract.*만 전달' "F3: stale forward-only rule removed"
}

t_docs(){
  assert_grep D1 "$ROOT/README.md" '\-\-ultracode' "README mentions --ultracode"
  assert_grep D2 "$ROOT/README.ko.md" '\-\-ultracode' "README.ko mentions --ultracode"
  assert_grep D3 "$CLAUDEMD" '\-\-ultracode' "CLAUDE.md slash table mentions --ultracode"
}

t_version(){
  assert_grep V1 "$ROOT/.claude-plugin/plugin.json" '"version": *"1\.10\.0"' "claude plugin 1.10.0"
  assert_grep V2 "$ROOT/.codex-plugin/plugin.json" '"version": *"1\.10\.0"' "codex plugin 1.10.0"
  assert_grep V3 "$ROOT/package.json" '"version": *"1\.10\.0"' "package.json 1.10.0"
  assert_grep V4 "$ROOT/CHANGELOG.md" '1\.10\.0' "CHANGELOG has 1.10.0"
  assert_grep V5 "$ROOT/CHANGELOG.ko.md" '1\.10\.0' "CHANGELOG.ko has 1.10.0"
}

# === main ===
t_parse_validation
t_precedence
t_sec1
t_ultra_ref
t_cmd_ultracode
t_reportfmt
t_codexref
t_source_enum
t_loop
t_docs
t_version
echo "----"
echo "ultracode-flags: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
