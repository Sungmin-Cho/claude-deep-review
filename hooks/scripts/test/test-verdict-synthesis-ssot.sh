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
# (b) solo(참고) 강등 줄에 N≥2 가드
assert_success "grep -qF 'N_actual ≥ 2' '$REVEXEC'" "solo(참고) 강등이 N≥2 로 가드됨"
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

test_summary
