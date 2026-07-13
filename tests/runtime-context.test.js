'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn: spawnChild } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const runtimeContextUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'runtime-context.mjs',
)).href;
const processUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'process.mjs',
)).href;

function readPidIfPresent(filePath) {
  if (!existsSync(filePath)) return undefined;
  const pid = Number(readFileSync(filePath, 'utf8'));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessGroupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    // An orphaned process can be between SIGKILL delivery and reaping. It is
    // not a successful cleanup signal, so keep the bounded test cleanup alive.
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

function killIfPresent(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function killProcessGroupIfPresent(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroupToExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!isProcessGroupGone(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`process group ${pid} survived test cleanup`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

async function importWindowsProcessFixture(spawnForTest) {
  const source = readFileSync(new URL(processUrl), 'utf8');
  const forcedWindowsSource = source
    .replace(
      "import { spawn } from 'node:child_process';",
      "import { spawn as realSpawn } from 'node:child_process';\nconst spawn = globalThis.__deepReviewSpawnForTest || realSpawn;",
    )
    .replace(
      "const IS_WINDOWS = process.platform === 'win32';",
      'const IS_WINDOWS = true;',
    );
  assert.notEqual(forcedWindowsSource, source, 'the platform seam must remain testable');

  globalThis.__deepReviewSpawnForTest = spawnForTest;
  try {
    const uniqueSource = `${forcedWindowsSource}\n// fixture ${Date.now()}-${Math.random()}\n`;
    return await import(`data:text/javascript;base64,${Buffer.from(uniqueSource).toString('base64')}`);
  } finally {
    delete globalThis.__deepReviewSpawnForTest;
  }
}

function createWindowsTaskkillFixture(outcome) {
  let child;
  let directFallbackCalls = 0;
  const directFallbackSignals = [];
  let taskkillCalls = 0;

  return {
    spawn(command, args, options) {
      if (String(command).toLowerCase() === 'taskkill.exe') {
        taskkillCalls += 1;
        assert.deepEqual(args, ['/pid', String(child.pid), '/t', '/f']);
        assert.equal(options.shell, false);

        const killer = new EventEmitter();
        queueMicrotask(() => {
          if (outcome === 'success') {
            child.__fixtureKill('SIGKILL');
            killer.emit('close', 0, null);
          } else if (outcome === 'error') {
            killer.emit('error', new Error('fake taskkill spawn failure'));
            killer.emit('close', -2, null);
          } else {
            killer.emit('close', 1, null);
          }
        });
        return killer;
      }

      child = spawnChild(command, args, options);
      const kill = child.kill.bind(child);
      child.__fixtureKill = kill;
      child.kill = (signal) => {
        directFallbackCalls += 1;
        directFallbackSignals.push(signal);
        return kill(signal);
      };
      return child;
    },
    stop() {
      child?.__fixtureKill('SIGKILL');
    },
    result() {
      return { directFallbackCalls, directFallbackSignals, taskkillCalls };
    },
  };
}

async function runWindowsTimeoutFixture(fixture) {
  const { runProcess } = await importWindowsProcessFixture(fixture.spawn);
  const resultPromise = runProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 30 },
  );
  let deadline;
  let result;
  try {
    result = await Promise.race([
      resultPromise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Windows timeout fixture exceeded 1000ms')), 1000);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(deadline);
    if (result === undefined) {
      fixture.stop();
      await resultPromise;
    }
  }
}

test('Codex markers win over compatibility Claude markers', async () => {
  const { detectRuntimeHost } = await import(runtimeContextUrl);
  assert.equal(detectRuntimeHost({
    CODEX_HOME: 'C:\\Users\\codex',
    PLUGIN_ROOT: 'C:\\plugins\\deep-review',
    CLAUDE_PLUGIN_ROOT: 'C:\\compat\\deep-review',
  }), 'codex');
});

test('generic PLUGIN_ROOT never misclassifies a Claude host as Codex', async () => {
  const { detectRuntimeHost } = await import(runtimeContextUrl);
  assert.equal(detectRuntimeHost({
    PLUGIN_ROOT: 'C:\\plugins\\deep-review',
    CLAUDE_PLUGIN_ROOT: 'C:\\plugins\\deep-review',
  }), 'claude');
  assert.equal(detectRuntimeHost({ PLUGIN_ROOT: '/opt/plugins/deep-review' }), 'unknown');
});

test('PLUGIN_ROOT wins and module URL is the final root fallback', async () => {
  const { resolvePluginRoot } = await import(runtimeContextUrl);
  assert.equal(resolvePluginRoot({
    env: { PLUGIN_ROOT: '/plugin A', CLAUDE_PLUGIN_ROOT: '/plugin B' },
    moduleUrl: pathToFileURL(join(tmpdir(), 'ignored', 'hooks', 'scripts', 'lib', 'probe.mjs')).href,
  }), resolve('/plugin A'));

  const root = mkdtempSync(join(tmpdir(), 'deep-review-root-'));
  const moduleUrl = pathToFileURL(join(root, 'hooks', 'scripts', 'lib', 'probe.mjs')).href;
  assert.equal(
    resolvePluginRoot({ env: {}, moduleUrl }),
    require('node:url').fileURLToPath(new URL('../../..', moduleUrl)),
  );
});

test('atomic writes create private files without leaving a sibling temp', async () => {
  const { atomicWriteFile } = await import(runtimeContextUrl);
  const root = mkdtempSync(join(tmpdir(), 'deep-review-atomic-'));
  const output = join(root, 'nested', 'result.txt');

  atomicWriteFile(output, '공백 Ω');

  assert.equal(readFileSync(output, 'utf8'), '공백 Ω');
  if (process.platform !== 'win32') {
    assert.equal(statSync(output).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(dirname(output)), [basename(output)]);
});

test('secure temp paths are unique, private, and suffix-preserving', async () => {
  const { makeSecureTempPath } = await import(runtimeContextUrl);
  const first = makeSecureTempPath('deep review', '.json');
  const second = makeSecureTempPath('deep review', '.json');
  const unicode = makeSecureTempPath('deep review', '-결과 Ω.md');

  assert.notEqual(first, second);
  assert.equal(first.endsWith('.json'), true);
  assert.equal(unicode.endsWith('-결과 Ω.md'), true);
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(dirname(first)), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(dirname(first)).mode & 0o777, 0o700);
  }
});

test('secure temp suffix rejects every path-like spelling before allocation', async () => {
  const { makeSecureTempPath } = await import(runtimeContextUrl);
  const prefix = `deep-review-unsafe-suffix-${process.pid}`;
  const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith(`${prefix}-`));
  const unsafeSuffixes = [
    '../target',
    '/../../../target',
    'nested/file',
    '..\\target',
    '\\absolute-looking',
    'C:drive-relative',
    'C:\\temp\\target',
    '\\\\server\\share\\target',
    '\0.json',
  ];

  for (const suffix of unsafeSuffixes) {
    assert.throws(
      () => makeSecureTempPath(prefix, suffix),
      TypeError,
      JSON.stringify(suffix),
    );
  }
  const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith(`${prefix}-`));
  assert.deepEqual(after, before, 'validation must run before mkdtempSync');
});

test('process runner preserves one Unicode argument and classifies timeout as 124', async () => {
  const { runProcess } = await import(processUrl);
  const probe = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', '공백 Ω'],
    {},
  );
  assert.equal(probe.code, 0);
  assert.equal(probe.stdout.toString(), '공백 Ω');

  const timed = await runProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 30 },
  );
  assert.equal(timed.timedOut, true);
  assert.equal(timed.code, 124);
});

