'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { hostname, tmpdir } = require('node:os');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
  gitResult,
} = require('./helpers/git-fixture.js');

const pluginRoot = join(__dirname, '..');
const protocolPath = join(pluginRoot, 'hooks', 'scripts', 'mutation-protocol.mjs');
const protocolUrl = pathToFileURL(protocolPath).href;
const sensitiveUrl = pathToFileURL(join(
  pluginRoot,
  'hooks',
  'scripts',
  'lib',
  'sensitive-files.mjs',
)).href;
const publicationRef = 'refs/worktree/deep-review/mutation/v3/publication';
const legacyStateRelative = join('.deep-review', '.pending-mutation.json');
const legacyReservationRelative = join('.deep-review', '.mutation.operation.reserve');
const legacyLockRelative = join('.deep-review', '.mutation.lock');
const v3SlotRelative = (slot) => join('.deep-review', `.pending-mutation.v3.${slot}.json`);

const allowedCapabilitySkips = new Set([
  'git-floor-unavailable',
  'git-sha256-unavailable',
  'fs-symlink-privilege-unavailable',
  'fs-junction-privilege-unavailable',
  'bash-unavailable',
]);
const capabilitySkipCounts = new Map();

function capabilitySkip(t, reason) {
  assert.equal(allowedCapabilitySkips.has(reason), true, `undeclared capability skip: ${reason}`);
  const count = (capabilitySkipCounts.get(reason) || 0) + 1;
  capabilitySkipCounts.set(reason, count);
  t.diagnostic(`capability-skip ${reason} count=${count} non-proof`);
  t.skip(reason);
}

test.after(() => cleanupGitFixtures());

async function loadProtocol() {
  return import(`${protocolUrl}?test=${Date.now()}-${Math.random()}`);
}

async function loadSensitiveFiles() {
  return import(`${sensitiveUrl}?test=${Date.now()}-${Math.random()}`);
}

function writeRepoFile(repo, relative, contents = `${relative}\n`) {
  const file = join(repo, ...relative.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function indexPath(repo) {
  const value = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  return isAbsolute(value) ? value : resolve(repo, value);
}

function readRef(repo) {
  const result = gitResult(repo, ['rev-parse', '--verify', publicationRef]);
  return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
}

function readRefBlob(repo) {
  const oid = readRef(repo);
  if (!oid) return null;
  return { oid, bytes: gitResult(repo, ['cat-file', 'blob', oid]).stdout };
}

function stageEntry(repo, relative) {
  return gitResult(repo, ['ls-files', '--stage', '-z', '--', `:(literal)${relative}`]).stdout;
}

function protocolFiles(repo) {
  const directory = join(repo, '.deep-review');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

function protocolSnapshot(repo) {
  const index = indexPath(repo);
  const directory = join(repo, '.deep-review');
  const files = {};
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const metadata = lstatSync(file);
      if (metadata.isFile()) files[name] = readFileSync(file).toString('base64');
      else if (metadata.isDirectory()) {
        files[name] = readdirSync(file).sort().map((entry) => {
          const child = join(file, entry);
          const childMetadata = lstatSync(child);
          return childMetadata.isFile()
            ? [entry, readFileSync(child).toString('base64')]
            : [entry, '<non-file>'];
        });
      } else files[name] = '<special>';
    }
  }
  return {
    ref: readRefBlob(repo),
    index: existsSync(index) ? readFileSync(index).toString('base64') : null,
    files,
    staged: gitResult(repo, ['ls-files', '--stage', '-z']).stdout.toString('base64'),
  };
}

function assertSnapshotEqual(before, after, message = 'protocol state changed') {
  assert.deepEqual(after, before, message);
}

function assertForceKilled(result) {
  if (result.signal === 'SIGKILL') return;
  const code = Object.hasOwn(result, 'code') ? result.code : result.status;
  assert.equal(process.platform, 'win32', `expected SIGKILL, got signal=${result.signal} code=${code}`);
  assert.equal(Number.isInteger(code) && code !== 0, true, `expected a nonzero Windows exit, got ${code}`);
}

function parseCliOutput(result) {
  assert.equal(result.stderr, '', `unexpected stderr: ${result.stderr}`);
  assert.ok(result.stdout.trim(), 'CLI returned no JSON');
  return JSON.parse(result.stdout);
}

function spawnFramed(buffer, options = {}) {
  return spawnSync(process.execPath, [protocolPath, '--request-stdin'], {
    cwd: options.cwd || pluginRoot,
    input: buffer,
    encoding: 'utf8',
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
  });
}

function runChild(input, options = {}) {
  const child = spawn(process.execPath, [protocolPath, '--request-stdin'], {
    cwd: options.cwd || pluginRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function killUpdateRefAfterPrepare(repo, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'git',
      ['-C', repo, '-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin', '-z'],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('timed out waiting for update-ref prepare response'));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (!killed && stdout.includes('prepare: ok')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, killed });
    });
    child.stdin.write(input.subarray(0, input.length - Buffer.byteLength('commit\0', 'latin1')));
  });
}

function killRealUpdateRefTransaction(repo, input, boundary) {
  const worker = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    'const repo = process.argv[1];',
    'const boundary = process.argv[2];',
    'const input = fs.readFileSync(0);',
    "const commit = Buffer.from('commit\\0', 'latin1');",
    'const offset = input.lastIndexOf(commit);',
    'if (offset < 0) process.exit(96);',
    "const child = spawn('git', ['-C', repo, '-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin', '-z'], {",
    "  stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,",
    '});',
    "let stdout = Buffer.alloc(0);",
    "let stderr = Buffer.alloc(0);",
    'let commitSent = false;',
    'let killed = false;',
    'const kill = () => {',
    '  if (killed) return;',
    '  killed = true;',
    "  child.kill('SIGTERM');",
    '};',
    'const timer = setTimeout(() => { kill(); }, 5000);',
    "child.stdout.on('data', (chunk) => {",
    '  stdout = Buffer.concat([stdout, chunk]);',
    "  const text = stdout.toString('utf8');",
    "  if (!commitSent && text.includes('prepare: ok')) {",
    "    if (boundary === 'prepared') { kill(); return; }",
    '    commitSent = true;',
    '    child.stdin.write(commit);',
    "    if (boundary === 'mid-commit') setImmediate(kill);",
    '  }',
    "  if (boundary === 'post-commit' && text.includes('commit: ok')) kill();",
    '});',
    "child.stderr.on('data', (chunk) => { stderr = Buffer.concat([stderr, chunk]); });",
    "child.on('close', () => {",
    '  clearTimeout(timer);',
    '  process.stdout.write(stdout);',
    '  process.stderr.write(stderr);',
    '  process.exit(killed ? 97 : 98);',
    '});',
    'child.stdin.write(input.subarray(0, offset));',
    '',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', worker, repo, boundary], {
    input,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  return {
    code: result.status ?? 1,
    signal: result.signal,
    stdout: Buffer.from(result.stdout || []),
    stderr: Buffer.from(result.stderr || []),
  };
}

function transactionNewOid(input) {
  const fields = input.toString('latin1').split('\0');
  const commandIndex = fields.findIndex((field) => field === `update ${publicationRef}`
    || field === `create ${publicationRef}`);
  assert.notEqual(commandIndex, -1, 'publication transaction command not found');
  assert.ok(fields[commandIndex + 1], 'publication transaction NEW OID not found');
  return fields[commandIndex + 1];
}

function authorityTransaction(input) {
  const fields = Buffer.from(input || []).toString('latin1').split('\0');
  const commandIndex = fields.findIndex((field) => field === `update ${publicationRef}`);
  if (commandIndex < 0) return null;
  return Object.freeze({
    newOid: fields[commandIndex + 1],
    oldOid: fields[commandIndex + 2],
    bytes: Buffer.from(input).toString('base64'),
  });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sessionLease(record) {
  return sha256(Buffer.concat([
    Buffer.from('deep-review-session-lease-v1\0', 'utf8'),
    Buffer.from(record.cutover_id, 'ascii'),
    Buffer.from(record.session_id, 'ascii'),
    Buffer.from(record.record_seq, 'ascii'),
    Buffer.from(record.record_digest, 'ascii'),
  ]));
}

function gitObjectInventory(repo) {
  const result = gitResult(repo, [
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname) %(objecttype) %(objectsize)',
  ]);
  assert.equal(result.code, 0, result.stderr.toString('utf8'));
  return result.stdout.toString('utf8').split('\n').filter(Boolean).sort();
}

function replaceFileIdentity(file) {
  const bytes = readFileSync(file);
  const before = lstatSync(file, { bigint: true });
  const held = `${file}.held-old-inode-${crypto.randomUUID()}`;
  renameSync(file, held);
  try {
    writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    const after = lstatSync(file, { bigint: true });
    assert.equal(
      before.dev === after.dev && before.ino === after.ino,
      false,
      'replacement fixture must create a distinct file identity',
    );
  } finally {
    rmSync(held, { force: true });
  }
}

function advanceHeadWithTarget(repo, target) {
  const oldHeadResult = gitResult(repo, ['rev-parse', '--verify', 'HEAD']);
  const oldHead = oldHeadResult.code === 0
    ? oldHeadResult.stdout.toString('utf8').trim()
    : null;
  const temporaryIndex = join(
    fixtureRootFor(repo),
    `${basename(repo)}-head-advance-${Date.now()}-${Math.random()}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  if (oldHead) git(repo, ['read-tree', oldHead], { env });
  else git(repo, ['read-tree', '--empty'], { env });
  git(repo, ['add', '--', target], { env });
  const tree = git(repo, ['write-tree'], { env });
  const commitArgs = ['commit-tree', tree];
  if (oldHead) commitArgs.push('-p', oldHead);
  const newHead = git(repo, commitArgs, { input: Buffer.from('advance HEAD\n') });
  if (oldHead) git(repo, ['update-ref', 'HEAD', newHead, oldHead]);
  else git(repo, ['update-ref', 'HEAD', newHead]);
  rmSync(temporaryIndex, { force: true });
  return { oldHead, newHead };
}

function advanceHeadWithoutTarget(repo) {
  const oldHeadResult = gitResult(repo, ['rev-parse', '--verify', 'HEAD']);
  const oldHead = oldHeadResult.code === 0
    ? oldHeadResult.stdout.toString('utf8').trim()
    : null;
  const tree = oldHead
    ? git(repo, ['rev-parse', `${oldHead}^{tree}`])
    : git(repo, ['mktree'], { input: Buffer.alloc(0) });
  const commitArgs = ['commit-tree', tree];
  if (oldHead) commitArgs.push('-p', oldHead);
  const newHead = git(repo, commitArgs, { input: Buffer.from('advance HEAD without target\n') });
  if (oldHead) git(repo, ['update-ref', 'HEAD', newHead, oldHead]);
  else git(repo, ['update-ref', 'HEAD', newHead]);
  return { oldHead, newHead };
}

function writePublicationAuthority(repo, protocol, publication, oldOid) {
  const bytes = protocol.__testing.encodePublication(
    protocol.__testing.buildPublication({ ...publication, publication_digest: undefined }),
  );
  const oid = git(repo, ['hash-object', '-w', '--stdin'], { input: bytes });
  git(repo, ['update-ref', publicationRef, oid, oldOid]);
  return { oid, bytes, publication: protocol.__testing.decodePublication(bytes) };
}

function installOperation(repo, protocol, options = {}) {
  const before = protocol.__testing.inspectProtocol({ repo });
  assert.equal(before.publication.operation, null);
  const operation = {
    operation_id: canonicalOwnerToken(),
    host_hash: protocol.__testing.currentHostHash(),
    pid: String(process.pid),
    process_start_ms: String(protocol.__testing.processStartMs()),
    base_publication_oid: options.baseOid || before.publication_oid,
    ...options.operation,
  };
  return writePublicationAuthority(repo, protocol, {
    ...before.publication,
    operation,
  }, before.publication_oid);
}

function exhaustReadyIdleSlots(repo, protocol, sequence = '4294967295') {
  const target = `src/exhaust-${Date.now()}-${Math.random()}.txt`;
  writeRepoFile(repo, target);
  const performed = protocol.performMutation({ repo, files: [target] });
  assert.equal(protocol.restoreMutation({
    repo,
    ownerToken: performed.owner_token,
  }).status, 'restored');
  const idle = protocol.__testing.inspectProtocol({ repo });
  assert.equal(idle.publication.session, null);
  for (const slot of idle.slots) {
    assert.ok(slot.record, `slot ${slot.slot} requires a retained active record`);
    const record = protocol.__testing.buildRecord({
      ...slot.record,
      record_seq: sequence,
      record_digest: undefined,
    });
    writeFileSync(join(repo, v3SlotRelative(slot.slot)), protocol.__testing.encodeRecord(record));
  }
  return protocol.__testing.inspectProtocol({ repo });
}

function gitFailureShim(repo, mode) {
  const locator = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(locator.status, 0, locator.stderr || 'git executable lookup failed');
  const realGit = locator.stdout.split(/\r?\n/u).find(Boolean);
  const directory = join(fixtureRootFor(repo), `git-shim-${mode}-${Date.now()}-${Math.random()}`);
  mkdirSync(directory, { recursive: true });
  const statePath = join(directory, 'state.json');
  const scriptPath = join(directory, 'git-shim.cjs');
  writeFileSync(statePath, JSON.stringify({ afterAdd: false, updates: 0 }));
  writeFileSync(scriptPath, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    `const realGit = ${JSON.stringify(realGit)};`,
    `const statePath = ${JSON.stringify(statePath)};`,
    `const mode = ${JSON.stringify(mode)};`,
    'const args = process.argv.slice(2);',
    'const input = fs.readFileSync(0);',
    'const state = JSON.parse(fs.readFileSync(statePath, "utf8"));',
    'const delegate = () => spawnSync(realGit, args, { input, encoding: null, env: process.env });',
    'const emit = (result, suffix = "") => {',
    '  if (result.stdout) process.stdout.write(result.stdout);',
    '  if (result.stderr) process.stderr.write(result.stderr);',
    '  if (suffix) process.stderr.write(suffix);',
    '  process.exit(result.status === null ? 1 : result.status);',
    '};',
    'if (args.includes("add")) {',
    '  const result = delegate();',
    '  if (result.status === 0) {',
    '    state.afterAdd = true;',
    '    state.updates = 0;',
    '    fs.writeFileSync(statePath, JSON.stringify(state));',
    '    emit({ ...result, status: 1 }, "primary cli add failure\\n");',
    '  }',
    '  emit(result);',
    '}',
    'if (state.afterAdd && args.includes("update-ref")) {',
    '  state.updates += 1;',
    '  fs.writeFileSync(statePath, JSON.stringify(state));',
    '  const shouldFail = (mode === "pending" && state.updates === 1)',
    '    || (mode === "terminal" && state.updates === 2);',
    '  if (shouldFail) {',
    '    process.stderr.write(`injected cli ${mode} publication failure\\n`);',
    '    process.exit(1);',
    '  }',
    '}',
    'emit(delegate());',
    '',
  ].join('\n'));
  const wrapper = join(directory, process.platform === 'win32' ? 'git.cmd' : 'git');
  if (process.platform === 'win32') {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    writeFileSync(join(directory, 'git.ps1'), `& '${process.execPath.replaceAll("'", "''")}' '${scriptPath.replaceAll("'", "''")}' @args\r\nexit $LASTEXITCODE\r\n`);
  } else {
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, {
      mode: 0o755,
    });
  }
  return {
    ...process.env,
    PATH: `${directory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  };
}

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to throw');
}

function rewriteSelectedRecordSequence(repo, protocol, recordSequence) {
  const before = protocol.__testing.inspectProtocol({ repo });
  assert.ok(before.selectedRecord, 'fixture requires an active selected record');
  const selectedSlot = before.publication.selected_slot;
  const record = protocol.__testing.buildRecord({
    ...before.selectedRecord,
    record_seq: recordSequence,
    record_digest: undefined,
  });
  writeFileSync(join(repo, v3SlotRelative(selectedSlot)), protocol.__testing.encodeRecord(record));
  const publication = protocol.__testing.buildPublication({
    ...before.publication,
    publication_seq: (BigInt(before.publication.publication_seq) + 1n).toString(),
    publication_digest: undefined,
    selected_record_seq: record.record_seq,
    selected_record_digest: record.record_digest,
    session: {
      ...before.publication.session,
      record_seq: record.record_seq,
      record_digest: record.record_digest,
      lease_id: sessionLease(record),
    },
  });
  const bytes = protocol.__testing.encodePublication(publication);
  const oid = git(repo, ['hash-object', '-w', '--stdin'], { input: bytes });
  git(repo, ['update-ref', publicationRef, oid, before.publication_oid]);
  return protocol.__testing.inspectProtocol({ repo });
}

function rewriteSelectedRecordOwner(repo, protocol, changes) {
  const before = protocol.__testing.inspectProtocol({ repo });
  assert.ok(before.selectedRecord, 'fixture requires selected record');
  const selectedSlot = before.publication.selected_slot;
  const record = protocol.__testing.buildRecord({
    ...before.selectedRecord,
    owner_process: changes.owner_process || before.selectedRecord.owner_process,
    started_at: changes.started_at || before.selectedRecord.started_at,
    record_digest: undefined,
  });
  writeFileSync(join(repo, v3SlotRelative(selectedSlot)), protocol.__testing.encodeRecord(record));
  const publication = protocol.__testing.buildPublication({
    ...before.publication,
    publication_seq: (BigInt(before.publication.publication_seq) + 1n).toString(),
    publication_digest: undefined,
    selected_record_digest: record.record_digest,
    session: {
      ...before.publication.session,
      record_digest: record.record_digest,
      lease_id: sessionLease(record),
    },
  });
  writePublicationAuthority(repo, protocol, publication, before.publication_oid);
  return { before, record };
}

function rewriteSelectedRecord(repo, protocol, changes) {
  const before = protocol.__testing.inspectProtocol({ repo });
  assert.ok(before.selectedRecord, 'fixture requires selected record');
  const selectedSlot = before.publication.selected_slot;
  const record = protocol.__testing.buildRecord({
    ...before.selectedRecord,
    ...changes,
    record_digest: undefined,
  });
  writeFileSync(join(repo, v3SlotRelative(selectedSlot)), protocol.__testing.encodeRecord(record));
  const publication = protocol.__testing.buildPublication({
    ...before.publication,
    publication_seq: (BigInt(before.publication.publication_seq) + 1n).toString(),
    publication_digest: undefined,
    selected_record_seq: record.record_seq,
    selected_record_digest: record.record_digest,
    session: {
      ...before.publication.session,
      phase: record.phase,
      record_seq: record.record_seq,
      record_digest: record.record_digest,
      lease_id: sessionLease(record),
    },
  });
  writePublicationAuthority(repo, protocol, publication, before.publication_oid);
  return { before, record };
}

function releaseFailureResult() {
  return {
    code: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from('injected operation release failure\n'),
  };
}

function retainOperationAtPhase(protocol, phase) {
  const repo = createGitFixture(`r1c-departed-${phase.replace(/[^a-z0-9]+/giu, '-')}`);
  const target = `src/${phase.replace(/[^a-z0-9]+/giu, '-')}.txt`;
  const ownerToken = canonicalOwnerToken();
  writeRepoFile(repo, target);

  const controller = {
    failRelease: false,
    failRestoreIndex: phase === 'failed',
  };
  const runner = (gitRepo, args, options = {}) => {
    if (controller.failRestoreIndex && args[0] === 'update-index') {
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('injected restore failure\n'),
      };
    }
    if (controller.failRelease && args.includes('update-ref')) return releaseFailureResult();
    return gitResult(gitRepo, args, options);
  };
  const retainAfter = (expected) => (label) => {
    if (label === expected) {
      controller.failRelease = true;
      throw new Error(`retain operation at ${expected}`);
    }
  };

  if (phase === 'prepared' || phase === 'committed') {
    captureError(() => protocol.performMutation({
      repo,
      files: [target],
      ownerToken,
      gitRunner: runner,
      transitionHook: retainAfter(phase),
    }));
  } else {
    if (phase === 'aborted') {
      captureError(() => protocol.performMutation({
        repo,
        files: [target],
        ownerToken,
        transitionHook(label) {
          if (label === 'prepared') throw new Error('leave prepared session');
        },
      }));
    } else {
      protocol.performMutation({ repo, files: [target], ownerToken });
    }
    const expected = phase === 'pending'
      ? 'recovery-attempt:restore-committed:pending:1'
      : phase === 'failed'
        ? 'recovery-attempt:restore-committed:failed:1'
        : phase === 'restored'
          ? 'restored:restore-committed:1'
          : 'aborted:abort-prepared:1';
    captureError(() => protocol.restoreMutation({
      repo,
      ownerToken,
      gitRunner: runner,
      transitionHook: retainAfter(expected),
    }));
  }

  const before = protocol.__testing.inspectProtocol({ repo });
  assert.equal(before.publication.operation !== null, true);
  const expectedPhase = phase === 'pending' || phase === 'failed'
    ? 'recovery-attempt'
    : phase;
  assert.equal(before.selectedRecord.phase, expectedPhase);
  if (phase === 'pending' || phase === 'failed') {
    assert.equal(before.selectedRecord.attempt_state, phase);
  }
  return { repo, target, ownerToken, before, controller, runner };
}

function recoveryFixture(protocol, kind, name) {
  const repo = createGitFixture(`recovery-${kind}-${name}`);
  const target = `src/${kind}-${name}.txt`;
  const ownerToken = canonicalOwnerToken();
  writeRepoFile(repo, target);
  if (kind === 'abort-prepared') {
    assert.throws(() => protocol.performMutation({
      repo,
      files: [target],
      ownerToken,
      transitionHook(label) {
        if (label === 'prepared') throw new Error('retain prepared recovery fixture');
      },
    }), /retain prepared/u);
  } else {
    protocol.performMutation({ repo, files: [target], ownerToken });
  }
  return { repo, target, ownerToken };
}

const legacyNodeFenceProbe = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const repo = process.argv[1];",
  "const reservation = path.join(repo, '.deep-review', '.mutation.operation.reserve');",
  "try {",
  "  const fd = fs.openSync(reservation, 'wx', 0o600);",
  "  fs.closeSync(fd);",
  "  process.exit(91);",
  "} catch (error) {",
  "  if (error.code !== 'EEXIST') process.exit(92);",
  "}",
  "const value = JSON.parse(fs.readFileSync(reservation, 'utf8'));",
  "if (value.schema_version !== 2) process.exit(93);",
  "if (value.operation !== 'v3-cutover-fence') process.exit(94);",
  "if (value.host !== '/deep-review-v3-fence/') process.exit(95);",
  "process.exit(23);",
  '',
].join('\n');
const legacyNodeFenceProbeSha256 = '2a7edcf6684d3b33c43dd7dcb69d8c6ceb0ef9811cbb8fce8a31549ed73589ba';
const oldCandidateV2Source = gunzipSync(Buffer.from(
  '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',
  'base64',
));
const oldCandidateV2Sha256 = '91bb007013c0a83c71692f698f38f8362b4398917ad4fee53c7bf303d0ffb1be';

