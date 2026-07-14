'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, sep } = require('node:path');
const { after, before, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  cleanupGitFixtures,
  createGitFixture,
  git,
  gitResult,
} = require('./helpers/git-fixture.js');

const root = join(__dirname, '..');
const protocolUrl = pathToFileURL(join(root, 'hooks', 'scripts', 'phase6-protocol.mjs')).href;
const repoPathUrl = pathToFileURL(join(root, 'hooks', 'scripts', 'lib', 'repo-path.mjs')).href;

let protocol;
let repoPath;

before(async () => {
  protocol = await import(protocolUrl);
  repoPath = await import(repoPathUrl);
});

after(() => cleanupGitFixtures());

function writeRepoFile(repo, path, content) {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function rawAbsolute(repo, rawPath) {
  if (process.platform === 'win32') {
    return join(repo, repoPath.decodeRepoPath(rawPath).replaceAll('/', sep));
  }
  return Buffer.concat([Buffer.from(repo), Buffer.from(sep), rawPath]);
}

function writeRawRepoFile(repo, rawPath, content) {
  const absolute = rawAbsolute(repo, rawPath);
  writeFileSync(absolute, content);
  return absolute;
}

function rawGit(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: null,
    input,
    shell: false,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${Buffer.from(result.stderr || []).toString('utf8')}`,
  );
  return Buffer.from(result.stdout || []);
}

function base64(rawPath) {
  return Buffer.from(rawPath).toString('base64');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function jsonToken(rawPath) {
  return JSON.stringify(repoPath.decodeRepoPath(rawPath));
}

function completedGroup(paths, options = {}) {
  const itemId = options.itemId || 'ITEM-1';
  const status = options.status || 'completed';
  const passed = options.passed ?? 1;
  const failed = options.failed ?? 0;
  const skipped = options.skipped ?? 0;
  const itemStatus = options.itemStatus || 'passed';
  const testExit = options.testExit ?? 0;
  const claims = paths.map((path) => `  - ${jsonToken(path)}`).join('\n') || '  - (none)';
  return [
    '## Group Result',
    `- execution_status: ${status}`,
    `- items_total: ${passed + failed + skipped}`,
    `- items_passed: ${passed}`,
    `- items_failed: ${failed}`,
    `- items_skipped: ${skipped}`,
    '',
    '## Items',
    '',
    `### ${itemId}`,
    `- status: ${itemStatus}`,
    '- files_changed:',
    claims,
    '- test_command: node fixture',
    `- test_exit_code: ${testExit}`,
    `- log_range: ${itemId}`,
    '- action_summary: applied',
  ].join('\n');
}

function writeSuccessfulLog(snapshot, itemId = 'ITEM-1', output = 'ok\n') {
  mkdirSync(dirname(snapshot.log_path), { recursive: true });
  writeFileSync(snapshot.log_path, [
    `===== ${itemId} START 2026-07-13T00:00:00.000Z =====`,
    output.replace(/\n$/u, ''),
    `===== ${itemId} END exit=0 =====`,
    '',
  ].join('\n'));
}

function accepted(path, extra = {}) {
  return {
    item_id: extra.item_id || 'ITEM-1',
    target_location: path,
    modifiable_paths: extra.modifiable_paths || [],
  };
}

function snapshotJson(snapshot) {
  return JSON.parse(readFileSync(snapshot.snapshot_path, 'utf8'));
}

function dirtyStatus(repo) {
  return gitResult(repo, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
    '--', '.', ':(exclude).deep-review', ':(exclude).deep-review/**',
  ]).stdout;
}

test('path validator accepts raw repo paths and rejects every cross-platform escape form', () => {
  const repo = createGitFixture('phase6 path 공간 한글 Ω');
  const valid = [
    Buffer.from('space name.txt'),
    Buffer.from('tab\tname.txt'),
    Buffer.from('line\nname.txt'),
    Buffer.from('한글 Ω.txt'),
    Buffer.from('-leading.txt'),
  ];
  if (process.platform !== 'win32') {
    valid.push(Buffer.concat([Buffer.from('invalid-'), Buffer.from([0x80]), Buffer.from('.txt')]));
    valid.push(Buffer.concat([Buffer.from('truncated-'), Buffer.from([0xe2, 0x82]), Buffer.from('.txt')]));
    valid.push(Buffer.from([0xae, 0x67, 0x69, 0x74]));
  }

  for (const rawPath of valid) {
    const result = repoPath.validatePhase6RepoPath({ repo, rawPath });
    assert.deepEqual(result.rawPath, rawPath);
    assert.equal(result.base64, base64(rawPath));
  }

  const invalid = [
    Buffer.from('/absolute.txt'),
    Buffer.from('\\\\server\\share\\file.txt'),
    Buffer.from('C:\\drive.txt'),
    Buffer.from('C:drive-relative.txt'),
    Buffer.from('../escape.txt'),
    Buffer.from('nested/../../escape.txt'),
    Buffer.from('nul\0path.txt'),
    Buffer.from('.git/config'),
  ];
  for (const rawPath of invalid) {
    assert.throws(
      () => repoPath.validatePhase6RepoPath({ repo, rawPath }),
      /repository-relative|absolute|UNC|drive|dot-dot|NUL|Git metadata/u,
      rawPath.toString('hex'),
    );
  }
});