test('process runner normalizes every ENOENT spawn result to code 127', async () => {
  const { runProcess } = await import(processUrl);
  const missing = join(mkdtempSync(join(tmpdir(), 'deep-review-missing-')), 'not-an-executable');

  const result = await runProcess(missing, [], { timeoutMs: 30 });

  assert.equal(result.code, 127);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr.toString(), /ENOENT/);
});

test('Windows timeout falls back once when taskkill exits nonzero', async () => {
  const fixture = createWindowsTaskkillFixture('nonzero');
  const result = await runWindowsTimeoutFixture(fixture);

  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  assert.match(
    result.stderr.toString(),
    /Windows taskkill failed; sent direct SIGKILL fallback\n/,
  );
  assert.deepEqual(fixture.result(), {
    directFallbackCalls: 1,
    directFallbackSignals: ['SIGKILL'],
    taskkillCalls: 1,
  });
});

test('Windows timeout falls back once when taskkill emits an error then closes', async () => {
  const fixture = createWindowsTaskkillFixture('error');
  const result = await runWindowsTimeoutFixture(fixture);

  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  assert.match(
    result.stderr.toString(),
    /Windows taskkill failed; sent direct SIGKILL fallback\n/,
  );
  assert.deepEqual(fixture.result(), {
    directFallbackCalls: 1,
    directFallbackSignals: ['SIGKILL'],
    taskkillCalls: 1,
  });
});

