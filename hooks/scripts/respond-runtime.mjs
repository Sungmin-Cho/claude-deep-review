#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveExecutable, runProcess } from './lib/process.mjs';
import { isSessionDocReportName } from './lib/session-doc.js';

const REVIEW_SUFFIX = '-review.md';
const DEFAULT_REPORT_LIMIT = 3;
const MAX_FILENAME_ATTEMPTS = 10_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function requiredString(value, label, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.includes('\0')
  ) {
    throw new TypeError(`${label} must be ${allowEmpty ? '' : 'a non-empty '}NUL-free string`);
  }
  return value;
}

function projectRoot(repo) {
  return resolve(requiredString(repo, 'repo'));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function reportLimit(value) {
  const limit = value === undefined ? DEFAULT_REPORT_LIMIT : value;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('limit must be a non-negative safe integer');
  }
  return limit;
}

export function listReviewReports({ repo, limit } = {}) {
  const project = projectRoot(repo);
  const maximum = reportLimit(limit);
  if (maximum === 0) return [];
  const reportsDirectory = join(project, '.deep-review', 'reports');
  let entries;
  try {
    entries = readdirSync(reportsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const reports = [];
  for (const entry of entries) {
    // The opt-in per-session review doc (`loop-<id>-review.md`) shares this dir
    // and the `-review.md` suffix but is a derived aggregate, not a canonical
    // round report; it is re-rendered last each round so it usually has the
    // newest mtime. Exclude it (shared predicate) so a later pathless
    // `--respond` never resumes off the un-parseable aggregate.
    if (!entry.isFile() || !entry.name.endsWith(REVIEW_SUFFIX) || isSessionDocReportName(entry.name)) continue;
    const filePath = resolve(reportsDirectory, entry.name);
    let stat;
    try {
      stat = statSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    reports.push({
      path: filePath,
      name: entry.name,
      mtime_ms: stat.mtimeMs,
      size_bytes: stat.size,
    });
  }

  return reports
    .sort((left, right) => {
      if (left.mtime_ms !== right.mtime_ms) return right.mtime_ms - left.mtime_ms;
      return compareUtf8(left.path, right.path);
    })
    .slice(0, maximum);
}

function positiveIdentifier(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive safe integer`);
    }
    return value;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function repositoryName(value) {
  const repository = requiredString(value, 'repository');
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new TypeError('repository must be an owner/name GitHub repository');
  }
  const [owner, name] = repository.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new TypeError('repository must be an owner/name GitHub repository');
  }
  return repository;
}

function githubBinary(value, env) {
  const requested = value === undefined ? 'gh' : requiredString(value, 'ghBinary');
  const executable = resolveExecutable(requested, env);
  if (!executable) throw new Error(`GitHub CLI executable not found: ${requested}`);
  return executable;
}

class GitHubCliError extends Error {
  constructor(message, { args, code, stderr } = {}) {
    super(message);
    this.name = 'GitHubCliError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

async function invokeGh({ binary, args, repo, env, input }) {
  const result = await runProcess(binary, args, {
    cwd: repo,
    env,
    input,
  });
  if (result.code !== 0) {
    const stderr = result.stderr.toString('utf8').trim();
    throw new GitHubCliError(
      stderr || `gh ${args[0] || 'command'} failed with exit ${result.code}`,
      { args: [...args], code: result.code, stderr },
    );
  }
  return result.stdout;
}

function parseGithubJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} returned malformed JSON: ${error.message}`);
  }
}

async function resolveRepository({ binary, repo, env }) {
  const raw = await invokeGh({
    binary,
    repo,
    env,
    args: ['repo', 'view', '--json', 'nameWithOwner'],
  });
  const parsed = parseGithubJson(raw, 'gh repo view');
  return repositoryName(parsed?.nameWithOwner);
}

async function resolvePr({ binary, repo, env }) {
  const raw = await invokeGh({
    binary,
    repo,
    env,
    args: ['pr', 'view', '--json', 'number,url'],
  });
  const parsed = parseGithubJson(raw, 'gh pr view');
  return {
    pr: positiveIdentifier(parsed?.number, 'PR number'),
    url: requiredString(parsed?.url, 'PR URL'),
  };
}

function pageArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  if (value.every(Array.isArray)) return value.flat();
  if (value.some(Array.isArray)) throw new Error(`${label} returned mixed pagination JSON`);
  return value;
}

async function fetchEndpoint({ binary, repo, env, endpoint }) {
  const raw = await invokeGh({
    binary,
    repo,
    env,
    args: ['api', '--paginate', '--slurp', endpoint],
  });
  return pageArray(parseGithubJson(raw, `gh api ${endpoint}`), `gh api ${endpoint}`);
}