function runOldCandidateV2(repo, command, target, ownerToken = canonicalOwnerToken()) {
  const invocation = command === 'perform'
    ? `const result=performMutation({repo:process.argv[2],files:[process.argv[3]],ownerToken:process.argv[4]});process.stdout.write(JSON.stringify(result));\n`
    : `const result=restoreMutation({repo:process.argv[2],ownerToken:process.argv[4]});process.stdout.write(JSON.stringify(result));\n`;
  return spawnSync(process.execPath, ['--input-type=module', '-', repo, target, ownerToken], {
    cwd: join(pluginRoot, 'hooks', 'scripts'),
    input: Buffer.concat([oldCandidateV2Source, Buffer.from('\n' + invocation)]),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
}

function runRealOldBash(repo, command, target) {
  const functionName = command === 'perform' ? 'perform_mutation' : 'restore_mutation';
  const invocation = command === 'perform'
    ? `${functionName} "$3"`
    : functionName;
  return spawnSync(
    'bash',
    [
      '-c',
      `cd "$1" && source "$2" && ${invocation}`,
      'legacy-bash',
      repo,
      join(pluginRoot, 'hooks', 'scripts', 'mutation-protocol.sh'),
      target,
    ],
    { encoding: 'utf8', shell: false },
  );
}

function currentGitVersion() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const match = result.stdout.match(/(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function gitAtLeast245() {
  const [major, minor] = currentGitVersion();
  return major > 2 || (major === 2 && minor >= 45);
}

function canonicalOwnerToken(length = 36) {
  if (length === 36) return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return 'x'.repeat(length);
}

function makeBootstrapRecord(overrides = {}) {
  return {
    schema_version: 3,
    slot: 'a',
    phase: 'cutover-anchor',
    cutover_id: '1'.repeat(64),
    session_id: null,
    record_seq: '0',
    record_digest: null,
    owner_token: null,
    owner_process: { host_hash: null, pid: null, process_start_ms: null },
    started_at: null,
    commit_hash: null,
    restore_attempts: 0,
    recovery_kind: null,
    attempt_state: null,
    files: [],
    fence_inventory: { sha256: '2'.repeat(64), entries: 3, bytes: 128 },
    self_slot_identity: { dev: '1', ino: '2' },
    peer_slot_identity: null,
    ...overrides,
  };
}

function makeActiveRecord(phase, overrides = {}) {
  let recovery = {
    restore_attempts: 0,
    recovery_kind: null,
    attempt_state: null,
  };
  if (phase === 'recovery-attempt') {
    recovery = {
      restore_attempts: 1,
      recovery_kind: 'restore-committed',
      attempt_state: 'pending',
    };
  } else if (phase === 'restored') {
    recovery = {
      restore_attempts: 1,
      recovery_kind: 'restore-committed',
      attempt_state: null,
    };
  } else if (phase === 'aborted') {
    recovery = {
      restore_attempts: 1,
      recovery_kind: 'abort-prepared',
      attempt_state: null,
    };
  }
  return {
    schema_version: 3,
    slot: 'a',
    phase,
    cutover_id: '1'.repeat(64),
    session_id: '00000000-0000-4000-8000-000000000004',
    record_seq: '1',
    record_digest: undefined,
    owner_token: canonicalOwnerToken(),
    owner_process: {
      host_hash: '3'.repeat(64),
      pid: '1',
      process_start_ms: '1',
    },
    started_at: '1970-01-01T00:00:00.000Z',
    commit_hash: '4'.repeat(40),
    files: ['src/active.txt'],
    fence_inventory: { sha256: '2'.repeat(64), entries: 3, bytes: 128 },
    self_slot_identity: { dev: '1', ino: '2' },
    peer_slot_identity: { dev: '3', ino: '4' },
    ...recovery,
    ...overrides,
  };
}

function exactRecordAtByteCap(testing) {
  const prefixes = Array.from({ length: 256 }, (_, index) => `p/${index.toString().padStart(3, '0')}/`);
  const input = makeActiveRecord('prepared', { files: prefixes });
  let record = testing.buildRecord(input);
  let remaining = 1_048_576 - testing.encodeRecord(record).length;
  assert.equal(remaining > 0, true);
  for (let index = 0; index < prefixes.length && remaining >= 2; index += 1) {
    const capacity = 4096 - Buffer.byteLength(prefixes[index]);
    const count = Math.min(Math.floor(capacity / 2), Math.floor(remaining / 2));
    prefixes[index] += 'é'.repeat(count);
    remaining -= count * 2;
  }
  if (remaining === 1) {
    const index = prefixes.findIndex((file) => Buffer.byteLength(file) < 4096);
    assert.notEqual(index, -1);
    prefixes[index] += 'x';
    remaining = 0;
  }
  assert.equal(remaining, 0);
  record = testing.buildRecord({ ...input, files: prefixes });
  const bytes = testing.encodeRecord(record);
  assert.equal(bytes.length, 1_048_576);
  return { input: { ...input, files: prefixes }, record, bytes };
}

function performCapacityRecordAtByteCap(testing, ownerToken = 'é'.repeat(128)) {
  const files = Array.from({ length: 256 }, (_, index) => `p/${index.toString().padStart(3, '0')}/x`);
  const make = () => testing.buildPerformCapacityRecord(ownerToken, files);
  let remaining = 1_048_576 - testing.encodeRecord(make()).length;
  assert.ok(remaining > 0);
  for (let index = 0; index < files.length && remaining >= 2; index += 1) {
    const capacity = 4096 - Buffer.byteLength(files[index]);
    const count = Math.min(Math.floor(capacity / 2), Math.floor(remaining / 2));
    files[index] += 'é'.repeat(count);
    remaining -= count * 2;
  }
  if (remaining === 1) {
    const index = files.findIndex((file) => Buffer.byteLength(file) < 4096);
    assert.notEqual(index, -1);
    files[index] += 'x';
    remaining = 0;
  }
  assert.equal(remaining, 0);
  const bytes = testing.encodeRecord(make());
  assert.equal(bytes.length, 1_048_576);
  return { ownerToken, files, bytes };
}

function failedAttemptThreeFixture(protocol) {
  const fixture = retainOperationAtPhase(protocol, 'failed');
  fixture.controller.failRelease = false;
  const released = protocol.ensureCutover({
    repo: fixture.repo,
    processProbe: () => ({ status: 'dead' }),
    gitRunner: fixture.runner,
  });
  assert.equal(released.status, 'ready', JSON.stringify(released));
  for (const attempt of [2, 3]) {
    const error = captureError(() => protocol.restoreMutation({
      repo: fixture.repo,
      ownerToken: fixture.ownerToken,
      gitRunner: fixture.runner,
    }));
    assert.match(error.message, /restore attempt failed|restore failure|RESTORE_FAILED/u);
    const state = protocol.__testing.inspectProtocol({ repo: fixture.repo });
    assert.equal(state.selectedRecord.phase, 'recovery-attempt');
    assert.equal(state.selectedRecord.attempt_state, 'failed');
    assert.equal(state.selectedRecord.restore_attempts, attempt);
    assert.equal(state.publication.operation, null);
  }
  return fixture;
}

function assertProtocolIdle(inspection) {
  assert.equal(inspection.status, 'ready');
  assert.equal(inspection.publication.cutover_phase, 'ready');
  assert.equal(inspection.publication.session, null);
  assert.equal(inspection.publication.operation, null);
  assert.equal(inspection.slots.length, 2);
  assert.equal(inspection.fence_inventory.entries, 3);
}

function exactLifecycleReceipt(protocol, repo, target, unrelated) {
  const snapshot = protocolSnapshot(repo);
  const ref = snapshot.ref;
  assert.ok(ref);
  const inspection = protocol.__testing.inspectProtocol({ repo });
  assert.equal(inspection.publication_oid, ref.oid);
  assert.deepEqual(
    protocol.__testing.decodePublication(ref.bytes),
    inspection.publication,
  );
  const slots = {};
  for (const slot of inspection.slots) {
    const file = join(repo, v3SlotRelative(slot.slot));
    const bytes = readFileSync(file);
    assert.equal(snapshot.files[basename(file)], bytes.toString('base64'));
    if (slot.record) {
      assert.deepEqual(protocol.__testing.decodeRecord(bytes), slot.record);
    }
    slots[slot.slot] = Object.freeze({
      bytes: bytes.toString('base64'),
      record: slot.record === null ? null : structuredClone(slot.record),
      identity: structuredClone(slot.identity),
    });
  }
  let lease = null;
  if (inspection.publication.session) {
    assert.ok(inspection.selectedRecord);
    lease = sessionLease(inspection.selectedRecord);
    assert.equal(inspection.publication.session.lease_id, lease);
  }
  const targetStage = stageEntry(repo, target).toString('base64');
  const unrelatedStage = unrelated ? stageEntry(repo, unrelated).toString('base64') : null;
  return Object.freeze({
    refOid: ref.oid,
    refBytes: ref.bytes.toString('base64'),
    publication: structuredClone(inspection.publication),
    selectedRecord: inspection.selectedRecord === null
      ? null
      : structuredClone(inspection.selectedRecord),
    slots: Object.freeze(slots),
    lease,
    index: snapshot.index,
    staged: snapshot.staged,
    targetStage,
    unrelatedStage,
  });
}

function projectedAuthorityReceipt(protocol, base, oid, bytes) {
  const publication = protocol.__testing.decodePublication(bytes);
  const selectedRecord = publication.session === null
    ? null
    : base.slots[publication.selected_slot].record;
  assert.equal(publication.session === null, selectedRecord === null);
  return Object.freeze({
    ...base,
    refOid: oid,
    refBytes: bytes.toString('base64'),
    publication,
    selectedRecord,
    lease: selectedRecord === null ? null : sessionLease(selectedRecord),
  });
}

function recoveryAuthorityPhase(protocol, repo, transaction) {
  if (!transaction) return null;
  const bytes = gitResult(repo, ['cat-file', 'blob', transaction.newOid]).stdout;
  const publication = protocol.__testing.decodePublication(bytes);
  if (publication.session?.phase === 'recovery-attempt') return 'attempt-cas';
  if (publication.session?.phase === 'aborted' || publication.session?.phase === 'restored') {
    return 'terminal-cas';
  }
  if (publication.session === null && publication.operation !== null) return 'session-release';
  if (publication.session === null && publication.operation === null) return 'operation-release';
  return 'operation-acquire';
}

// Group 1: Git floor and complete capability preflight.
test('[group 1] Git floor, transaction-control, reflog-list, and HEAD-only capability are fail-closed', async (t) => {
  const { __testing } = await loadProtocol();
  for (const version of ['git version 2.27.0\n', 'git version 2.44.9\n']) {
    const repo = createGitFixture(`group-1-floor-${version.match(/[0-9.]+/u)[0].replaceAll('.', '-')}`);
    const before = protocolSnapshot(repo);
    const calls = [];
    assert.throws(() => __testing.preflightRepository({
      repo,
      gitRunner(gitRepo, args, options) {
        calls.push({ gitRepo, args: [...args], env: options.env });
        if (args[0] === '--version') {
          return { code: 0, stdout: Buffer.from(version), stderr: Buffer.alloc(0) };
        }
        assert.fail(`Git ${version.trim()} reached post-floor command: ${args.join(' ')}`);
      },
    }), /git-floor-unavailable/u);
    assert.equal(calls.length, 1);
    assertSnapshotEqual(before, protocolSnapshot(repo));
  }
  assert.deepEqual(__testing.parseGitVersion('git version 2.45.0'), [2, 45, 0]);
  assert.deepEqual(__testing.parseGitVersion('git version 2.50.1 (Vendor Git-1)'), [2, 50, 1]);
  assert.deepEqual(__testing.parseGitVersion('git version 2.50.1.windows.1'), [2, 50, 1]);
  assert.throws(() => __testing.requireGitFloor('git version 2.44.9'), /git-floor-unavailable/u);
  assert.throws(() => __testing.parseGitVersion('git version unknown'), /git version/u);

  const accepted = __testing.parseReflogList(Buffer.from('HEAD\nrefs/heads/main\n'), {
    checkRef: (name, allowOneLevel) => name === 'HEAD' ? allowOneLevel : !allowOneLevel,
  });
  assert.deepEqual(accepted, []);
  for (const name of ['FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'head', 'token']) {
    assert.throws(
      () => __testing.parseReflogList(Buffer.from(`${name}\n`), { checkRef: () => true }),
      /invalid reflog name/u,
    );
  }
  assert.throws(() => __testing.parseReflogList(Buffer.from('HEAD'), { checkRef: () => true }), /unterminated/u);
  assert.throws(() => __testing.parseReflogList(Buffer.from('HEAD\nHEAD\n'), { checkRef: () => true }), /duplicate/u);
  assert.throws(() => __testing.parseReflogList(Buffer.from('HEAD\r\n'), { checkRef: () => true }), /CR/u);
  assert.throws(() => __testing.parseReflogList(Buffer.from('HEAD\0\n'), { checkRef: () => true }), /NUL/u);

  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-1-real-git');
  const before = protocolSnapshot(repo);
  const checkRefCalls = [];
  const result = __testing.preflightRepository({
    repo,
    gitRunner(gitRepo, args, options) {
      if (args[0] === 'check-ref-format') checkRefCalls.push([...args]);
      return gitResult(gitRepo, args, options);
    },
  });
  assert.equal(result.gitVersion[0] >= 2, true);
  assert.equal(
    checkRefCalls.filter((args) => args.includes('--allow-onelevel')).every(
      (args) => args.length === 3 && args[2] === 'HEAD',
    ),
    true,
  );
  assertSnapshotEqual(before, protocolSnapshot(repo));

  const capabilityFailures = [
    ['transaction-control', (args) => args.includes('update-ref') && args.includes('--stdin')],
    ['for-each-ref', (args) => args[0] === 'for-each-ref'],
    ['reflog-list', (args) => args[0] === 'reflog' && args[1] === 'list'],
    ['reflog-exists', (args) => args[0] === 'reflog' && args[1] === 'exists'],
  ];
  for (const [label, shouldFail] of capabilityFailures) {
    const failureRepo = createGitFixture(`group-1-missing-${label}`);
    const failureBefore = protocolSnapshot(failureRepo);
    assert.throws(() => __testing.preflightRepository({
      repo: failureRepo,
      gitRunner(gitRepo, args, options) {
        if (shouldFail(args)) {
          return {
            code: 129,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(`missing ${label}\n`),
          };
        }
        return gitResult(gitRepo, args, options);
      },
    }), /capability|inventory|existence|Git command|missing/u);
    assertSnapshotEqual(failureBefore, protocolSnapshot(failureRepo), label);
  }
});

// Group 2: physical topology, environment sanitization, malformed inventory.
test('[group 2] repository topology and every inherited GIT_* spelling are sanitized before Git', async (t) => {
  const { __testing, ensureCutover } = await loadProtocol();
  const sanitized = __testing.sanitizeGitEnvironment({
    PATH: process.env.PATH,
    GIT_DIR: '/foreign',
    git_work_tree: '/foreign-worktree',
    GiT_InDeX_fIlE: '/foreign-index',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/foreign-hooks',
    KEEP_ME: 'yes',
  });
  assert.equal(sanitized.KEEP_ME, 'yes');
  assert.equal(sanitized.GIT_TERMINAL_PROMPT, '0');
  assert.equal(sanitized.LC_ALL, 'C');
  assert.equal(
    Object.keys(sanitized)
      .filter((key) => key !== 'GIT_TERMINAL_PROMPT')
      .some((key) => /^git_/iu.test(key)),
    false,
  );
  const poisonFamilies = {
    GIT_COMMON_DIR: '/foreign-common',
    GIT_OBJECT_DIRECTORY: '/foreign-objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/foreign-alternates',
    GIT_NAMESPACE: 'foreign',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/foreign-hooks',
    git_config_key_1: 'core.worktree',
    GiT_cOnFiG_vAlUe_1: '/foreign-worktree',
  };
  const fullySanitized = __testing.sanitizeGitEnvironment(poisonFamilies);
  assert.deepEqual(
    Object.keys(fullySanitized).filter((key) => /^git_/iu.test(key)),
    ['GIT_TERMINAL_PROMPT'],
  );
  const overCapList = Buffer.from(
    Array.from({ length: 50_000 }, (_, index) => `refs/heads/reflog-${index.toString().padStart(5, '0')}`).join('\n') + '\n',
  );
  assert.equal(overCapList.length > 1_048_576, true);
  assert.throws(
    () => __testing.parseReflogList(overCapList, { checkRef: () => true }),
    /cap|size|large/u,
  );

  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const target = createGitFixture('group-2-target');
  const foreign = createGitFixture('group-2-foreign');
  const targetBefore = protocolSnapshot(target);
  const foreignBefore = protocolSnapshot(foreign);
  const result = ensureCutover({
    repo: target,
    env: {
      ...process.env,
      GIT_DIR: join(foreign, '.git'),
      GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: indexPath(foreign),
    },
  });
  assert.equal(result.status, 'ready');
  assertSnapshotEqual(foreignBefore, protocolSnapshot(foreign), 'foreign repository was redirected');
  assert.notDeepEqual(protocolSnapshot(target), targetBefore);

  for (const [label, replacement] of [
    ['bare', (args) => args[0] === 'rev-parse' && args[1] === '--is-bare-repository'
      ? Buffer.from('true\n') : null],
    ['no-worktree', (args) => args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree'
      ? Buffer.from('false\n') : null],
    ['foreign-index', (args) => args.includes('--git-path') && args.at(-1) === 'index'
      ? Buffer.from(`${indexPath(foreign)}\n`) : null],
  ]) {
    const topologyRepo = createGitFixture(`group-2-${label}`);
    const topologyBefore = protocolSnapshot(topologyRepo);
    assert.throws(() => __testing.preflightRepository({
      repo: topologyRepo,
      gitRunner(gitRepo, args, options) {
        const output = replacement(args);
        return output === null
          ? gitResult(gitRepo, args, options)
          : { code: 0, stdout: output, stderr: Buffer.alloc(0) };
      },
    }), /bare|worktree|index|topology/u);
    assertSnapshotEqual(topologyBefore, protocolSnapshot(topologyRepo));
  }

  const zero = createGitFixture('group-2-zero-commit', { initialCommit: false });
  assert.equal(existsSync(indexPath(zero)), false);
  const zeroBefore = protocolSnapshot(zero);
  assert.equal(ensureCutover({ repo: zero }).status, 'ready');
  assert.notDeepEqual(protocolSnapshot(zero), zeroBefore);

  const equivalentRepo = createGitFixture('group-2-equivalent-index-spelling');
  const nativeIndex = indexPath(equivalentRepo);
  const equivalentIndex = process.platform === 'win32'
    ? nativeIndex.replaceAll('\\', '/')
    : `${dirname(nativeIndex)}/./${basename(nativeIndex)}`;
  const equivalent = __testing.preflightRepository({
    repo: equivalentRepo,
    gitRunner(gitRepo, args, options) {
      if (args.includes('--git-path') && args.at(-1) === 'index') {
        return {
          code: 0,
          stdout: Buffer.from(`${equivalentIndex}\n`),
          stderr: Buffer.alloc(0),
        };
      }
      return gitResult(gitRepo, args, options);
    },
  });
  assert.equal(equivalent.indexPath, join(equivalent.gitDirectory, 'index'));
});

// Group 3: legacy quiescence and byte-identical refusal.
test('[group 3] every legacy or unknown same-prefix topology is a byte-identical legacy-not-quiescent refusal', async (t) => {
  const { ensureCutover } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const fixtures = [
    ['.pending-mutation.json', 'legacy-state\n'],
    ['.mutation.operation.reserve', 'legacy-reservation\n'],
    ['.pending-mutation.completed-old', 'completion\n'],
    ['.mutation.lock.quarantine-old/owner.json', 'quarantine\n'],
    ['.mutation.artifact.capture-old/artifact', 'capture\n'],
    ['.mutation.artifact.retiring-old', 'retiring\n'],
    ['.mutation.operation.reserve.unknown', 'unknown\n'],
    ['.mutation.lock.completed-old/owner.json', 'completion\n'],
    ['.mutation.lock.only/owner.json', 'lock-only\n'],
    ['.pending-mutation.v3.unknown.json', 'unknown-v3\n'],
  ];
  for (const [relative, bytes] of fixtures) {
    const repo = createGitFixture(`group-3-${relative.replace(/[^a-z]/giu, '-')}`);
    writeRepoFile(repo, `.deep-review/${relative}`, bytes);
    const before = protocolSnapshot(repo);
    const result = ensureCutover({ repo });
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, 'legacy-not-quiescent');
    assertSnapshotEqual(before, protocolSnapshot(repo), relative);
  }

  const symlinkRepo = createGitFixture('group-3-legacy-symlink');
  try {
    const symlinkTarget = join(fixtureRootFor(symlinkRepo), 'legacy-review-target');
    mkdirSync(symlinkTarget);
    writeFileSync(join(symlinkTarget, '.pending-mutation.json'), 'legacy-through-link\n');
    const reviewPath = join(symlinkRepo, '.deep-review');
    symlinkSync(symlinkTarget, reviewPath);
    const before = protocolSnapshot(symlinkRepo);
    const result = ensureCutover({ repo: symlinkRepo });
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, 'legacy-not-quiescent');
    assertSnapshotEqual(before, protocolSnapshot(symlinkRepo));
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    capabilitySkip(t, 'fs-symlink-privilege-unavailable');
  }
});

// Group 4: fixed fences and old-writer exclusion.
test('[group 4] cutover creates exact bounded Node and Bash fences and retries without growth', async (t) => {
  const { ensureCutover, __testing } = await loadProtocol();
  assert.equal(oldCandidateV2Source.length, 79_169);
  assert.equal(sha256(oldCandidateV2Source), oldCandidateV2Sha256);
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-4-fences');
  assert.equal(ensureCutover({ repo }).status, 'ready');
  const first = __testing.inspectProtocol({ repo });
  assertProtocolIdle(first);
  assert.deepEqual(protocolFiles(repo), [
    '.mutation.lock',
    '.mutation.operation.reserve',
    '.pending-mutation.v3.a.json',
    '.pending-mutation.v3.b.json',
  ]);
  assert.equal(readdirSync(join(repo, legacyLockRelative)).join(','), 'v3-cutover-fence');
  assert.ok(readFileSync(join(repo, legacyReservationRelative)).length <= 4096);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(join(repo, legacyReservationRelative)).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(repo, legacyLockRelative)).mode & 0o777, 0o700);
    assert.equal(
      lstatSync(join(repo, legacyLockRelative, 'v3-cutover-fence')).mode & 0o777,
      0o600,
    );
  }
  assert.equal(__testing.platformMetadataTag('file', 'win32'), 'win32-file-rw');
  assert.equal(__testing.platformMetadataTag('directory', 'win32'), 'win32-dir-marker-owned');
  assert.equal(__testing.platformMetadataTag('file', 'linux'), 'posix-file-0600');
  assert.equal(__testing.platformMetadataTag('directory', 'darwin'), 'posix-dir-0700');

  const target = 'legacy-fence-target.txt';
  writeRepoFile(repo, target);
  const fenced = protocolSnapshot(repo);
  assert.equal(sha256(Buffer.from(legacyNodeFenceProbe)), legacyNodeFenceProbeSha256);
  const oldNode = spawnSync(process.execPath, ['-e', legacyNodeFenceProbe, repo], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(oldNode.status, 23, oldNode.stderr);
  assertSnapshotEqual(fenced, protocolSnapshot(repo), 'legacy Node probe crossed v3 fence');
  await t.test('real local Bash old writer is excluded after ready', (bashTest) => {
    const bashVersion = spawnSync('bash', ['--version'], { encoding: 'utf8', shell: false });
    if (process.platform === 'win32' || bashVersion.error?.code === 'ENOENT') {
      capabilitySkip(bashTest, 'bash-unavailable');
      return;
    }
    const oldBash = spawnSync(
      'bash',
      [
        '-c',
        'cd "$1" && source "$2" && perform_mutation "$3"',
        'legacy-bash',
        repo,
        join(pluginRoot, 'hooks', 'scripts', 'mutation-protocol.sh'),
        target,
      ],
      { encoding: 'utf8', shell: false },
    );
    assert.notEqual(oldBash.status, 0, oldBash.stderr);
    assertSnapshotEqual(fenced, protocolSnapshot(repo), 'legacy Bash crossed v3 fence');
  });
  const before = protocolSnapshot(repo);
  assert.equal(ensureCutover({ repo }).status, 'ready');
  assertSnapshotEqual(before, protocolSnapshot(repo));

  const oldWins = createGitFixture('group-4-old-v2-wins-fresh');
  const oldWinsTarget = 'src/old-v2-wins.txt';
  writeRepoFile(oldWins, oldWinsTarget);
  const oldPerform = runOldCandidateV2(oldWins, 'perform', oldWinsTarget);
  assert.equal(oldPerform.status, 0, oldPerform.stderr);
  assert.equal(JSON.parse(oldPerform.stdout).status, 'committed');
  assert.equal(stageEntry(oldWins, oldWinsTarget).length > 0, true);
  const oldAuthority = protocolSnapshot(oldWins);
  assert.deepEqual(ensureCutover({ repo: oldWins }), {
    status: 'manual',
    reason: 'legacy-not-quiescent',
  });
  assertSnapshotEqual(oldAuthority, protocolSnapshot(oldWins));
  const oldRestore = runOldCandidateV2(oldWins, 'restore', oldWinsTarget);
  assert.equal(oldRestore.status, 0, oldRestore.stderr);
  assert.equal(stageEntry(oldWins, oldWinsTarget).length, 0);

  for (const barrier of [
    'node-fence-created',
    'bash-directory-created',
    'bash-marker-created',
    'fence-inventory-bound',
  ]) {
    const raceRepo = createGitFixture(`group-4-old-node-${barrier}`);
    const raceTarget = 'src/old-node-race.txt';
    writeRepoFile(raceRepo, raceTarget);
    let oldResult;
    const newResult = ensureCutover({
      repo: raceRepo,
      fenceHook(label) {
        if (label === barrier) oldResult = runOldCandidateV2(raceRepo, 'perform', raceTarget);
      },
    });
    assert.equal(oldResult.status, 1, `${barrier}: ${oldResult.stderr}`);
    assert.equal(newResult.status, 'ready');
    assert.equal(stageEntry(raceRepo, raceTarget).length, 0);
    assertProtocolIdle(__testing.inspectProtocol({ repo: raceRepo }));
  }

  for (const barrier of [
    'node-fence-created',
    'bash-directory-created',
    'bash-marker-created',
    'fence-inventory-bound',
  ]) {
    const barrierRepo = createGitFixture(`group-4-${barrier}`);
    assert.throws(() => ensureCutover({
      repo: barrierRepo,
      fenceHook(label) {
        if (label === barrier) throw new Error(`crash at ${barrier}`);
      },
    }), new RegExp(`crash at ${barrier}`, 'u'));
    const residue = protocolSnapshot(barrierRepo);
    const retry = ensureCutover({ repo: barrierRepo });
    if (barrier === 'bash-directory-created') {
      assert.equal(retry.status, 'manual');
      assert.equal(retry.reason, 'legacy-not-quiescent');
      assertSnapshotEqual(residue, protocolSnapshot(barrierRepo));
    } else {
      assert.equal(retry.status, 'ready');
      assertProtocolIdle(__testing.inspectProtocol({ repo: barrierRepo }));
    }
  }

  const driftRepo = createGitFixture('group-4-inventory-drift');
  assert.equal(ensureCutover({ repo: driftRepo }).status, 'ready');
  writeFileSync(join(driftRepo, legacyLockRelative, 'v3-cutover-fence'), 'drift\n');
  const driftBefore = protocolSnapshot(driftRepo);
  const drift = ensureCutover({ repo: driftRepo });
  assert.equal(drift.status, 'manual');
  assert.equal(drift.reason, 'legacy-not-quiescent');
  assertSnapshotEqual(driftBefore, protocolSnapshot(driftRepo));
});

// Group 5: API and framed-stdin caps.
test('[group 5] scalar, target, record, and framed-stdin boundaries refuse before mutation', async () => {
  const { performMutation, __testing } = await loadProtocol();
  const repo = createGitFixture('group-5-caps');
  const target = 'src/cap.txt';
  writeRepoFile(repo, target);
  const before = protocolSnapshot(repo);
  assert.throws(
    () => performMutation({ repo, files: [target], ownerToken: `${'é'.repeat(128)}x` }),
    /owner token.*256/u,
  );
  assert.throws(
    () => performMutation({ repo, files: Array.from({ length: 257 }, (_, index) => `x/${index}.txt`) }),
    /target.*256/u,
  );
  assert.throws(
    () => performMutation({ repo, files: [`${'x'.repeat(4097)}.txt`] }),
    /path.*4096/u,
  );
  assertSnapshotEqual(before, protocolSnapshot(repo));

  const exactRepo = createGitFixture('group-5-exact-api');
  const exactTargets = Array.from({ length: 256 }, (_, index) => `targets/${index.toString().padStart(3, '0')}.txt`);
  for (const file of exactTargets) writeRepoFile(exactRepo, file);
  const exactToken = 'é'.repeat(128);
  assert.equal(Buffer.byteLength(exactToken), 256);
  const exactPerformed = performMutation({
    repo: exactRepo,
    files: exactTargets,
    ownerToken: exactToken,
  });
  assert.equal(exactPerformed.status, 'committed');
  assert.equal(exactPerformed.files.length, 256);

  const exactPath = `p/${'\\'.repeat(4094)}`;
  assert.equal(Buffer.byteLength(exactPath), 4096);
  const pathBoundaryBefore = protocolSnapshot(repo);
  const boundaryError = captureError(() => performMutation({
    repo,
    files: [exactPath],
    platform: 'linux',
  }));
  assert.doesNotMatch(boundaryError.message, /exceeds 4096/u);
  assertSnapshotEqual(pathBoundaryBefore, protocolSnapshot(repo));

  const exactRecord = exactRecordAtByteCap(__testing);
  assert.equal(exactRecord.bytes.at(-1), 0x0a);
  const capPlusFiles = [...exactRecord.input.files];
  const expandable = capPlusFiles.findIndex((file) => Buffer.byteLength(file) < 4096);
  assert.notEqual(expandable, -1);
  capPlusFiles[expandable] += 'x';
  const capPlusRecord = __testing.buildRecord({ ...exactRecord.input, files: capPlusFiles });
  assert.throws(() => __testing.encodeRecord(capPlusRecord), /record exceeds slot byte cap/u);

  const valid = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'ensure-cutover',
    repo,
    owner_token: null,
    files: [],
  });
  const parsed = parseCliOutput(spawnFramed(valid));
  assert.equal(parsed.ok, true);
  const exactCliPath = `q/${'x'.repeat(4094)}`;
  const exactCli = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'scan-sensitive',
    repo: pluginRoot,
    owner_token: null,
    files: [exactCliPath],
  });
  assert.equal(parseCliOutput(spawnFramed(exactCli)).ok, true);
  assert.throws(() => __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'scan-sensitive',
    repo: pluginRoot,
    owner_token: null,
    files: [`q/${'x'.repeat(4095)}`],
  }), /path.*4096/u);
  assert.doesNotThrow(() => __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'ensure-cutover',
    repo: 'r'.repeat(131_072),
    owner_token: null,
    files: [],
  }));
  assert.throws(() => __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'ensure-cutover',
    repo: 'r'.repeat(131_073),
    owner_token: null,
    files: [],
  }), /repo.*cap|repo.*131072/u);
  const validPayload = valid.subarray(valid.indexOf(0x0a) + 1);
  const alternatePayload = Buffer.from(` ${validPayload.toString('utf8').trim()}\n`);
  const alternateFrame = Buffer.concat([
    Buffer.from(`deep-review-mutation-v3 ${alternatePayload.length} ${sha256(alternatePayload)}\n`),
    alternatePayload,
  ]);
  for (const corrupt of [
    Buffer.concat([valid, Buffer.from('x')]),
    valid.subarray(0, valid.length - 1),
    Buffer.from(valid.toString('utf8').replace(/[0-9a-f]{64}/u, '0'.repeat(64))),
    Buffer.from(`deep-review-mutation-v3 99999999 ${'0'.repeat(64)}\n{}\n`),
    alternateFrame,
    Buffer.concat([Buffer.alloc(129, 0x61), Buffer.from('\n')]),
    Buffer.alloc(1_310_850, 0x61),
  ]) {
    const result = parseCliOutput(spawnFramed(corrupt));
    assert.equal(result.ok, false);
  }
});