test('snapshot, verify, recover, and commit each independently reject invalid raw paths', () => {
  const invalid = [
    Buffer.from('/absolute.txt'),
    Buffer.from('\\\\server\\share\\file.txt'),
    Buffer.from('D:\\drive.txt'),
    Buffer.from('../escape.txt'),
    Buffer.from('nul\0path.txt'),
  ];

  for (const [index, rawPath] of invalid.entries()) {
    const repo = createGitFixture(`phase6-invalid-${index}`);
    assert.throws(
      () => protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted(rawPath)] }),
      /path|NUL|absolute|UNC|drive|dot-dot/u,
    );

    const snapshotPath = join(repo, `.deep-review/tmp/invalid-${index}.json`);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({
      schema_version: 1,
      severity: 'critical',
      head: git(repo, ['rev-parse', 'HEAD']),
      path_encoding: 'base64',
      allowed: [base64(rawPath)],
      pre_changed: [],
      pre_dirty: {},
      paths: {
        [base64(rawPath)]: {
          worktree: { present: false, sha256: null, backup: null },
          index: { present: false, mode: null, blob: null },
          pre_staged: false,
        },
      },
      log_path: join(repo, '.deep-review/tmp/phase6-critical.log'),
    }));
    const group = completedGroup([rawPath]);
    assert.throws(() => protocol.verifyPhase6({ repo, snapshotPath, groupResult: group }), /path|NUL|absolute|UNC|drive|dot-dot/u);
    assert.throws(() => protocol.recoverPhase6({ repo, snapshotPath, paths: [rawPath] }), /path|NUL|absolute|UNC|drive|dot-dot/u);
    assert.throws(() => protocol.commitPhase6({ repo, snapshotPath, severity: 'critical' }), /path|NUL|absolute|UNC|drive|dot-dot/u);
  }
});

test('all four protocol commands reject an existing or ancestor symlink escaping the repository', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation needs an elevated/developer-mode fixture');
    return;
  }
  const repo = createGitFixture('phase6-symlink-escape');
  const outside = createGitFixture('phase6-outside');
  symlinkSync(outside, join(repo, 'escape-dir'));
  const rawPath = Buffer.from('escape-dir/file.txt');

  assert.throws(
    () => protocol.snapshotPhase6({ repo, severity: 'warning', acceptedItems: [accepted(rawPath)] }),
    /symlink|outside|repository/u,
  );

  const snapshotPath = join(repo, '.deep-review/tmp/symlink-invalid.json');
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify({
    schema_version: 1,
    severity: 'warning',
    head: git(repo, ['rev-parse', 'HEAD']),
    path_encoding: 'base64',
    allowed: [base64(rawPath)],
    pre_changed: [],
    pre_dirty: {},
    paths: {
      [base64(rawPath)]: {
        worktree: { present: false, sha256: null, backup: null },
        index: { present: false, mode: null, blob: null },
        pre_staged: false,
      },
    },
    log_path: join(repo, '.deep-review/tmp/phase6-warning.log'),
  }));
  assert.throws(() => protocol.verifyPhase6({ repo, snapshotPath, groupResult: completedGroup([rawPath]) }), /symlink|outside|repository/u);
  assert.throws(() => protocol.recoverPhase6({ repo, snapshotPath, paths: [rawPath] }), /symlink|outside|repository/u);
  assert.throws(() => protocol.commitPhase6({ repo, snapshotPath, severity: 'warning' }), /symlink|outside|repository/u);
});

test('tampered pre-dirty authority cannot use path traversal and logs cannot escape through .deep-review symlinks', async (t) => {
  const repo = createGitFixture('phase6-tampered-runtime-path');
  const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
  const parsed = snapshotJson(snapshot);
  parsed.pre_dirty[base64(Buffer.from('../outside.txt'))] = {
    worktree: { present: false, type: null, sha256: null, backup: null, mode: null },
    index: { present: false, mode: null, blob: null },
  };
  writeFileSync(snapshot.snapshot_path, JSON.stringify(parsed));
  assert.throws(
    () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
    /pre-dirty|path|dot-dot/u,
  );

  if (process.platform === 'win32') {
    t.diagnostic('Windows symlink log escape is covered by path validator unit cases');
    return;
  }
  const outside = createGitFixture('phase6-log-outside');
  rmSync(join(repo, '.deep-review'), { recursive: true, force: true });
  symlinkSync(outside, join(repo, '.deep-review'));
  await assert.rejects(
    protocol.runLoggedTest({
      repo,
      itemId: 'ITEM-1',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("no")'],
      logPath: join(repo, '.deep-review', 'tmp', 'phase6-critical.log'),
    }),
    /symlink|outside|repository/u,
  );
  assert.equal(existsSync(join(outside, 'tmp', 'phase6-critical.log')), false);
  assert.throws(
    () => protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] }),
    /symlink|outside|repository/u,
  );
  assert.equal(existsSync(join(outside, 'tmp', 'phase6-critical-snapshot.json')), false);
});

test('tampered snapshot and log artifact paths must remain inside the repository runtime directory', () => {
  const repo = createGitFixture('phase6-artifact-boundary');
  const snapshot = protocol.snapshotPhase6({ repo, severity: 'warning', acceptedItems: [accepted('tracked.txt')] });
  const parsed = snapshotJson(snapshot);
  parsed.log_path = join(dirname(repo), 'outside-phase6.log');
  writeFileSync(snapshot.snapshot_path, JSON.stringify(parsed));
  assert.throws(
    () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
    /log|artifact|runtime|repository/u,
  );

  const outsideSnapshot = join(dirname(repo), 'outside-snapshot.json');
  writeFileSync(outsideSnapshot, JSON.stringify(parsed));
  assert.throws(
    () => protocol.verifyPhase6({ repo, snapshotPath: outsideSnapshot, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
    /snapshot|artifact|runtime|repository/u,
  );
});

test('runtime artifacts refuse even in-repository symlink aliases', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation needs an elevated/developer-mode fixture');
    return;
  }
  const repo = createGitFixture('phase6-runtime-inside-symlink');
  mkdirSync(join(repo, 'runtime-target'));
  symlinkSync(join(repo, 'runtime-target'), join(repo, '.deep-review'));
  assert.throws(
    () => protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] }),
    /runtime|symlink/u,
  );
  assert.equal(existsSync(join(repo, 'runtime-target', 'tmp')), false);
});

