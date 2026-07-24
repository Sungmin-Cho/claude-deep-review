import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runClaudeReviewer } from '../hooks/scripts/run-claude-reviewer.mjs';
import {
  normalizeAdversarialReport,
  runCodexReviewer,
} from '../hooks/scripts/run-codex-reviewer.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const codexBridgePath = join(pluginRoot, 'hooks', 'scripts', 'run-codex-reviewer.mjs');

function workspace(label) {
  return mkdtempSync(join(tmpdir(), `deep-review-${label}-`));
}

function fakeCli(root, name = 'reviewer', nodeModule = false) {
  const script = join(root, `${name}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
const row = { argv: process.argv.slice(2), stdin, cwd: process.cwd() };
appendFileSync(process.env.FAKE_LOG, JSON.stringify(row) + '\\n');
const behavior = process.env.FAKE_BEHAVIOR || 'success';
if (behavior === 'auth') { process.stderr.write('Authentication failed: Not signed in\\n'); process.exit(7); }
if (behavior === 'failed') { process.stderr.write('generic failure\\n'); process.exit(9); }
if (behavior === 'empty') process.exit(0);
if (behavior === 'timeout') setInterval(() => {}, 1000);
if (behavior === 'success') {
  if (process.argv.includes('adversarial-review')) {
    process.stdout.write('# Codex Adversarial Review\\n\\nTarget: working tree diff\\nVerdict: needs-attention\\n\\nFindings:\\n- [high] reachable security regression (src/a.js:1)\\n');
  } else {
    process.stdout.write('review ok Ω\\n');
  }
}
`, { mode: 0o700 });
  chmodSync(script, 0o700);
  if (process.platform !== 'win32' || nodeModule) return script;
  const wrapper = join(root, `${name}.cmd`);
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  writeFileSync(join(root, `${name}.ps1`), `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}' @args\r\nexit $LASTEXITCODE\r\n`);
  return wrapper;
}

function rows(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function assertNoAtomicDebris(directory) {
  assert.equal(
    readdirSync(directory).some((name) => /\.tmp$|deep-review-focus/u.test(name)),
    false,
  );
}

test('Claude bridge preserves argv, stdin, Unicode paths, cwd, and arbitrary model', async () => {
  const root = workspace('claude bridge 리뷰 Ω');
  const projectRoot = join(root, 'project space 리뷰 Ω');
  const output = join(root, 'output space', 'claude.txt');
  const prompt = join(root, 'prompt 리뷰 Ω.txt');
  const log = join(root, 'argv.jsonl');
  const binary = fakeCli(root, 'claude fake');
  writeFileSync(prompt, 'shared prompt 리뷰 Ω');
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(projectRoot, { recursive: true }));

  const result = await runClaudeReviewer({
    projectRoot,
    pluginRoot,
    promptFile: prompt,
    outputFile: output,
    binary,
    model: 'future model 리뷰 Ω',
    timeoutSeconds: 5,
    env: { ...process.env, FAKE_LOG: log },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.code, 0);
  assert.equal(readFileSync(output, 'utf8'), 'review ok Ω\n');
  assert.equal(readFileSync(`${output}.status`, 'utf8'), 'success\n');
  const [row] = rows(log);
  const expectedCwd = statSync(projectRoot);
  const actualCwd = statSync(row.cwd);
  assert.deepEqual(
    [actualCwd.dev, actualCwd.ino],
    [expectedCwd.dev, expectedCwd.ino],
  );
  assert.equal(row.stdin, 'shared prompt 리뷰 Ω');
  assert.deepEqual(row.argv, [
    '-p',
    '--plugin-dir', pluginRoot,
    '--agent', 'code-reviewer',
    '--model', 'future model 리뷰 Ω',
    '--permission-mode', 'dontAsk',
    '--add-dir', projectRoot,
    '--tools', 'Read,Glob,Grep,Bash',
    '--output-format', 'text',
  ]);
  assertNoAtomicDebris(dirname(output));
});

test('Claude bridge defaults to opus and classifies 127, auth, timeout, failure, and empty output', async (t) => {
  const cases = [
    ['auth', 'not_authenticated', 7],
    ['failed', 'failed', 9],
    ['empty', 'failed', 0],
    ['timeout', 'timeout', 124],
  ];
  for (const [behavior, status, code] of cases) {
    await t.test(behavior, async () => {
      const root = workspace(`claude-${behavior}`);
      const projectRoot = join(root, 'repo');
      const prompt = join(root, 'prompt.txt');
      const output = join(root, 'out.txt');
      const log = join(root, 'argv.jsonl');
      const binary = fakeCli(root);
      await import('node:fs').then(({ mkdirSync }) => mkdirSync(projectRoot));
      writeFileSync(prompt, 'body');
      const result = await runClaudeReviewer({
        projectRoot,
        pluginRoot,
        promptFile: prompt,
        outputFile: output,
        binary,
        timeoutSeconds: behavior === 'timeout' ? 0.05 : 5,
        env: { ...process.env, FAKE_LOG: log, FAKE_BEHAVIOR: behavior },
      });
      assert.equal(result.status, status);
      assert.equal(result.code, code);
      assert.equal(readFileSync(`${output}.status`, 'utf8'), `${status}\n`);
      if (rows(log)[0]) assert.equal(rows(log)[0].argv.includes('opus'), true);
      assertNoAtomicDebris(root);
    });
  }

  const root = workspace('claude-missing');
  const projectRoot = join(root, 'repo');
  const prompt = join(root, 'prompt.txt');
  const output = join(root, 'out.txt');
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(projectRoot));
  writeFileSync(prompt, 'body');
  const missing = await runClaudeReviewer({
    projectRoot,
    pluginRoot,
    promptFile: prompt,
    outputFile: output,
    binary: join(root, 'missing-claude'),
    timeoutSeconds: 1,
  });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.code, 127);
  assert.match(missing.stderr, /ENOENT|not found/i);
  await assert.rejects(
    runClaudeReviewer({ projectRoot, pluginRoot, promptFile: prompt, outputFile: output, timeoutSeconds: 0 }),
    /positive/i,
  );
});

