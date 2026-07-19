#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalizeRepoPath, extractFindings, matchFindings } from './lib/finding-identity.mjs';

const SNAPSHOT_SCHEMA = 1;
const ROUND_STATE_SCHEMA = 1;
const PRIOR_CONTEXT_MAX_BYTES_DEFAULT = 16384;
const PRIOR_CONTEXT_REJECT_NOTICE = '재검증 필수, 억제 금지 (advisory — re-verify, never suppress)';
const STALLED_REPEAT_RATIO_THRESHOLD = 0.5;
const TAXONOMY = new Set([
  'error-handling',
  'naming-convention',
  'type-safety',
  'test-coverage',
  'security',
  'performance',
  'architecture',
]);

class LoopStateError extends Error {
  constructor(message, code = 'LOOP_STATE_ERROR', details = {}) {
    super(message);
    this.name = 'LoopStateError';
    this.code = code;
    this.details = details;
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new LoopStateError(`${label} must be a non-empty NUL-free path`, 'INVALID_PATH');
  }
  return resolve(value);
}

function atomicText(filePath, text, label = 'output') {
  const target = absolute(filePath, label);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function atomicJson(filePath, value) {
  atomicText(filePath, `${JSON.stringify(value)}\n`, 'output');
}

function listReports(reportsDir) {
  const root = absolute(reportsDir, 'reports directory');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('-review.md'))
    .map((entry) => resolve(root, entry.name))
    .sort(utf8Compare);
}

export function snapshotReports({ reportsDir, output } = {}) {
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA,
    reports_dir: absolute(reportsDir, 'reports directory'),
    reports: listReports(reportsDir),
  };
  if (output) atomicJson(output, snapshot);
  return { ...snapshot, ...(output ? { snapshot_file: absolute(output, 'output') } : {}) };
}

function readSnapshot(snapshotFile) {
  const filePath = absolute(snapshotFile, 'snapshot file');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new LoopStateError(`cannot read snapshot: ${error.message}`, 'INVALID_SNAPSHOT');
  }
  if (parsed?.schema_version !== SNAPSHOT_SCHEMA || !Array.isArray(parsed.reports)) {
    throw new LoopStateError('snapshot schema is invalid', 'INVALID_SNAPSHOT');
  }
  return parsed;
}

export function resolveRoundReport({ reportsDir, snapshotFile } = {}) {
  const before = readSnapshot(snapshotFile);
  const currentDir = absolute(reportsDir, 'reports directory');
  if (absolute(before.reports_dir, 'snapshot reports directory') !== currentDir) {
    throw new LoopStateError('snapshot reports directory differs from current directory', 'SNAPSHOT_DIRECTORY_MISMATCH');
  }
  const previous = new Set(before.reports.map((entry) => absolute(entry, 'snapshot report')));
  const delta = listReports(currentDir).filter((entry) => !previous.has(entry));
  if (delta.length !== 1) {
    throw new LoopStateError(
      `review round must create exactly one report, observed ${delta.length}`,
      'REPORT_DELTA_COUNT',
      { count: delta.length, reports: delta },
    );
  }
  return { report_path: delta[0], count: 1 };
}

export function assertSamePath({ expected, actual, platform = process.platform } = {}) {
  const expectedPath = absolute(expected, 'expected path');
  const actualPath = absolute(actual, 'actual path');
  const canonical = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const same = canonical(expectedPath) === canonical(actualPath);
  if (!same) {
    throw new LoopStateError('captured and loaded report paths differ', 'PATH_MISMATCH', {
      expected: expectedPath,
      actual: actualPath,
      same: false,
    });
  }
  return { expected: expectedPath, actual: actualPath, same: true };
}

function integerMatch(text, expression, fallback = 0) {
  const match = expression.exec(text);
  return match ? Number(match[1]) : fallback;
}

function parseIssues(review) {
  const issues = /\*\*Issues\*\*\s*:\s*[^\n]*?🔴\s*(\d+)[^\n]*?🟡\s*(\d+)[^\n]*?ℹ(?:️)?\s*(\d+)/u.exec(review);
  if (issues) return issues.slice(1).map(Number);
  const fallback = [
    /count_red\s*[:=]\s*(\d+)/iu.exec(review),
    /count_yellow\s*[:=]\s*(\d+)/iu.exec(review),
    /count_info\s*[:=]\s*(\d+)/iu.exec(review),
  ];
  return fallback.every(Boolean) ? fallback.map((match) => Number(match[1])) : null;
}

