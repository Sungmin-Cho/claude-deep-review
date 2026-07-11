'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  cleanupGitFixtures,
  createGitFixture,
  git,
} = require('./helpers/git-fixture.js');

const modulePath = join(__dirname, '..', 'hooks', 'scripts', 'lib', 'review-target.mjs');
const moduleUrl = pathToFileURL(modulePath).href;
const cliPath = join(__dirname, '..', 'hooks', 'scripts', 'build-change-files.mjs');
const temporaryRoots = new Set();

function temporaryDirectory(prefix = 'deep-review-target-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadTarget() {
  return import(moduleUrl);
}

function paths(records) {
  return records.map((record) => record.path);
}

function parseJsonLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('staged rename and copy records retain old_path and similarity score', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('rename copy 공간 Ω');
  writeFileSync(join(repo, 'copy-source.txt'), 'copy source\nline 2\nline 3\n');
  git(repo, ['add', '--', 'copy-source.txt']);
  git(repo, ['commit', '--quiet', '-m', 'add copy source']);

  git(repo, ['mv', '--', 'tracked.txt', 'renamed.txt']);
  copyFileSync(join(repo, 'copy-source.txt'), join(repo, 'copied.txt'));
  writeFileSync(join(repo, 'copy-source.txt'), 'changed source\n');
  git(repo, ['add', '-A']);

  const records = buildChangeFiles({ repo, changeState: 'staged' });
  const rename = records.find((record) => record.status === 'R');
  const copy = records.find((record) => record.status === 'C');
  assert.deepEqual(
    { path: rename?.path, old_path: rename?.old_path, score: rename?.score },
    { path: 'renamed.txt', old_path: 'tracked.txt', score: '100' },
  );
  assert.deepEqual(
    { path: copy?.path, old_path: copy?.old_path, score: copy?.score },
    { path: 'copied.txt', old_path: 'copy-source.txt', score: '100' },
  );
});

test('every dirty state unions untracked files while clean excludes leftovers', async () => {
  const { buildChangeFiles } = await loadTarget();

  for (const state of ['staged', 'unstaged', 'mixed', 'untracked-only']) {
    const repo = createGitFixture(`state-${state}`);
    writeFileSync(join(repo, 'second.txt'), 'second base\n');
    git(repo, ['add', '--', 'second.txt']);
    git(repo, ['commit', '--quiet', '-m', 'second']);
    writeFileSync(join(repo, 'leftover.txt'), `${state}\n`);
    if (state === 'staged') {
      writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
      git(repo, ['add', '--', 'tracked.txt']);
    } else if (state === 'unstaged') {
      writeFileSync(join(repo, 'tracked.txt'), 'unstaged\n');
    } else if (state === 'mixed') {
      writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
      git(repo, ['add', '--', 'tracked.txt']);
      writeFileSync(join(repo, 'second.txt'), 'unstaged\n');
    }
    const records = buildChangeFiles({ repo, changeState: state });
    assert.equal(paths(records).includes('leftover.txt'), true, state);
  }

  const clean = createGitFixture('clean-leftover');
  const base = git(clean, ['rev-parse', 'HEAD']);
  writeFileSync(join(clean, 'committed.txt'), 'committed\n');
  git(clean, ['add', '--', 'committed.txt']);
  git(clean, ['commit', '--quiet', '-m', 'review target']);
  writeFileSync(join(clean, 'leftover.txt'), 'not in range\n');
  const records = buildChangeFiles({ repo: clean, changeState: 'clean', reviewBase: base });
  assert.equal(paths(records).includes('committed.txt'), true);
  assert.equal(paths(records).includes('leftover.txt'), false);
  assert.throws(
    () => buildChangeFiles({ repo: clean, changeState: 'clean' }),
    /reviewBase.*required/i,
  );
});

