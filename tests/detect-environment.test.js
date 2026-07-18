'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
} = require('./helpers/git-fixture.js');

const detectorPath = join(__dirname, '..', 'hooks', 'scripts', 'detect-environment.mjs');
const detectorUrl = pathToFileURL(detectorPath).href;
const gitModuleUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'git.mjs',
)).href;

const temporaryRoots = new Set();

function makeTemporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
}

test.after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadDetector() {
  return import(detectorUrl);
}

async function loadGitModule() {
  return import(gitModuleUrl);
}

function isolatedEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX_|CLAUDE_|PLUGIN_ROOT$)/i.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}

function makeExecutable(filePath, source) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

function createFakeCliDirectory(name, scripts = {}) {
  const root = makeTemporaryDirectory(`${name}-`);
  const bin = join(root, 'bin 공간 Ω');
  mkdirSync(bin, { recursive: true });

  for (const [command, body] of Object.entries(scripts)) {
    const program = join(root, `${command}-probe.js`);
    writeFileSync(program, body);
    if (process.platform === 'win32') {
      const launcher = join(bin, `${command}.cmd`);
      makeExecutable(
        launcher,
        `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`,
      );
    } else {
      const launcher = join(bin, command);
      writeFileSync(launcher, `#!/usr/bin/env node\n${body}`);
      chmodSync(launcher, 0o755);
    }
  }
  return { root, bin };
}

function writeCompanion(root, version) {
  const companion = join(
    root,
    'plugins',
    'cache',
    'openai-codex',
    'codex',
    version,
    'scripts',
    'codex-companion.mjs',
  );
  mkdirSync(join(companion, '..'), { recursive: true });
  writeFileSync(companion, '// deterministic companion fixture\n');
  return companion;
}

function writeClaudeCompanion(home, version) {
  const companion = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'openai-codex',
    'codex',
    version,
    'scripts',
    'codex-companion.mjs',
  );
  mkdirSync(join(companion, '..'), { recursive: true });
  writeFileSync(companion, '// deterministic companion fixture\n');
  return companion;
}

function assertAvailabilityShape(result) {
  for (const key of [
    'node_available',
    'node_path',
    'claude_cli',
    'claude_cli_path',
    'codex_plugin',
    'codex_companion_path',
    'codex_cli',
    'codex_cli_path',
    'codex_installed',
    'agy_cli',
    'agy_cli_path',
    'agy_version',
  ]) {
    assert.equal(Object.hasOwn(result, key), true, `missing stable key ${key}`);
  }
}

test('non-Git directory emits the stable shape and every CLI availability field', async () => {
  const { detectEnvironment } = await loadDetector();
  const cwd = makeTemporaryDirectory('deep-review-non-git-');
  const result = await detectEnvironment({
    cwd,
    env: isolatedEnvironment({ PATH: '' }),
  });

  assert.equal(result.is_git, false);
  assert.equal(result.has_commits, false);
  assert.equal(result.change_state, 'non-git');
  assert.equal(result.staged, 0);
  assert.equal(result.unstaged, 0);
  assert.equal(result.untracked, 0);
  assert.equal(result.has_untracked, false);
  assert.equal(result.review_base, '');
  assert.equal(result.review_base_method, '');
  assert.equal(result.is_shallow, false);
  assert.equal(result.node_available, true);
  assert.equal(result.node_path, process.execPath);
  assertAvailabilityShape(result);
});

test('zero-commit repository is initial and retains zeroed Git fields', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('deep review 환경 Ω', { initialCommit: false });
  const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });

  assert.equal(result.is_git, true);
  assert.equal(result.has_commits, false);
  assert.equal(result.change_state, 'initial');
  assert.equal(result.staged, 0);
  assert.equal(result.unstaged, 0);
  assert.equal(result.untracked, 0);
  assert.equal(result.has_untracked, false);
  assert.equal(result.review_base, '');
  assert.equal(result.review_base_method, '');
});

