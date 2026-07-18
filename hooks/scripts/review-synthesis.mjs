#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERDICTS = new Set(['APPROVE', 'CONCERN', 'REQUEST_CHANGES']);

export function parseReviewerReport(output) {
  if (typeof output !== 'string' || output.length === 0) return null;
  if (!/^# Deep Review Report — [0-9]{4}-[0-9]{2}-[0-9]{2}$/mu.test(output)
    || !/^## Summary$/mu.test(output)) return null;
  const verdictMatch = /^- \*\*Verdict\*\*:\s*(APPROVE|CONCERN|REQUEST_CHANGES)\s*$/mu.exec(output);
  const issuesMatch = /^- \*\*Issues\*\*:\s*[^\n]*?🔴\s*([0-9]+)[^\n]*?🟡\s*([0-9]+)[^\n]*?ℹ(?:️)?\s*([0-9]+)[^\n]*$/mu.exec(output);
  if (!verdictMatch || !issuesMatch || !VERDICTS.has(verdictMatch[1])) return null;
  const issues = {
    critical: Number(issuesMatch[1]),
    warning: Number(issuesMatch[2]),
    info: Number(issuesMatch[3]),
  };
  if (issues.critical > 0 && verdictMatch[1] !== 'REQUEST_CHANGES') return null;
  if (issues.critical === 0 && issues.warning === 0 && verdictMatch[1] !== 'APPROVE') return null;
  return { verdict: verdictMatch[1], issues };
}

function fingerprintFailure(before, after) {
  if (!before || !after || before.error || after.error) return 'fingerprint_error';
  if (before.mode !== after.mode || before.digest !== after.digest) return 'fingerprint_mismatch';
  return null;
}

export function evaluateReviewerAttempt({
  role,
  output,
  beforeFingerprint,
  afterFingerprint,
}) {
  if (typeof role !== 'string' || role.length === 0) throw new TypeError('role must be non-empty');
  const fingerprintExclusion = fingerprintFailure(beforeFingerprint, afterFingerprint);
  if (fingerprintExclusion) {
    return { role, included: false, exclusion: fingerprintExclusion, verdict: null, issues: null };
  }
  const parsed = parseReviewerReport(output);
  if (!parsed) {
    return {
      role,
      included: false,
      exclusion: 'malformed_or_empty_result',
      verdict: null,
      issues: null,
    };
  }
  return { role, included: true, exclusion: null, ...parsed };
}

function consensusVerdict(consensus) {
  if (!consensus || typeof consensus !== 'object' || Array.isArray(consensus)) return null;
  for (const key of ['critical', 'agreed_warning', 'split_warning']) {
    if (!Number.isSafeInteger(consensus[key]) || consensus[key] < 0) return null;
  }
  if (consensus.critical > 0 || consensus.agreed_warning > 0) return 'REQUEST_CHANGES';
  if (consensus.split_warning > 0) return 'CONCERN';
  return 'APPROVE';
}

export function synthesizeReviewAttempts(attempts, consensus) {
  if (!Array.isArray(attempts)) throw new TypeError('attempts must be an array');
  const included = attempts.filter((attempt) => attempt?.included === true);
  const exclusions = attempts
    .filter((attempt) => attempt?.included !== true)
    .map((attempt) => ({ role: attempt?.role || 'unknown', reason: attempt?.exclusion || 'not_successful' }));
  if (included.length === 0) {
    return {
      status: 'operational_failure',
      n_actual: 0,
      verdict: null,
      phase6_allowed: false,
      exclusions,
    };
  }
  let verdict;
  if (included.length === 1) {
    const critical = included[0].issues.critical;
    const warning = included[0].issues.warning;
    verdict = critical > 0 ? 'REQUEST_CHANGES' : warning > 0 ? 'CONCERN' : 'APPROVE';
  } else {
    verdict = consensusVerdict(consensus);
    if (verdict === null) {
      return {
        status: 'operational_failure',
        n_actual: included.length,
        verdict: null,
        phase6_allowed: false,
        exclusions,
        error: 'consensus_required',
      };
    }
  }
  return {
    status: 'reviewed',
    n_actual: included.length,
    verdict,
    phase6_allowed: true,
    exclusions,
  };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const inputIndex = process.argv.indexOf('--input');
    if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('--input FILE is required');
    const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), 'utf8'));
    const attemptInput = Array.isArray(input) ? input : input?.attempts;
    if (!Array.isArray(attemptInput)) throw new TypeError('input must contain an attempt array');
    const attempts = attemptInput.map((attempt) => (
      Object.hasOwn(attempt || {}, 'output')
        ? evaluateReviewerAttempt(attempt)
        : attempt
    ));
    const consensus = Array.isArray(input) ? undefined : input.consensus;
    process.stdout.write(`${JSON.stringify(synthesizeReviewAttempts(attempts, consensus))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    process.exitCode = 2;
  }
}
