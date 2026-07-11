'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

  assert.notEqual(first, second);
  assert.equal(first.endsWith('.json'), true);
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(dirname(first)), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(dirname(first)).mode & 0o777, 0o700);
  }
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

test('executable resolution and argv transport remain shell-free', async () => {
  const { resolveExecutable, runProcess } = await import(processUrl);
  const root = mkdtempSync(join(tmpdir(), 'deep-review-path-'));
  const binDir = join(root, 'Path with spaces');
  const marker = join(root, 'unexpected-marker');
  const dangerous = '공백 Ω %!^&|<>';
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

    for (const variant of variants) {
      const env = {
        ...process.env,
        ...variant,
        NODE_EXE: process.execPath,
        PROBE_MARKER_FILE: marker,
      };
      assert.equal(resolveExecutable('probe', env)?.toLowerCase(), probe.toLowerCase());
      const result = await runProcess('probe', [dangerous], { env });
      assert.equal(result.code, 0, result.stderr.toString());
      assert.deepEqual(JSON.parse(result.stdout.toString()), [dangerous]);
      assert.equal(existsSync(marker), false);
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