function parseRecurring(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const payload = parsed?.payload && !Array.isArray(parsed.payload) ? parsed.payload : parsed;
    return Array.isArray(payload?.findings) ? payload.findings : [];
  } catch {
    return [];
  }
}

function categoryFor(findings, file, line) {
  const target = `${file}:${line}`;
  for (const finding of findings) {
    if (!TAXONOMY.has(finding?.category) || !Array.isArray(finding.example_files)) continue;
    if (finding.example_files.some((entry) => entry === target)) return finding.category;
  }
  return 'untagged';
}

function signatures(review, recurringFindings) {
  const result = new Set();
  let severity = '';
  for (const lineText of review.split(/\r?\n/u)) {
    if (/^###\s+🔴\s+Critical/iu.test(lineText)) severity = 'critical';
    else if (/^###\s+🟡\s+Warning/iu.test(lineText)) severity = 'warning';
    else if (/^###\s+/u.test(lineText)) severity = '';
    if (!severity) continue;
    const matches = [...lineText.matchAll(/`([^`\r\n]+):(\d+)`/gu)];
    const withoutQuotedPaths = lineText.replace(/`[^`\r\n]+:\d+`/gu, ' ');
    matches.push(...withoutQuotedPaths.matchAll(
      /(?:^|[\s(])((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+):(\d+)(?=$|[\s,.)])/gu,
    ));
    for (const match of matches) {
      const file = match[1];
      const line = Number(match[2]);
      result.add(`${severity}:${file}:${Math.floor(line / 7)}:${categoryFor(recurringFindings, file, line)}`);
    }
  }
  return [...result].sort(utf8Compare);
}

function readOptional(filePath) {
  return filePath ? readFileSync(absolute(filePath, 'report path'), 'utf8') : '';
}

export function collectMetrics(options = {}) {
  const roundNumber = Number(options.roundNumber);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new LoopStateError('round number must be a positive integer', 'INVALID_ROUND');
  }
  const reviewPath = absolute(options.reviewReport, 'review report');
  const responsePath = options.responseReport ? absolute(options.responseReport, 'response report') : '';
  const review = readFileSync(reviewPath, 'utf8');
  const response = readOptional(responsePath);
  const verdictMatch = /\*\*Verdict\*\*\s*:\s*(APPROVE|REQUEST_CHANGES|CONCERN)/iu.exec(review);
  if (!verdictMatch) throw new LoopStateError('review report has no valid Verdict', 'INVALID_REPORT');
  const issueCounts = parseIssues(review);
  if (!issueCounts) throw new LoopStateError('review report has no valid Issues summary', 'INVALID_REPORT');
  const [countRed, countYellow, countInfo] = issueCounts;
  const itemCounts = /\*\*Items\*\*\s*:\s*(?:수락|accepted?)\s*(\d+)[^\n]*?(?:반박|rejected?)\s*(\d+)[^\n]*?(?:보류|deferred?)\s*(\d+)/iu.exec(response);
  const executionMatch = /\*\*execution_path\*\*\s*:\s*(subagent|main_fallback|mixed|n\/a)/iu.exec(response);
  const haltedMatch = /\*\*halted\*\*\s*:\s*(true|false)/iu.exec(response);
  const implemented = integerMatch(response, /\*\*implemented_count\*\*\s*:\s*(\d+)/iu);
  const recurringPath = options.recurringFindings
    || join(dirname(dirname(reviewPath)), 'recurring-findings.json');
  return {
    round_number: roundNumber,
    round_review_report_path: reviewPath,
    response_report_path: responsePath || null,
    verdict: verdictMatch[1].toUpperCase(),
    count_red: countRed,
    count_yellow: countYellow,
    count_info: countInfo,
    accepted_count: itemCounts ? Number(itemCounts[1]) : 0,
    rejected_count: itemCounts ? Number(itemCounts[2]) : 0,
    deferred_count: itemCounts ? Number(itemCounts[3]) : 0,
    implemented_count: implemented,
    halted: haltedMatch ? haltedMatch[1].toLowerCase() === 'true' : false,
    execution_path: executionMatch ? executionMatch[1].toLowerCase() : 'n/a',
    findings_signature: signatures(review, parseRecurring(recurringPath)),
  };
}

function splitItemBlocks(response) {
  const headerPattern = /^###\s+ITEM-\d+:[^\n]*$/gmu;
  const starts = [...response.matchAll(headerPattern)];
  const blocks = [];
  for (let index = 0; index < starts.length; index += 1) {
    const begin = starts[index].index;
    const end = index + 1 < starts.length ? starts[index + 1].index : response.length;
    blocks.push(response.slice(begin, end));
  }
  return blocks;
}

function firstLocationToken(blockText) {
  const match = /`([^`\r\n]+):(\d+)(?:-\d+)?`/u.exec(blockText);
  if (!match) return null;
  return { path: match[1], line: Number(match[2]) };
}

function actionReason(blockText) {
  const match = /-\s*\*\*Action\*\*\s*:\s*([^\n]*)/u.exec(blockText);
  return match ? match[1].trim() : '';
}

/**
 * Parse REJECT-decision ITEM blocks from a response report into
 * `{path, line, reason}` entries. An item without a backtick `path:line` (or
 * `path:line-line`, start line only) location token anywhere in its block is
 * conservatively excluded and counted in `skippedRejects` — session-only,
 * advisory-only memory never silently invents a location.
 */
function parseRejectedItems(response, { repoRoot } = {}) {
  if (!response) return { rejected: [], skippedRejects: 0 };
  const rejected = [];
  let skippedRejects = 0;
  for (const block of splitItemBlocks(response)) {
    if (!/-\s*\*\*Decision\*\*\s*:\s*REJECT/iu.test(block)) continue;
    const location = firstLocationToken(block);
    if (!location) {
      skippedRejects += 1;
      continue;
    }
    rejected.push({
      path: canonicalizeRepoPath(location.path, { repoRoot }),
      line: location.line,
      reason: actionReason(block),
    });
  }
  return { rejected, skippedRejects };
}

/**
 * Record one round's finding-state snapshot from a canonical review report
 * (+ optional response report) into a loop-bound, schema-versioned JSON file.
 * `loopId` is minted with `randomUUID()` when omitted (round 1) and echoed
 * back alongside the absolute `state_file` so callers never need to know the
 * file naming convention. `baseCommit` is required (fail-closed).
 */
export function recordRound(options = {}) {
  const roundNumber = Number(options.roundNumber);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new LoopStateError('round number must be a positive integer', 'INVALID_ROUND');
  }
  if (typeof options.baseCommit !== 'string' || options.baseCommit.length === 0) {
    throw new LoopStateError('base_commit is required', 'MISSING_BASE_COMMIT');
  }
  const reviewPath = absolute(options.reviewReport, 'review report');
  const review = readFileSync(reviewPath, 'utf8');
  const verdictMatch = /\*\*Verdict\*\*\s*:\s*(APPROVE|REQUEST_CHANGES|CONCERN)/iu.exec(review);
  if (!verdictMatch) throw new LoopStateError('review report has no valid Verdict', 'INVALID_REPORT');
  const issueCounts = parseIssues(review);
  if (!issueCounts) throw new LoopStateError('review report has no valid Issues summary', 'INVALID_REPORT');
  const [countRed, countYellow, countInfo] = issueCounts;

  const responsePath = options.responseReport ? absolute(options.responseReport, 'response report') : '';
  const response = readOptional(responsePath);
  const recurringPath = options.recurringFindings
    || join(dirname(dirname(reviewPath)), 'recurring-findings.json');
  const recurring = parseRecurring(recurringPath);

  const findings = extractFindings(review, { repoRoot: options.repoRoot }).map((finding) => ({
    ...finding,
    category: categoryFor(recurring, finding.path, finding.line),
  }));
  const { rejected, skippedRejects } = parseRejectedItems(response, { repoRoot: options.repoRoot });

  const loopId = options.loopId || randomUUID();
  const stateDir = absolute(options.stateDir, 'state directory');
  const stateFile = resolve(stateDir, `loop-${loopId}-round-${roundNumber}.state.json`);
  const state = {
    schema_version: ROUND_STATE_SCHEMA,
    source: 'report-parse',
    loop_id: loopId,
    round_number: roundNumber,
    base_commit: options.baseCommit,
    verdict: verdictMatch[1].toUpperCase(),
    counts: { critical: countRed, warning: countYellow, info: countInfo },
    findings,
    rejected,
    skipped_rejects: skippedRejects,
  };
  atomicJson(stateFile, state);
  return { loop_id: loopId, state_file: stateFile };
}

function readRoundState(stateFile) {
  const filePath = absolute(stateFile, 'state file');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new LoopStateError(`cannot read round state: ${error.message}`, 'INVALID_STATE');
  }
  if (
    parsed?.schema_version !== ROUND_STATE_SCHEMA
    || typeof parsed.loop_id !== 'string'
    || typeof parsed.base_commit !== 'string'
    || !Number.isInteger(parsed.round_number)
  ) {
    throw new LoopStateError('round state schema is invalid', 'INVALID_STATE');
  }
  return parsed;
}

function truncateUtf8(text, maxBytes, marker) {
  const bodyBuffer = Buffer.from(text, 'utf8');
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  let sliceEnd = Math.min(budget, bodyBuffer.length);
  // Never split a multi-byte UTF-8 sequence: back up to the previous
  // lead-byte boundary (a continuation byte has the high bits 10xxxxxx).
  while (sliceEnd > 0 && (bodyBuffer[sliceEnd] & 0xc0) === 0x80) sliceEnd -= 1;
  return `${bodyBuffer.subarray(0, sliceEnd).toString('utf8')}${marker}`;
}

/**
 * Render a loop-bound prior-round advisory context file: a `PRIOR-CONTEXT v1`
 * header carrying `loop_id`/`base_commit`/`round` (consumed by
 * build-reviewer-payload.mjs's ingest validation), an open-findings summary,
 * and a REJECT list explicitly marked re-verify/never-suppress. Truncates at
 * `maxBytes` with a visible marker rather than silently growing unbounded.
 */
export function renderPriorContext(options = {}) {
  const state = readRoundState(options.stateFile);
  const maxBytes = options.maxBytes ? Number(options.maxBytes) : PRIOR_CONTEXT_MAX_BYTES_DEFAULT;

  const header = `<!-- PRIOR-CONTEXT v1 loop_id=${state.loop_id} base_commit=${state.base_commit} round=${state.round_number} -->`;
  const lines = [header, '', `# Prior round ${state.round_number} context (loop ${state.loop_id})`, ''];

  const findings = Array.isArray(state.findings) ? state.findings : [];
  lines.push(`## Open findings from round ${state.round_number} (${findings.length})`);
  if (findings.length === 0) {
    lines.push('- (none)');
  } else {
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] \`${finding.path}:${finding.line}\` (${finding.category}) — ${finding.title_slug}`);
    }
  }
  lines.push('');

  const rejected = Array.isArray(state.rejected) ? state.rejected : [];
  lines.push(`## Previously rejected — ${PRIOR_CONTEXT_REJECT_NOTICE}`);
  if (rejected.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of rejected) {
      lines.push(`- \`${entry.path}:${entry.line}\` — ${entry.reason || '(no reason recorded)'}`);
    }
  }
  lines.push('');

  const body = lines.join('\n');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const truncated = bodyBytes > maxBytes;
  const finalText = truncated
    ? truncateUtf8(body, maxBytes, '\n\n<!-- TRUNCATED: prior-context exceeded maxBytes -->\n')
    : body;

  const outputFile = atomicText(options.output, finalText, 'output');
  return {
    output_file: outputFile,
    loop_id: state.loop_id,
    round_number: state.round_number,
    truncated,
  };
}