test('an unchanged pre-dirty outside symlink is snapshotted without following its external target', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation needs an elevated/developer-mode fixture');
    return;
  }
  const repo = createGitFixture('phase6-pre-dirty-symlink');
  const outside = createGitFixture('phase6-pre-dirty-target');
  writeRepoFile(outside, 'secret.txt', 'must-not-be-authority\n');
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'outside-link'));
  const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
  writeRepoFile(repo, 'tracked.txt', 'allowed-change\n');
  writeSuccessfulLog(snapshot);
  const result = protocol.verifyPhase6({
    repo,
    snapshotPath: snapshot.snapshot_path,
    groupResult: completedGroup([Buffer.from('tracked.txt')]),
  });
  assert.equal(result.status, 'verified');
  const parsed = snapshotJson(snapshot);
  const symlinkState = parsed.pre_dirty[base64(Buffer.from('outside-link'))].worktree;
  assert.equal(symlinkState.type, 'symlink');
  assert.equal(symlinkState.sha256, sha256(Buffer.from(join(outside, 'secret.txt'))));
  assert.notEqual(symlinkState.sha256, sha256(Buffer.from('must-not-be-authority\n')));
});

test('pre-dirty tracked paths below an outside symlink ancestor never read the external file', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation needs an elevated/developer-mode fixture');
    return;
  }
  const repo = createGitFixture('phase6-pre-dirty-ancestor-symlink');
  writeRepoFile(repo, 'dir/file.txt', 'tracked-base\n');
  git(repo, ['add', '--', 'dir/file.txt']);
  git(repo, ['commit', '--quiet', '-m', 'tracked directory']);
  const outside = createGitFixture('phase6-pre-dirty-ancestor-target');
  writeRepoFile(outside, 'file.txt', 'outside-secret-content\n');
  rmSync(join(repo, 'dir'), { recursive: true });
  symlinkSync(outside, join(repo, 'dir'));

  const snapshot = protocol.snapshotPhase6({ repo, severity: 'warning', acceptedItems: [accepted('tracked.txt')] });
  const parsed = snapshotJson(snapshot);
  const nested = parsed.pre_dirty[base64(Buffer.from('dir/file.txt'))].worktree;
  assert.equal(nested.type, 'ancestor_symlink');
  assert.notEqual(nested.sha256, sha256(Buffer.from('outside-secret-content\n')));

  writeRepoFile(repo, 'tracked.txt', 'allowed-change\n');
  writeSuccessfulLog(snapshot);
  assert.equal(protocol.verifyPhase6({
    repo,
    snapshotPath: snapshot.snapshot_path,
    groupResult: completedGroup([Buffer.from('tracked.txt')]),
  }).status, 'verified');
});

test('empty accepted group skips without creating dispatch artifacts and allowlist normalization is deterministic', () => {
  const repo = createGitFixture('phase6-empty-normalize');
  const empty = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [] });
  assert.deepEqual(empty, { status: 'skipped', reason: 'no_accepted_items' });
  assert.equal(existsSync(join(repo, '.deep-review', 'tmp')), false);

  writeRepoFile(repo, 'src/a.js', 'base\n');
  writeRepoFile(repo, 'tests/a.test.js', 'base\n');
  writeRepoFile(repo, 'docs/note.md', 'base\n');
  git(repo, ['add', '--', 'src/a.js', 'tests/a.test.js', 'docs/note.md']);
  git(repo, ['commit', '--quiet', '-m', 'fixture']);
  const snapshot = protocol.snapshotPhase6({
    repo,
    severity: 'warning',
    acceptedItems: [{
      item_id: 'ITEM-1',
      target_location: ' src/a.js:12-20, tests/a.test.js:3 ',
      modifiable_paths: ['docs/note.md', 'src/a.js'],
    }],
  });
  const parsed = snapshotJson(snapshot);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.path_encoding, 'base64');
  assert.deepEqual(parsed.allowed, [
    base64(Buffer.from('docs/note.md')),
    base64(Buffer.from('src/a.js')),
    base64(Buffer.from('tests/a.test.js')),
  ]);
  assert.equal(Object.keys(parsed.paths).length, 3);
});

test('Phase 6 protocol refuses a repository subdirectory as its authority root', () => {
  const repo = createGitFixture('phase6-root-pinning');
  mkdirSync(join(repo, 'nested'));
  assert.throws(
    () => protocol.snapshotPhase6({
      repo: join(repo, 'nested'),
      severity: 'critical',
      acceptedItems: [accepted('tracked.txt')],
    }),
    /repository root|top-level/u,
  );
  assert.equal(existsSync(join(repo, 'nested', '.deep-review')), false);
});

test('snapshot records exact worktree, index, pre-staged, HEAD, and pre-dirty outside authority', () => {
  const repo = createGitFixture('phase6-snapshot-authority');
  writeRepoFile(repo, 'allowed.bin', Buffer.from([0, 1, 2, 3]));
  writeRepoFile(repo, 'outside.txt', 'outside-v1\n');
  git(repo, ['add', '--', 'allowed.bin', 'outside.txt']);
  git(repo, ['commit', '--quiet', '-m', 'fixture']);
  writeRepoFile(repo, 'allowed.bin', Buffer.from([0, 1, 2, 4]));
  git(repo, ['add', '--', 'allowed.bin']);
  writeRepoFile(repo, 'allowed.bin', Buffer.from([0, 1, 2, 5]));
  writeRepoFile(repo, 'outside.txt', 'outside-user-wip\n');
  writeRepoFile(repo, 'outside-untracked.txt', 'untracked-user-wip\n');

  const snapshot = protocol.snapshotPhase6({
    repo,
    severity: 'critical',
    acceptedItems: [accepted('allowed.bin')],
  });
  const parsed = snapshotJson(snapshot);
  const key = base64(Buffer.from('allowed.bin'));
  assert.equal(parsed.head, git(repo, ['rev-parse', 'HEAD']));
  assert.equal(parsed.paths[key].worktree.present, true);
  assert.equal(parsed.paths[key].worktree.sha256, sha256(Buffer.from([0, 1, 2, 5])));
  assert.equal(parsed.paths[key].index.present, true);
  assert.match(parsed.paths[key].index.mode, /^100[67][45][45]$/u);
  assert.match(parsed.paths[key].index.blob, /^[0-9a-f]{40,64}$/u);
  assert.equal(parsed.paths[key].pre_staged, true);
  assert.ok(parsed.pre_changed.includes(key));
  assert.ok(Object.hasOwn(parsed.pre_dirty, base64(Buffer.from('outside.txt'))));
  assert.ok(Object.hasOwn(parsed.pre_dirty, base64(Buffer.from('outside-untracked.txt'))));
  assert.ok(parsed.pre_modified.includes(base64(Buffer.from('outside.txt'))));
  assert.ok(parsed.pre_untracked.includes(base64(Buffer.from('outside-untracked.txt'))));
  const backup = join(repo, parsed.paths[key].worktree.backup);
  assert.equal(readFileSync(backup).equals(Buffer.from([0, 1, 2, 5])), true);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(backup).mode & 0o077, 0);
  }
});