// Group 6: exact finite codecs, null-peer exception, and sequence ceiling.
test('[group 6] canonical record/publication codecs pin golden bytes, semantics, and uint32 exhaustion', async (t) => {
  const { __testing } = await loadProtocol();
  const built = __testing.buildRecord(makeBootstrapRecord());
  assert.equal(__testing.recordCoreBytes(built).toString('utf8'), `${JSON.stringify({
    schema_version: 3,
    slot: 'a',
    phase: 'cutover-anchor',
    cutover_id: '1'.repeat(64),
    session_id: null,
    record_seq: '0',
    owner_token: null,
    owner_process: { host_hash: null, pid: null, process_start_ms: null },
    started_at: null,
    commit_hash: null,
    restore_attempts: 0,
    recovery_kind: null,
    attempt_state: null,
    files: [],
    fence_inventory: { sha256: '2'.repeat(64), entries: 3, bytes: 128 },
    self_slot_identity: { dev: '1', ino: '2' },
    peer_slot_identity: null,
  })}\n`);
  assert.equal(built.record_digest, '8e09a9b2e56edfbf15ebe02b287c43b8e09bfedd157091a9fe712dd0fc182823');
  const bytes = __testing.encodeRecord(built);
  assert.deepEqual(__testing.decodeRecord(bytes, { transition: 'initial-a' }), built);

  const wrongSlot = __testing.buildRecord({ ...makeBootstrapRecord(), slot: 'b' });
  assert.equal(wrongSlot.record_digest, 'f6695de1a70f08f26b2442b7bc08ca19bde8b68ab973f434c63d5dcb2e79cbee');
  assert.throws(() => __testing.decodeRecord(__testing.encodeRecord(wrongSlot), { transition: 'initial-a' }), /null peer/u);
  assert.throws(
    () => __testing.buildRecord({ ...makeBootstrapRecord(), record_seq: '4294967296' }),
    /record sequence/u,
  );
  const max = __testing.buildRecord({ ...makeBootstrapRecord(), record_seq: '4294967295' });
  assert.equal(max.record_seq, '4294967295');

  const activeGolden = __testing.buildRecord(makeActiveRecord('prepared'));
  assert.equal(activeGolden.record_digest, '999fd5ce24251df92abbe9f1918958c208936ea149d050b0d22598b568a7b323');
  assert.equal(sessionLease(activeGolden), 'ca30d616fa19f6b3b2554c75af73844573af32c2603d845ecae33295b5f86963');
  assert.equal(__testing.encodeRecord(activeGolden).at(-1), 0x0a);

  const phaseRows = [
    makeActiveRecord('prepared'),
    makeActiveRecord('committed'),
    ...['abort-prepared', 'restore-committed'].flatMap((recoveryKind) => (
      ['pending', 'failed'].flatMap((attemptState) => [1, 3].map((attempt) => makeActiveRecord(
        'recovery-attempt',
        {
          restore_attempts: attempt,
          recovery_kind: recoveryKind,
          attempt_state: attemptState,
        },
      )))
    )),
    makeActiveRecord('restored', { restore_attempts: 1 }),
    makeActiveRecord('restored', { restore_attempts: 3 }),
    makeActiveRecord('aborted', {
      restore_attempts: 0,
      recovery_kind: null,
      attempt_state: null,
    }),
    makeActiveRecord('aborted', { restore_attempts: 1 }),
    makeActiveRecord('aborted', { restore_attempts: 3 }),
  ];
  for (const row of phaseRows) {
    const canonical = __testing.buildRecord(row);
    assert.doesNotThrow(() => __testing.validateRecordSemantics(canonical));
    assert.deepEqual(__testing.decodeRecord(__testing.encodeRecord(canonical)), canonical);
    let invalid;
    if (row.phase === 'prepared' || row.phase === 'committed') {
      invalid = __testing.buildRecord({ ...row, restore_attempts: 1 });
    } else if (row.phase === 'recovery-attempt') {
      invalid = __testing.buildRecord({ ...row, attempt_state: null });
    } else if (row.phase === 'restored') {
      invalid = __testing.buildRecord({ ...row, recovery_kind: 'abort-prepared' });
    } else {
      invalid = __testing.buildRecord({ ...row, attempt_state: 'pending' });
    }
    assert.throws(() => __testing.validateRecordSemantics(invalid), /semantics|invalid/u);
    const nullPeer = __testing.buildRecord({ ...row, peer_slot_identity: null });
    assert.throws(() => __testing.decodeRecord(__testing.encodeRecord(nullPeer)), /null peer/u);
  }

  const readyPublication = __testing.buildPublication({
    publication_schema: 1,
    protocol: 'deep-review-mutation-v3',
    cutover_id: '1'.repeat(64),
    publication_seq: '0',
    cutover_phase: 'ready',
    selected_slot: null,
    selected_record_seq: null,
    selected_record_digest: null,
    session: null,
    operation: null,
    fence_inventory_sha256: '2'.repeat(64),
  });
  assert.deepEqual(
    __testing.decodePublication(__testing.encodePublication(readyPublication)),
    readyPublication,
  );
  assert.equal(
    __testing.publicationCoreBytes(readyPublication).toString('utf8'),
    `${JSON.stringify({
      publication_schema: 1,
      protocol: 'deep-review-mutation-v3',
      cutover_id: '1'.repeat(64),
      publication_seq: '0',
      cutover_phase: 'ready',
      selected_slot: null,
      selected_record_seq: null,
      selected_record_digest: null,
      session: null,
      operation: null,
      fence_inventory_sha256: '2'.repeat(64),
    })}\n`,
  );
  assert.equal(readyPublication.publication_digest, '2ad0887306a16e048b61036ffb38b34d712acb7927889f70040686a65e1c18f6');
  assert.equal(__testing.encodePublication(readyPublication).at(-1), 0x0a);
  assert.equal(__testing.buildPublication({
    ...readyPublication,
    cutover_phase: 'slot-b',
  }).operation, null);
  assert.throws(() => __testing.buildPublication({
    ...readyPublication,
    operation: {
      operation_id: '00000000-0000-4000-8000-000000000004',
      host_hash: '3'.repeat(64),
      pid: '1',
      process_start_ms: '1',
      base_publication_oid: null,
    },
  }), /base publication OID|fresh cutover/u);

  const insertionOrders = [
    built,
    Object.fromEntries(Object.entries(built).reverse()),
    Object.fromEntries(Object.entries(built).sort(() => 0.5 - 0.25)),
  ];
  assert.equal(new Set(insertionOrders.map((record) => __testing.encodeRecord(record).toString('hex'))).size, 1);
  assert.throws(() => __testing.decodeRecord(Buffer.concat([bytes, Buffer.from('\n')])), /canonical/u);

  const maxActive = __testing.buildRecord(makeActiveRecord('committed', {
    record_seq: '4294967295',
  }));
  const maxLease = sessionLease(maxActive);
  const maxBinding = __testing.buildPublication({
    ...readyPublication,
    publication_seq: '4294967295',
    selected_slot: 'a',
    selected_record_seq: maxActive.record_seq,
    selected_record_digest: maxActive.record_digest,
    session: {
      session_id: maxActive.session_id,
      phase: maxActive.phase,
      record_seq: maxActive.record_seq,
      record_digest: maxActive.record_digest,
      lease_id: maxLease,
    },
  });
  assert.equal(maxBinding.session.record_seq, '4294967295');
  assert.throws(() => __testing.buildPublication({
    ...maxBinding,
    publication_digest: undefined,
    selected_record_seq: '4294967296',
    session: { ...maxBinding.session, record_seq: '4294967296' },
  }), /record sequence/u);
  assert.throws(() => __testing.buildPublication({
    ...maxBinding,
    publication_digest: undefined,
    session: { ...maxBinding.session, lease_id: '0'.repeat(64) },
  }), /lease/u);

  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const positiveRepo = createGitFixture('group-6-max-minus-eight');
  const positiveTarget = 'src/max-minus-eight.txt';
  writeRepoFile(positiveRepo, positiveTarget);
  const positive = (await loadProtocol());
  const positivePerformed = positive.performMutation({ repo: positiveRepo, files: [positiveTarget] });
  rewriteSelectedRecordSequence(positiveRepo, positive, '4294967285');
  assert.equal(positive.restoreMutation({
    repo: positiveRepo,
    ownerToken: positivePerformed.owner_token,
  }).status, 'restored');
  assert.equal(positive.performMutation({ repo: positiveRepo, files: [positiveTarget] }).status, 'committed');

  const exhaustedRepo = createGitFixture('group-6-max-minus-seven');
  const exhaustedTarget = 'src/max-minus-seven.txt';
  writeRepoFile(exhaustedRepo, exhaustedTarget);
  const exhaustedPerformed = positive.performMutation({ repo: exhaustedRepo, files: [exhaustedTarget] });
  rewriteSelectedRecordSequence(exhaustedRepo, positive, '4294967286');
  assert.equal(positive.restoreMutation({
    repo: exhaustedRepo,
    ownerToken: exhaustedPerformed.owner_token,
  }).status, 'restored');
  const exhaustedBefore = protocolSnapshot(exhaustedRepo);
  const exhaustedObjects = gitObjectInventory(exhaustedRepo);
  assert.throws(() => positive.performMutation({
    repo: exhaustedRepo,
    files: [exhaustedTarget],
  }), /record-sequence-exhausted/u);
  assertSnapshotEqual(exhaustedBefore, protocolSnapshot(exhaustedRepo));
  assert.deepEqual(gitObjectInventory(exhaustedRepo), exhaustedObjects);
});

// Group 7: restartable cutover, fixed footprint, and readiness preservation.
test('[group 7] restartable cutover and 100 perform/restore cycles keep one ref, two slots, and three fence entries', async (t) => {
  const { ensureCutover, performMutation, restoreMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-7-cycles');
  const target = 'src/반복 cycle.txt';
  writeRepoFile(repo, target);
  assert.equal(ensureCutover({ repo }).status, 'ready');
  const cycleCount = Number(process.env.DEEP_REVIEW_TASK4_CYCLES || '100');
  for (let index = 0; index < cycleCount; index += 1) {
    const performed = performMutation({ repo, files: [target] });
    assert.equal(performed.status, 'committed');
    const middle = protocolSnapshot(repo);
    assert.equal(ensureCutover({ repo }).status, 'ready');
    assertSnapshotEqual(middle, protocolSnapshot(repo));
    const restored = restoreMutation({ repo, ownerToken: performed.owner_token });
    assert.equal(restored.status, 'restored');
  }
  const inspection = __testing.inspectProtocol({ repo });
  assertProtocolIdle(inspection);
  assert.equal(gitResult(repo, ['for-each-ref', '--format=%(refname)', publicationRef]).stdout.toString('utf8').trim(), publicationRef);
  assert.equal(protocolFiles(repo).length, 4);
  for (const slot of ['a', 'b']) assert.ok(lstatSync(join(repo, v3SlotRelative(slot))).size <= 1_048_576);
  assert.ok(readRefBlob(repo).bytes.length <= 8192);

  const restart = createGitFixture('group-7-cutover-restart');
  assert.throws(() => ensureCutover({
    repo: restart,
    cutoverHook(label) {
      if (label === 'mutual-a-written') throw new Error('injected mutual-A crash');
    },
  }), /mutual-A crash/u);
  assert.equal(ensureCutover({
    repo: restart,
    processProbe: () => ({ status: 'dead' }),
  }).status, 'ready');
  assertProtocolIdle(__testing.inspectProtocol({ repo: restart }));

  for (const barrier of [
    'authority-created',
    'slot-a-captured',
    'slot-b-captured',
    'mutual-a-written',
    'ready-published',
  ]) {
    const barrierRepo = createGitFixture(`group-7-${barrier}`);
    assert.throws(() => ensureCutover({
      repo: barrierRepo,
      cutoverHook(label) {
        if (label === barrier) throw new Error(`crash at ${barrier}`);
      },
    }), new RegExp(`crash at ${barrier}`, 'u'));
    assert.equal(ensureCutover({
      repo: barrierRepo,
      processProbe: () => ({ status: 'dead' }),
    }).status, 'ready');
    assertProtocolIdle(__testing.inspectProtocol({ repo: barrierRepo }));
  }

  const torn = createGitFixture('group-7-torn-inactive');
  const tornTarget = 'src/torn-recovery.txt';
  writeRepoFile(torn, tornTarget);
  const tornPerformed = performMutation({ repo: torn, files: [tornTarget] });
  const tornInspection = __testing.inspectProtocol({ repo: torn });
  const inactive = tornInspection.publication.selected_slot === 'a' ? 'b' : 'a';
  writeFileSync(join(torn, v3SlotRelative(inactive)), '{torn');
  assert.equal(
    restoreMutation({ repo: torn, ownerToken: tornPerformed.owner_token }).status,
    'restored',
  );
  assertProtocolIdle(__testing.inspectProtocol({ repo: torn }));

  const childRepo = createGitFixture('group-7-separate-process-readiness');
  const childTarget = 'src/separate-process.txt';
  writeRepoFile(childRepo, childTarget);
  const ensureRequest = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'ensure-cutover',
    repo: childRepo,
    owner_token: null,
    files: [],
  });
  assert.equal(parseCliOutput(spawnFramed(ensureRequest)).status, 'ready');
  const performRequest = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'perform',
    repo: childRepo,
    owner_token: null,
    files: [childTarget],
  });
  const childPerformed = parseCliOutput(spawnFramed(performRequest));
  assert.equal(childPerformed.status, 'committed');
  const childMiddle = protocolSnapshot(childRepo);
  assert.equal(parseCliOutput(spawnFramed(ensureRequest)).status, 'ready');
  assertSnapshotEqual(childMiddle, protocolSnapshot(childRepo));
  const restoreRequest = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'restore',
    repo: childRepo,
    owner_token: childPerformed.owner_token,
    files: [],
  });
  assert.equal(parseCliOutput(spawnFramed(restoreRequest)).status, 'restored');
  assertProtocolIdle(__testing.inspectProtocol({ repo: childRepo }));

  const departedRepo = createGitFixture('group-7-departed-session');
  const departedTarget = 'src/departed-session.txt';
  writeRepoFile(departedRepo, departedTarget);
  performMutation({ repo: departedRepo, files: [departedTarget] });
  assert.equal((await loadProtocol()).autoRecover({
    repo: departedRepo,
    now: Date.now() + 10_000_000,
    staleMs: 0,
    processProbe: () => ({ status: 'dead' }),
  }).status, 'restored');
  assertProtocolIdle(__testing.inspectProtocol({ repo: departedRepo }));
});

// Group 8: descriptor-bound slot write replacement.
test('[group 8] descriptor-bound slot writes never publish a raced pathname replacement', async (t) => {
  const { ensureCutover, performMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-8-slot-replacement');
  const target = 'src/replacement.txt';
  writeRepoFile(repo, target);
  ensureCutover({ repo });
  const beforeRef = readRefBlob(repo);
  let replacementPath;
  assert.throws(() => performMutation({
    repo,
    files: [target],
    slotWriteHook({ path: slotPath }) {
      if (replacementPath) return;
      replacementPath = `${slotPath}.old-for-test`;
      renameSync(slotPath, replacementPath);
      writeFileSync(slotPath, 'foreign-slot\n');
    },
  }), /slot.*replaced|identity/u);
  assert.equal(readFileSync(join(repo, v3SlotRelative('a')), 'utf8') === 'foreign-slot\n'
    || readFileSync(join(repo, v3SlotRelative('b')), 'utf8') === 'foreign-slot\n', true);
  const retainedAuthority = __testing.decodePublication(readRefBlob(repo).bytes);
  assert.equal(retainedAuthority.session, null);
  assert.equal(retainedAuthority.selected_slot, null);
  assert.ok(retainedAuthority.operation);
  assert.equal(retainedAuthority.operation.base_publication_oid, beforeRef.oid);
  assert.equal(stageEntry(repo, target).length, 0);

  for (const racedSlot of ['a', 'b']) {
    const racedRepo = createGitFixture(`group-8-exact-slot-${racedSlot}`);
    const racedTarget = `src/slot-${racedSlot}.txt`;
    writeRepoFile(racedRepo, racedTarget);
    ensureCutover({ repo: racedRepo });
    const initial = __testing.inspectProtocol({ repo: racedRepo });
    const initialSlot = initial.slots.find((slot) => slot.slot === racedSlot);
    const initialBytes = readFileSync(join(racedRepo, v3SlotRelative(racedSlot)));
    const publicBytes = Buffer.from(`foreign-slot-${racedSlot}\n`);
    let heldPath;
    assert.throws(() => performMutation({
      repo: racedRepo,
      files: [racedTarget],
      slotWriteHook({ path: candidatePath }) {
        if (basename(candidatePath) !== basename(v3SlotRelative(racedSlot)) || heldPath) return;
        heldPath = `${candidatePath}.held-old-inode`;
        renameSync(candidatePath, heldPath);
        writeFileSync(candidatePath, publicBytes);
      },
    }), /slot.*replaced|identity/u);
    assert.ok(heldPath, `slot ${racedSlot} barrier was not reached`);
    assert.deepEqual(readFileSync(join(racedRepo, v3SlotRelative(racedSlot))), publicBytes);
    assert.notDeepEqual(readFileSync(heldPath), initialBytes);
    const heldRecord = __testing.decodeRecord(readFileSync(heldPath));
    assert.equal(heldRecord.slot, racedSlot);
    assert.equal(heldRecord.self_slot_identity.dev, initialSlot.identity.dev);
    const after = JSON.parse(readRefBlob(racedRepo).bytes);
    assert.notEqual(after.selected_slot, racedSlot);
  }

  const releaseRepo = createGitFixture('group-8-primary-and-release');
  const releaseTarget = 'src/release-error.txt';
  writeRepoFile(releaseRepo, releaseTarget);
  ensureCutover({ repo: releaseRepo });
  let primaryRaised = false;
  const releaseRunner = (gitRepo, args, runnerOptions = {}) => {
    if (primaryRaised && args.includes('update-ref')) {
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('release failure\n') };
    }
    return gitResult(gitRepo, args, runnerOptions);
  };
  let combined;
  try {
    performMutation({
      repo: releaseRepo,
      files: [releaseTarget],
      gitRunner: releaseRunner,
      slotWriteHook() {
        primaryRaised = true;
        throw new Error('primary slot fault');
      },
    });
  } catch (error) {
    combined = error;
  }
  assert.match(combined?.message || '', /primary slot fault/u);
  assert.deepEqual(
    combined?.failures?.map((failure) => failure.stage),
    ['primary', 'operation-release'],
  );
  assert.match(combined.failures[1].message, /release/u);
});