/**
 * Deterministic, code-owned convergence judgment between two adjacent round
 * state files (SKILL §5 condition 3's former natural-language "half of the
 * larger set repeats" rule, now this function's `stalled` output). Rejects a
 * `loop_id`/`schema_version` mismatch as `STALE_STATE` rather than comparing
 * unrelated loops. Only critical/warning findings ever appear in round state
 * (extractFindings never captures info-level items), so no extra filtering
 * is needed before matchFindings.
 */
export function compareRounds(options = {}) {
  const previous = readRoundState(options.previous);
  const current = readRoundState(options.current);
  if (previous.schema_version !== current.schema_version || previous.loop_id !== current.loop_id) {
    throw new LoopStateError('previous/current round state is from a different loop or schema', 'STALE_STATE', {
      previous_loop_id: previous.loop_id,
      current_loop_id: current.loop_id,
    });
  }

  const previousFindings = Array.isArray(previous.findings) ? previous.findings : [];
  const currentFindings = Array.isArray(current.findings) ? current.findings : [];
  const { repeated, resolved, added } = matchFindings(previousFindings, currentFindings);
  const largerSetSize = Math.max(previousFindings.length, currentFindings.length);
  const repeatRatio = largerSetSize > 0 ? repeated.length / largerSetSize : 0;

  return {
    repeated_count: repeated.length,
    resolved_count: resolved.length,
    added_count: added.length,
    larger_set_size: largerSetSize,
    repeat_ratio: repeatRatio,
    stalled: largerSetSize > 0 && repeatRatio >= STALLED_REPEAT_RATIO_THRESHOLD,
    progressed: resolved.length > 0,
  };
}

