'use strict';

const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const fixtureRoots = new Set();

function gitResult(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: null,
    input: options.input,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  return {
    code: result.error ? 127 : (result.status ?? 1),
    signal: result.signal,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(result.stderr ?? result.error?.message ?? ''),
  };
}

function git(repo, args, options = {}) {
  const result = gitResult(repo, args, options);
  assert.equal(
    result.code,
    0,
    `git ${args.join(' ')} failed in ${repo}: ${result.stderr.toString('utf8')}`,
  );
  return result.stdout.toString('utf8').trim();
}

function createGitFixture(name = 'repo', options = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'deep-review-git-'));
  fixtureRoots.add(fixtureRoot);
  const repo = join(fixtureRoot, name);
  mkdirSync(repo, { recursive: true });

  const initArgs = ['init', '--quiet'];
  if (options.objectFormat) initArgs.push(`--object-format=${options.objectFormat}`);
  const initialized = spawnSync('git', [...initArgs, repo], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(
    initialized.status,
    0,
    options.objectFormat === 'sha256'
      ? `installed Git lacks SHA-256 repository support: ${initialized.stderr || initialized.error || 'unknown error'}`
      : `git init failed: ${initialized.stderr || initialized.error || 'unknown error'}`,
  );

  git(repo, ['config', 'user.name', 'Deep Review Test']);
  git(repo, ['config', 'user.email', 'deep-review@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);

  if (options.initialCommit !== false) {
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    git(repo, ['add', '--', 'tracked.txt']);
    git(repo, ['commit', '--quiet', '-m', 'initial']);
  }
  return repo;
}

function cleanupGitFixtures() {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
}

function fixtureRootFor(repo) {
  return dirname(repo);
}

module.exports = {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
  gitResult,
};