// Group 9: surviving-slot self identity before peer repair.
test('[group 9] a byte-identical survivor replacement cannot authorize torn-peer repair', async (t) => {
  const { ensureCutover, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-9-survivor');
  ensureCutover({ repo });
  const inspection = __testing.inspectProtocol({ repo });
  const survivor = join(repo, v3SlotRelative('a'));
  replaceFileIdentity(survivor);
  writeFileSync(join(repo, v3SlotRelative('b')), '{torn');
  const before = protocolSnapshot(repo);
  const result = ensureCutover({ repo });
  assert.equal(result.status, 'manual');
  assert.match(result.reason, /slot|identity|binding/u);
  assertSnapshotEqual(before, protocolSnapshot(repo));
  assert.equal(inspection.publication.cutover_phase, 'ready');

  const selectedRepo = createGitFixture('group-9-selected-survivor');
  const selectedTarget = 'src/selected-survivor.txt';
  writeRepoFile(selectedRepo, selectedTarget);
  const selectedPerformed = (await loadProtocol()).performMutation({
    repo: selectedRepo,
    files: [selectedTarget],
  });
  const selectedInspection = __testing.inspectProtocol({ repo: selectedRepo });
  const selectedSlot = selectedInspection.publication.selected_slot;
  const otherSlot = selectedSlot === 'a' ? 'b' : 'a';
  const selectedPath = join(selectedRepo, v3SlotRelative(selectedSlot));
  replaceFileIdentity(selectedPath);
  writeFileSync(join(selectedRepo, v3SlotRelative(otherSlot)), '{torn');
  const selectedBefore = protocolSnapshot(selectedRepo);
  const selectedResult = ensureCutover({ repo: selectedRepo });
  assert.equal(selectedResult.status, 'manual');
  assertSnapshotEqual(selectedBefore, protocolSnapshot(selectedRepo));
  assert.equal(stageEntry(selectedRepo, selectedTarget).length > 0, true);
  assert.ok(selectedPerformed.owner_token);

  const repairRepo = createGitFixture('group-9-valid-inactive-repair');
  const repairTarget = 'src/inactive-repair.txt';
  writeRepoFile(repairRepo, repairTarget);
  ensureCutover({ repo: repairRepo });
  const repairBefore = __testing.inspectProtocol({ repo: repairRepo });
  const repairedIdentity = repairBefore.slots.find((slot) => slot.slot === 'a').identity;
  writeFileSync(join(repairRepo, v3SlotRelative('a')), '{torn');
  const repairProtocol = await loadProtocol();
  const repaired = repairProtocol.performMutation({ repo: repairRepo, files: [repairTarget] });
  const repairAfter = __testing.inspectProtocol({ repo: repairRepo });
  assert.deepEqual(repairAfter.slots.find((slot) => slot.slot === 'a').identity, repairedIdentity);
  assert.equal(repairAfter.slots.find((slot) => slot.slot === 'a').record.phase, 'prepared');
  assert.equal(repairProtocol.restoreMutation({
    repo: repairRepo,
    ownerToken: repaired.owner_token,
  }).status, 'restored');

  const bothTornRepo = createGitFixture('group-9-both-torn');
  ensureCutover({ repo: bothTornRepo });
  writeFileSync(join(bothTornRepo, v3SlotRelative('a')), '{torn-a');
  writeFileSync(join(bothTornRepo, v3SlotRelative('b')), '{torn-b');
  const bothBefore = protocolSnapshot(bothTornRepo);
  const both = ensureCutover({ repo: bothTornRepo });
  assert.equal(both.status, 'manual');
  assertSnapshotEqual(bothBefore, protocolSnapshot(bothTornRepo));
});

// Group 10: pre-index and under-operation recheck.
test('[group 10] index inspection refuses before cutover and raced entries release only the operation', async (t) => {
  const { ensureCutover, performMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-10-index');
  const target = 'src/indexed.txt';
  writeRepoFile(repo, target);
  git(repo, ['add', '--', target]);
  const before = protocolSnapshot(repo);
  assert.throws(() => performMutation({ repo, files: [target] }), /already.*index/u);
  assertSnapshotEqual(before, protocolSnapshot(repo));

  git(repo, ['reset', '--', target]);
  const cleanBefore = protocolSnapshot(repo);
  assert.throws(() => performMutation({
    repo,
    files: [target],
    underOperationHook() { git(repo, ['add', '--', target]); },
  }), /already.*index|raced/u);
  assert.equal(readRefBlob(repo)?.bytes.toString('utf8').includes('"operation":null'), true);
  assert.equal(stageEntry(repo, target).length > 0, true);
  assert.equal(cleanBefore.files['.pending-mutation.v3.a.json'] === undefined, true);

  const preparedRace = createGitFixture('group-10-prepared-race');
  const preparedTarget = 'src/prepared-race.txt';
  writeRepoFile(preparedRace, preparedTarget);
  const phases = [];
  assert.throws(() => performMutation({
    repo: preparedRace,
    files: [preparedTarget],
    transitionHook(phase) {
      phases.push(phase);
      if (phase === 'prepared') git(preparedRace, ['add', '--', preparedTarget]);
    },
  }), /already.*index|raced/u);
  assert.equal(stageEntry(preparedRace, preparedTarget).length > 0, true);
  assert.equal(phases.includes('aborted:direct:0'), true);
  assert.equal(phases.some((phase) => phase.startsWith('recovery-attempt:')), false);

  const reentrant = createGitFixture('group-10-reentrant');
  const reentrantTarget = 'src/reentrant.txt';
  writeRepoFile(reentrant, reentrantTarget);
  let nested;
  const outer = performMutation({
    repo: reentrant,
    files: [reentrantTarget],
    underOperationHook() {
      nested = ensureCutover({ repo: reentrant });
    },
  });
  assert.equal(outer.status, 'committed');
  assert.equal(nested.status, 'manual');
  assert.match(nested.reason, /operation|busy|live/u);

  const inspectionRepo = createGitFixture('group-10-inspection-error');
  const inspectionTarget = 'src/inspection-error.txt';
  writeRepoFile(inspectionRepo, inspectionTarget);
  const inspectionBefore = protocolSnapshot(inspectionRepo);
  assert.throws(() => performMutation({
    repo: inspectionRepo,
    files: [inspectionTarget],
    gitRunner(gitRepo, args, options) {
      if (args[0] === 'ls-files' && args.includes('--stage')) {
        return { code: 74, stdout: Buffer.alloc(0), stderr: Buffer.from('index inspection unavailable\n') };
      }
      return gitResult(gitRepo, args, options);
    },
  }), /index inspection/u);
  assertSnapshotEqual(inspectionBefore, protocolSnapshot(inspectionRepo));

  for (const [label, hook] of [
    ['after-operation', { underOperationHook() { throw new Error('pre-session operation crash'); } }],
    ['during-candidate', { slotWriteHook() { throw new Error('pre-session candidate crash'); } }],
  ]) {
    const crashRepo = createGitFixture(`group-10-${label}`);
    const crashTarget = `src/${label}.txt`;
    writeRepoFile(crashRepo, crashTarget);
    ensureCutover({ repo: crashRepo });
    assert.throws(() => performMutation({
      repo: crashRepo,
      files: [crashTarget],
      ...hook,
    }), /pre-session/u);
    const crashInspection = __testing.inspectProtocol({ repo: crashRepo });
    assert.equal(crashInspection.publication.session, null);
    assert.equal(crashInspection.publication.operation, null);
    assert.equal(stageEntry(crashRepo, crashTarget).length, 0);
  }
});

// Group 11: one-ref NUL transaction shape and candidate reread.
test('[group 11] every authority transaction contains exactly one constant-ref command and OLD/NEW CAS', async () => {
  const { ensureCutover, __testing } = await loadProtocol();
  const sha1Old = '1'.repeat(40);
  const sha1New = '2'.repeat(40);
  const update = __testing.buildUpdateRefInput({ oldOid: sha1Old, newOid: sha1New });
  assert.equal(update.toString('latin1'), `start\0update ${publicationRef}\0${sha1New}\0${sha1Old}\0prepare\0commit\0`);
  const create = __testing.buildUpdateRefInput({ oldOid: null, newOid: sha1New });
  assert.equal(create.toString('latin1'), `start\0create ${publicationRef}\0${sha1New}\0prepare\0commit\0`);
  const guarded = __testing.buildUpdateRefInput({
    oldOid: sha1Old,
    newOid: sha1New,
    headOid: '3'.repeat(40),
  });
  assert.equal(
    guarded.toString('latin1'),
    `start\0verify HEAD\0${'3'.repeat(40)}\0update ${publicationRef}\0${sha1New}\0${sha1Old}\0prepare\0commit\0`,
  );
  assert.equal((update.toString('latin1').match(new RegExp(publicationRef, 'gu')) || []).length, 1);

  if (gitAtLeast245()) {
    const repo = createGitFixture('group-11-killed-transaction');
    ensureCutover({ repo });
    const oldOid = readRef(repo);
    const newOid = git(repo, ['hash-object', '-w', '--stdin'], {
      input: Buffer.from('uncommitted-candidate\n'),
    });
    const killed = await killUpdateRefAfterPrepare(
      repo,
      __testing.buildUpdateRefInput({ oldOid, newOid }),
    );
    assert.equal(killed.killed, true);
    assert.match(killed.stdout, /prepare: ok/u);
    assertForceKilled(killed);
    assert.equal(readRef(repo), oldOid);
  }
});

// Group 12: SHA-1/SHA-256 opaque OIDs and no zero synthesis.
test('[group 12] one-ref transaction framing treats SHA-1 and SHA-256 OIDs as opaque Git output', async (t) => {
  const { __testing } = await loadProtocol();
  for (const width of [40, 64]) {
    const oldOid = 'a'.repeat(width);
    const newOid = 'b'.repeat(width);
    const bytes = __testing.buildUpdateRefInput({ oldOid, newOid });
    assert.ok(bytes.includes(Buffer.from(oldOid)));
    assert.ok(bytes.includes(Buffer.from(newOid)));
    assert.equal(bytes.includes(Buffer.from('0'.repeat(width))), false);
  }
  assert.throws(() => __testing.buildUpdateRefInput({ oldOid: 'not-git', newOid: 'b'.repeat(40) }), /OID/u);

  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const format of ['sha1', 'sha256']) {
    await t.test(`real ${format} one-ref transactions`, async (formatTest) => {
      let repo;
      try {
        repo = createGitFixture(`group-12-${format}`, format === 'sha256'
          ? { objectFormat: 'sha256' }
          : {});
      } catch (error) {
        if (format !== 'sha256') throw error;
        capabilitySkip(formatTest, 'git-sha256-unavailable');
        return;
      }
      const target = `src/${format}.txt`;
      writeRepoFile(repo, target);
      const transactions = [];
      const runner = (gitRepo, args, options = {}) => {
        if (args.includes('update-ref') && args.includes('--stdin')
            && !options.input?.equals(Buffer.from('start\0abort\0', 'latin1'))) {
          transactions.push(Buffer.from(options.input));
        }
        return gitResult(gitRepo, args, options);
      };
      assert.equal((format === 'sha1' ? 40 : 64), git(repo, ['rev-parse', 'HEAD']).length);
      const runtime = await loadProtocol();
      assert.equal(runtime.ensureCutover({ repo, gitRunner: runner }).status, 'ready');
      const performed = runtime.performMutation({ repo, files: [target], gitRunner: runner });
      assert.equal(runtime.restoreMutation({
        repo,
        ownerToken: performed.owner_token,
        gitRunner: runner,
      }).status, 'restored');
      assert.equal(transactions.length > 0, true);
      for (const input of transactions) {
        const latin = input.toString('latin1');
        assert.match(
          latin,
          /^start\0(?:verify HEAD\0(?:[0-9a-f]{40}|[0-9a-f]{64})?\0)?(?:create|update) refs\/worktree\/deep-review\/mutation\/v3\/publication\0/u,
        );
        assert.match(latin, /prepare\0commit\0$/u);
        assert.equal((latin.match(new RegExp(publicationRef, 'gu')) || []).length, 1);
        assert.equal(latin.includes('\0' + '0'.repeat(format === 'sha1' ? 40 : 64) + '\0'), false);
      }
    });
  }
});

// Group 13: foreign authority and exact owned residues.
test('[group 13] foreign reserved authority is preserved manual while owned publication residues remain classifiable', async (t) => {
  const { ensureCutover, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-13-foreign');
  const foreignOid = git(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.from('foreign\n') });
  git(repo, ['update-ref', publicationRef, foreignOid]);
  const before = protocolSnapshot(repo);
  const result = ensureCutover({ repo });
  assert.equal(result.status, 'manual');
  assertSnapshotEqual(before, protocolSnapshot(repo));

  const owned = createGitFixture('group-13-owned');
  ensureCutover({ repo: owned });
  assertProtocolIdle(__testing.inspectProtocol({ repo: owned }));

  const foreignAuthorities = [
    ['nonblob', (fixture) => git(fixture, ['rev-parse', 'HEAD^{tree}'])],
    ['oversized', (fixture) => git(fixture, ['hash-object', '-w', '--stdin'], {
      input: Buffer.alloc(8193, 0x78),
    })],
    ['noncanonical', (fixture) => git(fixture, ['hash-object', '-w', '--stdin'], {
      input: Buffer.from('{"publication_schema":1}\nextra\n'),
    })],
  ];
  for (const [label, makeOid] of foreignAuthorities) {
    const foreignRepo = createGitFixture(`group-13-${label}`);
    git(foreignRepo, ['update-ref', publicationRef, makeOid(foreignRepo)]);
    const foreignBefore = protocolSnapshot(foreignRepo);
    const foreignResult = ensureCutover({ repo: foreignRepo });
    assert.equal(foreignResult.status, 'manual');
    assertSnapshotEqual(foreignBefore, protocolSnapshot(foreignRepo), label);
  }

  const wrongFenceRepo = createGitFixture('group-13-wrong-fence');
  ensureCutover({ repo: wrongFenceRepo });
  const wrongFenceInspection = __testing.inspectProtocol({ repo: wrongFenceRepo });
  const wrongFencePublication = __testing.buildPublication({
    ...wrongFenceInspection.publication,
    publication_digest: undefined,
    fence_inventory_sha256: 'f'.repeat(64),
  });
  const wrongFenceOid = git(wrongFenceRepo, ['hash-object', '-w', '--stdin'], {
    input: __testing.encodePublication(wrongFencePublication),
  });
  git(wrongFenceRepo, ['update-ref', publicationRef, wrongFenceOid, wrongFenceInspection.publication_oid]);
  const wrongFenceBefore = protocolSnapshot(wrongFenceRepo);
  const wrongFence = ensureCutover({ repo: wrongFenceRepo });
  assert.equal(wrongFence.status, 'manual');
  assert.match(wrongFence.reason, /fence|binding/u);
  assertSnapshotEqual(wrongFenceBefore, protocolSnapshot(wrongFenceRepo));

  const badLeaseRepo = createGitFixture('group-13-bad-session-lease');
  const badLeaseTarget = 'src/bad-lease.txt';
  writeRepoFile(badLeaseRepo, badLeaseTarget);
  (await loadProtocol()).performMutation({ repo: badLeaseRepo, files: [badLeaseTarget] });
  const badLeaseBlob = readRefBlob(badLeaseRepo);
  const badLeasePublication = JSON.parse(badLeaseBlob.bytes);
  badLeasePublication.session.lease_id = '0'.repeat(64);
  const badLeaseOid = git(badLeaseRepo, ['hash-object', '-w', '--stdin'], {
    input: Buffer.from(`${JSON.stringify(badLeasePublication)}\n`),
  });
  git(badLeaseRepo, ['update-ref', publicationRef, badLeaseOid, badLeaseBlob.oid]);
  const badLeaseBefore = protocolSnapshot(badLeaseRepo);
  const badLease = ensureCutover({ repo: badLeaseRepo });
  assert.equal(badLease.status, 'manual');
  assert.match(badLease.reason, /lease|authority|publication/u);
  assertSnapshotEqual(badLeaseBefore, protocolSnapshot(badLeaseRepo));
});

// Group 14: separate-process perform race.
test('[group 14] two separate performs yield one publication owner and one index mutation', async (t) => {
  const { ensureCutover, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-14-race');
  const target = 'src/race.txt';
  const foreign = 'foreign-stage.txt';
  writeRepoFile(repo, target);
  writeRepoFile(repo, foreign, 'foreign-exact\n');
  git(repo, ['add', '--', foreign]);
  const foreignBytes = readFileSync(join(repo, foreign));
  const foreignStage = stageEntry(repo, foreign);
  ensureCutover({ repo });
  const request = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'perform',
    repo,
    owner_token: null,
    files: [target],
  });
  const results = await Promise.all([runChild(request), runChild(request)]);
  const bodies = results.map((result) => JSON.parse(result.stdout));
  assert.equal(bodies.filter((body) => body.ok && body.status === 'committed').length, 1);
  assert.equal(bodies.filter((body) => !body.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(stageEntry(repo, target).length > 0, true);
  assert.deepEqual(readFileSync(join(repo, foreign)), foreignBytes);
  assert.deepEqual(stageEntry(repo, foreign), foreignStage);
  assert.deepEqual(protocolFiles(repo), [
    '.mutation.lock',
    '.mutation.operation.reserve',
    '.pending-mutation.v3.a.json',
    '.pending-mutation.v3.b.json',
  ]);
  const inspection = __testing.inspectProtocol({ repo });
  assert.equal(inspection.publication.session.phase, 'committed');
  assert.equal(inspection.publication.operation, null);
  const winner = bodies.find((body) => body.ok && body.status === 'committed');
  const activeRecords = inspection.slots.map((slot) => slot.record);
  assert.deepEqual(activeRecords.map((record) => record.phase).sort(), ['committed', 'prepared']);
  assert.equal(new Set(activeRecords.map((record) => record.session_id)).size, 1);
  assert.equal(new Set(activeRecords.map((record) => record.owner_token)).size, 1);
  assert.equal(activeRecords[0].owner_token, winner.owner_token);
});

// Group 15: pre-index refusal and partial-add intent/rollback/abort chain.
test('[group 15] partial git add publishes abort intent before rollback and preserves unrelated/real staging', async (t) => {
  const { performMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-15-partial');
  const target = 'src/partial.txt';
  const unrelated = 'unrelated.txt';
  writeRepoFile(repo, target);
  writeRepoFile(repo, unrelated);
  git(repo, ['add', '--', unrelated]);
  const unrelatedBefore = stageEntry(repo, unrelated);
  const phases = [];
  const runner = (gitRepo, args, options = {}) => {
    if (args[0] === 'add') {
      const real = gitResult(gitRepo, args, options);
      assert.equal(real.code, 0);
      return { ...real, code: 1, stderr: Buffer.from('injected partial add\n') };
    }
    return gitResult(gitRepo, args, options);
  };
  assert.throws(() => performMutation({
    repo,
    files: [target],
    gitRunner: runner,
    transitionHook(phase) { phases.push(phase); },
  }), /git add|partial/u);
  assert.equal(stageEntry(repo, target).length, 0);
  assert.deepEqual(stageEntry(repo, unrelated), unrelatedBefore);
  assert.deepEqual(phases.filter((phase) => /abort|aborted/u.test(phase)), [
    'recovery-attempt:abort-prepared:pending:1',
    'aborted:abort-prepared:1',
  ]);
  assertProtocolIdle(__testing.inspectProtocol({ repo }));
});

// Group 16: singular three-attempt engine.
test('[group 16] committed recovery replays pending, increments only failed records, and stops at attempt three', async (t) => {
  const { performMutation, restoreMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-16-attempts');
  const target = 'src/retry.txt';
  writeRepoFile(repo, target);
  const performed = performMutation({ repo, files: [target] });
  let updateAttempts = 0;
  const failingRunner = (gitRepo, args, options = {}) => {
    if (args[0] === 'update-index') {
      updateAttempts += 1;
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('injected restore failure\n') };
    }
    return gitResult(gitRepo, args, options);
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.throws(() => restoreMutation({
      repo,
      ownerToken: performed.owner_token,
      gitRunner: failingRunner,
    }), /restore|update-index|manual/u);
    const selected = __testing.inspectProtocol({ repo }).selectedRecord;
    assert.equal(selected.phase, 'recovery-attempt');
    assert.equal(selected.attempt_state, 'failed');
    assert.equal(selected.restore_attempts, attempt);
    assert.equal(selected.recovery_kind, 'restore-committed');
  }
  const before = protocolSnapshot(repo);
  const terminal = restoreMutation({ repo, ownerToken: performed.owner_token, gitRunner: failingRunner });
  assert.equal(terminal.status, 'manual');
  assert.equal(terminal.reason, 'restore-attempts-exhausted');
  assert.equal(updateAttempts, 3);
  assertSnapshotEqual(before, protocolSnapshot(repo));
});

// Group 17: crash rows for both recovery kinds.
test('[group 17] recovery crash rows retain exact pending/terminal OLD-or-NEW evidence', async (t) => {
  const { performMutation, restoreMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const preparedRepo = createGitFixture('group-17-prepared-crash');
  const preparedTarget = 'src/prepared-crash.txt';
  const preparedToken = canonicalOwnerToken();
  writeRepoFile(preparedRepo, preparedTarget);
  assert.throws(() => performMutation({
    repo: preparedRepo,
    files: [preparedTarget],
    ownerToken: preparedToken,
    transitionHook(phase) {
      if (phase === 'prepared') throw new Error('crash after prepared CAS');
    },
  }), /crash after prepared CAS/u);
  const preparedResidue = __testing.inspectProtocol({ repo: preparedRepo });
  assert.equal(preparedResidue.selectedRecord.phase, 'prepared');
  assert.equal(stageEntry(preparedRepo, preparedTarget).length, 0);
  assert.equal(
    restoreMutation({ repo: preparedRepo, ownerToken: preparedToken }).status,
    'restored',
  );

  const pendingRepo = createGitFixture('group-17-pending-crash');
  const pendingTarget = 'src/pending-crash.txt';
  writeRepoFile(pendingRepo, pendingTarget);
  const pendingPerformed = performMutation({ repo: pendingRepo, files: [pendingTarget] });
  assert.throws(() => restoreMutation({
    repo: pendingRepo,
    ownerToken: pendingPerformed.owner_token,
    transitionHook(phase) {
      if (phase === 'recovery-attempt:restore-committed:pending:1') {
        throw new Error('crash after pending CAS');
      }
    },
  }), /crash after pending CAS/u);
  const pendingResidue = __testing.inspectProtocol({ repo: pendingRepo }).selectedRecord;
  assert.equal(pendingResidue.phase, 'recovery-attempt');
  assert.equal(pendingResidue.attempt_state, 'pending');
  assert.equal(pendingResidue.restore_attempts, 1);
  assert.equal(
    restoreMutation({ repo: pendingRepo, ownerToken: pendingPerformed.owner_token }).status,
    'restored',
  );

  const recoveryKinds = process.env.DEEP_REVIEW_TASK4_RECOVERY_KIND
    ? [process.env.DEEP_REVIEW_TASK4_RECOVERY_KIND]
    : ['abort-prepared', 'restore-committed'];
  for (const kind of recoveryKinds) {
    assert.equal(['abort-prepared', 'restore-committed'].includes(kind), true);
    const beforeWrite = recoveryFixture(await loadProtocol(), kind, 'before-attempt-write');
    const beforeWriteSnapshot = protocolSnapshot(beforeWrite.repo);
    assert.throws(() => restoreMutation({
      repo: beforeWrite.repo,
      ownerToken: beforeWrite.ownerToken,
      slotWriteHook() { throw new Error(`crash before ${kind} attempt write`); },
    }), /attempt write/u);
    assertSnapshotEqual(beforeWriteSnapshot, protocolSnapshot(beforeWrite.repo));

    const afterCas = recoveryFixture(await loadProtocol(), kind, 'after-attempt-cas');
    assert.throws(() => restoreMutation({
      repo: afterCas.repo,
      ownerToken: afterCas.ownerToken,
      transitionHook(label) {
        if (label === `recovery-attempt:${kind}:pending:1`) {
          throw new Error(`crash after ${kind} attempt CAS`);
        }
      },
    }), /attempt CAS/u);
    const afterCasState = __testing.inspectProtocol({ repo: afterCas.repo });
    assert.equal(afterCasState.selectedRecord.phase, 'recovery-attempt');
    assert.equal(afterCasState.selectedRecord.recovery_kind, kind);
    assert.equal(afterCasState.selectedRecord.attempt_state, 'pending');
    assert.equal(afterCasState.selectedRecord.restore_attempts, 1);
    assert.equal(
      afterCasState.publication.session.lease_id,
      sessionLease(afterCasState.selectedRecord),
    );
    assert.equal(stageEntry(afterCas.repo, afterCas.target).length > 0, kind === 'restore-committed');

    const afterIndex = recoveryFixture(await loadProtocol(), kind, 'after-index');
    assert.throws(() => restoreMutation({
      repo: afterIndex.repo,
      ownerToken: afterIndex.ownerToken,
      recoveryHook(label) {
        if (label === 'after-index-before-terminal') {
          throw new Error(`crash after ${kind} index publication`);
        }
      },
    }), /index publication/u);
    const afterIndexState = __testing.inspectProtocol({ repo: afterIndex.repo });
    assert.equal(afterIndexState.selectedRecord.phase, 'recovery-attempt');
    assert.equal(afterIndexState.selectedRecord.attempt_state, 'pending');
    assert.equal(stageEntry(afterIndex.repo, afterIndex.target).length, 0);

    const terminalWrite = recoveryFixture(await loadProtocol(), kind, 'terminal-write');
    assert.throws(() => restoreMutation({
      repo: terminalWrite.repo,
      ownerToken: terminalWrite.ownerToken,
      transitionHook(label) {
        if (label === `recovery-attempt:${kind}:pending:1`) {
          throw new Error('retain pending before terminal write');
        }
      },
    }), /retain pending/u);
    assert.throws(() => restoreMutation({
      repo: terminalWrite.repo,
      ownerToken: terminalWrite.ownerToken,
      slotWriteHook() { throw new Error(`crash during ${kind} terminal write`); },
    }), /terminal write/u);
    const terminalWriteState = __testing.inspectProtocol({ repo: terminalWrite.repo });
    assert.equal(terminalWriteState.selectedRecord.phase, 'recovery-attempt');
    assert.equal(terminalWriteState.selectedRecord.attempt_state, 'pending');
    assert.equal(stageEntry(terminalWrite.repo, terminalWrite.target).length, 0);

    const terminalCas = recoveryFixture(await loadProtocol(), kind, 'terminal-cas');
    const terminalPhase = kind === 'abort-prepared' ? 'aborted' : 'restored';
    assert.throws(() => restoreMutation({
      repo: terminalCas.repo,
      ownerToken: terminalCas.ownerToken,
      transitionHook(label) {
        if (label === `${terminalPhase}:${kind}:1`) {
          throw new Error(`crash after ${kind} terminal CAS`);
        }
      },
    }), /terminal CAS/u);
    const terminalCasState = __testing.inspectProtocol({ repo: terminalCas.repo });
    assert.equal(terminalCasState.selectedRecord.phase, terminalPhase);
    assert.equal(terminalCasState.publication.session.phase, terminalPhase);
    assert.equal(stageEntry(terminalCas.repo, terminalCas.target).length, 0);

    const sessionRelease = recoveryFixture(await loadProtocol(), kind, 'session-release');
    assert.throws(() => restoreMutation({
      repo: sessionRelease.repo,
      ownerToken: sessionRelease.ownerToken,
      recoveryHook(label) {
        if (label === 'after-session-release') {
          throw new Error(`crash after ${kind} session release`);
        }
      },
    }), /session release/u);
    const sessionReleaseState = __testing.inspectProtocol({ repo: sessionRelease.repo });
    assert.equal(sessionReleaseState.publication.session, null);
    assert.equal(stageEntry(sessionRelease.repo, sessionRelease.target).length, 0);

    for (const fixture of [afterCas, afterIndex, terminalWrite, terminalCas, sessionRelease]) {
      const retry = restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
      });
      assert.equal(['restored', 'noop'].includes(retry.status), true);
      assertProtocolIdle(__testing.inspectProtocol({ repo: fixture.repo }));
    }
  }
});

// Group 18: normal restore total table and operation release.
test('[group 18] normal restore table checks token first and shares committed pending-first recovery', async (t) => {
  const { ensureCutover, performMutation, restoreMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-18-restore');
  const target = 'src/restore.txt';
  writeRepoFile(repo, target);
  ensureCutover({ repo });
  const idleBefore = protocolSnapshot(repo);
  assert.equal(restoreMutation({ repo, ownerToken: canonicalOwnerToken() }).status, 'noop');
  assertSnapshotEqual(idleBefore, protocolSnapshot(repo));

  const performed = performMutation({ repo, files: [target] });
  const boundBefore = protocolSnapshot(repo);
  assert.throws(() => restoreMutation({ repo }), /owner token.*string/u);
  assertSnapshotEqual(boundBefore, protocolSnapshot(repo));
  assert.throws(() => restoreMutation({ repo, ownerToken: 'wrong-token' }), /owner token/u);
  assertSnapshotEqual(boundBefore, protocolSnapshot(repo));
  const transitions = [];
  const restored = restoreMutation({
    repo,
    ownerToken: performed.owner_token,
    transitionHook(phase) { transitions.push(phase); },
  });
  assert.equal(restored.status, 'restored');
  assert.equal(transitions[0], 'recovery-attempt:restore-committed:pending:1');
  assert.equal(transitions.includes('restored:restore-committed:1'), true);
  assertProtocolIdle(__testing.inspectProtocol({ repo }));

  const phaseRuntime = await loadProtocol();
  for (const phase of ['prepared', 'committed', 'pending', 'failed', 'restored', 'aborted']) {
    const fixture = retainOperationAtPhase(phaseRuntime, phase);
    fixture.controller.failRelease = false;
    fixture.controller.failRestoreIndex = false;
    const phaseTransitions = [];
    const phaseResult = phaseRuntime.restoreMutation({
      repo: fixture.repo,
      ownerToken: fixture.ownerToken,
      gitRunner: fixture.runner,
      processProbe: () => ({ status: 'dead' }),
      transitionHook(label) { phaseTransitions.push(label); },
    });
    assert.equal(phaseResult.status, 'restored', phase);
    if (phase === 'committed') {
      assert.equal(phaseTransitions[0], 'recovery-attempt:restore-committed:pending:1');
    }
    if (phase === 'pending') {
      assert.equal(phaseTransitions.some((label) => label.includes(':pending:1')), false);
    }
    assertProtocolIdle(phaseRuntime.__testing.inspectProtocol({ repo: fixture.repo }));
  }

  const releaseRepo = createGitFixture('group-18-session-release-retry');
  const releaseTarget = 'src/session-release.txt';
  writeRepoFile(releaseRepo, releaseTarget);
  const releasePerformed = performMutation({ repo: releaseRepo, files: [releaseTarget] });
  assert.throws(() => restoreMutation({
    repo: releaseRepo,
    ownerToken: releasePerformed.owner_token,
    transitionHook(label) {
      if (label.startsWith('restored:')) throw new Error('retain terminal for release test');
    },
  }), /retain terminal/u);
  let releaseTransactions = 0;
  const sessionReleaseRunner = (gitRepo, args, options = {}) => {
    if (args.includes('update-ref') && args.includes('--stdin')
        && !options.input?.equals(Buffer.from('start\0abort\0', 'latin1'))) {
      releaseTransactions += 1;
      if (releaseTransactions === 2) {
        return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('session release failure\n') };
      }
    }
    return gitResult(gitRepo, args, options);
  };
  assert.throws(() => restoreMutation({
    repo: releaseRepo,
    ownerToken: releasePerformed.owner_token,
    gitRunner: sessionReleaseRunner,
  }), /release|compare-and-swap/u);
  const retainedTerminal = __testing.inspectProtocol({ repo: releaseRepo });
  assert.equal(retainedTerminal.publication.session.phase, 'restored');
  assert.equal(retainedTerminal.publication.operation, null);
  assert.equal(restoreMutation({
    repo: releaseRepo,
    ownerToken: releasePerformed.owner_token,
  }).status, 'restored');
  assertProtocolIdle(__testing.inspectProtocol({ repo: releaseRepo }));

  const terminalRepo = createGitFixture('group-18-terminal-verification');
  const terminalTarget = 'src/terminal.txt';
  writeRepoFile(terminalRepo, terminalTarget);
  const terminalPerformed = performMutation({ repo: terminalRepo, files: [terminalTarget] });
  assert.throws(() => restoreMutation({
    repo: terminalRepo,
    ownerToken: terminalPerformed.owner_token,
    transitionHook(phase) {
      if (phase.startsWith('restored:')) throw new Error('terminal publication crash');
    },
  }), /terminal publication crash/u);
  git(terminalRepo, ['add', '-N', '--', terminalTarget]);
  const terminalBefore = protocolSnapshot(terminalRepo);
  assert.throws(() => restoreMutation({
    repo: terminalRepo,
    ownerToken: terminalPerformed.owner_token,
  }), /terminal|intent-to-add|verification/u);
  assertSnapshotEqual(terminalBefore, protocolSnapshot(terminalRepo));
});

// Group 19: operation/session liveness.
test('[group 19] operation and session liveness is fail-closed for live, EPERM, reuse, foreign, and future owners', async () => {
  const { __testing } = await loadProtocol();
  const now = Date.now();
  const validProcessStart = now - 4_000_001;
  const base = {
    host_hash: __testing.currentHostHash(),
    pid: String(process.pid),
    process_start_ms: String(validProcessStart),
    started_at: new Date(now - 4_000_000).toISOString(),
  };
  assert.equal(__testing.classifyLiveness(base, { now, processProbe: () => ({ status: 'live', startMs: validProcessStart }) }), 'live');
  assert.equal(__testing.classifyLiveness(base, { now, processProbe: () => ({ status: 'eperm' }) }), 'uncertain');
  assert.equal(__testing.classifyLiveness(base, { now, processProbe: () => ({ status: 'live', startMs: validProcessStart + 1 }) }), 'uncertain');
  assert.equal(__testing.classifyLiveness({ ...base, host_hash: 'f'.repeat(64) }, { now, processProbe: () => ({ status: 'dead' }) }), 'foreign');
  assert.equal(__testing.classifyLiveness({ ...base, started_at: new Date(now + 1).toISOString() }, { now, processProbe: () => ({ status: 'dead' }) }), 'manual');
  assert.equal(__testing.classifyLiveness(base, { now, processProbe: () => ({ status: 'dead' }) }), 'departed');
});

// Group 20: complete ref and reflog inventories.
test('[group 20] unexpected live, blob-valued, and orphan reserved reflogs block mutation', async (t) => {
  const { ensureCutover, performMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-20-reflog');
  ensureCutover({ repo });
  const foreignRef = 'refs/worktree/deep-review/mutation/v3/foreign';
  const oid = git(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.from('foreign\n') });
  git(repo, ['update-ref', '--create-reflog', foreignRef, oid]);
  const before = protocolSnapshot(repo);
  const result = ensureCutover({ repo });
  assert.equal(result.status, 'manual');
  assert.match(result.reason, /reserved|reflog/u);
  assertSnapshotEqual(before, protocolSnapshot(repo));
  // Git's porcelain deletes the reflog together with the final ref value.
  // Remove only the fixture's live ref file so the nonempty reflog is a real
  // orphan for the backend-neutral production inventory to discover.
  unlinkSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-path', foreignRef]));
  assert.equal(gitResult(repo, ['reflog', 'exists', foreignRef]).code, 0);
  const orphanBefore = protocolSnapshot(repo);
  const orphan = ensureCutover({ repo });
  assert.equal(orphan.status, 'manual');
  assertSnapshotEqual(orphanBefore, protocolSnapshot(repo));

  const raced = createGitFixture('group-20-jit-race');
  const racedTarget = 'src/jit-race.txt';
  writeRepoFile(raced, racedTarget);
  ensureCutover({ repo: raced });
  const racedForeignRef = publicationRef.slice(0, -'publication'.length) + 'jit-race';
  const racedForeignOid = git(raced, ['hash-object', '-w', '--stdin'], {
    input: Buffer.from('jit-race\n'),
  });
  let injected = false;
  assert.throws(() => performMutation({
    repo: raced,
    files: [racedTarget],
    authorityTransitionHook({ stage, purpose }) {
      if (!injected && stage === 'after-pre-inventory' && purpose === 'operation-acquire') {
        injected = true;
        git(raced, ['update-ref', '--create-reflog', racedForeignRef, racedForeignOid]);
      }
    },
  }), /reserved.*reflog|inventory|freeze/u);
  assert.equal(injected, true);
  assert.equal(JSON.parse(readRefBlob(raced).bytes).operation !== null, true);
  assert.equal(stageEntry(raced, racedTarget).length, 0);
  assert.equal(__testing.parseReflogList(Buffer.from(`${foreignRef}\n`), { checkRef: () => true })[0], foreignRef);
});

// Group 21: selected corruption never falls back.
test('[group 21] selected corrupt or self-mismatched slot never falls back to an inactive valid slot', async (t) => {
  const { performMutation, restoreMutation, __testing } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('group-21-selected');
  const target = 'src/corrupt.txt';
  writeRepoFile(repo, target);
  const performed = performMutation({ repo, files: [target] });
  const inspection = __testing.inspectProtocol({ repo });
  const selectedPath = join(repo, v3SlotRelative(inspection.publication.selected_slot));
  writeFileSync(selectedPath, '{corrupt');
  const before = protocolSnapshot(repo);
  assert.throws(() => restoreMutation({ repo, ownerToken: performed.owner_token }), /selected|canonical|manual/u);
  assertSnapshotEqual(before, protocolSnapshot(repo));
  assert.equal(stageEntry(repo, target).length > 0, true);
});

// Group 22: zero commit, linked worktree, Unicode paths, framed stdin, sensitive scanner.
test('[group 22] zero-commit, linked-worktree, Unicode/literal paths, and framed child transport are portable', async (t) => {
  const { ensureCutover, performMutation, restoreMutation, __testing, isProtocolIntentToAdd } = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const zero = createGitFixture('group-22-zero', { initialCommit: false });
  const literal = 'src/한 글 Ω [x].txt';
  writeRepoFile(zero, literal);
  const performed = performMutation({ repo: zero, files: [literal] });
  assert.equal(isProtocolIntentToAdd({ repo: zero, file: literal }), true);
  assert.equal(restoreMutation({ repo: zero, ownerToken: performed.owner_token }).status, 'restored');
  assertProtocolIdle(__testing.inspectProtocol({ repo: zero }));

  const main = createGitFixture('group-22-main');
  const linked = join(fixtureRootFor(main), 'group-22-linked');
  git(main, ['worktree', 'add', '--quiet', '-b', 'linked-branch', linked]);
  writeRepoFile(linked, 'linked 파일.txt');
  assert.equal(ensureCutover({ repo: main }).status, 'ready');
  assert.equal(ensureCutover({ repo: linked }).status, 'ready');
  assert.notEqual(readRef(main), readRef(linked));

  const request = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'ensure-cutover',
    repo: zero,
    owner_token: null,
    files: [],
  });
  assert.equal(parseCliOutput(spawnFramed(request)).ok, true);

  const { createSensitiveFileScanner, scanSensitiveFiles } = await loadSensitiveFiles();
  const hits = scanSensitiveFiles({
    pluginRoot,
    files: ['.env', 'nested/CREDENTIALS.json', 'keys/id_rsa', 'src/normal.ts'],
  });
  assert.deepEqual(hits, ['.env', 'nested/CREDENTIALS.json', 'keys/id_rsa']);

  const ordinaryRepo = createGitFixture('group-22-sensitive-ordinary-project');
  writeRepoFile(ordinaryRepo, '.env', 'SECRET=redacted\n');
  const sensitiveRequest = __testing.buildCliRequest({
    protocol: 'deep-review-mutation-v3',
    command: 'scan-sensitive',
    repo: ordinaryRepo,
    owner_token: null,
    files: ['.env', 'src/normal.ts'],
  });
  const sensitiveResult = parseCliOutput(spawnFramed(sensitiveRequest, { cwd: ordinaryRepo }));
  assert.equal(sensitiveResult.ok, true);
  assert.deepEqual(sensitiveResult.sensitive_files, ['.env']);

  for (const [code, condition] of [['ENOENT', 'missing'], ['EACCES', 'unreadable']]) {
    const scanner = createSensitiveFileScanner({
      readPatternData(listPath) {
        assert.equal(listPath, join(
          pluginRoot,
          'hooks',
          'scripts',
          'lib',
          'sensitive-patterns.list',
        ));
        const error = new Error(`injected ${condition}`);
        error.code = code;
        throw error;
      },
    });
    const error = captureError(() => scanner({
      pluginRoot,
      files: ['.env'],
    }));
    assert.equal(error.code, 'SENSITIVE_PATTERN_DATA_UNAVAILABLE');
    assert.match(error.message, new RegExp(`canonical sensitive pattern data is ${condition}`, 'u'));
  }
});