function parseFlags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new LoopStateError(`unknown or incomplete argument: ${flag}`, 'INVALID_ARGUMENT');
    }
    if (Object.hasOwn(values, flag)) throw new LoopStateError(`duplicate argument: ${flag}`, 'INVALID_ARGUMENT');
    values[flag] = value;
    index += 1;
  }
  return values;
}

function commandOptions(command, flags) {
  const known = {
    'snapshot-reports': new Map([['--reports-dir', 'reportsDir'], ['--output', 'output']]),
    'resolve-round-report': new Map([['--reports-dir', 'reportsDir'], ['--snapshot-file', 'snapshotFile']]),
    'assert-same-path': new Map([['--expected', 'expected'], ['--actual', 'actual']]),
    'collect-metrics': new Map([
      ['--round-number', 'roundNumber'],
      ['--review-report', 'reviewReport'],
      ['--response-report', 'responseReport'],
      ['--recurring-findings', 'recurringFindings'],
    ]),
    'record-round': new Map([
      ['--round-number', 'roundNumber'],
      ['--review-report', 'reviewReport'],
      ['--response-report', 'responseReport'],
      ['--loop-id', 'loopId'],
      ['--base-commit', 'baseCommit'],
      ['--state-dir', 'stateDir'],
      ['--repo-root', 'repoRoot'],
      ['--recurring-findings', 'recurringFindings'],
    ]),
    'render-prior-context': new Map([
      ['--state-file', 'stateFile'],
      ['--output', 'output'],
      ['--max-bytes', 'maxBytes'],
    ]),
    'compare-rounds': new Map([
      ['--previous', 'previous'],
      ['--current', 'current'],
    ]),
  }[command];
  if (!known) throw new LoopStateError(`unknown command: ${command}`, 'INVALID_COMMAND');
  const options = {};
  for (const [flag, value] of Object.entries(flags)) {
    const key = known.get(flag);
    if (!key) throw new LoopStateError(`unknown argument for ${command}: ${flag}`, 'INVALID_ARGUMENT');
    options[key] = value;
  }
  return options;
}

export function runLoopStateCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = commandOptions(command, parseFlags(rest));
  if (command === 'snapshot-reports') return snapshotReports(options);
  if (command === 'resolve-round-report') return resolveRoundReport(options);
  if (command === 'assert-same-path') return assertSamePath(options);
  if (command === 'record-round') return recordRound(options);
  if (command === 'render-prior-context') return renderPriorContext(options);
  if (command === 'compare-rounds') return compareRounds(options);
  return collectMetrics(options);
}

function serializeError(error) {
  return {
    code: error?.code || 'LOOP_STATE_ERROR',
    message: error?.message || String(error),
    ...(error?.details || {}),
  };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...runLoopStateCli() })}\n`);
  } catch (error) {
    const detail = serializeError(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: detail, ...error?.details })}\n`);
    process.exitCode = 2;
  }
}