test('Group Result parser is strict and preserves JSON-escaped raw path tokens', () => {
  const raw = process.platform === 'win32'
    ? Buffer.from('한글 Ω.txt')
    : Buffer.concat([Buffer.from('bad-'), Buffer.from([0x80]), Buffer.from('.txt')]);
  const parsed = protocol.parseGroupResult(completedGroup([raw]));
  assert.equal(parsed.execution_status, 'completed');
  assert.equal(parsed.items_total, 1);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].files_changed_tokens[0], jsonToken(raw));
  assert.deepEqual(parsed.items[0].files_changed_raw[0], raw);

  const warning = protocol.parseGroupResult(
    completedGroup([raw]).replace('## Group Result\n', '## Group Result\n- severity: warning\n'),
  );
  assert.equal(warning.severity, 'warning');
  assert.throws(
    () => protocol.parseGroupResult(
      completedGroup([raw]).replace('## Group Result\n', '## Group Result\n- severity: blocker\n'),
    ),
    /severity/u,
  );

  const invalid = [
    '## Items\n### ITEM-1\n- status: pass',
    '## Group Result\n- execution_status: completed\n- items_total: 1\n- items_passed: 1\n- items_failed: 0\n- items_skipped: 0',
    completedGroup([raw]).replace('- items_total: 1', '- items_total: 2'),
    completedGroup([raw]).replace(jsonToken(raw), 'not-a-json-string-token'),
    completedGroup([raw]).replace('- test_exit_code: 0', '- test_exit_code: nope'),
  ];
  for (const value of invalid) {
    assert.throws(() => protocol.parseGroupResult(value), /Group Result|Items|count|JSON|string token|exit/u);
  }
});

test('Group Result parser accepts fail-closed halted/error items with n/a test exits', () => {
  const halted = [
    '## Group Result',
    '- execution_status: halted_on_regression',
    '- items_total: 2',
    '- items_passed: 0',
    '- items_failed: 1',
    '- items_skipped: 1',
    '- halt_item: ITEM-1',
    '',
    '## Items',
    '',
    '### ITEM-1',
    '- status: failed',
    '- files_changed: []',
    '- test_command: node fixture',
    '- test_exit_code: 1',
    '- log_range: ITEM-1',
    '',
    '### ITEM-2',
    '- status: skipped_due_to_halt',
    '- files_changed: []',
    '- test_command: (not run)',
    '- test_exit_code: (n/a)',
    '- log_range: (n/a)',
  ].join('\n');
  const parsed = protocol.parseGroupResult(halted);
  assert.equal(parsed.execution_status, 'halted_on_regression');
  assert.equal(parsed.items[1].test_exit_code, null);
  assert.throws(
    () => protocol.parseGroupResult(halted.replace('- halt_item: ITEM-1\n', '')),
    /halt_item/u,
  );
});

test('structured logged tests preserve argv/stdout/stderr and reject free-form shell control syntax', async () => {
  const repo = createGitFixture('phase6 log 공간 한글 Ω');
  const logPath = join(repo, '.deep-review', 'tmp', 'phase6-critical.log');
  const result = await protocol.runLoggedTest({
    repo,
    itemId: 'ITEM-7',
    command: process.execPath,
    args: ['-e', "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2])", '공백 Ω', '%!^&|<>'],
    logPath,
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timed_out, false);
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /^===== ITEM-7 START .* =====$/mu);
  assert.match(log, /공백 Ω/u);
  assert.match(log, /%!\^&\|<>/u);
  assert.match(log, /^===== ITEM-7 END exit=0 =====$/mu);

  const marker = join(repo, 'must-not-exist.txt');
  await assert.rejects(
    protocol.runLoggedTest({
      repo,
      itemId: 'ITEM-8',
      command: `${process.execPath} -e "require('fs').writeFileSync('${marker}','bad')" ; echo injected`,
      logPath,
    }),
    /shell control|redirection|legacy command/u,
  );
  assert.equal(existsSync(marker), false);

  const quoted = await protocol.runLoggedTest({
    repo,
    itemId: 'ITEM-9',
    command: `${process.execPath} -e "process.stdout.write(process.argv[1])" "quoted value Ω"`,
    logPath,
  });
  assert.equal(quoted.code, 0);
  assert.match(readFileSync(logPath, 'utf8'), /quoted value Ω/u);

  const windowsPath = 'C:\\hostedtoolcache\\windows\\node\\22.23.1\\x64\\node.exe';
  const windowsPathResult = await protocol.runLoggedTest({
    repo,
    itemId: 'ITEM-9B',
    command: `"${process.execPath}" -e "process.stdout.write(process.argv[1])" "${windowsPath}"`,
    logPath,
  });
  assert.equal(windowsPathResult.code, 0);
  assert.match(readFileSync(logPath, 'utf8'), new RegExp(escapeRegex(windowsPath)));

  await assert.rejects(
    protocol.runLoggedTest({
      repo,
      itemId: 'ITEM-9C',
      command: `"${process.execPath}" -e "process.stdout.write('must-not-run')" \\;`,
      logPath,
    }),
    /shell control|redirection/u,
  );

  const timed = await protocol.runLoggedTest({
    repo,
    itemId: 'ITEM-10',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    logPath,
    timeoutMs: 30,
  });
  assert.equal(timed.code, 124);
  assert.equal(timed.timed_out, true);
  assert.match(readFileSync(logPath, 'utf8'), /^===== ITEM-10 END exit=124 =====$/mu);
});