test('initial and non-Git manual targets work without a shell', async () => {
  const { buildChangeFiles } = await loadTarget();
  const initial = createGitFixture('initial', { initialCommit: false });
  writeFileSync(join(initial, 'only.txt'), 'initial\n');
  assert.deepEqual(paths(buildChangeFiles({ repo: initial, changeState: 'initial' })), ['only.txt']);

  const nonGit = temporaryDirectory('deep-review-non-git-');
  writeFileSync(join(nonGit, 'manual one.txt'), 'one\n');
  writeFileSync(join(nonGit, '한글 Ω.txt'), 'two\n');
  const filesFromZ = Buffer.from('manual one.txt\0한글 Ω.txt\0');
  const records = buildChangeFiles({ repo: nonGit, changeState: 'non-git', filesFromZ });
  assert.deepEqual(paths(records), ['manual one.txt', '한글 Ω.txt'].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.equal(records.every((record) => record.status === 'non-git'), true);
});

test('JSONL round-trips control bytes, newline, leading dash, spaces, and Unicode', async () => {
  const { serializeChangeFiles } = await loadTarget();
  const records = [
    { status: 'M', path: 'a\u0001b.txt' },
    { status: 'M', path: 'c\nd.txt' },
    { status: 'M', path: '-leading.txt' },
    { status: 'M', path: 'space name.txt' },
    { status: 'M', path: '한글 Ω.txt' },
  ];
  const serialized = serializeChangeFiles(records, { maxEntries: 500, maxBytes: 65536 });
  assert.deepEqual(parseJsonLines(serialized), records);
  assert.match(serialized, /a\\u0001b\.txt/);
  assert.match(serialized, /c\\nd\.txt/);
});

test('Git collection preserves supported leading-dash, space, and Unicode paths', async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('path spelling 공간 Ω');
  const expected = ['-leading.txt', 'space name.txt', '한글 Ω.txt'];
  for (const relative of expected) writeFileSync(join(repo, relative), `${relative}\n`);
  git(repo, ['add', '-A']);

  const records = buildChangeFiles({ repo, changeState: 'staged' });
  const decoded = parseJsonLines(serializeChangeFiles(records));
  assert.deepEqual(
    decoded.map((record) => record.path),
    expected.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
});

test('POSIX Git collection preserves control-byte and embedded-newline path bytes', { skip: process.platform === 'win32' }, async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('control-paths');
  const expected = ['a\u0001b.txt', 'c\nd.txt'];
  for (const relative of expected) writeFileSync(join(repo, relative), 'content\n');
  git(repo, ['add', '-A']);

  const records = parseJsonLines(serializeChangeFiles(buildChangeFiles({ repo, changeState: 'staged' })));
  assert.deepEqual(
    records.map((record) => record.path),
    expected.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
});

test('canonical directory, basename, and binary exclusions match the Stage-1 target', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('exclusions');
  const excluded = [
    'node_modules/x.js', 'dist/x.js', 'build/x.js', '.next/x.js', 'target/x.js',
    '.venv/x.py', '__pycache__/x.pyc', '.pytest_cache/x', 'vendor/x.js', '.git/never',
    'src/a.min.js', 'src/b.generated.ts', 'src/c.lock', 'src/.DS_Store',
  ];
  for (const relative of excluded.filter((entry) => !entry.startsWith('.git/'))) {
    mkdirSync(join(repo, relative, '..'), { recursive: true });
    writeFileSync(join(repo, relative), 'excluded\n');
  }
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'real.ts'), 'real\n');
  writeFileSync(join(repo, 'src', 'tracked.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, 'src', 'untracked.bin'), Buffer.from([80, 75, 0, 4]));
  writeFileSync(join(repo, 'src', 'high-byte.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
  git(repo, ['add', '-A']);

  const records = buildChangeFiles({ repo, changeState: 'staged' });
  assert.equal(paths(records).includes('src/real.ts'), true);
  assert.equal(paths(records).includes('src/high-byte.dat'), true);
  assert.equal(paths(records).includes('src/tracked.bin'), false);
  assert.equal(paths(records).includes('src/untracked.bin'), false);
  for (const relative of excluded) assert.equal(paths(records).includes(relative), false, relative);
});

test('untracked NUL binary is dropped while high-byte text and a missing manual path remain', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('binary-sniff');
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(repo, 'high.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
  let records = buildChangeFiles({ repo, changeState: 'unstaged' });
  assert.equal(paths(records).includes('binary.dat'), false);
  assert.equal(paths(records).includes('high.dat'), true);

  records = buildChangeFiles({
    repo,
    changeState: 'non-git',
    filesFromZ: Buffer.from('missing.txt\0'),
  });
  assert.deepEqual(paths(records), ['missing.txt']);
});

test('FIFO binary sniff never opens the special file and cannot hang', { skip: process.platform === 'win32' }, async () => {
  const root = temporaryDirectory('deep-review-fifo-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const fifo = join(repo, 'special.fifo');
  const made = spawnSync('mkfifo', [fifo], { shell: false });
  assert.equal(made.status, 0, made.stderr?.toString());
  const list = join(root, 'files.z');
  writeFileSync(list, Buffer.concat([Buffer.from(fifo), Buffer.from([0])]));

  const result = spawnSync(process.execPath, [
    cliPath,
    '--repo', repo,
    '--change-state', 'non-git',
    '--files-from-z', list,
  ], { encoding: 'utf8', shell: false, timeout: 1000 });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseJsonLines(result.stdout)[0].path, fifo);
});

test('entry and byte limits emit one exact trailer and retain an oversized first row', async () => {
  const { serializeChangeFiles } = await loadTarget();
  const records = Array.from({ length: 501 }, (_, index) => ({
    status: 'M',
    path: `src/${String(index).padStart(3, '0')}.txt`,
  }));
  let lines = parseJsonLines(serializeChangeFiles(records, { maxEntries: 500, maxBytes: 65536 }));
  assert.equal(lines.length, 501);
  assert.deepEqual(lines.at(-1), { omitted: 1, truncated: true });
  assert.equal(lines.filter((record) => record.truncated === true).length, 1);

  const longRecords = [
    { status: 'M', path: `first-${'x'.repeat(256)}` },
    { status: 'M', path: 'second' },
    { status: 'M', path: 'third' },
  ];
  const serialized = serializeChangeFiles(longRecords, { maxEntries: 500, maxBytes: 32 });
  lines = parseJsonLines(serialized);
  assert.deepEqual(lines[0], longRecords[0]);
  assert.deepEqual(lines[1], { omitted: 2, truncated: true });
  assert.equal(lines.length, 2);
});
