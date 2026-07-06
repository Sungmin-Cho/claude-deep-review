#!/usr/bin/env bash
# test-verdict-synthesis-ssot.sh — Stage-4 verdict 합성 SSOT 구조 검증(#3 + #3-파생).
# verdict 합성은 자연어 스펙(LLM 수행)이라 단위 실행 테스트 대상이 아니다 →
# 문서 SSOT 일관성을 doc-grep 으로 고정(in-idiom: test-codex-claude-reviewer.sh 말미).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
# repo 루트 기준(cwd·git 비의존): hooks/scripts/test → ../../.. = repo root
REF="$(cd "$SCRIPT_DIR/../../.." && pwd)/skills/deep-review-workflow/references"
REVEXEC="$REF/review-execution.md"
CODEX="$REF/codex-integration.md"
RPT="$REF/report-format.md"

# (a) §5.1 실행 블록이 N=1 전용 분기(🟡 CONCERN / 🟢 APPROVE + 단일 리뷰어)를 인라인 보유
assert_success "grep -qF 'N_actual == 1' '$REVEXEC'" "review-execution 이 N=1 전용 분기를 인라인 보유"
assert_success "grep -qF '단일 리뷰어' '$REVEXEC'" "N=1 분기에 단일 리뷰어 표기 규칙 존재"
# (b) solo(참고) 강등 줄이 N≥3 로 가드 (N=2 미포함 — 2-way 1/2 는 참고 아님 CONCERN) — R3 fix
assert_success "grep -qF '단독 지적 (N_actual ≥ 3 일 때만) → 참고' '$REVEXEC'" "solo(참고) 강등이 N≥3 로 가드됨(N=2 미포함)"
# (b2) N_actual == 2 명시 분기: 1/2 단독 → 🟡 CONCERN (에스컬레이션, codex-integration §N-way 표와 동일)
assert_success "grep -qF 'N_actual == 2 분기' '$REVEXEC'" "review-execution N=2 명시 분기 존재"
assert_success "grep -qF '1/2 단독 → 🟡 CONCERN' '$REVEXEC'" "N=2 1/2 단독이 CONCERN(에스컬레이션)"
# (c) codex-integration N=1 행이 여전히 존재(값 drift 검출 — 두 파일 동일 결론)
assert_success "grep -qF 'N=1' '$CODEX'" "codex-integration N=1 행 존재"
assert_success "grep -qF 'APPROVE' '$CODEX'" "codex-integration N=1 0/1 APPROVE 존재"
# (d) degraded 가드가 두 파일 모두 claude_reviewer != none 로 codex-only(none) 제외.
#     bare 'claude_reviewer != none'(리뷰어 열거 :386)와 구분되도록 가드 고유의
#     'claude_reviewer != none AND opus_status' 시퀀스로 실제 degraded 가드를 고정한다.
assert_success "grep -qF 'claude_reviewer != none AND opus_status' '$REVEXEC'" "review-execution degraded 가드가 none 제외"
assert_success "grep -qF 'claude_reviewer != none AND opus_status' '$RPT'" "report-format degraded 가드가 none 제외"
# (e) verdict-decision 블록의 unanimous-yellow 규칙이 N≥2 게이트를 명시 —
#     N=1(1건 = 전원 일치가 자명)에서 REQUEST_CHANGES 로 N=1 CONCERN 이 무력화되지 않게 고정.
assert_success "grep -qF '전원 일치 (N_actual ≥ 2)' '$REVEXEC'" "review-execution unanimous-yellow 가 N≥2 게이트"
assert_success "grep -qF '전원 일치 (N_actual ≥ 2)' '$RPT'" "report-format unanimous-yellow 가 N≥2 게이트"
# (f) N=1 예외가 verdict-decision 레벨에 명시(N=1 전용 분기가 최종)
assert_success "grep -qF 'N_actual == 1 예외' '$REVEXEC'" "review-execution 이 N=1 예외를 verdict 규칙에 명시"
assert_success "grep -qF 'N_actual == 1 예외' '$RPT'" "report-format 이 N=1 예외를 명시"
# (g) N=1 전용 분기가 🔴(critical/security)은 단독이라도 REQUEST_CHANGES 로 유지(non-blocking 회피) — R2 fix.
#     세 문서(review-execution / report-format / codex-integration SSOT)가 동일 결론.
assert_success "grep -qF 'critical/security 는 단독이라도 blocking' '$REVEXEC'" "review-execution N=1 critical 이 blocking 유지"
assert_success "grep -qF 'critical/security 단독 blocking' '$RPT'" "report-format N=1 critical 이 blocking 유지"
assert_success "grep -qF '1/1 지적 (🔴 critical/security)' '$CODEX'" "codex-integration N=1 표에 🔴 REQUEST_CHANGES 행"
# (h) degraded 가드가 blocking verdict(RC)를 덮지 않고 신뢰도 floor 로만 동작 — R4 fix.
#     🔴/critical 존재 시 REQUEST_CHANGES 보존, APPROVE→CONCERN 상향만(fail-open 회피).
assert_success "grep -qF 'blocking verdict 를 덮지 않는다' '$REVEXEC'" "review-execution degraded 가 RC 를 덮지 않음(floor)"
assert_success "grep -qF 'REQUEST_CHANGES 보존' '$REVEXEC'" "review-execution degraded 가 critical 시 RC 보존"
assert_success "grep -qF 'REQUEST_CHANGES preserved' '$RPT'" "report-format degraded 가 critical 시 RC 보존"

test_summary
