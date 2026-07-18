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

const SNAPSHOT_SCHEMA = 1;
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

function atomicJson(filePath, value) {
  const target = absolute(filePath, 'output');
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
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