// Group 23: static one-ref/no-pathname-publication audit.
test('[group 23] static audit has one reserved ref and no protocol artifact delete/rename backend', () => {
  const source = readFileSync(protocolPath, 'utf8');
  assert.equal((source.match(/refs\/worktree\/deep-review\/mutation\/v3\/publication/gu) || []).length, 1);
  assert.doesNotMatch(source, /refs\/worktree\/deep-review\/mutation\/v3\/(?!publication)/u);
  assert.doesNotMatch(source, /\.git[\\/](?:refs|logs)[\\/]/u);
  assert.doesNotMatch(source, /multi[-_ ]ref|delete\s+refs\/worktree/iu);
  const forbiddenArtifactCalls = [
    /unlinkSync\([^\n]*(?:pending-mutation|mutation\.lock|mutation\.operation)/u,
    /rmdirSync\([^\n]*(?:pending-mutation|mutation\.lock|mutation\.operation)/u,
    /rmSync\([^\n]*(?:pending-mutation|mutation\.lock|mutation\.operation)/u,
    /renameSync\([^\n]*(?:pending-mutation\.v3|mutation\.operation\.reserve|mutation\.lock)/u,
  ];
  for (const pattern of forbiddenArtifactCalls) assert.doesNotMatch(source, pattern);
  assert.doesNotMatch(source, /--files-json|--owner-token|--repo\b/u);
});

test('[R1C C1] departed-operation reconcile preserves every selected session phase before separate acquire', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const phase of ['prepared', 'committed', 'pending', 'failed', 'restored', 'aborted']) {
    await t.test(phase, () => {
      const fixture = retainOperationAtPhase(protocol, phase);
      const indexBefore = stageEntry(fixture.repo, fixture.target);
      const slotsBefore = fixture.before.slots.map((slot) => ({
        slot: slot.slot,
        identity: slot.identity,
        record: slot.record,
      }));
      const result = protocol.ensureCutover({
        repo: fixture.repo,
        processProbe: () => ({ status: 'dead' }),
      });
      assert.deepEqual(result, { status: 'ready' });
      const after = protocol.__testing.inspectProtocol({ repo: fixture.repo });
      assert.equal(after.publication.operation, null);
      assert.deepEqual(after.publication.session, fixture.before.publication.session);
      assert.equal(after.publication.selected_slot, fixture.before.publication.selected_slot);
      assert.equal(after.publication.selected_record_seq, fixture.before.publication.selected_record_seq);
      assert.equal(after.publication.selected_record_digest, fixture.before.publication.selected_record_digest);
      assert.deepEqual(after.selectedRecord, fixture.before.selectedRecord);
      assert.deepEqual(after.slots.map((slot) => ({
        slot: slot.slot,
        identity: slot.identity,
        record: slot.record,
      })), slotsBefore);
      assert.deepEqual(stageEntry(fixture.repo, fixture.target), indexBefore);
    });
  }
});

test('[R1C W1] auto-recovery refuses complete sequence exhaustion before candidates, slots, or index mutation', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('r1c-sequence-headroom');
  const target = 'src/sequence-headroom.txt';
  writeRepoFile(repo, target);
  protocol.performMutation({ repo, files: [target] });
  rewriteSelectedRecordSequence(repo, protocol, '4294967294');
  const before = protocolSnapshot(repo);
  const objectsBefore = gitObjectInventory(repo);
  assert.throws(() => protocol.autoRecover({
    repo,
    now: Date.now() + 10_000_000,
    staleMs: 0,
    processProbe: () => ({ status: 'dead' }),
  }), /record-sequence-exhausted/u);
  assertSnapshotEqual(before, protocolSnapshot(repo));
  assert.deepEqual(gitObjectInventory(repo), objectsBefore);
  assert.equal(protocol.isProtocolIntentToAdd({ repo, file: target }), true);
});

test('[R1C W2] fence inventory uses exact platform tags, payload lengths, bytes, and digests', async () => {
  const { __testing } = await loadProtocol();
  assert.equal(__testing.platformMetadataTag('file', 'win32'), 'win32-file-rw');
  assert.equal(__testing.platformMetadataTag('directory', 'win32'), 'win32-dir-marker-owned');
  assert.equal(__testing.platformMetadataTag('file', 'linux'), 'posix-file-0600');
  assert.equal(__testing.platformMetadataTag('directory', 'darwin'), 'posix-dir-0700');

  const baseEntries = [
    {
      kind: 'file',
      relativePath: '.mutation.operation.reserve',
      identity: { dev: '1', ino: '2' },
      payload: Buffer.from('node\n'),
    },
    {
      kind: 'directory',
      relativePath: '.mutation.lock',
      identity: { dev: '3', ino: '4' },
      payload: Buffer.alloc(0),
    },
    {
      kind: 'file',
      relativePath: '.mutation.lock/v3-cutover-fence',
      identity: { dev: '5', ino: '6' },
      payload: Buffer.from('marker\n'),
    },
  ];
  const posix = __testing.encodeFenceInventory(baseEntries.map((entry) => ({
    ...entry,
    metadataTag: entry.kind === 'directory' ? 'posix-dir-0700' : 'posix-file-0600',
  })));
  assert.equal(posix.toString('hex'), '646565702d7265766965772d76332d66656e6365732d7631006469726563746f7279002e6d75746174696f6e2e6c6f636b00706f7369782d6469722d30373030003300340030000066696c65002e6d75746174696f6e2e6c6f636b2f76332d6375746f7665722d66656e636500706f7369782d66696c652d30363030003500360037006d61726b65720a0066696c65002e6d75746174696f6e2e6f7065726174696f6e2e7265736572766500706f7369782d66696c652d30363030003100320035006e6f64650a00');
  assert.equal(sha256(posix), 'a3df8108421c42154c372c6051e698ec156baa25686c136390824a5a835ece6f');

  const win32 = __testing.encodeFenceInventory(baseEntries.map((entry) => ({
    ...entry,
    metadataTag: entry.kind === 'directory' ? 'win32-dir-marker-owned' : 'win32-file-rw',
  })));
  assert.equal(win32.toString('hex'), '646565702d7265766965772d76332d66656e6365732d7631006469726563746f7279002e6d75746174696f6e2e6c6f636b0077696e33322d6469722d6d61726b65722d6f776e6564003300340030000066696c65002e6d75746174696f6e2e6c6f636b2f76332d6375746f7665722d66656e63650077696e33322d66696c652d7277003500360037006d61726b65720a0066696c65002e6d75746174696f6e2e6f7065726174696f6e2e726573657276650077696e33322d66696c652d7277003100320035006e6f64650a00');
  assert.equal(sha256(win32), 'f7342e4654565de07a0f17edfc9d0e9828f45539f47c8ade1e1ab915f1934636');
});

test('[R1C W3] primary, failed-state-publication, and release errors remain ordered and serializable', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const repo = createGitFixture('r1c-composite-errors');
  const target = 'src/composite-errors.txt';
  writeRepoFile(repo, target);
  const performed = protocol.performMutation({ repo, files: [target] });
  let failPublication = false;
  const runner = (gitRepo, args, options = {}) => {
    if (args[0] === 'update-index') {
      failPublication = true;
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('primary restore failure\n'),
      };
    }
    if (failPublication && args.includes('update-ref')) {
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('secondary publication or release failure\n'),
      };
    }
    return gitResult(gitRepo, args, options);
  };
  const error = captureError(() => protocol.restoreMutation({
    repo,
    ownerToken: performed.owner_token,
    gitRunner: runner,
  }));
  assert.deepEqual(error.failures.map((failure) => failure.stage), [
    'primary',
    'failed-state-publication',
    'release',
  ]);
  assert.match(error.failures[0].message, /primary restore failure/u);
  assert.match(error.failures[1].message, /publication compare-and-swap/u);
  assert.match(error.failures[2].message, /release|compare-and-swap/u);
  const serialized = protocol.__testing.serializeProtocolError(error);
  assert.deepEqual(serialized.failures.map((failure) => failure.stage), [
    'primary',
    'failed-state-publication',
    'release',
  ]);
});

test('[R2 C1] every record CAS revalidates selected and peer identities before index mutation', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const boundary of ['post-write-pre-CAS', 'post-CAS-pre-index']) {
    for (const role of ['selected', 'peer']) {
      await t.test(`${boundary}:${role}`, () => {
        const repo = createGitFixture(`r2-c1-${boundary}-${role}`);
        const target = `src/${boundary}-${role}.txt`;
        writeRepoFile(repo, target);
        protocol.ensureCutover({ repo });
        let candidatePath = null;
        let replacementPath = null;
        let indexMutationCalls = 0;
        const runner = (gitRepo, args, options = {}) => {
          if (args[0] === 'add' || args[0] === 'update-index') indexMutationCalls += 1;
          return gitResult(gitRepo, args, options);
        };
        const replaceRole = () => {
          assert.ok(candidatePath, 'prepared slot-write boundary was not reached');
          const selectedSlot = basename(candidatePath).includes('.a.json') ? 'a' : 'b';
          const slot = role === 'selected'
            ? selectedSlot
            : (selectedSlot === 'a' ? 'b' : 'a');
          replacementPath = join(repo, v3SlotRelative(slot));
          replaceFileIdentity(replacementPath);
        };
        assert.throws(() => protocol.performMutation({
          repo,
          files: [target],
          gitRunner: runner,
          slotWriteHook({ path: slotPath }) {
            candidatePath = slotPath;
          },
          authorityTransitionHook({ stage, purpose }) {
            if (boundary === 'post-write-pre-CAS'
                && replacementPath === null
                && stage === 'after-pre-inventory'
                && purpose === 'publication-transition') {
              replaceRole();
            }
          },
          transitionHook(label) {
            if (boundary === 'post-CAS-pre-index'
                && replacementPath === null
                && label === 'prepared') {
              replaceRole();
            }
          },
        }), /authority|binding|identity|manual|peer|replaced|slot/u);
        assert.ok(replacementPath, `${boundary}:${role} replacement was not injected`);
        assert.equal(indexMutationCalls, 0, `${boundary}:${role} reached index mutation`);
        assert.equal(stageEntry(repo, target).length, 0);
      });
    }
  }
});

test('[R2 C2] captured commit and exact target projection reject every moving-HEAD recovery phase', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const exercise = async (label, repo, target, retainPhase) => {
    const unrelated = `unrelated-${label}.txt`;
    writeRepoFile(repo, target, `target-${label}\n`);
    writeRepoFile(repo, unrelated, `unrelated-${label}\n`);
    git(repo, ['add', '--', unrelated]);
    const unrelatedBefore = stageEntry(repo, unrelated);
    const performed = protocol.performMutation({ repo, files: [target] });
    if (retainPhase === 'pending') {
      assert.throws(() => protocol.restoreMutation({
        repo,
        ownerToken: performed.owner_token,
        transitionHook(labelValue) {
          if (labelValue === 'recovery-attempt:restore-committed:pending:1') {
            throw new Error('retain pending before moving HEAD');
          }
        },
      }), /retain pending/u);
    } else if (retainPhase === 'terminal') {
      assert.throws(() => protocol.restoreMutation({
        repo,
        ownerToken: performed.owner_token,
        transitionHook(labelValue) {
          if (labelValue === 'restored:restore-committed:1') {
            throw new Error('retain terminal before moving HEAD');
          }
        },
      }), /retain terminal/u);
    }
    const retained = protocol.__testing.inspectProtocol({ repo });
    if (retainPhase === 'pending') {
      assert.equal(retained.selectedRecord.phase, 'recovery-attempt');
      assert.equal(retained.selectedRecord.attempt_state, 'pending');
    } else if (retainPhase === 'terminal') {
      assert.equal(retained.selectedRecord.phase, 'restored');
    } else {
      assert.equal(retained.selectedRecord.phase, 'committed');
    }
    const targetBefore = stageEntry(repo, target);
    if (retainPhase === 'terminal') {
      assert.equal(targetBefore.length, 0, `${label} requires verified absent target projection`);
    } else {
      assert.ok(targetBefore.length > 0, `${label} requires protocol ITA before HEAD movement`);
    }
    advanceHeadWithTarget(repo, target);
    const beforeRecovery = protocolSnapshot(repo);
    assert.throws(() => protocol.restoreMutation({
      repo,
      ownerToken: performed.owner_token,
    }), /captured commit|commit.*mismatch|index projection|manual|HEAD/u);
    assertSnapshotEqual(beforeRecovery, protocolSnapshot(repo), `${label} mutated after HEAD drift`);
    assert.deepEqual(stageEntry(repo, target), targetBefore, `${label} target index projection changed`);
    assert.deepEqual(stageEntry(repo, unrelated), unrelatedBefore, `${label} unrelated staging changed`);
  };

  for (const phase of ['committed', 'pending', 'terminal']) {
    await t.test(phase, async () => {
      const repo = createGitFixture(`r2-c2-${phase}`);
      await exercise(phase, repo, `src/${phase}.txt`, phase);
    });
  }

  await t.test('zero-to-first-commit', async () => {
    const repo = createGitFixture('r2-c2-zero-first', { initialCommit: false });
    await exercise('zero-first', repo, 'src/zero-first.txt', 'committed');
  });

  await t.test('linked-worktree', async () => {
    const main = createGitFixture('r2-c2-main');
    const linked = join(fixtureRootFor(main), 'r2-c2-linked');
    git(main, ['worktree', 'add', '--quiet', '-b', 'r2-c2-linked-branch', linked]);
    await exercise('linked', linked, 'src/linked.txt', 'committed');
  });
});

test('[R2 W1] every ready-bound operation base and cutover projection must be byte-identical', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const poisonBase = (repo, mutateBase) => {
    const before = protocol.__testing.inspectProtocol({ repo });
    assert.ok(before.publication.operation, 'fixture requires retained operation');
    const projection = protocol.__testing.buildPublication({
      ...before.publication,
      operation: null,
      publication_digest: undefined,
    });
    const base = protocol.__testing.buildPublication({
      ...mutateBase(projection),
      publication_digest: undefined,
    });
    const baseBytes = protocol.__testing.encodePublication(base);
    const baseOid = git(repo, ['hash-object', '-w', '--stdin'], { input: baseBytes });
    writePublicationAuthority(repo, protocol, {
      ...before.publication,
      operation: {
        ...before.publication.operation,
        base_publication_oid: baseOid,
      },
    }, before.publication_oid);
  };

  for (const phase of ['prepared', 'committed', 'pending', 'failed', 'restored', 'aborted']) {
    await t.test(`ready-bound:${phase}`, () => {
      const fixture = retainOperationAtPhase(protocol, phase);
      poisonBase(fixture.repo, (projection) => ({
        ...projection,
        selected_slot: null,
        selected_record_seq: null,
        selected_record_digest: null,
        session: null,
      }));
      const before = protocolSnapshot(fixture.repo);
      const result = protocol.ensureCutover({
        repo: fixture.repo,
        processProbe: () => ({ status: 'dead' }),
      });
      assert.equal(result.status, 'manual');
      assert.match(result.reason, /base publication|binding|byte-identical|manual|projection/u);
      assertSnapshotEqual(before, protocolSnapshot(fixture.repo), phase);
    });
  }

  await t.test('publication-sequence', () => {
    const fixture = retainOperationAtPhase(protocol, 'committed');
    poisonBase(fixture.repo, (projection) => ({
      ...projection,
      publication_seq: (BigInt(projection.publication_seq) + 1n).toString(),
    }));
    const before = protocolSnapshot(fixture.repo);
    const result = protocol.ensureCutover({
      repo: fixture.repo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(result.status, 'manual');
    assert.match(result.reason, /base publication|binding|byte-identical|manual|projection/u);
    assertSnapshotEqual(before, protocolSnapshot(fixture.repo));
  });

  await t.test('selected-session-lease', () => {
    const fixture = retainOperationAtPhase(protocol, 'committed');
    poisonBase(fixture.repo, (projection) => {
      const recordDigest = 'f'.repeat(64);
      const session = {
        ...projection.session,
        record_digest: recordDigest,
      };
      session.lease_id = sessionLease({
        cutover_id: projection.cutover_id,
        session_id: session.session_id,
        record_seq: session.record_seq,
        record_digest: recordDigest,
      });
      return {
        ...projection,
        selected_record_digest: recordDigest,
        session,
      };
    });
    const before = protocolSnapshot(fixture.repo);
    const result = protocol.ensureCutover({
      repo: fixture.repo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(result.status, 'manual');
    assert.match(result.reason, /base publication|binding|byte-identical|manual|projection/u);
    assertSnapshotEqual(before, protocolSnapshot(fixture.repo));
  });

  await t.test('cutover-phase', () => {
    const repo = createGitFixture('r2-w1-cutover-phase');
    protocol.ensureCutover({ repo });
    const idle = protocol.__testing.inspectProtocol({ repo });
    const badBase = protocol.__testing.buildPublication({
      ...idle.publication,
      cutover_phase: 'mutual-slots',
      operation: null,
      publication_digest: undefined,
    });
    const baseOid = git(repo, ['hash-object', '-w', '--stdin'], {
      input: protocol.__testing.encodePublication(badBase),
    });
    installOperation(repo, protocol, { baseOid });
    const before = protocolSnapshot(repo);
    const result = protocol.ensureCutover({
      repo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(result.status, 'manual');
    assert.match(result.reason, /base publication|binding|byte-identical|manual|projection/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });
});

test('[R2 W2] new-session headroom is read-only for null, departed, and losing-CAS operations', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  await t.test('operation-null', () => {
    const repo = createGitFixture('r2-w2-null');
    exhaustReadyIdleSlots(repo, protocol);
    const target = 'src/null-exhausted.txt';
    writeRepoFile(repo, target);
    const before = protocolSnapshot(repo);
    const objects = gitObjectInventory(repo);
    assert.throws(() => protocol.performMutation({ repo, files: [target] }), /record-sequence-exhausted/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
    assert.deepEqual(gitObjectInventory(repo), objects);
  });

  await t.test('departed-operation', () => {
    const repo = createGitFixture('r2-w2-departed');
    exhaustReadyIdleSlots(repo, protocol);
    installOperation(repo, protocol);
    const target = 'src/departed-exhausted.txt';
    writeRepoFile(repo, target);
    const before = protocolSnapshot(repo);
    const objects = gitObjectInventory(repo);
    assert.throws(() => protocol.performMutation({
      repo,
      files: [target],
      processProbe: () => ({ status: 'dead' }),
    }), /record-sequence-exhausted/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
    assert.deepEqual(gitObjectInventory(repo), objects);
  });

  await t.test('losing-CAS', () => {
    const repo = createGitFixture('r2-w2-losing-cas');
    exhaustReadyIdleSlots(repo, protocol, '4294967287');
    const target = 'src/losing-cas.txt';
    writeRepoFile(repo, target);
    let racedSnapshot = null;
    let racedObjects = null;
    assert.throws(() => protocol.performMutation({
      repo,
      files: [target],
      authorityTransitionHook({ stage, purpose }) {
        if (racedSnapshot !== null
            || stage !== 'after-pre-inventory'
            || purpose !== 'operation-acquire') return;
        const state = protocol.__testing.inspectProtocol({ repo });
        for (const slot of state.slots) {
          const record = protocol.__testing.buildRecord({
            ...slot.record,
            record_seq: '4294967295',
            record_digest: undefined,
          });
          writeFileSync(join(repo, v3SlotRelative(slot.slot)), protocol.__testing.encodeRecord(record));
        }
        writePublicationAuthority(repo, protocol, {
          ...state.publication,
          publication_seq: (BigInt(state.publication.publication_seq) + 1n).toString(),
        }, state.publication_oid);
        racedSnapshot = protocolSnapshot(repo);
        racedObjects = gitObjectInventory(repo);
      },
    }), /compare-and-swap|CAS|record-sequence-exhausted/u);
    assert.ok(racedSnapshot, 'losing-CAS fixture did not advance authority');
    assertSnapshotEqual(racedSnapshot, protocolSnapshot(repo));
    assert.deepEqual(gitObjectInventory(repo), racedObjects);
    assert.equal(stageEntry(repo, target).length, 0);
  });
});

test('[R2 W3] add failure remains primary across pending, terminal, session, and operation cleanup', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const directCase = (mode, expectedStage, failingUpdate) => {
    const repo = createGitFixture(`r2-w3-direct-${mode}`);
    const target = `src/direct-${mode}.txt`;
    writeRepoFile(repo, target);
    let afterAdd = false;
    let updates = 0;
    const runner = (gitRepo, args, options = {}) => {
      if (args[0] === 'add') {
        const result = gitResult(gitRepo, args, options);
        assert.equal(result.code, 0);
        afterAdd = true;
        return { ...result, code: 1, stderr: Buffer.from('primary direct add failure\n') };
      }
      if (afterAdd && args.includes('update-ref')) {
        updates += 1;
        if (updates === failingUpdate) {
          return {
            code: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(`injected ${mode} cleanup failure\n`),
          };
        }
      }
      return gitResult(gitRepo, args, options);
    };
    const error = captureError(() => protocol.performMutation({
      repo,
      files: [target],
      gitRunner: runner,
    }));
    assert.deepEqual(error.failures.map((failure) => failure.stage), ['primary', expectedStage]);
    assert.match(error.failures[0].message, /primary direct add failure/u);
    assert.match(error.failures[1].message, /publication compare-and-swap|release|base-OID/u);
    const serialized = protocol.__testing.serializeProtocolError(error);
    assert.deepEqual(serialized.failures, error.failures);
  };

  await t.test('direct-pending-intent', () => {
    directCase('pending', 'pending-intent-publication', 1);
  });
  await t.test('direct-terminal-publication', () => {
    directCase('terminal', 'terminal-publication', 2);
  });
  await t.test('direct-session-release', () => {
    directCase('session', 'session-release', 3);
  });
  await t.test('direct-operation-release', () => {
    directCase('operation', 'operation-release', 4);
  });

  for (const [mode, stage] of [
    ['pending', 'pending-intent-publication'],
    ['terminal', 'terminal-publication'],
  ]) {
    await t.test(`framed-cli-${mode}`, () => {
      const repo = createGitFixture(`r2-w3-cli-${mode}`);
      const target = `src/cli-${mode}.txt`;
      writeRepoFile(repo, target);
      protocol.ensureCutover({ repo });
      const request = protocol.__testing.buildCliRequest({
        protocol: 'deep-review-mutation-v3',
        command: 'perform',
        repo,
        owner_token: null,
        files: [target],
      });
      const result = spawnFramed(request, { env: gitFailureShim(repo, mode) });
      assert.notEqual(result.status, 0);
      assert.equal(result.stderr, '');
      const body = JSON.parse(result.stdout);
      assert.equal(body.ok, false);
      assert.deepEqual(body.error.failures.map((failure) => failure.stage), ['primary', stage]);
      assert.match(body.error.failures[0].message, /primary cli add failure/u);
    });
  }
});

test('[R2 C3 group 4] real local Bash races every fence boundary and exactly one writer wins', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const bashVersion = spawnSync('bash', ['--version'], { encoding: 'utf8', shell: false });
  if (process.platform === 'win32' || bashVersion.error?.code === 'ENOENT') {
    capabilitySkip(t, 'bash-unavailable');
    return;
  }
  for (const barrier of [
    'node-fence-created',
    'bash-directory-created',
    'bash-marker-created',
    'fence-inventory-bound',
  ]) {
    await t.test(barrier, () => {
      const repo = createGitFixture(`r2-c3-g4-bash-${barrier}`);
      const target = `src/bash-${barrier}.txt`;
      writeRepoFile(repo, target);
      let oldResult = null;
      const newResult = protocol.ensureCutover({
        repo,
        fenceHook(label) {
          if (label === barrier) oldResult = runRealOldBash(repo, 'perform', target);
        },
      });
      assert.ok(oldResult, `${barrier}: real Bash child did not run`);
      if (oldResult.status === 0) {
        assert.equal(newResult.status, 'manual', `${barrier}: v3 reported ready after Bash won`);
        assert.equal(readRef(repo), null, `${barrier}: v3 authority appeared after Bash won`);
        assert.ok(stageEntry(repo, target).length > 0, `${barrier}: Bash winner lacks ITA`);
        assert.equal(existsSync(join(repo, legacyStateRelative)), true);
      } else {
        assert.equal(newResult.status, 'ready', `${barrier}: neither writer won: ${oldResult.stderr}`);
        assert.equal(stageEntry(repo, target).length, 0, `${barrier}: rejected Bash changed index`);
        assert.equal(existsSync(join(repo, legacyStateRelative)), false);
        assertProtocolIdle(protocol.__testing.inspectProtocol({ repo }));
      }
    });
  }
});

test('[R2 C3 group 11] production authority transitions survive real Git child kills with exact OLD-or-NEW evidence', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const rows = [
    ['operation-acquire', 1],
    ['prepared', 2],
    ['committed', 3],
    ['session-release', 4],
    ['operation-release', 2],
  ];
  for (const [purpose, killAt] of rows) {
    for (const boundary of ['prepared', 'mid-commit', 'post-commit']) {
      await t.test(`${purpose}:${boundary}`, () => {
        const repo = createGitFixture(`r2-c3-g11-${purpose}-${boundary}`);
        const target = `src/${purpose}-${boundary}.txt`;
        const ownerToken = canonicalOwnerToken();
        writeRepoFile(repo, target);
        protocol.ensureCutover({ repo });
        let performed = null;
        if (purpose === 'session-release') {
          performed = protocol.performMutation({ repo, files: [target], ownerToken });
        }
        let transactions = 0;
        let evidence = null;
        const runner = (gitRepo, args, options = {}) => {
          if (args.includes('update-ref') && args.includes('--stdin')
              && !options.input?.equals(Buffer.from('start\0abort\0', 'latin1'))) {
            transactions += 1;
            if (transactions === killAt) {
              const before = protocolSnapshot(repo);
              const oldOid = before.ref.oid;
              const newOid = transactionNewOid(options.input);
              const result = killRealUpdateRefTransaction(repo, options.input, boundary);
              const after = protocolSnapshot(repo);
              const publication = protocol.__testing.decodePublication(after.ref.bytes);
              const selectedBytes = publication.session === null
                ? null
                : readFileSync(join(repo, v3SlotRelative(publication.selected_slot)));
              evidence = {
                before,
                after,
                oldOid,
                newOid,
                publication,
                selectedBytes,
                result,
              };
              return result;
            }
          }
          return gitResult(gitRepo, args, options);
        };

        if (purpose === 'session-release') {
          captureError(() => protocol.restoreMutation({
            repo,
            ownerToken: performed.owner_token,
            gitRunner: runner,
          }));
        } else if (purpose === 'operation-release') {
          const result = protocol.ensureCutover({ repo, gitRunner: runner });
          assert.equal(result.status, 'manual');
        } else {
          captureError(() => protocol.performMutation({
            repo,
            files: [target],
            ownerToken,
            gitRunner: runner,
          }));
        }

        assert.ok(evidence, `${purpose}:${boundary} did not reach targeted transaction`);
        assert.equal(evidence.result.code, 97);
        assert.equal(
          [evidence.oldOid, evidence.newOid].includes(evidence.after.ref.oid),
          true,
          `${purpose}:${boundary} exposed neither OLD nor NEW`,
        );
        const expectedBlob = gitResult(repo, ['cat-file', 'blob', evidence.after.ref.oid]).stdout;
        assert.deepEqual(evidence.after.ref.bytes, expectedBlob);
        assert.deepEqual(evidence.after.files, evidence.before.files);
        assert.equal(evidence.after.index, evidence.before.index);
        assert.equal(evidence.after.staged, evidence.before.staged);
        if (evidence.publication.session !== null) {
          const record = protocol.__testing.decodeRecord(evidence.selectedBytes);
          assert.equal(evidence.publication.session.lease_id, sessionLease(record));
          assert.equal(evidence.publication.session.record_digest, record.record_digest);
        }

        if (purpose === 'operation-release') {
          assert.equal(protocol.ensureCutover({
            repo,
            processProbe: () => ({ status: 'dead' }),
          }).status, 'ready');
        } else {
          let state = protocol.__testing.inspectProtocol({ repo });
          if (state.publication.session === null && purpose !== 'session-release') {
            protocol.performMutation({
              repo,
              files: [target],
              ownerToken,
              processProbe: () => ({ status: 'dead' }),
            });
            state = protocol.__testing.inspectProtocol({ repo });
          }
          if (state.publication.session !== null) {
            assert.equal(protocol.restoreMutation({
              repo,
              ownerToken,
              processProbe: () => ({ status: 'dead' }),
            }).status, 'restored');
          } else {
            assert.equal(protocol.restoreMutation({
              repo,
              ownerToken,
              processProbe: () => ({ status: 'dead' }),
            }).status, 'noop');
          }
        }
        assertProtocolIdle(protocol.__testing.inspectProtocol({ repo }));
        assert.equal(stageEntry(repo, target).length, 0);
      });
    }
  }
});

test('[R2 C3 group 17] both recovery kinds retain exact operation-release evidence before one retry', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const kind of ['abort-prepared', 'restore-committed']) {
    await t.test(kind, () => {
      const fixture = recoveryFixture(protocol, kind, 'operation-release-evidence');
      let boundary = null;
      const error = captureError(() => protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
        authorityTransitionHook({ stage, purpose }) {
          if (boundary === null && stage === 'after-pre-inventory' && purpose === 'operation-release') {
            boundary = protocolSnapshot(fixture.repo);
            throw new Error(`crash before ${kind} operation release CAS`);
          }
        },
      }));
      assert.match(error.message, /operation release|crash before/u);
      assert.ok(boundary, `${kind}: operation-release boundary not reached`);
      const retained = protocolSnapshot(fixture.repo);
      assertSnapshotEqual(boundary, retained, `${kind}: post-boundary state drifted`);
      const publication = protocol.__testing.decodePublication(retained.ref.bytes);
      assert.equal(publication.session, null);
      assert.ok(publication.operation);
      assert.equal(stageEntry(fixture.repo, fixture.target).length, 0);
      const baseBytes = gitResult(
        fixture.repo,
        ['cat-file', 'blob', publication.operation.base_publication_oid],
      ).stdout;
      const expectedBase = protocol.__testing.encodePublication(
        protocol.__testing.buildPublication({
          ...publication,
          operation: null,
          publication_digest: undefined,
        }),
      );
      assert.deepEqual(baseBytes, expectedBase);
      assert.equal(protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
        processProbe: () => ({ status: 'dead' }),
      }).status, 'noop');
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo: fixture.repo }));
    });
  }
});

