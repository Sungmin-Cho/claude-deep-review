#!/usr/bin/env bash
# Current Stage-4 verdict synthesis and fail-closed structural oracle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
REF="$(cd "$SCRIPT_DIR/../../.." && pwd)/skills/deep-review-workflow/references"
REVEXEC="$REF/review-execution.md"
CODEX="$REF/codex-integration.md"
RPT="$REF/report-format.md"

# Count only trusted success and fail closed when none remain.
assert_success "grep -qF 'Count only successful trusted reviewer roles' '$REVEXEC'" \
  "review-execution counts trusted successful roles only"
assert_success "grep -qF 'N_actual == 0' '$REVEXEC'" \
  "review-execution owns explicit N=0 branch"
assert_success "grep -qF 'no verdict is allowed; report an operational failure' '$REVEXEC'" \
  "N=0 forbids a verdict and fails operationally"

# N=1 keeps critical/security blocking, warning-only cautious, and clean green.
assert_success "grep -qF 'N_actual == 1' '$REVEXEC'" \
  "review-execution owns explicit N=1 branch"
assert_success "grep -qE 'critical or security findings yield.*REQUEST_CHANGES' '$REVEXEC'" \
  "N=1 critical/security remains blocking"
assert_success "grep -qE 'warnings alone yield.*CONCERN' '$REVEXEC'" \
  "N=1 warning-only yields CONCERN"
assert_success "grep -qE 'no blocking finding yields.*APPROVE' '$REVEXEC'" \
  "N=1 clean result may APPROVE"

# N>=2 consensus keeps agreed warnings blocking and split warnings escalated.
assert_success "grep -qF 'N_actual >= 2' '$REVEXEC'" \
  "review-execution owns N>=2 branch"
assert_success "grep -qE 'REQUEST_CHANGES.*split warnings yield.*CONCERN.*otherwise.*APPROVE' '$REVEXEC'" \
  "N>=2 agreed/split/clean mapping is complete"

# Codex synthesis must count trusted roles, apply low-N rules before consensus,
# name excluded roles, and give them no vote.
assert_success "grep -qF 'number of trusted successful roles' '$CODEX'" \
  "Codex synthesis counts trusted successes"
assert_success "grep -qF 'Apply the N=0/N=1 rules' '$CODEX'" \
  "Codex synthesis applies low-N rules before consensus"
assert_success "grep -qF 'failed or untrusted' '$CODEX'" \
  "failed and untrusted roles remain visible"
assert_success "grep -qF 'contributes no vote' '$CODEX'" \
  "failed and untrusted roles contribute no vote"

# The rendered report mirrors the N=1 exception and degraded confidence floor.
assert_success "grep -qF 'N_actual == 1 예외' '$RPT'" \
  "report format mirrors N=1 exception"
assert_success "grep -qF 'N_actual ≥ 2' '$RPT'" \
  "unanimous-warning escalation is gated to N>=2"
assert_success "grep -qF 'critical/security 단독 blocking' '$RPT'" \
  "report format keeps N=1 critical blocking"
assert_success "grep -qF 'confidence floor' '$RPT'" \
  "degraded mode is a confidence floor"
assert_success "grep -qF 'REQUEST_CHANGES preserved' '$RPT'" \
  "degraded mode preserves blocking verdict"
assert_success "grep -qF 'APPROVE → **raised to CONCERN**' '$RPT'" \
  "degraded mode raises low-confidence approval"
assert_success "grep -qF 'never' '$REVEXEC' && grep -qF 'downgrades a blocking verdict' '$REVEXEC'" \
  "review execution never downgrades blocking verdict"
assert_success "grep -qF 'raises a low-confidence' '$REVEXEC'" \
  "review execution raises low-confidence approval"

# Decisive mutants for fail-closed and safety semantics.
mutant=$(mktemp)
sed 's/no verdict is allowed; report an operational failure/a verdict may be APPROVE/' \
  "$REVEXEC" > "$mutant"
assert_failure "grep -qF 'no verdict is allowed; report an operational failure' '$mutant'" \
  "N=0 APPROVE mutant is rejected"

sed 's/critical or security findings yield/critical or security findings may yield/' \
  "$REVEXEC" > "$mutant"
assert_failure "grep -qE 'critical or security findings yield.*REQUEST_CHANGES' '$mutant'" \
  "N=1 critical weakening mutant is rejected"

sed 's/A degraded failed Claude role never/A degraded failed Claude role may/' \
  "$REVEXEC" > "$mutant"
assert_failure "grep -qF 'A degraded failed Claude role never' '$mutant'" \
  "blocking-verdict downgrade mutant is rejected"

sed 's/trusted successful roles/requested roles/' "$CODEX" > "$mutant"
assert_failure "grep -qF 'trusted successful roles' '$mutant'" \
  "requested-role counting mutant is rejected"
rm -f "$mutant"

test_summary