test('clean, staged, unstaged, mixed, and untracked-only states have exact counts', async (t) => {
  const { detectEnvironment } = await loadDetector();

  await t.test('clean', async () => {
    const repo = createGitFixture('clean 환경 Ω');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['clean', 0, 0, 0, false],
    );
  });

  await t.test('staged with spaces and Unicode', async () => {
    const repo = createGitFixture('staged 환경 Ω');
    writeFileSync(join(repo, '한 글.txt'), 'one');
    git(repo, ['add', '--', '한 글.txt']);
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['staged', 1, 0, 0, false],
    );
  });

  await t.test('unstaged', async () => {
    const repo = createGitFixture('unstaged 환경 Ω');
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['unstaged', 0, 1, 0, false],
    );
  });

  await t.test('mixed counts the same path in both index and worktree', async () => {
    const repo = createGitFixture('mixed 환경 Ω');
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
    git(repo, ['add', '--', 'tracked.txt']);
    writeFileSync(join(repo, 'tracked.txt'), 'unstaged after staged\n');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['mixed', 1, 1, 0, false],
    );
  });

  await t.test('untracked-only', async () => {
    const repo = createGitFixture('untracked 환경 Ω');
    writeFileSync(join(repo, '새 파일.txt'), 'new\n');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['untracked-only', 0, 0, 1, true],
    );
  });
});

test('root commit computes the empty-tree base inside the repository', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('root base 환경 Ω');
  const expected = git(repo, ['hash-object', '-t', 'tree', '--stdin'], { input: Buffer.alloc(0) });
  const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });

  assert.equal(result.review_base, expected);
  assert.equal(result.review_base_method, 'empty-tree');
});

test('two-commit base prefers origin HEAD, main, master, then HEAD parent', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('base precedence 환경 Ω');
  const rootCommit = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'tracked.txt'), 'second\n');
  git(repo, ['add', '--', 'tracked.txt']);
  git(repo, ['commit', '--quiet', '-m', 'second']);
  const headCommit = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['update-ref', 'refs/remotes/origin/trunk', headCommit]);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', rootCommit]);
  git(repo, ['update-ref', 'refs/remotes/origin/master', rootCommit]);
  let result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], [headCommit, 'merge-base']);

  git(repo, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], [rootCommit, 'merge-base']);

  git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], [rootCommit, 'merge-base']);

  git(repo, ['update-ref', '-d', 'refs/remotes/origin/master']);
  result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], ['HEAD~1', 'head-parent']);
});

test('shallow repositories are detected through Git plumbing', async () => {
  const { detectEnvironment } = await loadDetector();
  const source = createGitFixture('shallow source 환경 Ω');
  writeFileSync(join(source, 'tracked.txt'), 'second\n');
  git(source, ['add', '--', 'tracked.txt']);
  git(source, ['commit', '--quiet', '-m', 'second']);

  const target = join(fixtureRootFor(source), 'shallow clone 환경 Ω');
  const cloned = spawnSync('git', [
    'clone',
    '--quiet',
    '--depth',
    '1',
    pathToFileURL(source).href,
    target,
  ], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(cloned.status, 0, cloned.stderr);

  const result = await detectEnvironment({ cwd: target, env: isolatedEnvironment() });
  assert.equal(result.is_shallow, true);
});

test('companion discovery spans trusted Codex and Claude caches with stable semver ordering', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('companion 환경 Ω');
  const codexHome = makeTemporaryDirectory('codex-home 공간 Ω-');
  const home = makeTemporaryDirectory('home 공간 Ω-');

  writeCompanion(codexHome, '1.9.9');
  writeCompanion(codexHome, '2.0.0-rc.1');
  const stable = writeClaudeCompanion(home, '2.0.0');
  writeClaudeCompanion(home, '1.100.0');

  const result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({ CODEX_HOME: codexHome, HOME: home }),
  });
  assert.equal(result.codex_plugin, true);
  assert.equal(result.codex_companion_path, stable);
  assert.equal(result.codex_installed, true);
});