test('[R2 C3 group 19] production operation and session liveness covers every result and failure class', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const operationRows = [
    ['live', {}, () => ({ status: 'live', startMs: protocol.__testing.processStartMs() }), 'manual'],
    ['reuse', {}, () => ({ status: 'live', startMs: protocol.__testing.processStartMs() + 1 }), 'manual'],
    ['eperm', {}, () => ({ status: 'eperm' }), 'manual'],
    ['esrch', {}, () => ({ status: 'dead' }), 'ready'],
    ['foreign', { host_hash: 'f'.repeat(64) }, () => ({ status: 'dead' }), 'manual'],
    [
      'future',
      { process_start_ms: String(Date.now() + 3_600_000) },
      () => ({ status: 'dead' }),
      'manual',
    ],
  ];
  for (const [label, operation, processProbe, status] of operationRows) {
    await t.test(`operation:${label}`, () => {
      const repo = createGitFixture(`r2-c3-g19-operation-${label}`);
      protocol.ensureCutover({ repo });
      installOperation(repo, protocol, { operation });
      const before = protocolSnapshot(repo);
      const result = protocol.ensureCutover({ repo, processProbe });
      assert.equal(result.status, status);
      const after = protocolSnapshot(repo);
      assert.equal(after.index, before.index);
      assert.deepEqual(after.files, before.files);
      assert.equal(after.staged, before.staged);
      if (status === 'manual') assertSnapshotEqual(before, after, label);
      else assert.equal(protocol.__testing.inspectProtocol({ repo }).publication.operation, null);
    });
  }

  await t.test('operation:reconcile-failure', () => {
    const repo = createGitFixture('r2-c3-g19-operation-reconcile-failure');
    protocol.ensureCutover({ repo });
    installOperation(repo, protocol);
    const before = protocolSnapshot(repo);
    const result = protocol.ensureCutover({
      repo,
      processProbe: () => ({ status: 'dead' }),
      gitRunner(gitRepo, args, options = {}) {
        if (args.includes('update-ref')) return releaseFailureResult();
        return gitResult(gitRepo, args, options);
      },
    });
    assert.equal(result.status, 'manual');
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });

  await t.test('operation:release-failure', () => {
    const repo = createGitFixture('r2-c3-g19-operation-release-failure');
    protocol.ensureCutover({ repo });
    const result = protocol.ensureCutover({
      repo,
      authorityTransitionHook({ stage, purpose }) {
        if (stage === 'after-pre-inventory' && purpose === 'operation-release') {
          throw new Error('injected operation release failure');
        }
      },
    });
    assert.equal(result.status, 'manual');
    assert.match(result.reason, /operation release failure|inventory freeze/u);
    assert.ok(protocol.__testing.inspectProtocol({ repo }).publication.operation);
  });

  const sessionRows = [
    ['live', null, () => ({ status: 'live', startMs: protocol.__testing.processStartMs() }), 'active', 'live'],
    ['reuse', null, () => ({ status: 'live', startMs: protocol.__testing.processStartMs() + 1 }), 'active', 'uncertain'],
    ['eperm', null, () => ({ status: 'eperm' }), 'active', 'uncertain'],
    ['esrch', null, () => ({ status: 'dead' }), 'restored', null],
    ['foreign', { owner_process: { host_hash: 'f'.repeat(64) } }, () => ({ status: 'dead' }), 'manual', 'session-foreign'],
    [
      'future',
      { started_at: new Date(Date.now() + 600_000).toISOString() },
      () => ({ status: 'dead' }),
      'manual',
      'session-manual',
    ],
  ];
  for (const [label, mutation, processProbe, status, reason] of sessionRows) {
    await t.test(`session:${label}`, () => {
      const repo = createGitFixture(`r2-c3-g19-session-${label}`);
      const target = `src/session-${label}.txt`;
      writeRepoFile(repo, target);
      protocol.performMutation({ repo, files: [target] });
      if (mutation) {
        const selected = protocol.__testing.inspectProtocol({ repo }).selectedRecord;
        const ownerProcess = mutation.owner_process
          ? { ...selected.owner_process, ...mutation.owner_process }
          : selected.owner_process;
        rewriteSelectedRecordOwner(repo, protocol, {
          ...mutation,
          owner_process: ownerProcess,
        });
      }
      const before = protocolSnapshot(repo);
      const result = protocol.autoRecover({
        repo,
        now: Date.now() + 120_000,
        staleMs: 0,
        processProbe,
      });
      assert.equal(result.status, status);
      if (reason !== null) assert.equal(result.reason, reason);
      if (status === 'restored') {
        assertProtocolIdle(protocol.__testing.inspectProtocol({ repo }));
        assert.equal(stageEntry(repo, target).length, 0);
      } else {
        assertSnapshotEqual(before, protocolSnapshot(repo), label);
      }
    });
  }

  const malformed = makeActiveRecord('committed');
  assert.throws(() => protocol.__testing.buildRecord({
    ...malformed,
    owner_process: { host_hash: null, pid: malformed.owner_process.pid, process_start_ms: null },
  }), /owner process|all-null|mixed/u);
});