export async function fetchPrReview(options = {}) {
  const project = projectRoot(options.repo);
  // Validate explicit user data before executable resolution or any child process.
  const explicitPr = options.pr === undefined
    ? null
    : positiveIdentifier(options.pr, 'PR number');
  const env = options.env ?? process.env;
  const binary = githubBinary(options.ghBinary, env);
  const repository = await resolveRepository({ binary, repo: project, env });
  const detected = explicitPr === null
    ? await resolvePr({ binary, repo: project, env })
    : { pr: explicitPr, url: `https://github.com/${repository}/pull/${explicitPr}` };

  const endpoints = [
    { key: 'reviews', endpoint: `repos/${repository}/pulls/${detected.pr}/reviews` },
    { key: 'review_comments', endpoint: `repos/${repository}/pulls/${detected.pr}/comments` },
    { key: 'issue_comments', endpoint: `repos/${repository}/issues/${detected.pr}/comments` },
  ];
  const settled = await Promise.all(endpoints.map(async ({ key, endpoint }) => {
    try {
      return {
        key,
        endpoint,
        value: await fetchEndpoint({ binary, repo: project, env, endpoint }),
        error: null,
      };
    } catch (error) {
      return { key, endpoint, value: [], error };
    }
  }));
  const failures = settled.filter((entry) => entry.error);
  if (failures.length === endpoints.length) {
    throw new AggregateError(
      failures.map((entry) => entry.error),
      'all GitHub PR review endpoints failed',
    );
  }

  const source = {
    source: 'github-pr',
    repository,
    pr: detected.pr,
    url: detected.url,
    reviews: [],
    review_comments: [],
    issue_comments: [],
    errors: failures.map((entry) => ({
      endpoint: entry.endpoint,
      message: entry.error.message,
      code: entry.error.code ?? null,
    })),
  };
  for (const entry of settled) source[entry.key] = entry.value;
  return source;
}

export async function postPrResponse(options = {}) {
  const project = projectRoot(options.repo);
  const pr = positiveIdentifier(options.pr, 'PR number');
  const body = requiredString(options.body, 'body');
  const kind = options.kind ?? 'issue';
  if (kind !== 'issue' && kind !== 'inline') {
    throw new TypeError('kind must be issue or inline');
  }
  const commentId = kind === 'inline'
    ? positiveIdentifier(options.commentId, 'comment ID')
    : null;
  const env = options.env ?? process.env;
  // If supplied, validate the repository before resolving or starting gh.
  const suppliedRepository = options.repository === undefined
    ? null
    : repositoryName(options.repository);
  const binary = githubBinary(options.ghBinary, env);
  const repository = suppliedRepository
    ?? await resolveRepository({ binary, repo: project, env });
  const endpoint = kind === 'inline'
    ? `repos/${repository}/pulls/${pr}/comments/${commentId}/replies`
    : `repos/${repository}/issues/${pr}/comments`;
  await invokeGh({
    binary,
    repo: project,
    env,
    args: ['api', '--method', 'POST', endpoint, '--input', '-'],
    input: Buffer.from(JSON.stringify({ body }), 'utf8'),
  });
}

function responseTimestamp(value) {
  const timestamp = value === undefined
    ? new Date()
    : (value instanceof Date ? new Date(value.getTime()) : new Date(value));
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError('timestamp must be a valid date');
  const iso = timestamp.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

function ensurePrivateDirectory(project, segments) {
  let current = project;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`response runtime directory is not a real directory: ${current}`);
      }
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`response runtime directory is not a real directory: ${current}`);
      }
    }
  }
  return current;
}

function writeCompleteTemporary(filePath, content) {
  const descriptor = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(filePath, 0o600);
}

export function writeResponseReport({ repo, content, timestamp } = {}) {
  const project = projectRoot(repo);
  const report = requiredString(content, 'content', { allowEmpty: true });
  const stamp = responseTimestamp(timestamp);
  const responsesDirectory = ensurePrivateDirectory(project, ['.deep-review', 'responses']);
  const temporary = join(responsesDirectory, `.response-${randomUUID()}.tmp`);
  try {
    writeCompleteTemporary(temporary, report);
    for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt += 1) {
      const disambiguator = attempt === 0 ? '' : `-${String(attempt).padStart(2, '0')}`;
      const destination = join(responsesDirectory, `${stamp}${disambiguator}-response.md`);
      try {
        // Hard-linking a fully flushed private inode publishes complete content
        // atomically and fails instead of replacing an existing report.
        linkSync(temporary, destination);
        return destination;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error('could not allocate a unique response report filename');
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith('--') || index + 1 >= rest.length) {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    const key = flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    options[key] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

async function runCli(argv) {
  const { command, options } = parseCli(argv);
  if (command === 'list-reports') {
    return {
      reports: listReviewReports({
        repo: options.repo,
        limit: options.limit === undefined ? undefined : Number(options.limit),
      }),
    };
  }
  if (command === 'fetch-pr') {
    return fetchPrReview({
      repo: options.repo,
      pr: options.pr,
      ghBinary: options.ghBinary,
    });
  }
  if (command === 'post-pr-response') {
    const body = readFileSync(resolve(requiredString(options.bodyFile, 'body file')), 'utf8');
    await postPrResponse({
      repo: options.repo,
      repository: options.repository,
      pr: options.pr,
      body,
      kind: options.kind,
      commentId: options.commentId,
      ghBinary: options.ghBinary,
    });
    return { status: 'posted' };
  }
  if (command === 'write-report') {
    const content = readFileSync(resolve(requiredString(options.contentFile, 'content file')), 'utf8');
    return {
      path: writeResponseReport({
        repo: options.repo,
        content,
        timestamp: options.timestamp,
      }),
    };
  }
  throw new Error(
    'usage: respond-runtime.mjs <list-reports|fetch-pr|post-pr-response|write-report> [options]',
  );
}

const invoked = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    process.exitCode = 1;
  }
}