test('verify accepts exact binary delta and rejects missing, false, staged, outside, and HEAD-changing claims', async (t) => {
  await t.test('binary exact claim passes and writes a bound verification receipt', () => {
    const repo = createGitFixture('phase6-binary-pass');
    writeRepoFile(repo, 'bin.dat', Buffer.from([0, 1, 2]));
    git(repo, ['add', '--', 'bin.dat']);
    git(repo, ['commit', '--quiet', '-m', 'binary']);
    const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('bin.dat')] });
    writeRepoFile(repo, 'bin.dat', Buffer.from([0, 1, 3]));
    writeSuccessfulLog(snapshot);
    const verified = protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('bin.dat')]) });
    assert.equal(verified.status, 'verified');
    assert.deepEqual(verified.changed_paths, [base64(Buffer.from('bin.dat'))]);
    assert.ok(existsSync(verified.verification_receipt));
  });

  await t.test('missing and false claims fail closed', () => {
    const repo = createGitFixture('phase6-claim-mismatch');
    const snapshot = protocol.snapshotPhase6({ repo, severity: 'warning', acceptedItems: [accepted('tracked.txt'), accepted('false.txt', { item_id: 'ITEM-2' })] });
    writeRepoFile(repo, 'tracked.txt', 'changed\n');
    writeSuccessfulLog(snapshot);
    assert.throws(
      () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([]) }),
      /claim.*delta|delta.*claim/u,
    );
    assert.throws(
      () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt'), Buffer.from('false.txt')]) }),
      /claim.*delta|delta.*claim/u,
    );
  });

  await t.test('new outside and changed pre-dirty outside paths fail closed', () => {
    const repo = createGitFixture('phase6-outside-mutation');
    writeRepoFile(repo, 'outside.txt', 'base\n');
    git(repo, ['add', '--', 'outside.txt']);
    git(repo, ['commit', '--quiet', '-m', 'outside']);
    writeRepoFile(repo, 'outside.txt', 'user-wip\n');
    const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
    writeRepoFile(repo, 'tracked.txt', 'allowed\n');
    writeRepoFile(repo, 'outside.txt', 'subagent-overwrite\n');
    writeRepoFile(repo, 'new-outside.txt', 'unauthorized\n');
    writeSuccessfulLog(snapshot);
    assert.throws(
      () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
      /outside|allowlist|pre-dirty/u,
    );
  });

  await t.test('any index mutation after snapshot fails verification', () => {
    const repo = createGitFixture('phase6-staged-change');
    const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
    writeRepoFile(repo, 'tracked.txt', 'changed\n');
    git(repo, ['add', '--', 'tracked.txt']);
    writeSuccessfulLog(snapshot);
    assert.throws(
      () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
      /index|staged/u,
    );
  });

  await t.test('rename destination outside allowlist is observed and rejected', () => {
    const repo = createGitFixture('phase6-rename-outside');
    const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
    git(repo, ['mv', '--', 'tracked.txt', 'renamed.txt']);
    writeSuccessfulLog(snapshot);
    assert.throws(
      () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
      /outside|allowlist|index|staged/u,
    );
  });

  await t.test('HEAD movement is unrecoverable and blocks verification', () => {
    const repo = createGitFixture('phase6-head-change');
    const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
    writeRepoFile(repo, 'other.txt', 'commit\n');
    git(repo, ['add', '--', 'other.txt']);
    git(repo, ['commit', '--quiet', '-m', 'move head']);
    writeSuccessfulLog(snapshot);
    assert.throws(
      () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([]) }),
      /HEAD|history/u,
    );
  });
});

test('verification requires exact per-item START/END markers and successful exit', () => {
  const repo = createGitFixture('phase6-log-contract');
  const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
  writeRepoFile(repo, 'tracked.txt', 'changed\n');
  mkdirSync(dirname(snapshot.log_path), { recursive: true });
  writeFileSync(snapshot.log_path, 'ITEM-1 output without exact markers\n');
  assert.throws(
    () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
    /log|START|END/u,
  );
  writeFileSync(snapshot.log_path, [
    '===== ITEM-1 START 2026-07-13T00:00:00.000Z =====',
    'failure',
    '===== ITEM-1 END exit=1 =====',
    '',
  ].join('\n'));
  assert.throws(
    () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
    /log|exit/u,
  );
  writeFileSync(snapshot.log_path, [
    '===== ITEM-1 START 2026-07-13T00:00:00.000Z =====',
    'old pass',
    '===== ITEM-1 END exit=0 =====',
    '===== ITEM-1 START 2026-07-13T00:00:01.000Z =====',
    'new failure',
    '===== ITEM-1 END exit=1 =====',
    '',
  ].join('\n'));
  assert.throws(
    () => protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) }),
    /log|duplicate|marker|exit/u,
  );
});