test('[R2 C3 groups 2,3,9,10,12,14,20,21,22] literal production and child evidence matrix', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  await t.test('group-2 all poisoned Git families and symlink index stay confined', (row) => {
    const repo = createGitFixture('r2-c3-g2-target');
    const foreign = createGitFixture('r2-c3-g2-foreign');
    const foreignBefore = protocolSnapshot(foreign);
    const result = protocol.ensureCutover({
      repo,
      env: {
        ...process.env,
        GIT_DIR: join(foreign, '.git'),
        git_work_tree: foreign,
        GiT_cOmMoN_dIr: join(foreign, '.git'),
        GIT_INDEX_FILE: indexPath(foreign),
        git_object_directory: join(foreign, '.git', 'objects'),
        GiT_AlTeRnAtE_oBjEcT_DiReCtOrIeS: join(foreign, '.git', 'objects'),
        GIT_NAMESPACE: 'foreign',
        git_config_count: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        Git_Config_Value_0: foreign,
      },
    });
    assert.equal(result.status, 'ready');
    assertSnapshotEqual(foreignBefore, protocolSnapshot(foreign));

    const linkedIndexRepo = createGitFixture('r2-c3-g2-symlink-index');
    const originalIndex = indexPath(linkedIndexRepo);
    const heldIndex = `${originalIndex}.physical-for-test`;
    renameSync(originalIndex, heldIndex);
    try {
      symlinkSync(heldIndex, originalIndex);
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      capabilitySkip(row, 'fs-symlink-privilege-unavailable');
      return;
    }
    const before = protocolSnapshot(linkedIndexRepo);
    const refused = protocol.ensureCutover({ repo: linkedIndexRepo });
    assert.equal(refused.status, 'manual');
    assert.match(refused.reason, /index|topology|physical/u);
    assertSnapshotEqual(before, protocolSnapshot(linkedIndexRepo));
  });

  await t.test('group-3 special-object legacy state is byte-identical manual', (row) => {
    if (process.platform === 'win32') {
      capabilitySkip(row, 'fs-junction-privilege-unavailable');
      return;
    }
    const repo = createGitFixture('r2-c3-g3-special');
    mkdirSync(join(repo, '.deep-review'));
    const fifo = join(repo, legacyStateRelative);
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', shell: false });
    assert.equal(made.status, 0, made.stderr);
    const before = protocolSnapshot(repo);
    const result = protocol.ensureCutover({ repo });
    assert.deepEqual(result, { status: 'manual', reason: 'legacy-not-quiescent' });
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });

  await t.test('group-9 real process crashes during inactive writes cannot authorize replaced survivors', () => {
    const crashDuringWrite = (repo, command, target, ownerToken = null) => {
      const invocation = command === 'perform'
        ? `performMutation({repo:${JSON.stringify(repo)},files:[${JSON.stringify(target)}],slotWriteHook:crash})`
        : `restoreMutation({repo:${JSON.stringify(repo)},ownerToken:${JSON.stringify(ownerToken)},slotWriteHook:crash})`;
      const source = [
        "import { writeFileSync } from 'node:fs';",
        `import { performMutation, restoreMutation } from ${JSON.stringify(protocolUrl)};`,
        "const crash=({fd})=>{writeFileSync(fd,Buffer.from('{torn'));process.kill(process.pid,'SIGKILL');};",
        `${invocation};`,
      ].join('\n');
      return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
    };

    const idleRepo = createGitFixture('r2-c3-g9-idle-crash');
    const idleTarget = 'src/idle-crash.txt';
    writeRepoFile(idleRepo, idleTarget);
    protocol.ensureCutover({ repo: idleRepo });
    const idleCrash = crashDuringWrite(idleRepo, 'perform', idleTarget);
    assertForceKilled(idleCrash);
    const idleState = protocol.__testing.inspectProtocol({ repo: idleRepo });
    const idleSurvivor = idleState.slots.find((slot) => slot.record !== null);
    replaceFileIdentity(join(idleRepo, v3SlotRelative(idleSurvivor.slot)));
    const idleBefore = protocolSnapshot(idleRepo);
    const idleResult = protocol.ensureCutover({
      repo: idleRepo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(idleResult.status, 'manual');
    assertSnapshotEqual(idleBefore, protocolSnapshot(idleRepo));

    const selectedRepo = createGitFixture('r2-c3-g9-selected-crash');
    const selectedTarget = 'src/selected-crash.txt';
    writeRepoFile(selectedRepo, selectedTarget);
    const performed = protocol.performMutation({ repo: selectedRepo, files: [selectedTarget] });
    const selectedCrash = crashDuringWrite(
      selectedRepo,
      'restore',
      selectedTarget,
      performed.owner_token,
    );
    assertForceKilled(selectedCrash);
    const selected = protocol.__testing.inspectProtocol({ repo: selectedRepo });
    replaceFileIdentity(join(selectedRepo, v3SlotRelative(selected.publication.selected_slot)));
    const selectedBefore = protocolSnapshot(selectedRepo);
    const selectedResult = protocol.ensureCutover({
      repo: selectedRepo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(selectedResult.status, 'manual');
    assertSnapshotEqual(selectedBefore, protocolSnapshot(selectedRepo));
  });

  await t.test('group-10 prepared bytes precede publication and pre-CAS crash reaches no index', () => {
    const repo = createGitFixture('r2-c3-g10-prepared-order');
    const target = 'src/prepared-order.txt';
    writeRepoFile(repo, target);
    protocol.ensureCutover({ repo });
    let boundary = null;
    const error = captureError(() => protocol.performMutation({
      repo,
      files: [target],
      authorityTransitionHook({ stage, purpose }) {
        if (boundary === null && stage === 'after-pre-inventory' && purpose === 'publication-transition') {
          boundary = protocolSnapshot(repo);
          throw new Error('crash after prepared bytes before publication');
        }
      },
    }));
    assert.match(error.message, /prepared bytes|inventory freeze/u);
    assert.ok(boundary);
    const preparedSlots = Object.entries(boundary.files)
      .filter(([name]) => name.startsWith('.pending-mutation.v3.'))
      .map(([, encoded]) => protocol.__testing.decodeRecord(
        Buffer.from(encoded, 'base64'),
        { allowNullPeer: true },
      ))
      .filter((record) => record.phase === 'prepared');
    assert.equal(preparedSlots.length, 1);
    assert.equal(protocol.__testing.decodePublication(boundary.ref.bytes).session, null);
    assert.equal(stageEntry(repo, target).length, 0);
  });

  await t.test('group-12 SHA-256 production kill treats OIDs as opaque and converges', (row) => {
    let repo;
    try {
      repo = createGitFixture('r2-c3-g12-sha256-kill', { objectFormat: 'sha256' });
    } catch (error) {
      capabilitySkip(row, 'git-sha256-unavailable');
      return;
    }
    const target = 'src/sha256-kill.txt';
    const ownerToken = canonicalOwnerToken();
    writeRepoFile(repo, target);
    protocol.ensureCutover({ repo });
    let evidence = null;
    const runner = (gitRepo, args, options = {}) => {
      if (evidence === null && args.includes('update-ref') && args.includes('--stdin')
          && !options.input?.equals(Buffer.from('start\0abort\0', 'latin1'))) {
        const oldOid = readRef(repo);
        const newOid = transactionNewOid(options.input);
        const result = killRealUpdateRefTransaction(repo, options.input, 'mid-commit');
        evidence = { oldOid, newOid, observed: readRef(repo) };
        return result;
      }
      return gitResult(gitRepo, args, options);
    };
    captureError(() => protocol.performMutation({
      repo,
      files: [target],
      ownerToken,
      gitRunner: runner,
    }));
    assert.equal(evidence.oldOid.length, 64);
    assert.equal(evidence.newOid.length, 64);
    assert.equal([evidence.oldOid, evidence.newOid].includes(evidence.observed), true);
    protocol.performMutation({
      repo,
      files: [target],
      ownerToken,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(protocol.restoreMutation({
      repo,
      ownerToken,
      processProbe: () => ({ status: 'dead' }),
    }).status, 'restored');
  });

  await t.test('group-20 reserved reflog races freeze prepared, committed, session, and operation transitions', () => {
    const runRace = (label) => {
      const repo = createGitFixture(`r2-c3-g20-${label}`);
      const target = `src/${label}.txt`;
      const ownerToken = canonicalOwnerToken();
      writeRepoFile(repo, target);
      protocol.ensureCutover({ repo });
      let performed = null;
      if (label === 'session-release') {
        performed = protocol.performMutation({ repo, files: [target], ownerToken });
      }
      const foreignRef = `${publicationRef.slice(0, -'publication'.length)}race-${label}`;
      const foreignOid = git(repo, ['hash-object', '-w', '--stdin'], {
        input: Buffer.from(`race-${label}\n`),
      });
      let publicationTransitions = 0;
      let injected = false;
      const hook = ({ stage, purpose }) => {
        if (stage !== 'after-pre-inventory' || injected) return;
        if (purpose === 'publication-transition') publicationTransitions += 1;
        const matches = (label === 'prepared' && purpose === 'publication-transition' && publicationTransitions === 1)
          || (label === 'committed' && purpose === 'publication-transition' && publicationTransitions === 2)
          || (label === 'session-release' && purpose === 'publication-transition' && publicationTransitions === 3)
          || (label === 'operation-release' && purpose === 'operation-release');
        if (!matches) return;
        injected = true;
        git(repo, ['update-ref', '--create-reflog', foreignRef, foreignOid]);
      };
      if (label === 'session-release') {
        captureError(() => protocol.restoreMutation({
          repo,
          ownerToken: performed.owner_token,
          authorityTransitionHook: hook,
        }));
      } else if (label === 'operation-release') {
        const result = protocol.ensureCutover({ repo, authorityTransitionHook: hook });
        assert.equal(result.status, 'manual');
      } else {
        captureError(() => protocol.performMutation({
          repo,
          files: [target],
          ownerToken,
          authorityTransitionHook: hook,
        }));
      }
      assert.equal(injected, true, `${label}: reflog race not injected`);
      assert.equal(gitResult(repo, ['reflog', 'exists', foreignRef]).code, 0);
      assert.equal(readRef(repo === undefined ? '' : repo) !== null, true);
    };
    for (const label of ['prepared', 'committed', 'session-release', 'operation-release']) {
      runRace(label);
    }
    const always = createGitFixture('r2-c3-g20-log-always');
    git(always, ['config', 'core.logAllRefUpdates', 'always']);
    assert.equal(protocol.ensureCutover({ repo: always }).status, 'ready');
    const listed = gitResult(always, ['for-each-ref', '--format=%(refname)', 'refs/worktree/deep-review/mutation/v3/']).stdout.toString('utf8').trim().split('\n').filter(Boolean);
    assert.deepEqual(listed, [publicationRef]);
  });

  await t.test('group-21 selected same-byte replacement never falls back to valid inactive slot', () => {
    const repo = createGitFixture('r2-c3-g21-selected-identity');
    const target = 'src/selected-identity.txt';
    writeRepoFile(repo, target);
    const performed = protocol.performMutation({ repo, files: [target] });
    const selected = protocol.__testing.inspectProtocol({ repo }).publication.selected_slot;
    replaceFileIdentity(join(repo, v3SlotRelative(selected)));
    const before = protocolSnapshot(repo);
    assert.throws(() => protocol.restoreMutation({
      repo,
      ownerToken: performed.owner_token,
    }), /selected|identity|binding|slot|manual/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
    assert.ok(stageEntry(repo, target).length > 0);
  });

  await t.test('group-22 framed Unicode lifecycle and linked-worktree isolation are exact', () => {
    const zero = createGitFixture('r2-c3-g22-framed-zero', { initialCommit: false });
    const target = 'src/한 글 Ω [x].txt';
    writeRepoFile(zero, target);
    const perform = protocol.__testing.buildCliRequest({
      protocol: 'deep-review-mutation-v3',
      command: 'perform',
      repo: zero,
      owner_token: null,
      files: [target],
    });
    const performed = parseCliOutput(spawnFramed(perform));
    assert.equal(performed.status, 'committed');
    const restore = protocol.__testing.buildCliRequest({
      protocol: 'deep-review-mutation-v3',
      command: 'restore',
      repo: zero,
      owner_token: performed.owner_token,
      files: [],
    });
    assert.equal(parseCliOutput(spawnFramed(restore)).status, 'restored');
    assert.equal(stageEntry(zero, target).length, 0);
    assert.throws(() => protocol.performMutation({
      repo: zero,
      files: ['bad\0separator.txt'],
    }), /NUL|scalar|path/u);

    const main = createGitFixture('r2-c3-g22-main');
    const linked = join(fixtureRootFor(main), 'r2-c3-g22-linked');
    git(main, ['worktree', 'add', '--quiet', '-b', 'r2-c3-g22-linked-branch', linked]);
    protocol.ensureCutover({ repo: main });
    protocol.ensureCutover({ repo: linked });
    const mainBefore = protocolSnapshot(main);
    const linkedTarget = 'src/linked 격리.txt';
    writeRepoFile(linked, linkedTarget);
    const linkedPerformed = protocol.performMutation({ repo: linked, files: [linkedTarget] });
    assertSnapshotEqual(mainBefore, protocolSnapshot(main));
    assert.equal(protocol.restoreMutation({
      repo: linked,
      ownerToken: linkedPerformed.owner_token,
    }).status, 'restored');
    assertSnapshotEqual(mainBefore, protocolSnapshot(main));
  });
});

test('[R2 C3 groups 5,6,7,13,15,18] bounded reads, exhaustion, durability, foreign state, and retry matrix', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  await t.test('group-5 selected, inactive, cutover, and recovery oversized slots refuse before parse', () => {
    const oversized = Buffer.alloc(1_048_577, 0x78);

    const selectedRepo = createGitFixture('r2-c3-g5-selected');
    const selectedTarget = 'src/oversized-selected.txt';
    writeRepoFile(selectedRepo, selectedTarget);
    const selectedPerformed = protocol.performMutation({ repo: selectedRepo, files: [selectedTarget] });
    const selectedState = protocol.__testing.inspectProtocol({ repo: selectedRepo });
    writeFileSync(
      join(selectedRepo, v3SlotRelative(selectedState.publication.selected_slot)),
      oversized,
    );
    const selectedBefore = protocolSnapshot(selectedRepo);
    assert.throws(() => protocol.restoreMutation({
      repo: selectedRepo,
      ownerToken: selectedPerformed.owner_token,
    }), /size|oversized|slot|manual/u);
    assertSnapshotEqual(selectedBefore, protocolSnapshot(selectedRepo));

    const inactiveRepo = createGitFixture('r2-c3-g5-inactive');
    protocol.ensureCutover({ repo: inactiveRepo });
    writeFileSync(join(inactiveRepo, v3SlotRelative('b')), oversized);
    const inactiveBefore = protocolSnapshot(inactiveRepo);
    const inactiveResult = protocol.ensureCutover({ repo: inactiveRepo });
    assert.equal(inactiveResult.status, 'manual');
    assertSnapshotEqual(inactiveBefore, protocolSnapshot(inactiveRepo));

    const cutoverRepo = createGitFixture('r2-c3-g5-cutover');
    assert.throws(() => protocol.ensureCutover({
      repo: cutoverRepo,
      cutoverHook(label) {
        if (label === 'slot-a-captured') throw new Error('retain cutover slot A');
      },
    }), /retain cutover/u);
    writeFileSync(join(cutoverRepo, v3SlotRelative('a')), oversized);
    const cutoverBefore = protocolSnapshot(cutoverRepo);
    const cutoverResult = protocol.ensureCutover({
      repo: cutoverRepo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(cutoverResult.status, 'manual');
    const cutoverAfter = protocolSnapshot(cutoverRepo);
    assert.deepEqual(cutoverAfter.files, cutoverBefore.files);
    assert.equal(cutoverAfter.index, cutoverBefore.index);
    assert.equal(cutoverAfter.staged, cutoverBefore.staged);
    const cutoverBeforePublication = protocol.__testing.decodePublication(cutoverBefore.ref.bytes);
    const cutoverAfterPublication = protocol.__testing.decodePublication(cutoverAfter.ref.bytes);
    assert.equal(cutoverAfterPublication.cutover_phase, cutoverBeforePublication.cutover_phase);
    assert.equal(cutoverAfterPublication.session, null);
    assert.equal(cutoverAfterPublication.operation, null);

    const recoveryRepo = createGitFixture('r2-c3-g5-recovery');
    const recoveryTarget = 'src/oversized-recovery.txt';
    writeRepoFile(recoveryRepo, recoveryTarget);
    const recoveryPerformed = protocol.performMutation({ repo: recoveryRepo, files: [recoveryTarget] });
    assert.throws(() => protocol.restoreMutation({
      repo: recoveryRepo,
      ownerToken: recoveryPerformed.owner_token,
      transitionHook(label) {
        if (label === 'recovery-attempt:restore-committed:pending:1') {
          throw new Error('retain pending recovery record');
        }
      },
    }), /retain pending/u);
    const recoveryState = protocol.__testing.inspectProtocol({ repo: recoveryRepo });
    writeFileSync(
      join(recoveryRepo, v3SlotRelative(recoveryState.publication.selected_slot)),
      oversized,
    );
    const recoveryBefore = protocolSnapshot(recoveryRepo);
    assert.throws(() => protocol.restoreMutation({
      repo: recoveryRepo,
      ownerToken: recoveryPerformed.owner_token,
    }), /size|oversized|slot|manual/u);
    assertSnapshotEqual(recoveryBefore, protocolSnapshot(recoveryRepo));
  });

  await t.test('group-6 current-maximum successor refuses before object, slot, or index mutation', () => {
    const repo = createGitFixture('r2-c3-g6-current-max');
    const target = 'src/current-max.txt';
    writeRepoFile(repo, target);
    const performed = protocol.performMutation({ repo, files: [target] });
    rewriteSelectedRecordSequence(repo, protocol, '4294967295');
    const before = protocolSnapshot(repo);
    const objects = gitObjectInventory(repo);
    assert.throws(() => protocol.restoreMutation({
      repo,
      ownerToken: performed.owner_token,
    }), /record-sequence-exhausted/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
    assert.deepEqual(gitObjectInventory(repo), objects);
  });

  await t.test('group-7 operation-release barrier and committed null/departed restarts converge', () => {
    const releaseRepo = createGitFixture('r2-c3-g7-operation-release');
    const retained = protocol.ensureCutover({
      repo: releaseRepo,
      authorityTransitionHook({ stage, purpose }) {
        if (stage === 'after-pre-inventory' && purpose === 'operation-release') {
          throw new Error('retain operation release barrier');
        }
      },
    });
    assert.equal(retained.status, 'manual');
    assert.ok(protocol.__testing.inspectProtocol({ repo: releaseRepo }).publication.operation);
    assert.equal(protocol.ensureCutover({
      repo: releaseRepo,
      processProbe: () => ({ status: 'dead' }),
    }).status, 'ready');

    for (const operation of ['null', 'departed']) {
      const repo = createGitFixture(`r2-c3-g7-committed-${operation}`);
      const target = `src/committed-${operation}.txt`;
      writeRepoFile(repo, target);
      protocol.performMutation({ repo, files: [target] });
      if (operation === 'departed') installOperation(repo, protocol);
      assert.equal(protocol.ensureCutover({
        repo,
        processProbe: () => ({ status: 'dead' }),
      }).status, 'ready');
      assert.equal(protocol.autoRecover({
        repo,
        now: Date.now() + 10_000_000,
        staleMs: 0,
        processProbe: () => ({ status: 'dead' }),
      }).status, 'restored');
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo }));
      assert.equal(stageEntry(repo, target).length, 0);
    }
  });

  await t.test('group-13 recomputed foreign digest and sequence authorities remain byte-identical manual', () => {
    for (const [label, mutate] of [
      ['digest', (publication) => ({ ...publication, publication_digest: 'f'.repeat(64) })],
      ['sequence', (publication) => ({ ...publication, publication_seq: '01' })],
    ]) {
      const repo = createGitFixture(`r2-c3-g13-${label}`);
      protocol.ensureCutover({ repo });
      const authority = readRefBlob(repo);
      const publication = JSON.parse(authority.bytes);
      const bytes = Buffer.from(`${JSON.stringify(mutate(publication))}\n`);
      const oid = git(repo, ['hash-object', '-w', '--stdin'], { input: bytes });
      git(repo, ['update-ref', publicationRef, oid, authority.oid]);
      const before = protocolSnapshot(repo);
      const result = protocol.ensureCutover({ repo });
      assert.equal(result.status, 'manual');
      assertSnapshotEqual(before, protocolSnapshot(repo), label);
    }
  });

  await t.test('group-15 partial-add pending, failed, and aborted crash residues auto-recover exactly', () => {
    for (const phase of ['pending', 'failed', 'aborted']) {
      const repo = createGitFixture(`r2-c3-g15-${phase}`);
      const target = `src/partial-${phase}.txt`;
      const unrelated = `unrelated-${phase}.txt`;
      writeRepoFile(repo, target);
      writeRepoFile(repo, unrelated);
      git(repo, ['add', '--', unrelated]);
      const unrelatedBefore = stageEntry(repo, unrelated);
      let failRestore = phase === 'failed';
      const runner = (gitRepo, args, options = {}) => {
        if (args[0] === 'add') {
          const result = gitResult(gitRepo, args, options);
          assert.equal(result.code, 0);
          return { ...result, code: 1, stderr: Buffer.from('partial add crash matrix\n') };
        }
        if (failRestore && args[0] === 'update-index') {
          return {
            code: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('partial restore failure\n'),
          };
        }
        return gitResult(gitRepo, args, options);
      };
      const expected = phase === 'pending'
        ? 'recovery-attempt:abort-prepared:pending:1'
        : phase === 'failed'
          ? 'recovery-attempt:abort-prepared:failed:1'
          : 'aborted:abort-prepared:1';
      captureError(() => protocol.performMutation({
        repo,
        files: [target],
        gitRunner: runner,
        transitionHook(label) {
          if (label === expected) throw new Error(`retain partial ${phase}`);
        },
      }));
      const residue = protocol.__testing.inspectProtocol({ repo });
      if (phase === 'pending' || phase === 'failed') {
        assert.equal(residue.selectedRecord.phase, 'recovery-attempt');
        assert.equal(residue.selectedRecord.attempt_state, phase);
        assert.ok(stageEntry(repo, target).length > 0);
      } else {
        assert.equal(residue.selectedRecord.phase, 'aborted');
        assert.equal(stageEntry(repo, target).length, 0);
      }
      assert.deepEqual(stageEntry(repo, unrelated), unrelatedBefore);
      failRestore = false;
      assert.equal(protocol.autoRecover({
        repo,
        now: Date.now() + 10_000_000,
        staleMs: 0,
        processProbe: () => ({ status: 'dead' }),
      }).status, 'restored');
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo }));
      assert.equal(stageEntry(repo, target).length, 0);
      assert.deepEqual(stageEntry(repo, unrelated), unrelatedBefore);
    }
  });

  await t.test('group-18 every phase keeps exact operation-null projection after same-process retry', () => {
    for (const phase of ['prepared', 'committed', 'pending', 'failed', 'restored', 'aborted']) {
      const fixture = retainOperationAtPhase(protocol, phase);
      fixture.controller.failRelease = false;
      fixture.controller.failRestoreIndex = false;
      const indexBefore = stageEntry(fixture.repo, fixture.target);
      assert.equal(protocol.ensureCutover({
        repo: fixture.repo,
        processProbe: () => ({ status: 'dead' }),
      }).status, 'ready');
      const ready = protocol.__testing.inspectProtocol({ repo: fixture.repo });
      assert.equal(ready.publication.operation, null);
      assert.equal(ready.selectedRecord.phase, phase === 'pending' || phase === 'failed'
        ? 'recovery-attempt'
        : phase);
      assert.deepEqual(stageEntry(fixture.repo, fixture.target), indexBefore);
    }
  });
});

test('[R3 C1] perform HEAD guards roll back every post-prepared drift boundary', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const createRepository = (kind, label) => {
    if (kind === 'zero') return createGitFixture(`r3-c1-${kind}-${label}`, { initialCommit: false });
    if (kind === 'linked') {
      const main = createGitFixture(`r3-c1-${kind}-${label}-main`);
      const linked = join(fixtureRootFor(main), `r3-c1-${kind}-${label}-worktree`);
      git(main, ['worktree', 'add', '--quiet', '-b', `r3-c1-${label}-${Date.now()}`, linked]);
      return linked;
    }
    return createGitFixture(`r3-c1-${kind}-${label}`);
  };

  for (const kind of ['ordinary', 'zero', 'linked']) {
    for (const boundary of ['after-prepared', 'during-add', 'before-committed', 'before-success']) {
      await t.test(`${kind}:${boundary}`, () => {
        const repo = createRepository(kind, boundary);
        const target = `src/${kind}-${boundary}.txt`;
        const unrelated = `unrelated-${kind}-${boundary}.txt`;
        writeRepoFile(repo, target);
        writeRepoFile(repo, unrelated);
        git(repo, ['add', '--', unrelated]);
        const unrelatedBefore = stageEntry(repo, unrelated);
        let moved = false;
        const move = () => {
          assert.equal(moved, false, `${kind}:${boundary}: HEAD moved twice`);
          advanceHeadWithoutTarget(repo);
          moved = true;
        };
        const gitRunner = (gitRepo, args, options = {}) => {
          const result = gitResult(gitRepo, args, options);
          if (boundary === 'during-add' && !moved && args[0] === 'add' && result.code === 0) move();
          return result;
        };
        const error = captureError(() => protocol.performMutation({
          repo,
          files: [target],
          gitRunner,
          transitionHook(label) {
            if (boundary === 'after-prepared' && label === 'prepared' && !moved) move();
          },
          performBoundaryHook(label) {
            if (boundary === 'before-committed'
                && label === 'before-committed-publication' && !moved) move();
          },
          authorityTransitionHook({ stage, purpose }) {
            if (stage !== 'after-pre-inventory') return;
            if (boundary === 'before-success'
                && purpose === 'operation-release' && !moved) move();
          },
        }));
        assert.equal(moved, true, `${kind}:${boundary}: drift seam was not reached`);
        assert.match(error.message, /HEAD|captured commit|compare-and-swap|rollback|operation-release/u);
        assert.equal(stageEntry(repo, target).length, 0, `${kind}:${boundary}: protocol ITA stranded`);
        assert.deepEqual(stageEntry(repo, unrelated), unrelatedBefore);
      });
    }
  }
});

test('[R4 C1] final perform HEAD guard closes post-release CAS and pre-return drift', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  const createRepository = (kind, label) => {
    if (kind === 'zero') return createGitFixture(`r4-c1-${kind}-${label}`, { initialCommit: false });
    if (kind === 'linked') {
      const main = createGitFixture(`r4-c1-${kind}-${label}-main`);
      const linked = join(fixtureRootFor(main), `r4-c1-${kind}-${label}-worktree`);
      git(main, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        `r4-c1-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        linked,
      ]);
      return linked;
    }
    return createGitFixture(`r4-c1-${kind}-${label}`);
  };

  for (const kind of ['ordinary', 'zero', 'linked']) {
    for (const boundary of ['post-release-cas', 'pre-return']) {
      for (const targetInNewHead of [false, true]) {
        const label = `${boundary}-${targetInNewHead ? 'target-present' : 'target-absent'}`;
        await t.test(`${kind}:${label}`, () => {
          const repo = createRepository(kind, label);
          const target = `src/${kind}-${label}.txt`;
          const unrelated = `unrelated-${kind}-${label}.txt`;
          const ownerToken = canonicalOwnerToken();
          assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
          writeRepoFile(repo, target);
          writeRepoFile(repo, unrelated);
          git(repo, ['add', '--', unrelated]);
          const unrelatedBefore = stageEntry(repo, unrelated);
          let moved = false;
          const move = () => {
            assert.equal(moved, false, `${kind}:${label}: HEAD moved twice`);
            if (targetInNewHead) advanceHeadWithTarget(repo, target);
            else advanceHeadWithoutTarget(repo);
            moved = true;
          };
          const error = captureError(() => protocol.performMutation({
            repo,
            files: [target],
            ownerToken,
            authorityTransitionHook({ stage, purpose }) {
              if (boundary === 'post-release-cas'
                  && stage === 'before-post-inventory'
                  && purpose === 'operation-release'
                  && !moved) move();
            },
            performReturnHook(labelValue) {
              if (boundary === 'pre-return'
                  && labelValue === 'before-final-head-guard'
                  && !moved) move();
            },
          }));
          assert.equal(moved, true, `${kind}:${label}: drift seam was not reached`);
          assert.match(error.message, /HEAD|captured commit|producer-head-drift|rollback/u);
          assert.deepEqual(stageEntry(repo, unrelated), unrelatedBefore);
          const state = protocol.__testing.inspectProtocol({ repo });
          assert.equal(
            state.publication.operation,
            null,
            `${kind}:${label}: operation stranded: ${error.message}`,
          );
          if (targetInNewHead) {
            assert.equal(state.selectedRecord.phase, 'committed');
            const retained = protocolSnapshot(repo);
            assert.throws(() => protocol.restoreMutation({
              repo,
              ownerToken,
            }), /HEAD|captured commit|CAPTURED_COMMIT_MISMATCH/u);
            assertSnapshotEqual(retained, protocolSnapshot(repo));
          } else {
            assert.equal(stageEntry(repo, target).length, 0, `${kind}:${label}: protocol ITA stranded`);
            assertProtocolIdle(state);
          }
        });
      }
    }
  }
});

test('[R3 C2] operation release cannot succeed across selected or peer replacement', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const stage of ['after-pre-inventory', 'before-post-inventory']) {
    for (const role of ['selected', 'peer']) {
      await t.test(`committed:${stage}:${role}`, () => {
        const repo = createGitFixture(`r3-c2-committed-${stage}-${role}`);
        const target = `src/${stage}-${role}.txt`;
        writeRepoFile(repo, target);
        let replaced = false;
        const error = captureError(() => protocol.performMutation({
          repo,
          files: [target],
          authorityTransitionHook(event) {
            if (replaced || event.stage !== stage || event.purpose !== 'operation-release') return;
            const state = protocol.__testing.inspectProtocol({ repo });
            const selected = state.publication.selected_slot;
            const slot = role === 'selected' ? selected : (selected === 'a' ? 'b' : 'a');
            replaceFileIdentity(join(repo, v3SlotRelative(slot)));
            replaced = true;
          },
        }));
        assert.equal(replaced, true);
        assert.match(error.message, /slot|identity|operation-release|ready-state|manual/u);
      });
    }
  }

  for (const stage of ['after-pre-inventory', 'before-post-inventory']) {
    await t.test(`ready-idle:${stage}`, () => {
      const repo = createGitFixture(`r3-c2-idle-${stage}`);
      assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
      let replaced = false;
      const result = protocol.ensureCutover({
        repo,
        authorityTransitionHook(event) {
          if (replaced || event.stage !== stage || event.purpose !== 'operation-release') return;
          const state = protocol.__testing.inspectProtocol({ repo });
          replaceFileIdentity(join(repo, v3SlotRelative(state.slots[0].slot)));
          replaced = true;
        },
      });
      assert.equal(replaced, true);
      assert.equal(result.status, 'manual');
      assert.match(result.reason, /slot|identity|ready-state|operation release/u);
    });
  }

  for (const stage of ['after-pre-inventory', 'before-post-inventory']) {
    for (const role of ['selected', 'peer']) {
      await t.test(`unchanged-committed:${stage}:${role}`, () => {
        const repo = createGitFixture(`r3-c2-unchanged-${stage}-${role}`);
        const target = `src/unchanged-${stage}-${role}.txt`;
        writeRepoFile(repo, target);
        protocol.performMutation({ repo, files: [target] });
        let replaced = false;
        const result = protocol.ensureCutover({
          repo,
          authorityTransitionHook(event) {
            if (replaced || event.stage !== stage || event.purpose !== 'operation-release') return;
            const state = protocol.__testing.inspectProtocol({ repo });
            const selected = state.publication.selected_slot;
            const slot = role === 'selected' ? selected : (selected === 'a' ? 'b' : 'a');
            replaceFileIdentity(join(repo, v3SlotRelative(slot)));
            replaced = true;
          },
        });
        assert.equal(replaced, true);
        assert.equal(result.status, 'manual');
        assert.match(result.reason, /slot|identity|ready-state|operation release/u);
      });
    }
  }

  for (const stage of ['after-pre-inventory', 'before-post-inventory']) {
    await t.test(`session-null-reconcile:${stage}`, () => {
      const repo = createGitFixture(`r3-c2-reconcile-${stage}`);
      assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
      installOperation(repo, protocol);
      let replaced = false;
      const result = protocol.ensureCutover({
        repo,
        processProbe: () => ({ status: 'dead' }),
        authorityTransitionHook(event) {
          if (replaced || event.stage !== stage || event.purpose !== 'operation-release') return;
          const state = protocol.__testing.inspectProtocol({ repo });
          replaceFileIdentity(join(repo, v3SlotRelative(state.slots[0].slot)));
          replaced = true;
        },
      });
      assert.equal(replaced, true);
      assert.equal(result.status, 'manual');
      assert.match(result.reason, /slot|identity|ready-state|operation release/u);
    });
  }
});

test('[R3 W1] reflog list-to-exists races freeze the same inventory pass', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  await t.test('publication semantic exists=0', () => {
    const repo = createGitFixture('r3-w1-publication-exists');
    assert.throws(() => protocol.__testing.preflightRepository({
      repo,
      gitRunner(gitRepo, args, options = {}) {
        if (args[0] === 'reflog' && args[1] === 'exists' && args[2] === publicationRef) {
          return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return gitResult(gitRepo, args, options);
      },
    }), /reserved.*reflog|inventory|manual/u);
  });

  await t.test('orphan appears after list', () => {
    const repo = createGitFixture('r3-w1-orphan-exists');
    const orphan = publicationRef.slice(0, -'publication'.length) + 'orphan-race';
    const oid = git(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.from('orphan\n') });
    let injected = false;
    assert.throws(() => protocol.__testing.preflightRepository({
      repo,
      gitRunner(gitRepo, args, options = {}) {
        if (!injected && args[0] === 'reflog' && args[1] === 'exists') {
          git(repo, ['update-ref', '--create-reflog', orphan, oid]);
          const loose = join(repo, '.git', ...orphan.split('/'));
          unlinkSync(loose);
          injected = true;
        }
        return gitResult(gitRepo, args, options);
      },
    }), /reserved.*reflog|inventory|manual/u);
    assert.equal(injected, true);
    assert.equal(gitResult(repo, ['reflog', 'exists', orphan]).code, 0);
  });
});

test('[R3 W1] pre- and post-CAS reflog races permit no later index action or success', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const boundary of ['pre-CAS', 'post-CAS']) {
    for (const kind of ['publication', 'orphan']) {
      await t.test(`${boundary}:${kind}`, () => {
        const repo = createGitFixture(`r3-w1-${boundary}-${kind}`);
        protocol.ensureCutover({ repo });
        const target = `src/${boundary}-${kind}.txt`;
        writeRepoFile(repo, target);
        const orphan = publicationRef.slice(0, -'publication'.length)
          + `race-${boundary}-${kind}`;
        const orphanOid = git(repo, ['hash-object', '-w', '--stdin'], {
          input: Buffer.from(`${boundary}-${kind}\n`),
        });
        let candidateSeen = false;
        let updateRefBaseline = 0;
        let casDone = false;
        let injected = false;
        let updateRefCalls = 0;
        const error = captureError(() => protocol.performMutation({
          repo,
          files: [target],
          gitRunner(gitRepo, args, options = {}) {
            if (!candidateSeen && args[0] === 'hash-object' && args.includes('-w')) {
              candidateSeen = true;
              updateRefBaseline = updateRefCalls;
            }
            if (args.includes('update-ref') && args.includes('--stdin')) {
              const result = gitResult(gitRepo, args, options);
              updateRefCalls += 1;
              if (boundary === 'post-CAS' && candidateSeen && result.code === 0) casDone = true;
              return result;
            }
            const shouldInject = !injected
              && args[0] === 'reflog'
              && args[1] === 'exists'
              && ((boundary === 'pre-CAS' && candidateSeen && !casDone)
                || (boundary === 'post-CAS' && casDone));
            if (shouldInject) {
              injected = true;
              if (kind === 'publication') {
                return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
              }
              git(repo, ['update-ref', '--create-reflog', orphan, orphanOid]);
              unlinkSync(join(repo, '.git', ...orphan.split('/')));
            }
            return gitResult(gitRepo, args, options);
          },
        }));
        assert.equal(injected, true);
        assert.match(error.message, /reserved.*reflog|inventory|freeze|manual/u);
        assert.equal(stageEntry(repo, target).length, 0);
        assert.equal(
          updateRefCalls - updateRefBaseline,
          boundary === 'pre-CAS' ? 0 : 1,
        );
      });
    }
  }
});

test('[R3 W2] operation-base pruning is object-format-aware and operationally fail-closed', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const [label, failure] of [
    ['timeout', { code: 124, timedOut: true, stderr: Buffer.from('timed out\n') }],
    ['execution', { code: 2, stderr: Buffer.from('permission denied\n') }],
  ]) {
    await t.test(label, () => {
      const repo = createGitFixture(`r3-w2-${label}`);
      protocol.ensureCutover({ repo });
      const installed = installOperation(repo, protocol);
      const baseOid = installed.publication.operation.base_publication_oid;
      const before = protocolSnapshot(repo);
      const result = protocol.ensureCutover({
        repo,
        processProbe: () => ({ status: 'dead' }),
        gitRunner(gitRepo, args, options = {}) {
          const oldProbe = args[0] === 'cat-file' && args[1] === '-e' && args[2] === baseOid;
          const batchProbe = args[0] === 'cat-file'
            && typeof args[1] === 'string'
            && args[1].startsWith('--batch-check')
            && Buffer.from(options.input || []).toString('ascii').includes(baseOid);
          if (oldProbe || batchProbe) return { stdout: Buffer.alloc(0), ...failure };
          return gitResult(gitRepo, args, options);
        },
      });
      assert.equal(result.status, 'manual');
      assert.match(result.reason, /operation base|probe|Git|timeout|manual/u);
      assertSnapshotEqual(before, protocolSnapshot(repo));
    });
  }

  await t.test('wrong SHA-1 width', () => {
    const repo = createGitFixture('r3-w2-wrong-width');
    protocol.ensureCutover({ repo });
    installOperation(repo, protocol, { baseOid: 'a'.repeat(64) });
    const before = protocolSnapshot(repo);
    const result = protocol.ensureCutover({
      repo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(result.status, 'manual');
    assert.match(result.reason, /object format|OID|width|operation base|manual/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });

  await t.test('confirmed pruned base', () => {
    const repo = createGitFixture('r3-w2-confirmed-pruned');
    protocol.ensureCutover({ repo });
    installOperation(repo, protocol, { baseOid: 'a'.repeat(40) });
    const result = protocol.ensureCutover({
      repo,
      processProbe: () => ({ status: 'dead' }),
    });
    assert.equal(result.status, 'ready');
    assert.equal(protocol.__testing.inspectProtocol({ repo }).publication.operation, null);
  });
});

test('[R3 C3 group 5] exact derived-record cap is enforced through API and framed perform', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const exact = performCapacityRecordAtByteCap(protocol.__testing);
  const oversizedFiles = [...exact.files];
  const expandable = oversizedFiles.findIndex((file) => Buffer.byteLength(file) < 4096);
  assert.notEqual(expandable, -1);
  oversizedFiles[expandable] += 'x';
  assert.equal(
    protocol.__testing.encodeRecord(
      protocol.__testing.buildPerformCapacityRecord(exact.ownerToken, exact.files),
    ).length,
    1_048_576,
  );
  assert.throws(() => protocol.__testing.encodeRecord(
    protocol.__testing.buildPerformCapacityRecord(exact.ownerToken, oversizedFiles),
  ), /record exceeds slot byte cap/u);

  await t.test('public API 1048576 and 1048577', () => {
    for (const platform of ['linux', 'win32']) {
      const repo = createGitFixture(`r4-c2-g5-api-${platform}`);
      const before = protocolSnapshot(repo);
      const exactError = captureError(() => protocol.performMutation({
        repo,
        files: exact.files,
        ownerToken: exact.ownerToken,
        platform,
      }));
      assert.doesNotMatch(exactError.message, /record exceeds slot byte cap/u);
      assert.match(exactError.message, /target|file|available|regular/u);
      assertSnapshotEqual(before, protocolSnapshot(repo));
      assert.throws(() => protocol.performMutation({
        repo,
        files: oversizedFiles,
        ownerToken: exact.ownerToken,
        platform,
      }), /record exceeds slot byte cap/u);
      assertSnapshotEqual(before, protocolSnapshot(repo));
    }
  });

  await t.test('framed child 1048576 and 1048577', () => {
    const repo = createGitFixture('r3-c3-g5-framed');
    const before = protocolSnapshot(repo);
    const exactFrame = protocol.__testing.buildCliRequest({
      protocol: 'deep-review-mutation-v3',
      command: 'perform',
      repo,
      owner_token: exact.ownerToken,
      files: exact.files,
    });
    const exactResult = parseCliOutput(spawnFramed(exactFrame));
    assert.equal(exactResult.ok, false);
    assert.doesNotMatch(exactResult.error.message, /record exceeds slot byte cap/u);
    assert.match(exactResult.error.message, /target|file|available|regular/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
    const oversizedFrame = protocol.__testing.buildCliRequest({
      protocol: 'deep-review-mutation-v3',
      command: 'perform',
      repo,
      owner_token: exact.ownerToken,
      files: oversizedFiles,
    });
    const oversizedResult = parseCliOutput(spawnFramed(oversizedFrame));
    assert.equal(oversizedResult.ok, false);
    assert.match(oversizedResult.error.message, /record exceeds slot byte cap/u);
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });
});

test('[R3 C3 group 18] missing and wrong tokens are read-only at every ready-bound phase', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const phase of ['prepared', 'committed', 'pending', 'failed', 'restored', 'aborted']) {
    await t.test(phase, () => {
      const fixture = retainOperationAtPhase(protocol, phase);
      const before = protocolSnapshot(fixture.repo);
      assert.throws(() => protocol.restoreMutation({
        repo: fixture.repo,
      }), /owner token|scalar|string|required/u);
      assertSnapshotEqual(before, protocolSnapshot(fixture.repo), `${phase}: missing token mutated`);
      assert.throws(() => protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        processProbe: () => ({ status: 'dead' }),
      }), /owner token.*match|OWNER_TOKEN_MISMATCH/u);
      assertSnapshotEqual(before, protocolSnapshot(fixture.repo), `${phase}: wrong token mutated`);
    });
  }

  await t.test('failed-attempt-3', () => {
    const fixture = failedAttemptThreeFixture(protocol);
    const before = protocolSnapshot(fixture.repo);
    assert.throws(() => protocol.restoreMutation({
      repo: fixture.repo,
    }), /owner token|scalar|string|required/u);
    assertSnapshotEqual(before, protocolSnapshot(fixture.repo), 'failed-attempt-3: missing token mutated');
    assert.throws(() => protocol.restoreMutation({
      repo: fixture.repo,
      ownerToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processProbe: () => ({ status: 'dead' }),
    }), /owner token.*match|OWNER_TOKEN_MISMATCH/u);
    assertSnapshotEqual(before, protocolSnapshot(fixture.repo), 'failed-attempt-3: wrong token mutated');
  });
});

test('[R3 C3 group 17] every recovery CAS has exact OLD-or-NEW authority and index evidence', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const kind of ['abort-prepared', 'restore-committed']) {
    await t.test(kind, () => {
      const fixture = recoveryFixture(protocol, kind, 'r3-exact-evidence');
      const unrelated = `unrelated-${kind}.txt`;
      writeRepoFile(fixture.repo, unrelated);
      git(fixture.repo, ['add', '--', unrelated]);
      const unrelatedExpected = stageEntry(fixture.repo, unrelated).toString('base64');
      const transitions = [];
      const result = protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
        gitRunner(gitRepo, args, options = {}) {
          const transaction = args.includes('update-ref')
            ? authorityTransaction(options.input)
            : null;
          if (!transaction) return gitResult(gitRepo, args, options);
          const oldReceipt = exactLifecycleReceipt(
            protocol,
            fixture.repo,
            fixture.target,
            unrelated,
          );
          const commandResult = gitResult(gitRepo, args, options);
          assert.equal(commandResult.code, 0, commandResult.stderr.toString('utf8'));
          const newReceipt = exactLifecycleReceipt(
            protocol,
            fixture.repo,
            fixture.target,
            unrelated,
          );
          transitions.push(Object.freeze({ transaction, oldReceipt, newReceipt }));
          return commandResult;
        },
      });
      assert.equal(result.status, 'restored');
      assert.equal(transitions.length, 5, `${kind}: exact acquire/pending/terminal/session/release CAS count`);

      for (const [index, transition] of transitions.entries()) {
        const { transaction, oldReceipt, newReceipt } = transition;
        assert.equal(transaction.oldOid, oldReceipt.refOid, `${kind}:${index}: immutable OLD OID`);
        assert.equal(transaction.newOid, newReceipt.refOid, `${kind}:${index}: immutable NEW OID`);
        assert.notEqual(oldReceipt.refOid, newReceipt.refOid, `${kind}:${index}: OLD and NEW differ`);
        assert.deepEqual(oldReceipt.slots, newReceipt.slots, `${kind}:${index}: slot bytes change across CAS`);
        assert.equal(oldReceipt.index, newReceipt.index, `${kind}:${index}: index bytes change across CAS`);
        assert.equal(oldReceipt.staged, newReceipt.staged, `${kind}:${index}: staged bytes change across CAS`);
        assert.equal(oldReceipt.unrelatedStage, unrelatedExpected, `${kind}:${index}: OLD unrelated stage`);
        assert.equal(newReceipt.unrelatedStage, unrelatedExpected, `${kind}:${index}: NEW unrelated stage`);
        assert.equal(
          Buffer.from(newReceipt.refBytes, 'base64').equals(
            gitResult(fixture.repo, ['cat-file', 'blob', transaction.newOid]).stdout,
          ),
          true,
          `${kind}:${index}: NEW blob bytes`,
        );
        assert.equal(
          Buffer.from(oldReceipt.refBytes, 'base64').equals(
            gitResult(fixture.repo, ['cat-file', 'blob', transaction.oldOid]).stdout,
          ),
          true,
          `${kind}:${index}: OLD blob bytes`,
        );
        if (newReceipt.publication.operation) {
          const baseOid = newReceipt.publication.operation.base_publication_oid;
          const baseBytes = gitResult(fixture.repo, ['cat-file', 'blob', baseOid]).stdout;
          const base = protocol.__testing.decodePublication(baseBytes);
          assert.equal(base.operation, null, `${kind}:${index}: operation base is operation-null`);
          assert.equal(
            base.session?.record_digest || null,
            newReceipt.publication.session?.record_digest || null,
            `${kind}:${index}: operation base session projection`,
          );
          const expectedBase = protocol.__testing.buildPublication({
            ...newReceipt.publication,
            operation: null,
            publication_digest: undefined,
          });
          assert.deepEqual(
            baseBytes,
            protocol.__testing.encodePublication(expectedBase),
            `${kind}:${index}: exact operation base bytes`,
          );
        }
        if (newReceipt.selectedRecord) {
          assert.equal(newReceipt.lease, sessionLease(newReceipt.selectedRecord));
          assert.equal(
            newReceipt.publication.selected_record_digest,
            newReceipt.selectedRecord.record_digest,
          );
          assert.equal(
            newReceipt.slots[newReceipt.publication.selected_slot].record.record_digest,
            newReceipt.selectedRecord.record_digest,
          );
        }
      }

      const [acquire, pending, terminal, sessionRelease, operationRelease] = transitions;
      assert.equal(acquire.oldReceipt.publication.operation, null);
      assert.ok(acquire.newReceipt.publication.operation);
      assert.equal(
        acquire.newReceipt.publication.operation.base_publication_oid,
        acquire.oldReceipt.refOid,
      );
      const operationId = acquire.newReceipt.publication.operation.operation_id;
      for (const operation of [
        pending.oldReceipt.publication.operation,
        pending.newReceipt.publication.operation,
        terminal.oldReceipt.publication.operation,
        terminal.newReceipt.publication.operation,
        sessionRelease.oldReceipt.publication.operation,
        sessionRelease.newReceipt.publication.operation,
        operationRelease.oldReceipt.publication.operation,
      ]) {
        assert.equal(operation.operation_id, operationId, `${kind}: exact operation identity`);
      }
      assert.deepEqual(acquire.oldReceipt.publication.session, acquire.newReceipt.publication.session);
      assert.equal(
        acquire.newReceipt.targetStage.length > 0,
        kind === 'restore-committed',
      );

      assert.equal(pending.newReceipt.selectedRecord.phase, 'recovery-attempt');
      assert.equal(pending.newReceipt.selectedRecord.attempt_state, 'pending');
      assert.equal(pending.newReceipt.selectedRecord.recovery_kind, kind);
      assert.ok(pending.newReceipt.publication.operation);
      assert.equal(pending.newReceipt.targetStage.length > 0, kind === 'restore-committed');
      const pendingChangedSlots = ['a', 'b'].filter(
        (slot) => acquire.newReceipt.slots[slot].bytes !== pending.oldReceipt.slots[slot].bytes,
      );
      assert.deepEqual(pendingChangedSlots, [pending.newReceipt.publication.selected_slot]);

      assert.equal(
        terminal.newReceipt.selectedRecord.phase,
        kind === 'abort-prepared' ? 'aborted' : 'restored',
      );
      assert.equal(terminal.oldReceipt.targetStage, '');
      assert.equal(terminal.newReceipt.targetStage, '');
      const terminalChangedSlots = ['a', 'b'].filter(
        (slot) => pending.newReceipt.slots[slot].bytes !== terminal.oldReceipt.slots[slot].bytes,
      );
      assert.deepEqual(terminalChangedSlots, [terminal.newReceipt.publication.selected_slot]);

      assert.equal(sessionRelease.oldReceipt.targetStage, '');
      assert.equal(sessionRelease.newReceipt.targetStage, '');
      assert.ok(sessionRelease.oldReceipt.publication.session);
      assert.equal(sessionRelease.newReceipt.publication.session, null);
      assert.ok(sessionRelease.newReceipt.publication.operation);
      assert.deepEqual(sessionRelease.oldReceipt.slots, sessionRelease.newReceipt.slots);

      assert.equal(operationRelease.oldReceipt.publication.session, null);
      assert.ok(operationRelease.oldReceipt.publication.operation);
      assert.equal(operationRelease.newReceipt.publication.session, null);
      assert.equal(operationRelease.newReceipt.publication.operation, null);
      assert.deepEqual(operationRelease.oldReceipt.slots, operationRelease.newReceipt.slots);
      assert.equal(operationRelease.newReceipt.targetStage, '');
      assert.equal(stageEntry(fixture.repo, fixture.target).length, 0, `${kind}: final residual ITA`);
      assert.deepEqual(stageEntry(fixture.repo, unrelated), Buffer.from(unrelatedExpected, 'base64'));
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo: fixture.repo }));
    });
  }
});

test('[R5 C1 group 19] inconsistent selected-session times are immutable before operation acquisition', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const now = Date.now();
  const rows = [
    {
      name: 'process-start-after-session-start',
      startedAt: new Date(now - 7_200_000).toISOString(),
      processStartMs: String(now - 3_600_000),
    },
    {
      name: 'session-start-beyond-now',
      startedAt: new Date(now + 1).toISOString(),
      processStartMs: String(now),
    },
    {
      name: 'process-and-session-beyond-now',
      startedAt: new Date(now + 2).toISOString(),
      processStartMs: String(now + 1),
    },
    {
      name: 'maximum-safe-process-time',
      startedAt: new Date(8_640_000_000_000_000).toISOString(),
      processStartMs: String(Number.MAX_SAFE_INTEGER),
    },
  ];
  for (const row of rows) {
    await t.test(row.name, () => {
      const fixture = recoveryFixture(protocol, 'restore-committed', `r5-time-${row.name}`);
      const owner = protocol.__testing.inspectProtocol({ repo: fixture.repo }).selectedRecord.owner_process;
      rewriteSelectedRecord(fixture.repo, protocol, {
        started_at: row.startedAt,
        owner_process: { ...owner, process_start_ms: row.processStartMs },
      });
      const before = protocolSnapshot(fixture.repo);
      const objects = gitObjectInventory(fixture.repo);
      for (const invoke of [
        () => protocol.ensureCutover({ repo: fixture.repo, now }),
        () => captureError(() => protocol.restoreMutation({
          repo: fixture.repo,
          ownerToken: fixture.ownerToken,
          now,
        })),
        () => protocol.autoRecover({
          repo: fixture.repo,
          now,
          staleMs: 0,
          processProbe: () => ({ status: 'dead' }),
        }),
      ]) {
        invoke();
        assertSnapshotEqual(before, protocolSnapshot(fixture.repo), row.name);
        assert.deepEqual(gitObjectInventory(fixture.repo), objects, `${row.name}: candidate created`);
      }
    });
  }

  const boundary = {
    host_hash: protocol.__testing.currentHostHash(),
    pid: String(process.pid),
    process_start_ms: String(now),
    started_at: new Date(now).toISOString(),
  };
  assert.equal(protocol.__testing.classifyLiveness(boundary, {
    now,
    processProbe: () => ({ status: 'dead' }),
  }), 'departed');
  assert.equal(protocol.__testing.classifyLiveness({ ...boundary, process_start_ms: 'not-decimal' }, {
    now,
    processProbe: () => ({ status: 'dead' }),
  }), 'manual');
});

test('[R5 C2 groups 15 and 17] recovery preserves real staging on protocol targets', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }

  for (const mode of ['normal-one', 'normal-all', 'auto-all']) {
    await t.test(mode, () => {
      const repo = createGitFixture(`r5-real-target-${mode}`);
      const targets = ['src/real-a.txt', 'src/real-b.txt'];
      for (const target of targets) writeRepoFile(repo, target);
      const performed = protocol.performMutation({ repo, files: targets });
      const realTargets = mode === 'normal-one' ? [targets[0]] : targets;
      git(repo, ['add', '--', ...realTargets]);
      const expected = new Map(realTargets.map((target) => [target, stageEntry(repo, target)]));
      const result = mode === 'auto-all'
        ? protocol.autoRecover({
          repo,
          now: Date.now() + 1_300_000,
          reviewTimeoutMs: 0,
          processProbe: () => ({ status: 'dead' }),
        })
        : protocol.restoreMutation({ repo, ownerToken: performed.owner_token });
      assert.equal(result.status, 'restored');
      for (const [target, bytes] of expected) assert.deepEqual(stageEntry(repo, target), bytes);
      for (const target of targets.filter((value) => !expected.has(value))) {
        assert.equal(stageEntry(repo, target).length, 0);
      }
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo }));
    });
  }

  for (const kind of ['abort-prepared', 'restore-committed']) {
    await t.test(`${kind}-terminal-cas-retry`, () => {
      const fixture = recoveryFixture(protocol, kind, 'r5-real-target-terminal');
      const terminal = kind === 'abort-prepared' ? 'aborted' : 'restored';
      assert.throws(() => protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
        transitionHook(label) {
          if (label === `${terminal}:${kind}:1`) throw new Error('retain terminal CAS');
        },
      }), /retain terminal CAS/u);
      git(fixture.repo, ['add', '--', fixture.target]);
      const expected = stageEntry(fixture.repo, fixture.target);
      const before = protocol.__testing.inspectProtocol({ repo: fixture.repo }).selectedRecord;
      assert.equal(before.phase, terminal);
      assert.equal(before.restore_attempts, 1);
      assert.equal(protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
      }).status, 'restored');
      assert.deepEqual(stageEntry(fixture.repo, fixture.target), expected);
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo: fixture.repo }));
    });
  }
});

test('[R5 C3 groups 12 and 21] repository-incompatible selected commits are immutable for every recovery entrypoint', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const objectFormat of ['sha1', 'sha256']) {
    await t.test(objectFormat, (row) => {
      let repo;
      try {
        repo = createGitFixture(`r5-selected-oid-${objectFormat}`, { objectFormat });
      } catch (error) {
        if (objectFormat !== 'sha256') throw error;
        capabilitySkip(row, 'git-sha256-unavailable');
        return;
      }
      const target = 'src/opposite-width.txt';
      writeRepoFile(repo, target);
      const performed = protocol.performMutation({ repo, files: [target] });
      rewriteSelectedRecord(repo, protocol, {
        commit_hash: objectFormat === 'sha1' ? 'a'.repeat(64) : 'a'.repeat(40),
      });
      const before = protocolSnapshot(repo);
      const objects = gitObjectInventory(repo);
      const ensure = protocol.ensureCutover({ repo });
      assert.equal(ensure.status, 'manual');
      assertSnapshotEqual(before, protocolSnapshot(repo), `${objectFormat}: ensure`);
      assert.deepEqual(gitObjectInventory(repo), objects, `${objectFormat}: ensure candidate`);
      assert.throws(() => protocol.restoreMutation({
        repo,
        ownerToken: performed.owner_token,
      }), /object format|commit_hash|width|manual recovery/u);
      assertSnapshotEqual(before, protocolSnapshot(repo), `${objectFormat}: restore`);
      assert.deepEqual(gitObjectInventory(repo), objects, `${objectFormat}: restore candidate`);
      assert.throws(() => protocol.autoRecover({
        repo,
        now: Date.now() + 1_300_000,
        reviewTimeoutMs: 0,
        processProbe: () => ({ status: 'dead' }),
      }), /object format|commit_hash|width|manual recovery/u);
      assertSnapshotEqual(before, protocolSnapshot(repo), `${objectFormat}: auto`);
      assert.deepEqual(gitObjectInventory(repo), objects, `${objectFormat}: auto candidate`);
    });
  }

  await t.test('null-selected-commit-with-real-head', () => {
    const repo = createGitFixture('r5-selected-oid-null-with-head');
    const target = 'src/null-with-head.txt';
    writeRepoFile(repo, target);
    const performed = protocol.performMutation({ repo, files: [target] });
    rewriteSelectedRecord(repo, protocol, { commit_hash: null });
    const before = protocolSnapshot(repo);
    const objects = gitObjectInventory(repo);
    const ensure = protocol.ensureCutover({ repo });
    assert.equal(ensure.status, 'manual');
    assertSnapshotEqual(before, protocolSnapshot(repo), 'null-with-head: ensure');
    assert.deepEqual(gitObjectInventory(repo), objects, 'null-with-head: ensure candidate');
    assert.throws(() => protocol.restoreMutation({
      repo,
      ownerToken: performed.owner_token,
    }), /zero-commit|commit_hash|HEAD|manual recovery/u);
    assertSnapshotEqual(before, protocolSnapshot(repo), 'null-with-head: restore');
    assert.deepEqual(gitObjectInventory(repo), objects, 'null-with-head: restore candidate');
    assert.throws(() => protocol.autoRecover({
      repo,
      now: Date.now() + 1_300_000,
      reviewTimeoutMs: 0,
      processProbe: () => ({ status: 'dead' }),
    }), /zero-commit|commit_hash|HEAD|manual recovery/u);
    assertSnapshotEqual(before, protocolSnapshot(repo), 'null-with-head: auto');
    assert.deepEqual(gitObjectInventory(repo), objects, 'null-with-head: auto candidate');
  });
});

test('[R5 C4 group 17] completed inactive-slot write is observable before authority CAS', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  for (const kind of ['abort-prepared', 'restore-committed']) {
    await t.test(kind, () => {
      const fixture = recoveryFixture(protocol, kind, 'r5-after-write-seam');
      const before = exactLifecycleReceipt(protocol, fixture.repo, fixture.target, null);
      let acquired = null;
      let afterWrite = null;
      assert.throws(() => protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
        authorityTransitionHook({ stage, purpose }) {
          if (stage === 'before-post-inventory' && purpose === 'operation-acquire') {
            acquired = exactLifecycleReceipt(protocol, fixture.repo, fixture.target, null);
          }
        },
        slotWriteAfterHook({ record }) {
          afterWrite = exactLifecycleReceipt(protocol, fixture.repo, fixture.target, null);
          assert.equal(record.phase, 'recovery-attempt');
          throw new Error('crash after durable inactive-slot write');
        },
      }), /after durable inactive-slot write/u);
      assert.ok(acquired, 'operation-acquire receipt was not captured');
      assert.ok(afterWrite, 'after-write seam did not execute');
      assert.notEqual(acquired.refOid, before.refOid);
      assert.equal(afterWrite.refOid, acquired.refOid, 'authority changed before pending CAS');
      assert.deepEqual(afterWrite.publication, acquired.publication);
      assert.equal(afterWrite.index, before.index);
      assert.equal(afterWrite.staged, before.staged);
      assert.notDeepEqual(afterWrite.slots, before.slots, 'inactive slot was not durably replaced');
      assert.equal(protocol.restoreMutation({
        repo: fixture.repo,
        ownerToken: fixture.ownerToken,
      }).status, 'restored');
      assertProtocolIdle(protocol.__testing.inspectProtocol({ repo: fixture.repo }));
    });
  }
});

test('[R5 C4 group 17] both recovery kinds pin every crash boundary before retry', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const rows = [
    ['attempt-write-before', { writePhase: 'attempt', writeMoment: 'before' }],
    ['attempt-write-during', { writePhase: 'attempt', writeMoment: 'during' }],
    ['attempt-write-after', { writePhase: 'attempt', writeMoment: 'after' }],
    ['attempt-cas-pre', { casPhase: 'attempt-cas', casMoment: 'pre' }],
    ['attempt-cas-during-old', { casPhase: 'attempt-cas', casMoment: 'during', kill: 'prepared', branch: 'OLD' }],
    ['attempt-cas-during-new', { casPhase: 'attempt-cas', casMoment: 'during', kill: 'post-commit', branch: 'NEW' }],
    ['attempt-cas-post', { casPhase: 'attempt-cas', casMoment: 'post' }],
    ['index-before-terminal', { recoveryMoment: 'after-index-before-terminal' }],
    ['terminal-write-before', { writePhase: 'terminal', writeMoment: 'before' }],
    ['terminal-write-during', { writePhase: 'terminal', writeMoment: 'during' }],
    ['terminal-write-after', { writePhase: 'terminal', writeMoment: 'after' }],
    ['terminal-cas-pre', { casPhase: 'terminal-cas', casMoment: 'pre' }],
    ['terminal-cas-during-old', { casPhase: 'terminal-cas', casMoment: 'during', kill: 'prepared', branch: 'OLD' }],
    ['terminal-cas-during-new', { casPhase: 'terminal-cas', casMoment: 'during', kill: 'post-commit', branch: 'NEW' }],
    ['terminal-cas-post', { casPhase: 'terminal-cas', casMoment: 'post' }],
    ['session-release-pre', { casPhase: 'session-release', casMoment: 'pre' }],
    ['session-release-during-old', { casPhase: 'session-release', casMoment: 'during', kill: 'prepared', branch: 'OLD' }],
    ['session-release-during-new', { casPhase: 'session-release', casMoment: 'during', kill: 'post-commit', branch: 'NEW' }],
    ['session-release-post', { casPhase: 'session-release', casMoment: 'post' }],
    ['operation-release-pre', { casPhase: 'operation-release', casMoment: 'pre' }],
    ['operation-release-during-old', { casPhase: 'operation-release', casMoment: 'during', kill: 'prepared', branch: 'OLD' }],
    ['operation-release-during-new', { casPhase: 'operation-release', casMoment: 'during', kill: 'post-commit', branch: 'NEW' }],
    ['operation-release-post', { casPhase: 'operation-release', casMoment: 'post' }],
  ];
  const selectedRows = process.env.DEEP_REVIEW_TASK4_GROUP17_ROW
    ? rows.filter(([name]) => name === process.env.DEEP_REVIEW_TASK4_GROUP17_ROW)
    : rows;
  assert.ok(selectedRows.length > 0, 'requested Group-17 row is unknown');

  for (const kind of ['abort-prepared', 'restore-committed']) {
    for (const [name, row] of selectedRows) {
      await t.test(`${kind}:${name}`, () => {
        const fixture = recoveryFixture(protocol, kind, `r5-matrix-${name}`);
        const unrelated = `unrelated-${kind}-${name}.txt`;
        writeRepoFile(fixture.repo, unrelated, `${kind}:${name}\n`);
        git(fixture.repo, ['add', '--', unrelated]);
        const unrelatedStage = stageEntry(fixture.repo, unrelated);
        const initial = exactLifecycleReceipt(
          protocol,
          fixture.repo,
          fixture.target,
          unrelated,
        );
        let slotOrdinal = 0;
        let crashOld = null;
        let crashNew = null;
        let crashObserved = null;
        let crashed = false;
        let publicationCasOrdinal = 0;
        const error = captureError(() => protocol.restoreMutation({
          repo: fixture.repo,
          ownerToken: fixture.ownerToken,
          slotWriteHook({ fd }) {
            slotOrdinal += 1;
            const phase = slotOrdinal === 1 ? 'attempt' : 'terminal';
            if (phase !== row.writePhase || row.writeMoment === 'after') return;
            crashOld = exactLifecycleReceipt(
              protocol,
              fixture.repo,
              fixture.target,
              unrelated,
            );
            if (row.writeMoment === 'during') {
              writeFileSync(fd, Buffer.from('{"torn":', 'utf8'));
            }
            crashed = true;
            throw new Error(`injected ${kind}:${name}`);
          },
          slotWriteAfterHook({ record }) {
            const phase = record.phase === 'recovery-attempt' ? 'attempt' : 'terminal';
            if (phase !== row.writePhase || row.writeMoment !== 'after') return;
            crashObserved = exactLifecycleReceipt(
              protocol,
              fixture.repo,
              fixture.target,
              unrelated,
            );
            crashed = true;
            throw new Error(`injected ${kind}:${name}`);
          },
          recoveryHook(label) {
            if (label !== row.recoveryMoment) return;
            crashObserved = exactLifecycleReceipt(
              protocol,
              fixture.repo,
              fixture.target,
              unrelated,
            );
            crashed = true;
            throw new Error(`injected ${kind}:${name}`);
          },
          authorityTransitionHook({ stage, purpose }) {
            if (purpose === 'publication-transition' && stage === 'after-pre-inventory') {
              publicationCasOrdinal += 1;
            }
            const phase = purpose === 'operation-release'
              ? 'operation-release'
              : purpose === 'publication-transition'
                ? ['attempt-cas', 'terminal-cas', 'session-release'][publicationCasOrdinal - 1]
                : null;
            if (phase !== row.casPhase || row.casMoment === 'during') return;
            if (row.casMoment === 'pre' && stage === 'after-pre-inventory') {
              crashOld = exactLifecycleReceipt(
                protocol,
                fixture.repo,
                fixture.target,
                unrelated,
              );
              crashed = true;
              throw new Error(`injected ${kind}:${name}`);
            }
            if (row.casMoment === 'post' && stage === 'before-post-inventory') {
              crashObserved = exactLifecycleReceipt(
                protocol,
                fixture.repo,
                fixture.target,
                unrelated,
              );
              crashed = true;
              throw new Error(`injected ${kind}:${name}`);
            }
          },
          gitRunner(gitRepo, args, options = {}) {
            const transaction = args.includes('update-ref')
              ? authorityTransaction(options.input)
              : null;
            const phase = recoveryAuthorityPhase(protocol, gitRepo, transaction);
            if (phase === row.casPhase && row.casMoment === 'during') {
              crashOld = exactLifecycleReceipt(
                protocol,
                fixture.repo,
                fixture.target,
                unrelated,
              );
              const candidateBytes = gitResult(
                fixture.repo,
                ['cat-file', 'blob', transaction.newOid],
              ).stdout;
              crashNew = projectedAuthorityReceipt(
                protocol,
                crashOld,
                transaction.newOid,
                candidateBytes,
              );
              const result = killRealUpdateRefTransaction(gitRepo, options.input, row.kill);
              crashObserved = exactLifecycleReceipt(
                protocol,
                fixture.repo,
                fixture.target,
                unrelated,
              );
              crashed = true;
              return {
                code: result.code,
                stdout: Buffer.from(result.stdout || ''),
                stderr: Buffer.from(result.stderr || ''),
              };
            }
            const result = gitResult(gitRepo, args, options);
            if (!transaction || result.code !== 0) return result;
            const completedPhase = recoveryAuthorityPhase(protocol, gitRepo, transaction);
            if (completedPhase !== row.casPhase || row.casMoment === 'during') return result;
            if (row.casMoment === 'pre') return result;
            if (row.casMoment === 'post') return result;
            return result;
          },
        }));
        assert.equal(crashed, true, `${kind}:${name}: crash seam did not execute`);
        assert.match(error.message, new RegExp(`injected ${kind}:${name}|compare-and-swap`, 'u'));

        const residue = exactLifecycleReceipt(
          protocol,
          fixture.repo,
          fixture.target,
          unrelated,
        );
        assert.deepEqual(stageEntry(fixture.repo, unrelated), unrelatedStage);
        assert.equal(residue.unrelatedStage, unrelatedStage.toString('base64'));
        assert.ok(residue.refOid);
        assert.ok(residue.refBytes);
        assert.ok(residue.slots.a.bytes);
        assert.ok(residue.slots.b.bytes);
        if (row.casMoment === 'during') {
          const expected = row.branch === 'OLD' ? crashOld : crashNew;
          assert.equal(crashObserved.refOid, expected.refOid, `${kind}:${name}: exact ${row.branch} OID`);
          assert.equal(crashObserved.refBytes, expected.refBytes, `${kind}:${name}: exact ${row.branch} blob`);
          assert.deepEqual(crashObserved.publication, expected.publication);
          assert.deepEqual(crashObserved.slots, expected.slots);
          assert.equal(crashObserved.index, expected.index);
          assert.equal(crashObserved.staged, expected.staged);
          assert.equal(crashObserved.lease, expected.lease);
          assert.equal(crashObserved.targetStage, expected.targetStage);
          assert.equal(crashObserved.unrelatedStage, expected.unrelatedStage);
          assert.ok(residue.refOid, `${kind}:${name}: reconciled residue OID`);
          assert.ok(residue.refBytes, `${kind}:${name}: reconciled residue blob`);
        } else if (crashObserved && row.casMoment === 'post') {
          assert.equal(residue.refOid, crashObserved.refOid);
          assert.equal(residue.refBytes, crashObserved.refBytes);
          assert.deepEqual(residue.publication, crashObserved.publication);
          assert.deepEqual(residue.slots, crashObserved.slots);
          assert.equal(residue.index, crashObserved.index);
          assert.equal(residue.staged, crashObserved.staged);
        } else if (crashObserved) {
          assert.ok(crashObserved.refOid);
          assert.ok(crashObserved.refBytes);
          assert.ok(crashObserved.slots.a.bytes);
          assert.ok(crashObserved.slots.b.bytes);
        } else if (crashOld) {
          assert.ok(crashOld.refOid);
          assert.ok(crashOld.refBytes);
          assert.ok(crashOld.slots.a.bytes);
          assert.ok(crashOld.slots.b.bytes);
        }
        if (residue.publication.session !== null) {
          assert.equal(residue.lease, sessionLease(residue.selectedRecord));
          assert.equal(
            residue.publication.session.record_digest,
            residue.selectedRecord.record_digest,
          );
        }
        const retry = protocol.restoreMutation({
          repo: fixture.repo,
          ownerToken: fixture.ownerToken,
          now: Date.now() + 1,
          processProbe: () => ({ status: 'dead' }),
        });
        assert.equal(['restored', 'noop'].includes(retry.status), true, `${kind}:${name}: retry`);
        assert.deepEqual(stageEntry(fixture.repo, unrelated), unrelatedStage);
        assert.equal(stageEntry(fixture.repo, fixture.target).length, 0);
        assertProtocolIdle(protocol.__testing.inspectProtocol({ repo: fixture.repo }));
        assert.notDeepEqual(initial.refOid, null);
      });
    }
  }
});

test('[R6 W1 group 19] operation owner times outside the Date range are typed and immutable', async (t) => {
  const protocol = await loadProtocol();
  if (!gitAtLeast245()) {
    capabilitySkip(t, 'git-floor-unavailable');
    return;
  }
  const boundaries = [
    ['date-maximum-plus-one', 8_640_000_000_000_001],
    ['maximum-safe-integer', Number.MAX_SAFE_INTEGER],
  ];
  const entrypoints = ['ensure', 'perform', 'restore', 'auto'];

  for (const [boundaryName, processStartMs] of boundaries) {
    for (const entrypoint of entrypoints) {
      await t.test(`${entrypoint}:${boundaryName}`, () => {
        let repo;
        let target;
        let ownerToken;
        if (entrypoint === 'restore' || entrypoint === 'auto') {
          const fixture = recoveryFixture(
            protocol,
            'restore-committed',
            `r6-operation-date-${entrypoint}-${boundaryName}`,
          );
          ({ repo, target, ownerToken } = fixture);
        } else {
          repo = createGitFixture(`r6-operation-date-${entrypoint}-${boundaryName}`);
          target = `src/${entrypoint}-${boundaryName}.txt`;
          writeRepoFile(repo, target);
          assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
        }
        installOperation(repo, protocol, {
          operation: { process_start_ms: String(processStartMs) },
        });
        const before = protocolSnapshot(repo);
        const objects = gitObjectInventory(repo);
        let probeCalls = 0;
        let mutationCalls = 0;
        const options = {
          repo,
          now: Date.now() + 1_300_000,
          staleMs: 0,
          processProbe() {
            probeCalls += 1;
            return { status: 'dead' };
          },
          authorityTransitionHook() { mutationCalls += 1; },
          slotWriteHook() { mutationCalls += 1; },
          transitionHook() { mutationCalls += 1; },
          recoveryHook() { mutationCalls += 1; },
        };
        if (entrypoint === 'ensure') {
          assert.deepEqual(protocol.ensureCutover(options), {
            status: 'manual',
            reason: 'operation-busy',
          });
        } else {
          const error = captureError(() => entrypoint === 'perform'
            ? protocol.performMutation({ ...options, files: [target] })
            : entrypoint === 'restore'
              ? protocol.restoreMutation({ ...options, ownerToken })
              : protocol.autoRecover(options));
          assert.equal(error.name, 'MutationProtocolError');
          assert.equal(error.code, 'MUTATION_BUSY');
          assert.match(error.message, /operation.*process_start_ms|Date-representable/u);
          assert.equal(error instanceof RangeError, false);
        }
        assert.equal(probeCalls, 0, `${entrypoint}:${boundaryName}: host/PID probe ran`);
        assert.equal(mutationCalls, 0, `${entrypoint}:${boundaryName}: mutation hook ran`);
        assertSnapshotEqual(before, protocolSnapshot(repo), `${entrypoint}:${boundaryName}`);
        assert.deepEqual(
          gitObjectInventory(repo),
          objects,
          `${entrypoint}:${boundaryName}: object candidate created`,
        );
      });
    }
  }

  await t.test('zero is Date-representable and departed', () => {
    const repo = createGitFixture('r6-operation-date-zero');
    assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
    installOperation(repo, protocol, { operation: { process_start_ms: '0' } });
    let probeCalls = 0;
    const result = protocol.ensureCutover({
      repo,
      processProbe() {
        probeCalls += 1;
        return { status: 'dead' };
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(probeCalls, 1);
    assert.equal(protocol.__testing.inspectProtocol({ repo }).publication.operation, null);
  });

  await t.test('representable future time remains immutable without a probe', () => {
    const repo = createGitFixture('r6-operation-date-future');
    assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
    const now = Date.now();
    installOperation(repo, protocol, {
      operation: { process_start_ms: String(now + 60_000) },
    });
    const before = protocolSnapshot(repo);
    let probeCalls = 0;
    assert.deepEqual(protocol.ensureCutover({
      repo,
      now,
      processProbe() {
        probeCalls += 1;
        return { status: 'dead' };
      },
    }), { status: 'manual', reason: 'operation-busy' });
    assert.equal(probeCalls, 0);
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });

  await t.test('current owner remains live and immutable', () => {
    const repo = createGitFixture('r6-operation-date-current');
    assert.equal(protocol.ensureCutover({ repo }).status, 'ready');
    installOperation(repo, protocol);
    const before = protocolSnapshot(repo);
    let probeCalls = 0;
    assert.deepEqual(protocol.ensureCutover({
      repo,
      processProbe() {
        probeCalls += 1;
        return { status: 'live', startMs: protocol.__testing.processStartMs() };
      },
    }), { status: 'manual', reason: 'operation-busy' });
    assert.equal(probeCalls, 1);
    assertSnapshotEqual(before, protocolSnapshot(repo));
  });
});

test('[R3 C3 groups 7 and 22] pure Windows durability and framed transport policies are bounded', async () => {
  const protocol = await loadProtocol();
  const windows = protocol.__testing.durabilityPolicy('win32');
  assert.deepEqual(windows, {
    platform: 'win32',
    fileOpenFlag: 'r+',
    fileFsync: true,
    fileReopen: true,
    identityRecheck: true,
    applyFileMode: false,
    fsyncDirectory: false,
  });
  const posix = protocol.__testing.durabilityPolicy('linux');
  assert.equal(posix.fileOpenFlag, 'r');
  assert.equal(posix.fileFsync, true);
  assert.equal(posix.fileReopen, true);
  assert.equal(posix.identityRecheck, true);
  assert.equal(posix.applyFileMode, true);
  assert.equal(posix.fsyncDirectory, true);

  const transport = protocol.__testing.framedTransportPolicy('win32');
  assert.deepEqual(transport.argv, ['--request-stdin']);
  assert.equal(transport.shell, false);
  assert.equal(transport.transport, 'framed-stdin');
  assert.equal(transport.requestMaxBytes, 1_310_720);
  assert.equal(transport.commandLineLimitCodeUnits, 32_767);
  assert.ok(transport.commandLineCodeUnits < transport.commandLineLimitCodeUnits);
  assert.equal(
    transport.commandLineCodeUnits,
    transport.argv[0].length + 2,
  );

  const bytes = Buffer.from('durable windows slot\n');
  const file = resolve('injected-win32-slot');
  const events = [];
  const fileStat = {
    dev: 7n,
    ino: 11n,
    mode: 0o666n,
    size: BigInt(bytes.length),
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const fsOps = {
    ftruncateSync(fd, size) { events.push(`truncate:${fd}:${size}`); },
    writeSync(fd, source, offset, length, position) {
      events.push(`write:${fd}:${offset}:${length}:${position}`);
      return length;
    },
    fsyncSync(fd) { events.push(`fsync:${fd}`); },
    fchmodSync(fd) { events.push(`chmod:${fd}`); },
    closeSync(fd) { events.push(`close:${fd}`); },
    lstatSync(path) { events.push(`lstat:${path}`); return fileStat; },
    realpathSync(path) { events.push(`realpath:${path}`); return path; },
    openSync(path, flag) { events.push(`open:${path}:${flag}`); return 43; },
    fstatSync(fd) { events.push(`fstat:${fd}`); return fileStat; },
    readSync(fd, target, offset, length, position) {
      events.push(`read:${fd}:${offset}:${length}:${position}`);
      if (position === bytes.length) return 0;
      bytes.copy(target, offset, 0, length);
      return length;
    },
  };
  const durable = protocol.__testing.persistDurableDescriptor({
    descriptor: 42,
    file,
    bytes,
    mode: 0o600,
    platform: 'win32',
    fsOps,
  });
  assert.deepEqual(durable.identity, { dev: '7', ino: '11' });
  assert.deepEqual(durable.bytes, bytes);
  assert.equal(events.includes('fsync:42'), true);
  assert.ok(events.indexOf('fsync:42') < events.indexOf('close:42'));
  assert.ok(events.indexOf('close:42') < events.indexOf(`open:${file}:r+`));
  assert.ok(events.indexOf(`open:${file}:r+`) < events.indexOf('fstat:43'));
  assert.ok(events.indexOf('fstat:43') < events.findIndex((entry) => entry.startsWith('read:43:')));
  assert.equal(events.some((entry) => entry === `open:${dirname(file)}:r`), false);
  assert.equal(events.some((entry) => entry.startsWith('chmod:')), false);
  assert.equal(events.filter((entry) => entry.startsWith('fsync:')).length, 1);

  let closedAfterProbeFailure = false;
  assert.throws(() => protocol.__testing.persistDurableDescriptor({
    descriptor: 44,
    file,
    bytes,
    platform: 'win32',
    fsOps: {
      fstatSync() { throw new Error('injected descriptor identity failure'); },
      closeSync(fd) {
        assert.equal(fd, 44);
        closedAfterProbeFailure = true;
      },
    },
  }), /injected descriptor identity failure/u);
  assert.equal(closedAfterProbeFailure, true);
});