test('Codex review and adversarial bridges use process.execPath, exact target argv, and stdin-only focus', async () => {
  const root = workspace('codex bridge 리뷰 Ω');
  const projectRoot = join(root, 'repo space');
  const companion = fakeCli(root, 'companion', true);
  const log = join(root, 'argv.jsonl');
  const reviewOutput = join(root, 'review.txt');
  const adversarialOutput = join(root, 'adversarial.txt');
  const focusFile = join(root, 'focus 리뷰 Ω.txt');
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(projectRoot));
  writeFileSync(focusFile, 'hostile $(touch never) ; 리뷰 Ω');

  const review = await runCodexReviewer({
    projectRoot,
    companion,
    kind: 'review',
    base: 'abc123',
    outputFile: reviewOutput,
    timeoutSeconds: 5,
    env: { ...process.env, FAKE_LOG: log },
  });
  const adversarial = await runCodexReviewer({
    projectRoot,
    companion,
    kind: 'adversarial',
    scope: 'working-tree',
    focusFile,
    outputFile: adversarialOutput,
    timeoutSeconds: 5,
    env: { ...process.env, FAKE_LOG: log },
  });

  assert.equal(review.status, 'success');
  assert.equal(adversarial.status, 'success');
  assert.match(adversarial.stdout, /^# Deep Review Report — /u);
  assert.match(adversarial.stdout, /\*\*Verdict\*\*: REQUEST_CHANGES/u);
  assert.match(adversarial.raw_stdout, /^# Codex Adversarial Review/u);
  assert.equal(readFileSync(adversarialOutput, 'utf8'), adversarial.stdout);
  const [reviewRow, adversarialRow] = rows(log);
  assert.deepEqual(reviewRow.argv, ['review', '--base', 'abc123']);
  assert.deepEqual(adversarialRow.argv, ['adversarial-review', '--scope', 'working-tree', '-']);
  assert.equal(reviewRow.stdin, '');
  assert.equal(adversarialRow.stdin, 'hostile $(touch never) ; 리뷰 Ω');
  assert.equal(adversarialRow.argv.join(' ').includes('touch never'), false);
  assertNoAtomicDebris(root);
});

test('Codex adversarial normalization is fail-closed and preserves finding counts', () => {
  const normalized = normalizeAdversarialReport([
    '# Codex Adversarial Review',
    '',
    'Target: working tree diff',
    'Verdict: needs-attention',
    '',
    'Findings:',
    '- [high] critical path',
    '- [warning] split concern',
    '- [info] observation',
  ].join('\n'), new Date('2026-07-24T00:00:00Z'));
  assert.match(normalized, /^# Deep Review Report — 2026-07-24$/mu);
  assert.match(normalized, /🔴 1건, 🟡 1건, ℹ️ 1건/u);
  assert.match(normalized, /\*\*Verdict\*\*: REQUEST_CHANGES/u);
  assert.equal(normalizeAdversarialReport(
    '# Codex Adversarial Review\nTarget: working tree\nVerdict: needs-attention\nFindings:\n',
  ), null);
  assert.equal(normalizeAdversarialReport(
    '# Codex Adversarial Review\nTarget: working tree\nVerdict: reject\nFindings:\n1. issue\n',
  ), null);
  assert.equal(normalizeAdversarialReport(
    '# Codex Adversarial Review\nTarget: working tree\nVerdict: unknown\nFindings:\n',
  ), null);
  assert.equal(normalizeAdversarialReport(
    '# Codex Adversarial Review\nTarget: working tree\nVerdict: clean\nFindings:\n- [high] contradiction\n',
  ), null);
  assert.equal(normalizeAdversarialReport(
    '# Codex Adversarial Review\nTarget: working tree\nVerdict: clean\nFindings:\n',
    new Date('2026-07-24T00:00:00Z'),
  ).includes('**Verdict**: APPROVE'), true);
  assert.equal(normalizeAdversarialReport('review ok'), null);
});

test('Codex bridge classifies auth, timeout, generic failure, and empty output with atomic status', async (t) => {
  for (const [behavior, status, code] of [
    ['auth', 'not_authenticated', 7],
    ['timeout', 'timeout', 124],
    ['failed', 'failed', 9],
    ['empty', 'failed', 0],
  ]) {
    await t.test(behavior, async () => {
      const root = workspace(`codex-${behavior}`);
      const projectRoot = join(root, 'repo');
      const companion = fakeCli(root, 'companion', true);
      const outputFile = join(root, 'output 리뷰 Ω', 'result.txt');
      const log = join(root, 'argv.jsonl');
      await import('node:fs').then(({ mkdirSync }) => mkdirSync(projectRoot));
      const result = await runCodexReviewer({
        projectRoot,
        companion,
        kind: 'review',
        scope: 'working-tree',
        outputFile,
        timeoutSeconds: behavior === 'timeout' ? 0.05 : 5,
        env: { ...process.env, FAKE_LOG: log, FAKE_BEHAVIOR: behavior },
      });
      assert.equal(result.status, status);
      assert.equal(result.code, code);
      assert.equal(readFileSync(`${outputFile}.status`, 'utf8'), `${status}\n`);
      assertNoAtomicDebris(dirname(outputFile));
    });
  }
});

test('Codex CLI defaults project root to cwd and keeps every target value in argv', () => {
  const root = workspace('codex-cli');
  const projectRoot = join(root, 'repo 리뷰 Ω');
  const companion = fakeCli(root, 'companion', true);
  const outputFile = join(root, 'output.txt');
  const log = join(root, 'argv.jsonl');
  mkdirSync(projectRoot);
  const result = spawnSync(process.execPath, [
    codexBridgePath,
    '--companion', companion,
    '--kind', 'review',
    '--scope', 'working-tree',
    '--output', outputFile,
  ], {
    cwd: projectRoot,
    env: { ...process.env, FAKE_LOG: log },
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(rows(log)[0].cwd, realpathSync(projectRoot));
  assert.deepEqual(rows(log)[0].argv, ['review', '--scope', 'working-tree']);
  assert.equal(readFileSync(`${outputFile}.status`, 'utf8'), 'success\n');
});