test('explicit companion path wins and similarly named untrusted marketplaces are ignored', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('trusted boundary 환경 Ω');
  const codexHome = makeTemporaryDirectory('codex-boundary-');
  const home = makeTemporaryDirectory('home-boundary-');
  const trusted = writeCompanion(codexHome, '3.0.0');
  const explicit = join(home, 'explicit companion 공간 Ω.mjs');
  writeFileSync(explicit, '// explicit fixture\n');

  const untrusted = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'not-openai-codex',
    'codex',
    '999.0.0',
    'scripts',
    'codex-companion.mjs',
  );
  mkdirSync(join(untrusted, '..'), { recursive: true });
  writeFileSync(untrusted, '// untrusted fixture\n');

  let result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({
      CODEX_HOME: codexHome,
      HOME: home,
      CODEX_COMPANION_PATH: explicit,
    }),
  });
  assert.equal(result.codex_companion_path, explicit);

  result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({ CODEX_HOME: codexHome, HOME: home }),
  });
  assert.equal(result.codex_companion_path, trusted);

  result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({
      CODEX_HOME: join(home, 'empty-codex-home'),
      HOME: home,
    }),
  });
  assert.equal(result.codex_plugin, false);
  assert.equal(result.codex_companion_path, '');
});

test('CLI paths with spaces and Unicode survive detection and agy version timeout is bounded', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('cli path 환경 Ω');
  const cli = createFakeCliDirectory('deep-review-cli', {
    claude: 'process.exit(0);\n',
    codex: 'process.exit(0);\n',
    agy: "if (process.argv.includes('--version')) setInterval(() => {}, 1000);\n",
  });
  const env = isolatedEnvironment({
    PATH: `${cli.bin}${delimiter}${process.env.PATH || ''}`,
    PATHEXT: process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : process.env.PATHEXT,
  });

  const started = Date.now();
  const result = await detectEnvironment({ cwd: repo, env });
  const elapsed = Date.now() - started;

  assert.equal(result.claude_cli, true);
  assert.equal(result.codex_cli, true);
  assert.equal(result.agy_cli, true);
  assert.equal(result.claude_cli_path.startsWith(cli.bin), true);
  assert.equal(result.codex_cli_path.startsWith(cli.bin), true);
  assert.equal(result.agy_cli_path.startsWith(cli.bin), true);
  assert.equal(result.agy_version, '');
  assert.equal(elapsed >= 2900, true, `agy timeout returned too early: ${elapsed}ms`);
  assert.equal(elapsed < 5000, true, `agy timeout was not bounded: ${elapsed}ms`);
});