test('Windows timeout preserves successful taskkill tree termination without direct fallback', async () => {
  const fixture = createWindowsTaskkillFixture('success');
  const result = await runWindowsTimeoutFixture(fixture);

  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  assert.doesNotMatch(result.stderr.toString(), /Windows taskkill failed/);
  assert.deepEqual(fixture.result(), {
    directFallbackCalls: 0,
    directFallbackSignals: [],
    taskkillCalls: 1,
  });
});

test('process runner returns a result when a child closes stdin during a large write', async () => {
  const { runProcess } = await import(processUrl);
  const target = [
    'process.stdin.destroy();',
    "process.stdout.write('stdin-closed');",
  ].join('');
  const caller = [
    `import { runProcess } from ${JSON.stringify(processUrl)};`,
    `const result = await runProcess(process.execPath, ['-e', ${JSON.stringify(target)}], {`,
    '  input: Buffer.alloc(32 * 1024 * 1024),',
    '});',
    'process.stdout.write(JSON.stringify({',
    '  code: result.code,',
    '  stdout: result.stdout.toString(),',
    '}));',
  ].join('\n');

  const outer = await runProcess(
    process.execPath,
    ['--input-type=module', '-e', caller],
  );

  assert.equal(outer.code, 0, outer.stderr.toString());
  assert.deepEqual(JSON.parse(outer.stdout.toString()), {
    code: 0,
    stdout: 'stdin-closed',
  });
});

