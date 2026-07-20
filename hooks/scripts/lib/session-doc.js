'use strict';

/**
 * session-doc.js — single source of truth for recognizing the opt-in
 * per-session review document (`--session-doc`, deep-review-loop §4a).
 *
 * The document lives in the SAME `.deep-review/reports/` dir as canonical round
 * reports and ends in the canonical `-review.md` suffix, but it is a DERIVED,
 * in-place aggregate keyed by loop_id (`loop-<id>-review.md`) — never a
 * per-round canonical report. Canonical round reports are always
 * timestamp-prefixed (`{YYYY-MM-DD}-{HHmmss}-review.md`), so the `loop-` prefix
 * never collides with one. EVERY surface that enumerates the reports dir by the
 * `-review.md` suffix alone MUST exclude it through this one predicate:
 *   - loop-state.mjs `listReports` (snapshot/resolve delta accounting — the
 *     fail-closed REPORT_DELTA_COUNT invariant),
 *   - respond-runtime.mjs `listReviewReports` (a later pathless `--respond`
 *     must never select the derived aggregate over a canonical round report),
 *   - wrap-recurring-findings-envelope.js `discoverSources` (recurring-findings
 *     provenance — the aggregate must not double-count round findings).
 *
 * CommonJS on purpose: consumed by both the ESM runtimes (named import) and the
 * CommonJS envelope wrapper (require), so ONE predicate serves all three
 * surfaces without a module-system boundary duplicating the rule.
 */

const SESSION_DOC_PATTERN = /^loop-.+-review\.md$/u;

/**
 * True when `name` is a session-doc report filename. Callers pass a directory
 * entry basename (never a full path); a non-string is never a session doc.
 */
function isSessionDocReportName(name) {
  return typeof name === 'string' && SESSION_DOC_PATTERN.test(name);
}

module.exports = { SESSION_DOC_PATTERN, isSessionDocReportName };