test('CLI JSON round-trips equals signs and KV remains a compatibility format', async () => {
  const repo = createGitFixture('cli output 환경 Ω');
  const cli = createFakeCliDirectory('deep-review-cli-output', {
    agy: "if (process.argv.includes('--version')) process.stdout.write('agy=9.4.0 Ω\\n');\n",
  });
  const env = isolatedEnvironment({
    PATH: `${cli.bin}${delimiter}${process.env.PATH || ''}`,
    PATHEXT: process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : process.env.PATHEXT,
    PLUGIN_ROOT: join(repo, 'plugin root 공간 Ω'),
  });

  const jsonRun = spawnSync(process.execPath, [detectorPath, '--cwd', repo, '--format', 'json'], {
    encoding: 'utf8',
    env,
    shell: false,
    windowsHide: true,
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.agy_version, 'agy=9.4.0 Ω');
  assert.equal(parsed.plugin_root, resolve(env.PLUGIN_ROOT));

  const kvRun = spawnSync(process.execPath, [detectorPath, '--cwd', repo, '--format', 'kv'], {
    encoding: 'utf8',
    env,
    shell: false,
    windowsHide: true,
  });
  assert.equal(kvRun.status, 0, kvRun.stderr);
  assert.equal(kvRun.stdout.includes('agy_version=agy=9.4.0 Ω\n'), true);
  assert.equal(kvRun.stdout.includes('plugin_root='), true);
});

test('SHA-256 root repositories use their dynamically computed 64-hex empty tree', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('sha256 환경 Ω', { objectFormat: 'sha256' });
  const expected = git(repo, ['hash-object', '-t', 'tree', '--stdin'], { input: Buffer.alloc(0) });
  assert.match(expected, /^[0-9a-f]{64}$/);

  const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.equal(result.review_base, expected);
  assert.notEqual(result.review_base, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(result.review_base_method, 'empty-tree');
});

test('Git path codec is byte-bijective and porcelain -z consumes rename source tokens', async () => {
  const {
    decodeGitPath,
    encodeGitPath,
    parsePorcelainV1Z,
    splitNul,
  } = await loadGitModule();

  for (const bytes of [
    Buffer.from('한 글 Ω.txt', 'utf8'),
    Buffer.from([0x61, 0x80, 0x62]),
    Buffer.from([0x66, 0xe2, 0x82]),
  ]) {
    const decoded = decodeGitPath(bytes);
    assert.equal(encodeGitPath(decoded).equals(bytes), true, bytes.toString('hex'));
  }

  const surrogateEscaped = `prefix-${String.fromCharCode(0xdc80)}-${String.fromCharCode(0xdcff)}-Ω`;
  assert.equal(decodeGitPath(encodeGitPath(surrogateEscaped)), surrogateEscaped);
  assert.deepEqual(splitNul(Buffer.from('a\0b\0')), [Buffer.from('a'), Buffer.from('b')]);

  const status = Buffer.concat([
    Buffer.from('R  renamed Ω.txt\0', 'utf8'),
    Buffer.from([0x6f, 0x6c, 0x64, 0x80]),
    Buffer.from('\0?? untracked.txt\0', 'utf8'),
  ]);
  const records = parsePorcelainV1Z(status);
  assert.equal(records.length, 2);
  assert.deepEqual(
    {
      index: records[0].index,
      workTree: records[0].workTree,
      path: records[0].path,
      originalPath: records[0].originalPath,
    },
    {
      index: 'R',
      workTree: ' ',
      path: 'renamed Ω.txt',
      originalPath: decodeGitPath(Buffer.from([0x6f, 0x6c, 0x64, 0x80])),
    },
  );
  assert.deepEqual(records[1], {
    index: '?',
    workTree: '?',
    path: 'untracked.txt',
  });
});

test('async and sync Git wrappers preserve argv and Buffer results', async () => {
  const { git: runGit, gitSync } = await loadGitModule();
  const repo = createGitFixture('git wrapper 환경 Ω');
  writeFileSync(join(repo, '한 글.txt'), 'one');
  git(repo, ['add', '--', '한 글.txt']);

  const asyncResult = await runGit(repo, ['ls-files', '-z', '--', '한 글.txt']);
  assert.equal(asyncResult.code, 0);
  assert.equal(Buffer.isBuffer(asyncResult.stdout), true);
  assert.equal(asyncResult.stdout.equals(Buffer.from('한 글.txt\0')), true);

  const syncResult = gitSync(repo, ['hash-object', '-t', 'tree', '--stdin'], {
    input: Buffer.alloc(0),
  });
  assert.equal(syncResult.code, 0);
  assert.equal(Buffer.isBuffer(syncResult.stdout), true);
  assert.match(syncResult.stdout.toString('utf8').trim(), /^[0-9a-f]{40,64}$/);
});

test('Git fixture naming contract remains argv-safe', () => {
  const repo = createGitFixture('deep review 환경 Ω');
  writeFileSync(join(repo, '한 글.txt'), 'one');
  git(repo, ['add', '--', '한 글.txt']);
  assert.equal(git(repo, ['-c', 'core.quotePath=false', 'ls-files', '--', '한 글.txt']), '한 글.txt');
  assert.equal(readFileSync(join(repo, '한 글.txt'), 'utf8'), 'one');
});