test('POSIX timeout escalates a SIGTERM-ignoring process group within a bound', {
  skip: process.platform === 'win32',
}, async () => {
  const { runProcess } = await import(processUrl);
  const root = mkdtempSync(join(tmpdir(), 'deep-review-timeout-'));
  const pidFile = join(root, 'child.pid');
  const resultPromise = runProcess(process.execPath, [
    '-e',
    [
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join(''),
    pidFile,
  ], { timeoutMs: 250 });

  let deadline;
  let result;
  try {
    result = await Promise.race([
      resultPromise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('timeout escalation exceeded 1500ms')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    if (result === undefined && existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await resultPromise;
    }
  }

  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(
    () => process.kill(-pid, 0),
    (error) => error.code === 'ESRCH',
    'the dedicated POSIX process group must be gone before runProcess resolves',
  );
});

test('POSIX timeout keeps an outer await alive until a SIGTERM-exiting parent group is gone', {
  skip: process.platform === 'win32',
}, async () => {
  const { runProcess } = await import(processUrl);
  const root = mkdtempSync(join(tmpdir(), 'deep-review-timeout-outer-'));
  const parentPidFile = join(root, 'parent.pid');
  const descendantPidFile = join(root, 'descendant.pid');
  const descendant = [
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('');
  const parent = [
    "const { spawn } = require('node:child_process');",
    `require('node:fs').writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));`,
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(descendantPidFile)}], { stdio: 'ignore' });`,
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const outer = [
    "import { readFileSync } from 'node:fs';",
    `import { runProcess } from ${JSON.stringify(processUrl)};`,
    `const result = await runProcess(process.execPath, ['-e', ${JSON.stringify(parent)}], { timeoutMs: 250 });`,
    `const processGroupId = Number(readFileSync(${JSON.stringify(parentPidFile)}, 'utf8'));`,
    'let processGroupGone = false;',
    'try { process.kill(-processGroupId, 0); } catch (error) {',
    "  if (error.code === 'ESRCH') processGroupGone = true; else throw error;",
    '}',
    'process.stdout.write(JSON.stringify({',
    '  code: result.code,',
    '  timedOut: result.timedOut,',
    '  processGroupGone,',
    '}));',
  ].join('\n');

  let deadline;
  let outerResult;
  const outerResultPromise = runProcess(
    process.execPath,
    ['--input-type=module', '-e', outer],
    { timeoutMs: 2500 },
  );
  try {
    outerResult = await Promise.race([
      outerResultPromise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('outer timeout fixture exceeded 3000ms')), 3000);
      }),
    ]);

    const parentPid = readPidIfPresent(parentPidFile);
    assert.ok(parentPid, 'the direct parent must record its process-group id');
    if (outerResult.stdout.length === 0) {
      assert.equal(
        isProcessGroupGone(parentPid),
        false,
        'an outputless outer process must leave the SIGTERM-ignoring descendant group behind',
      );
    }
    assert.notEqual(
      outerResult.stdout.length,
      0,
      'the old unreferenced escalation exits the outer process without JSON and leaks its descendant',
    );
    assert.equal(outerResult.timedOut, false, outerResult.stderr.toString());
    assert.equal(outerResult.code, 0, outerResult.stderr.toString());
    const result = JSON.parse(outerResult.stdout.toString());
    assert.equal(result.timedOut, true);
    assert.equal(result.code, 124);
    assert.equal(result.processGroupGone, true);

    assert.equal(isProcessGroupGone(parentPid), true);
  } finally {
    clearTimeout(deadline);
    const parentPid = readPidIfPresent(parentPidFile);
    const descendantPid = readPidIfPresent(descendantPidFile);
    killProcessGroupIfPresent(parentPid);
    killIfPresent(descendantPid);
    if (parentPid) await waitForProcessGroupToExit(parentPid);
  }
});

test('executable resolution and argv transport remain shell-free', async () => {
  const { resolveExecutable, runProcess } = await import(processUrl);
  const root = mkdtempSync(join(tmpdir(), 'deep-review-path-'));
  const binDir = join(root, 'Path with spaces');
  const marker = join(root, 'unexpected-marker');
  const dangerous = `공백 Ω %DEEP_REVIEW_INJECT% %PATH% !^&|<> " > "${marker}"`;
  mkdirSync(binDir);

  if (process.platform === 'win32') {
    const probe = join(binDir, 'probe.cmd');
    writeFileSync(probe, [
      '@echo off',
      'if not "%~2"=="" type nul > "%PROBE_MARKER_FILE%"',
      '"%NODE_EXE%" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" "%~1"',
      '',
    ].join('\r\n'));

    const variants = [
      {
        Path: binDir,
        pAtHeXt: '.COM;.EXE;.BAT;.CMD',
        cOmSpEc: process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
      },
      {
        PATH: binDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        COMSPEC: process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
      },
    ];
    const dangerousArguments = [
      dangerous,
      'embedded " quote',
      'before-quote\\"after',
      'trailing-backslash\\',
      '',
    ];

    for (const variant of variants) {
      const env = {
        ...process.env,
        ...variant,
        NODE_EXE: process.execPath,
        PROBE_MARKER_FILE: marker,
        DEEP_REVIEW_INJECT: `EXPANDED & type nul > "${marker}" & rem`,
      };
      assert.equal(resolveExecutable('probe', env)?.toLowerCase(), probe.toLowerCase());
      for (const argument of dangerousArguments) {
        const result = await runProcess('probe', [argument], { env });
        assert.equal(result.code, 0, result.stderr.toString());
        assert.deepEqual(JSON.parse(result.stdout.toString()), [argument]);
        assert.equal(existsSync(marker), false);
      }
    }
  } else {
    const probe = join(binDir, 'probe');
    writeFileSync(probe, [
      `#!${process.execPath}`,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      '',
    ].join('\n'));
    chmodSync(probe, 0o755);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      PROBE_MARKER_FILE: marker,
    };

    assert.equal(resolveExecutable('probe', env), probe);
    const result = await runProcess('probe', [dangerous], { env });
    assert.equal(result.code, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(result.stdout.toString()), [dangerous]);
    assert.equal(existsSync(marker), false);
  }
});

test('Windows batch preparation defers literal percent through one expansion pass', async () => {
  const source = readFileSync(new URL(processUrl), 'utf8');
  const forcedWindowsSource = source.replace(
    "const IS_WINDOWS = process.platform === 'win32';",
    'const IS_WINDOWS = true;',
  );
  assert.notEqual(forcedWindowsSource, source, 'the platform seam must remain testable');
  const instrumented = `${forcedWindowsSource}\nexport { prepareSpawn as __prepareSpawnForTest };\n`;
  const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);
  const root = mkdtempSync(join(tmpdir(), 'deep-review-cmd-transport-'));
  const command = join(root, 'probe.cmd');
  writeFileSync(command, '@echo off\r\n');
  const env = {
    ...process.env,
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    'DEEP_REVIEW_INJECT^': 'EXPANDED-INJECTION',
    'PATH^': 'EXPANDED-PATH',
  };
  const prepared = module.__prepareSpawnForTest(
    command,
    ['%DEEP_REVIEW_INJECT% %PATH%'],
    env,
  );

  const transportEnv = prepared.env || env;
  const expandedOnce = prepared.args.at(-1).replace(/%([^%]+)%/g, (match, name) => {
    const entry = Object.entries(transportEnv)
      .find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry ? String(entry[1]) : match;
  });
  assert.equal(expandedOnce.includes('%DEEP_REVIEW_INJECT%'), true);
  assert.equal(expandedOnce.includes('%PATH%'), true);
  assert.equal(expandedOnce.includes('EXPANDED-INJECTION'), false);
  assert.equal(expandedOnce.includes('EXPANDED-PATH'), false);
});