test('recovery restores worktree and exact index independently, including deletes, staging, untracked, and rename', () => {
  const repo = createGitFixture('phase6-recovery-states');
  for (const [path, content] of [
    ['unstaged-delete.txt', 'u1\n'],
    ['staged-delete.txt', 'd1\n'],
    ['partial.txt', 'p1\n'],
    ['rename-old.txt', 'r1\n'],
  ]) writeRepoFile(repo, path, content);
  git(repo, ['add', '--', 'unstaged-delete.txt', 'staged-delete.txt', 'partial.txt', 'rename-old.txt']);
  git(repo, ['commit', '--quiet', '-m', 'recovery base']);

  rmSync(join(repo, 'unstaged-delete.txt'));
  git(repo, ['rm', '--quiet', '--', 'staged-delete.txt']);
  writeRepoFile(repo, 'partial.txt', 'p2-staged\n');
  git(repo, ['add', '--', 'partial.txt']);
  writeRepoFile(repo, 'partial.txt', 'p3-worktree\n');
  writeRepoFile(repo, 'user-untracked.txt', 'user-untracked\n');
  git(repo, ['mv', '--', 'rename-old.txt', 'rename-new.txt']);
  const preStatus = Buffer.from(dirtyStatus(repo));
  const preIndexPartial = git(repo, ['rev-parse', ':partial.txt']);

  const paths = [
    'unstaged-delete.txt',
    'staged-delete.txt',
    'partial.txt',
    'user-untracked.txt',
    'rename-old.txt',
    'rename-new.txt',
  ];
  const snapshot = protocol.snapshotPhase6({
    repo,
    severity: 'warning',
    acceptedItems: paths.map((path, index) => accepted(path, { item_id: `ITEM-${index + 1}` })),
  });

  for (const path of paths) writeRepoFile(repo, path, `agent-${path}\n`);
  git(repo, ['add', '--', ...paths]);
  const recovered = protocol.recoverPhase6({ repo, snapshotPath: snapshot.snapshot_path, paths: paths.map(Buffer.from) });
  assert.equal(recovered.status, 'recovered');
  assert.deepEqual(dirtyStatus(repo), preStatus);
  assert.equal(existsSync(join(repo, 'unstaged-delete.txt')), false);
  assert.equal(existsSync(join(repo, 'staged-delete.txt')), false);
  assert.equal(readFileSync(join(repo, 'partial.txt'), 'utf8'), 'p3-worktree\n');
  assert.equal(git(repo, ['rev-parse', ':partial.txt']), preIndexPartial);
  assert.equal(readFileSync(join(repo, 'user-untracked.txt'), 'utf8'), 'user-untracked\n');
  assert.equal(existsSync(join(repo, 'rename-old.txt')), false);
  assert.equal(readFileSync(join(repo, 'rename-new.txt'), 'utf8'), 'r1\n');
});

test('raw paths survive snapshot, claim comparison, recover, and path-limited commit byte-for-byte', () => {
  const repo = createGitFixture('phase6 raw roundtrip 공간 Ω');
  const rawPaths = [
    Buffer.from('space name.txt'),
    Buffer.from('한글 Ω.txt'),
    Buffer.from('-leading.txt'),
    Buffer.from(':(glob)magic.txt'),
  ];
  if (process.platform !== 'win32') {
    rawPaths.push(Buffer.from('tab\tname.txt'), Buffer.from('line\nname.txt'));
  }
  if (process.platform === 'linux') {
    rawPaths.push(
      Buffer.concat([Buffer.from('invalid-'), Buffer.from([0x80]), Buffer.from('.txt')]),
      Buffer.concat([Buffer.from('truncated-'), Buffer.from([0xe2, 0x82]), Buffer.from('.txt')]),
    );
  }

  const first = protocol.snapshotPhase6({
    repo,
    severity: 'info',
    acceptedItems: rawPaths.map((path, index) => accepted(path, { item_id: `ITEM-${index + 1}` })),
  });
  assert.deepEqual(snapshotJson(first).allowed, [...rawPaths].sort(Buffer.compare).map(base64));
  for (const path of rawPaths) writeRawRepoFile(repo, path, Buffer.concat([Buffer.from('content:'), path]));
  writeSuccessfulLog(first);
  const verified = protocol.verifyPhase6({
    repo,
    snapshotPath: first.snapshot_path,
    groupResult: completedGroup(rawPaths),
  });
  assert.deepEqual(verified.changed_paths, [...rawPaths].sort(Buffer.compare).map(base64));
  protocol.recoverPhase6({ repo, snapshotPath: first.snapshot_path, paths: rawPaths });
  for (const path of rawPaths) assert.equal(existsSync(rawAbsolute(repo, path)), false);

  const second = protocol.snapshotPhase6({
    repo,
    severity: 'info',
    acceptedItems: rawPaths.map((path, index) => accepted(path, { item_id: `ITEM-${index + 1}` })),
  });
  for (const path of rawPaths) writeRawRepoFile(repo, path, Buffer.concat([Buffer.from('committed:'), path]));
  writeSuccessfulLog(second);
  protocol.verifyPhase6({ repo, snapshotPath: second.snapshot_path, groupResult: completedGroup(rawPaths) });
  const committed = protocol.commitPhase6({ repo, snapshotPath: second.snapshot_path, severity: 'info' });
  assert.equal(committed.status, 'committed');
  const tree = rawGit(repo, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
  for (const path of rawPaths) assert.notEqual(tree.indexOf(Buffer.concat([path, Buffer.from([0])])), -1, path.toString('hex'));

  if (process.platform === 'linux') {
    const badRepo = createGitFixture('phase6-mangled-claim');
    const invalid = Buffer.concat([Buffer.from('invalid-'), Buffer.from([0x80]), Buffer.from('.txt')]);
    const badSnapshot = protocol.snapshotPhase6({ repo: badRepo, severity: 'critical', acceptedItems: [accepted(invalid)] });
    writeRawRepoFile(badRepo, invalid, 'changed\n');
    writeSuccessfulLog(badSnapshot);
    const mangled = completedGroup([invalid]).replace(jsonToken(invalid), JSON.stringify('invalid-�.txt'));
    assert.throws(
      () => protocol.verifyPhase6({ repo: badRepo, snapshotPath: badSnapshot.snapshot_path, groupResult: mangled }),
      /Phase 6 claim is outside the allowlist/u,
    );
  }
});

test('same-path pre-staging requires a state-bound explicit confirmation before any mutation', () => {
  const repo = createGitFixture('phase6-prestaged-confirm');
  writeRepoFile(repo, 'outside.txt', 'outside-v1\n');
  git(repo, ['add', '--', 'outside.txt']);
  git(repo, ['commit', '--quiet', '-m', 'outside base']);
  writeRepoFile(repo, 'tracked.txt', 'user-staged\n');
  git(repo, ['add', '--', 'tracked.txt']);
  writeRepoFile(repo, 'tracked.txt', 'pre-dispatch-worktree\n');
  writeRepoFile(repo, 'outside.txt', 'outside-staged\n');
  git(repo, ['add', '--', 'outside.txt']);
  const snapshot = protocol.snapshotPhase6({ repo, severity: 'critical', acceptedItems: [accepted('tracked.txt')] });
  writeRepoFile(repo, 'tracked.txt', 'phase6-final\n');
  writeSuccessfulLog(snapshot);
  protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) });

  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const indexBefore = git(repo, ['write-tree']);
  const first = protocol.commitPhase6({ repo, snapshotPath: snapshot.snapshot_path, severity: 'critical' });
  assert.equal(first.status, 'requires_user_confirmation');
  assert.deepEqual(first.paths, [base64(Buffer.from('tracked.txt'))]);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['write-tree']), indexBefore);

  assert.throws(
    () => protocol.commitPhase6({ repo, snapshotPath: snapshot.snapshot_path, severity: 'critical', confirmPreStaged: 'yes' }),
    /confirmation/u,
  );
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['write-tree']), indexBefore);

  const second = protocol.commitPhase6({
    repo,
    snapshotPath: snapshot.snapshot_path,
    severity: 'critical',
    confirmPreStaged: protocol.PRE_STAGED_CONFIRMATION,
  });
  assert.equal(second.status, 'committed');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['show', 'HEAD:tracked.txt']), 'phase6-final');
  assert.equal(git(repo, ['diff', '--cached', '--name-only']), 'outside.txt');
});

