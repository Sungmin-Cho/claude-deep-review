#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runProcess } from './lib/process.mjs';
import { atomicWriteFile, makeSecureTempPath } from './lib/runtime-context.mjs';

const AUTH_PATTERN = /not logged in|not authenticated|authentication failed|please.*(?:log in|login)|unauthorized|token.*expired/iu;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty NUL-free string`);
  }
  return value;
}

function positiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError('timeoutSeconds must be positive');
  return seconds;
}

function classify(result) {
  const stderr = result.stderr.toString('utf8');
  if (result.code === 124 || result.timedOut) return 'timeout';
  if (result.code !== 0 && AUTH_PATTERN.test(stderr)) return 'not_authenticated';
  if (result.code !== 0 || result.stdout.length === 0) return 'failed';
  return 'success';
}

const ADVERSARIAL_FINDING_PATTERN = /^- \[(critical|high|warning|medium|info|low)\]\s+(.+)$/gmu;
const CLEAN_ADVERSARIAL_VERDICT = /^(?:clean|no[- ]issues?|pass(?:ed)?|ok|approve(?:d)?)\b/iu;
const BLOCKING_ADVERSARIAL_VERDICT = /\b(?:needs-attention|request.?changes|concern|block(?:ed)?|reject(?:ed)?|fail(?:ed)?|unsafe)\b/iu;

function normalizedSeverity(value) {
  if (value === 'critical' || value === 'high') return 'critical';
  if (value === 'warning' || value === 'medium') return 'warning';
  return 'info';
}

export function normalizeAdversarialReport(output, date = new Date()) {
  if (typeof output !== 'string' || !/^# Codex Adversarial Review\s*$/mu.test(output)) return null;
  const verdictLine = /^Verdict:\s*(.+?)\s*$/mu.exec(output)?.[1]?.toLowerCase() ?? '';
  if (verdictLine.length === 0
    || !/^Target:\s*\S.+$/mu.test(output)
    || !/^Findings:\s*$/mu.test(output)) return null;
  const findings = [...output.matchAll(ADVERSARIAL_FINDING_PATTERN)].map((match) => ({
    severity: normalizedSeverity(match[1].toLowerCase()),
    title: match[2].trim(),
  }));
  const counts = findings.reduce(
    (result, finding) => ({ ...result, [finding.severity]: result[finding.severity] + 1 }),
    { critical: 0, warning: 0, info: 0 },
  );
  const clean = CLEAN_ADVERSARIAL_VERDICT.test(verdictLine);
  const attention = BLOCKING_ADVERSARIAL_VERDICT.test(verdictLine);
  if (clean === attention) return null;
  const blockingFindings = counts.critical + counts.warning;
  if ((attention && blockingFindings === 0) || (clean && blockingFindings > 0)) return null;
  const verdict = counts.critical > 0
    ? 'REQUEST_CHANGES'
    : counts.warning > 0
      ? 'CONCERN'
      : 'APPROVE';
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const section = (severity, icon, label) => {
    const matching = findings.filter((finding) => finding.severity === severity);
    return [
      `### ${icon} ${label}`,
      '',
      ...(matching.length > 0
        ? matching.map((finding) => `- ${finding.title}`)
        : ['없음.']),
      '',
    ];
  };
  const indentedOriginal = output.trimEnd().split(/\r?\n/u).map((line) => `    ${line}`).join('\n');
  return [
    `# Deep Review Report — ${day}`,
    '',
    '## Summary',
    '',
    `- **Verdict**: ${verdict}`,
    '- **Review Mode**: 1-way (codex-adversarial)',
    `- **Issues**: 🔴 ${counts.critical}건, 🟡 ${counts.warning}건, ℹ️ ${counts.info}건`,
    '',
    '## Code Review',
    '',
    ...section('critical', '🔴', 'Critical'),
    ...section('warning', '🟡', 'Warning'),
    ...section('info', 'ℹ️', 'Info'),
    '## Original Adapter Output',
    '',
    indentedOriginal,
    '',
  ].join('\n');
}

function publishResult(outputFile, result, status, output = result.stdout) {
  atomicWriteFile(outputFile, output, { mode: 0o600 });
  atomicWriteFile(`${outputFile}.status`, `${status}\n`, { encoding: 'utf8', mode: 0o600 });
  const lines = result.stderr.toString('utf8').split(/\r?\n/u).filter(Boolean).slice(-5);
  atomicWriteFile(
    `${outputFile}.stderr-tail`,
    lines.length ? `${lines.join('\n')}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
}

function targetArguments(options) {
  const hasBase = options.base !== undefined;
  const hasScope = options.scope !== undefined;
  if (hasBase === hasScope) throw new TypeError('exactly one of base or scope is required');
  if (hasBase) return ['--base', requiredString(options.base, 'base')];
  if (options.scope !== 'working-tree') throw new TypeError('scope must be working-tree');
  return ['--scope', 'working-tree'];
}

export async function runCodexReviewer(options = {}) {
  const projectRoot = resolve(
    options.projectRoot === undefined
      ? process.cwd()
      : requiredString(options.projectRoot, 'projectRoot'),
  );
  const companion = resolve(requiredString(options.companion, 'companion'));
  const outputFile = resolve(requiredString(options.outputFile, 'outputFile'));
  const timeoutSeconds = positiveSeconds(options.timeoutSeconds ?? 900);
  const kind = options.kind ?? 'review';
  if (kind !== 'review' && kind !== 'adversarial') {
    throw new TypeError('kind must be review or adversarial');
  }
  const command = kind === 'review' ? 'review' : 'adversarial-review';
  const args = [companion, command, ...targetArguments(options)];
  let input;
  let securePath;
  try {
    if (kind === 'adversarial') {
      const focusFile = resolve(requiredString(options.focusFile, 'focusFile'));
      securePath = makeSecureTempPath('deep-review-focus', '.txt');
      atomicWriteFile(securePath, readFileSync(focusFile), { mode: 0o600 });
      input = readFileSync(securePath);
      args.push('-');
    }
    const processResult = await runProcess(process.execPath, args, {
      cwd: projectRoot,
      env: options.env ?? process.env,
      input,
      timeoutMs: timeoutSeconds * 1000,
    });
    let status = classify(processResult);
    const rawStdout = processResult.stdout.toString('utf8');
    const normalized = status === 'success' && kind === 'adversarial'
      ? normalizeAdversarialReport(rawStdout)
      : null;
    if (status === 'success' && kind === 'adversarial' && normalized === null) status = 'failed';
    const published = normalized === null ? processResult.stdout : Buffer.from(normalized, 'utf8');
    publishResult(outputFile, processResult, status, published);
    return {
      status,
      code: processResult.code,
      timedOut: processResult.timedOut,
      stdout: published.toString('utf8'),
      raw_stdout: rawStdout,
      stderr: processResult.stderr.toString('utf8'),
      outputFile,
    };
  } finally {
    if (securePath) rmSync(dirname(securePath), { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = {
      '--project-root': 'projectRoot',
      '--companion': 'companion',
      '--kind': 'kind',
      '--scope': 'scope',
      '--base': 'base',
      '--focus-file': 'focusFile',
      '--output': 'outputFile',
      '--timeout-seconds': 'timeoutSeconds',
    }[flag];
    if (!key || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${flag}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: run-codex-reviewer.mjs --companion FILE --kind review|adversarial (--base SHA|--scope working-tree) --output FILE [--project-root DIR] [--focus-file FILE]\n');
    return;
  }
  const result = await runCodexReviewer(options);
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`run-codex-reviewer.mjs: ${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  });
}
