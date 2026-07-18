#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REVIEW_FLAGS = new Set([
  '--entropy',
  '--ultracode',
  '--codex',
  '--no-codex',
  '--no-opus',
  '--no-agy',
]);

function routeError(message) {
  return { ok: false, route: 'error', error: message };
}

function normalizeHost(host) {
  if (host !== 'claude' && host !== 'codex') {
    throw new TypeError('host must be claude or codex');
  }
  return host;
}

function expandCodexOnly(argv) {
  const expanded = [];
  for (const token of argv) {
    if (token === '--codex-only') expanded.push('--codex', '--no-opus', '--no-agy');
    else expanded.push(token);
  }
  return expanded;
}

function validateReviewerFlags(argv) {
  if (argv.includes('--ultracode') && argv.includes('--no-opus')) {
    return '--ultracode cannot be combined with --no-opus';
  }
  if (argv.includes('--codex') && argv.includes('--no-codex')) {
    return '--codex cannot be combined with --no-codex';
  }
  return null;
}

function existingFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function parseReview(argv, host, cwd) {
  const expanded = expandCodexOnly(argv);
  if (expanded[0] === 'init') {
    return expanded.length === 1
      ? { ok: true, route: 'init', host, argv: expanded }
      : { ...routeError('init does not accept additional arguments'), host, argv: expanded };
  }
  if (expanded.includes('--qa')) {
    return expanded.length === 1
      ? { ok: true, route: 'qa', host, argv: expanded }
      : { ...routeError('--qa does not accept additional arguments'), host, argv: expanded };
  }
  const respondIndex = expanded.indexOf('--respond');
  if (respondIndex >= 0) {
    if (respondIndex !== 0) return { ...routeError('--respond must be the first argument'), host, argv: expanded };
    const ignoredReviewerFlags = expanded.filter((token) => REVIEW_FLAGS.has(token));
    let reportPath = null;
    let sourcePr = false;
    let prNumber = false;
    for (let index = 1; index < expanded.length; index += 1) {
      const token = expanded[index];
      if (REVIEW_FLAGS.has(token)) continue;
      if (token === '--source=pr') {
        sourcePr = true;
        continue;
      }
      if (/^--pr=[1-9][0-9]*$/u.test(token)) {
        prNumber = true;
        continue;
      }
      if (!token.startsWith('-') && reportPath === null) {
        const candidate = resolve(cwd, token);
        if (!existingFile(candidate)) {
          return { ...routeError(`respond report path must name an existing file: ${token}`), host, argv: expanded };
        }
        reportPath = candidate;
        continue;
      }
      return { ...routeError(`unknown respond argument: ${token}`), host, argv: expanded };
    }
    if (prNumber && !sourcePr) {
      return { ...routeError('--pr=NNN requires --source=pr'), host, argv: expanded };
    }
    if (reportPath !== null && (sourcePr || prNumber)) {
      return { ...routeError('respond accepts a report path or PR source options, not both'), host, argv: expanded };
    }
    return {
      ok: true,
      route: 'respond',
      host,
      argv: expanded,
      ignoredReviewerFlags,
      reportPath,
    };
  }

  const conflict = validateReviewerFlags(expanded);
  if (conflict) return { ...routeError(conflict), host, argv: expanded };
  for (let index = 0; index < expanded.length; index += 1) {
    const token = expanded[index];
    if (REVIEW_FLAGS.has(token)) continue;
    if (token === '--contract') {
      if (/^SLICE-[0-9]+$/u.test(expanded[index + 1] || '')) index += 1;
      continue;
    }
    return { ...routeError(`unknown review argument: ${token}`), host, argv: expanded };
  }
  return { ok: true, route: 'review', host, argv: expanded };
}

function parseLoop(argv, host) {
  const expanded = expandCodexOnly(argv);
  for (const forbidden of ['init', '--respond', '--qa']) {
    if (expanded.includes(forbidden)) {
      return { ...routeError(`${forbidden} is not valid for the loop entry`), host, argv: expanded };
    }
  }
  const conflict = validateReviewerFlags(expanded);
  if (conflict) return { ...routeError(conflict), host, argv: expanded };
  for (let index = 0; index < expanded.length; index += 1) {
    const token = expanded[index];
    if (REVIEW_FLAGS.has(token)) continue;
    if (/^--max=[1-9][0-9]*$/u.test(token)) continue;
    if (token === '--contract') {
      if (/^SLICE-[0-9]+$/u.test(expanded[index + 1] || '')) index += 1;
      continue;
    }
    return { ...routeError(`unknown loop argument: ${token}`), host, argv: expanded };
  }
  return { ok: true, route: 'loop', host, argv: expanded };
}

export function parsePublicRoute({ entry = 'review', argv = [], host, cwd = process.cwd() }) {
  const normalizedHost = normalizeHost(host);
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) {
    throw new TypeError('argv must be an array of strings');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cwd must be non-empty');
  if (entry === 'review') return parseReview(argv, normalizedHost, cwd);
  if (entry === 'loop') return parseLoop(argv, normalizedHost);
  throw new TypeError('entry must be review or loop');
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    if (argv[index] === '--entry') options.entry = value;
    else if (argv[index] === '--host') options.host = value;
    else if (argv[index] === '--args-file') options.argsFile = value;
    else if (argv[index] === '--cwd') options.cwd = value;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const options = cliOptions(process.argv.slice(2));
    const argv = options.argsFile ? JSON.parse(readFileSync(resolve(options.argsFile), 'utf8')) : [];
    const result = parsePublicRoute({ entry: options.entry, host: options.host, argv, cwd: options.cwd });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