test('commit refuses a stale verification receipt before staging or committing', () => {
  const repo = createGitFixture('phase6-stale-receipt');
  const snapshot = protocol.snapshotPhase6({ repo, severity: 'warning', acceptedItems: [accepted('tracked.txt')] });
  writeRepoFile(repo, 'tracked.txt', 'verified\n');
  writeSuccessfulLog(snapshot);
  protocol.verifyPhase6({ repo, snapshotPath: snapshot.snapshot_path, groupResult: completedGroup([Buffer.from('tracked.txt')]) });
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const indexBefore = git(repo, ['write-tree']);
  writeRepoFile(repo, 'tracked.txt', 'changed-after-verify\n');
  assert.throws(
    () => protocol.commitPhase6({ repo, snapshotPath: snapshot.snapshot_path, severity: 'warning' }),
    /stale|verification|state/u,
  );
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['write-tree']), indexBefore);
});

test('artifact rotation keeps one previous generation and preserves unrelated tmp files', () => {
  const repo = createGitFixture('phase6-rotate');
  const tmp = join(repo, '.deep-review', 'tmp');
  const prev = join(tmp, 'prev');
  mkdirSync(join(tmp, 'phase6-critical-baseline'), { recursive: true });
  mkdirSync(prev, { recursive: true });
  writeFileSync(join(tmp, 'phase6-critical.log'), 'current-log');
  writeFileSync(join(tmp, 'phase6-critical-snapshot.json'), 'current-json');
  writeFileSync(join(tmp, 'phase6-critical-pre-hash.tsv'), 'current-tsv');
  writeFileSync(join(tmp, 'phase6-critical-baseline', 'file'), 'current-baseline');
  writeFileSync(join(prev, 'phase6-critical.log'), 'old-log');
  writeFileSync(join(tmp, 'unrelated.txt'), 'keep');

  protocol.rotatePhase6Artifacts({ repo });
  assert.equal(existsSync(join(tmp, 'phase6-critical.log')), false);
  assert.equal(readFileSync(join(prev, 'phase6-critical.log'), 'utf8'), 'current-log');
  assert.equal(readFileSync(join(prev, 'phase6-critical-snapshot.json'), 'utf8'), 'current-json');
  assert.equal(readFileSync(join(prev, 'phase6-critical-pre-hash.tsv'), 'utf8'), 'current-tsv');
  assert.equal(readFileSync(join(prev, 'phase6-critical-baseline', 'file'), 'utf8'), 'current-baseline');
  assert.equal(readFileSync(join(tmp, 'unrelated.txt'), 'utf8'), 'keep');
});

test('run-test transports quotes, newlines, Unicode, and shell metacharacters as JSON argv data', async () => {
  const repo = createGitFixture('phase6-json-argv-data');
  const logPath = join(repo, '.deep-review', 'tmp', 'phase6-critical.log');
  const literal = 'quoted "value"\n한글 Ω\n$HOME; $(not-executed)';
  const result = await protocol.runLoggedTest({
    repo,
    itemId: 'ITEM-argv',
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', literal],
    logPath,
  });
  assert.equal(result.code, 0);
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /^===== ITEM-argv START /mu);
  assert.match(log, /===== ITEM-argv END exit=0 =====/u);
  assert.ok(log.includes(JSON.stringify([literal])));
});

test('CLI commit keeps HEAD and index unchanged until the exact pre-staged confirmation flag', () => {
  const repo = createGitFixture('phase6-cli-confirm');
  writeRepoFile(repo, 'tracked.txt', 'user-staged\n');
  git(repo, ['add', '--', 'tracked.txt']);
  writeRepoFile(repo, 'tracked.txt', 'pre-dispatch-worktree\n');
  const acceptedFile = join(repo, 'accepted.json');
  writeFileSync(acceptedFile, JSON.stringify([accepted('tracked.txt')]));
  const snapshotRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'snapshot', '--repo', repo, '--severity', 'critical', '--accepted-items-file', acceptedFile,
  ], { encoding: 'utf8', shell: false });
  assert.equal(snapshotRun.status, 0, snapshotRun.stderr);
  const snapshot = JSON.parse(snapshotRun.stdout);
  writeRepoFile(repo, 'tracked.txt', 'phase6-final\n');

  const argvFile = join(repo, '.deep-review', 'tmp', 'argv.json');
  writeFileSync(argvFile, JSON.stringify({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
  }));
  const logRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'run-test', '--repo', repo, '--item-id', 'ITEM-1', '--argv-file', argvFile,
    '--log-path', snapshot.log_path,
  ], { encoding: 'utf8', shell: false });
  assert.equal(logRun.status, 0, logRun.stderr);

  const resultFile = join(repo, '.deep-review', 'tmp', 'group-result.md');
  writeFileSync(resultFile, completedGroup([Buffer.from('tracked.txt')]));
  const verifyRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'verify', '--repo', repo, '--snapshot', snapshot.snapshot_path, '--result-file', resultFile,
  ], { encoding: 'utf8', shell: false });
  assert.equal(verifyRun.status, 0, verifyRun.stderr);

  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const indexBefore = git(repo, ['write-tree']);
  const gatedRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'commit', '--repo', repo, '--snapshot', snapshot.snapshot_path, '--severity', 'critical',
  ], { encoding: 'utf8', shell: false });
  assert.equal(gatedRun.status, 0, gatedRun.stderr);
  assert.equal(JSON.parse(gatedRun.stdout).status, 'requires_user_confirmation');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repo, ['write-tree']), indexBefore);

  const confirmedRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'commit', '--repo', repo, '--snapshot', snapshot.snapshot_path, '--severity', 'critical',
    '--confirm-pre-staged',
  ], { encoding: 'utf8', shell: false });
  assert.equal(confirmedRun.status, 0, confirmedRun.stderr);
  assert.equal(JSON.parse(confirmedRun.stdout).status, 'committed');
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('CLI subcommands consume JSON files and emit JSON without invoking a shell', () => {
  const repo = createGitFixture('phase6-cli 공간 Ω');
  const acceptedFile = join(repo, 'accepted.json');
  writeFileSync(acceptedFile, JSON.stringify([accepted('tracked.txt')]));
  const snapshotRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'snapshot', '--repo', repo, '--severity', 'critical', '--accepted-items-file', acceptedFile,
  ], { encoding: 'utf8', shell: false });
  assert.equal(snapshotRun.status, 0, snapshotRun.stderr);
  const snapshot = JSON.parse(snapshotRun.stdout);
  writeRepoFile(repo, 'tracked.txt', 'cli-change\n');

  const argvFile = join(repo, '.deep-review', 'tmp', 'argv.json');
  writeFileSync(argvFile, JSON.stringify({
    command: process.execPath,
    args: ['-e', "process.stdout.write('cli-ok')"],
  }));
  const logRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'run-test', '--repo', repo, '--item-id', 'ITEM-1', '--argv-file', argvFile,
    '--log-path', snapshot.log_path,
  ], { encoding: 'utf8', shell: false });
  assert.equal(logRun.status, 0, logRun.stderr);
  assert.equal(JSON.parse(logRun.stdout).code, 0);

  const resultFile = join(repo, '.deep-review', 'tmp', 'group-result.md');
  writeFileSync(resultFile, completedGroup([Buffer.from('tracked.txt')]));
  const verifyRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'verify', '--repo', repo, '--snapshot', snapshot.snapshot_path, '--result-file', resultFile,
  ], { encoding: 'utf8', shell: false });
  assert.equal(verifyRun.status, 0, verifyRun.stderr);
  assert.equal(JSON.parse(verifyRun.stdout).status, 'verified');

  const commitRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'commit', '--repo', repo, '--snapshot', snapshot.snapshot_path, '--severity', 'critical',
  ], { encoding: 'utf8', shell: false });
  assert.equal(commitRun.status, 0, commitRun.stderr);
  assert.equal(JSON.parse(commitRun.stdout).status, 'committed');

  const recoverRepo = createGitFixture('phase6-cli-recover');
  const recoverAccepted = join(recoverRepo, 'accepted.json');
  writeFileSync(recoverAccepted, JSON.stringify([accepted('tracked.txt')]));
  const recoverSnapshotRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'snapshot', '--repo', recoverRepo, '--severity', 'warning', '--accepted-items-file', recoverAccepted,
  ], { encoding: 'utf8', shell: false });
  assert.equal(recoverSnapshotRun.status, 0, recoverSnapshotRun.stderr);
  const recoverSnapshot = JSON.parse(recoverSnapshotRun.stdout);
  writeRepoFile(recoverRepo, 'tracked.txt', 'must-recover\n');
  const recoveryPaths = join(recoverRepo, '.deep-review', 'tmp', 'recovery-paths.json');
  writeFileSync(recoveryPaths, JSON.stringify({ paths_base64: [base64(Buffer.from('tracked.txt'))] }));
  const recoverRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'recover', '--repo', recoverRepo, '--snapshot', recoverSnapshot.snapshot_path, '--paths-file', recoveryPaths,
  ], { encoding: 'utf8', shell: false });
  assert.equal(recoverRun.status, 0, recoverRun.stderr);
  assert.equal(JSON.parse(recoverRun.stdout).status, 'recovered');
  assert.equal(readFileSync(join(recoverRepo, 'tracked.txt'), 'utf8'), 'base\n');

  const rotateRun = spawnSync(process.execPath, [
    join(root, 'hooks', 'scripts', 'phase6-protocol.mjs'),
    'rotate', '--repo', repo,
  ], { encoding: 'utf8', shell: false });
  assert.equal(rotateRun.status, 0, rotateRun.stderr);
  assert.equal(JSON.parse(rotateRun.stdout).status, 'rotated');
});
