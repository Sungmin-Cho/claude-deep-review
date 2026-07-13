'use strict';

const assert = require('node:assert/strict');
const {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { after, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
} = require('./helpers/git-fixture.js');

const sourceRoot = path.resolve(__dirname, '..');
const temporaryRoots = new Set();

after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function installPluginFixture() {
  const repo = createGitFixture('deep review 공간 한글 Ω');
  const installedRoot = path.join(fixtureRootFor(repo), 'installed plugin 공간 Ω');
  mkdirSync(installedRoot, { recursive: true });
  for (const relativePath of [
    'agents',
    'commands',
    'hooks',
    'skills',
    '.claude-plugin',
    '.codex-plugin',
  ]) {
    cpSync(path.join(sourceRoot, relativePath), path.join(installedRoot, relativePath), {
      recursive: true,
    });
  }
  cpSync(path.join(sourceRoot, 'package.json'), path.join(installedRoot, 'package.json'));
  assert.equal(path.basename(repo), 'deep review 공간 한글 Ω');
  return { repo, installedRoot };
}

function readInstalled(installedRoot, relativePath) {
  return readFileSync(path.join(installedRoot, relativePath), 'utf8');
}

function exercisePublicRoute(installedRoot, host, route) {
  assert.ok(['claude', 'codex'].includes(host));
  assert.ok(['review', 'respond', 'loop'].includes(route));
  const publicReview = readInstalled(installedRoot, 'skills/deep-review/SKILL.md');
  const publicLoop = readInstalled(installedRoot, 'skills/deep-review-loop/SKILL.md');
  const claudeAdapter = readInstalled(installedRoot, 'commands/deep-review.md');
  if (host === 'claude') {
    if (route === 'loop') {
      assert.match(publicLoop, /Claude Code enters through \x60\/deep-review-loop\x60/u);
    } else {
      assert.match(claudeAdapter, /\/deep-review/u);
      assert.match(claudeAdapter, /skills\/deep-review\/SKILL\.md/u);
      assert.match(claudeAdapter, /\$ARGUMENTS/u);
    }
  } else if (route === 'loop') {
    assert.match(publicLoop, /\$deep-review:deep-review-loop/u);
  } else {
    assert.match(publicReview, /\$deep-review:deep-review/u);
  }
  if (route === 'respond') {
    assert.match(publicReview, /--respond.{0,40}terminal/isu);
    assert.match(publicReview, /phase6-protocol\.mjs/u);
  } else if (route === 'loop') {
    assert.match(publicLoop, /N_actual == 0.{0,100}operational failure/isu);
  } else {
    assert.match(publicReview, /review.{0,40}terminal/isu);
  }
}

function validReviewerReport() {
  return [
    '# Deep Review Report',
    '## Summary',
    '- **Verdict**: APPROVE',
    '- **Issues**: 🔴 0, 🟡 0, ℹ️ 0',
    '',
  ].join('\n');
}

function isWellFormedReviewerReport(value) {
  return typeof value === 'string'
    && /^# Deep Review Report$/mu.test(value)
    && /^## Summary$/mu.test(value)
    && /^- \*\*Verdict\*\*: (?:APPROVE|CONCERN|REQUEST_CHANGES)$/mu.test(value)
    && /^- \*\*Issues\*\*:/mu.test(value);
}

async function runGenericReviewerFake({ repo, installedRoot, behavior }) {
  const fingerprintUrl = pathToFileURL(
    path.join(installedRoot, 'hooks', 'scripts', 'lib', 'fingerprint.mjs'),
  ).href;
  const { captureFingerprint } = await import(fingerprintUrl);
  const before = await captureFingerprint({
    repo,
    pluginRoot: installedRoot,
    mode: 'hybrid',
  });
  assert.equal(before.error, null);

  let output;
  if (behavior === 'mutate') {
    writeFileSync(path.join(repo, 'generic reviewer mutation Ω.txt'), 'untrusted edit\n');
    output = validReviewerReport();
  } else if (behavior === 'malformed') {
    output = 'APPROVE without the shipped report contract';
  } else if (behavior === 'unavailable') {
    output = '';
  } else {
    throw new Error('unknown reviewer fake behavior');
  }

  const after = await captureFingerprint({
    repo,
    pluginRoot: installedRoot,
    mode: 'hybrid',
  });
  assert.equal(after.error, null);
  const trusted = before.digest === after.digest;
  const wellFormed = isWellFormedReviewerReport(output);
  const included = trusted && wellFormed;
  return {
    included,
    nActual: included ? 1 : 0,
    verdict: included ? 'APPROVE' : null,
    terminalStatus: included ? 'reviewed' : 'operational_failure',
    exclusion: !trusted
      ? 'fingerprint_mismatch'
      : (!wellFormed ? 'malformed_or_empty_result' : null),
  };
}

function applyTerminalGate(reviewResult, onPhase6Commit) {
  if (reviewResult.nActual === 0) {
    return {
      status: 'operational_failure',
      verdict: null,
      phase6Committed: false,
    };
  }
  onPhase6Commit();
  return {
    status: 'reviewed',
    verdict: reviewResult.verdict,
    phase6Committed: true,
  };
}

test('installed Claude and Codex routes resolve review, respond, and loop in a spaces/Unicode fixture', () => {
  const { installedRoot } = installPluginFixture();
  for (const host of ['claude', 'codex']) {
    for (const route of ['review', 'respond', 'loop']) {
      exercisePublicRoute(installedRoot, host, route);
    }
  }
  const codexManifest = JSON.parse(readInstalled(installedRoot, '.codex-plugin/plugin.json'));
  assert.deepEqual(codexManifest.interface.defaultPrompt, [
    '$deep-review:deep-review',
    '$deep-review:deep-review-loop',
  ]);
  assert.equal(Object.hasOwn(codexManifest, 'hooks'), false);
  assert.equal(Object.hasOwn(codexManifest, 'mcpServers'), false);
});

test('Codex generic reviewer mutation is fingerprinted and excluded', async () => {
  const { repo, installedRoot } = installPluginFixture();
  exercisePublicRoute(installedRoot, 'codex', 'review');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'mutate' });
  assert.deepEqual(review, {
    included: false,
    nActual: 0,
    verdict: null,
    terminalStatus: 'operational_failure',
    exclusion: 'fingerprint_mismatch',
  });
  let commitCalls = 0;
  const terminal = applyTerminalGate(review, () => { commitCalls += 1; });
  assert.deepEqual(terminal, {
    status: 'operational_failure',
    verdict: null,
    phase6Committed: false,
  });
  assert.equal(commitCalls, 0);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('malformed generic reviewer result fails closed with no Phase 6 commit', async () => {
  const { repo, installedRoot } = installPluginFixture();
  exercisePublicRoute(installedRoot, 'codex', 'respond');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'malformed' });
  assert.equal(review.included, false);
  assert.equal(review.nActual, 0);
  assert.equal(review.verdict, null);
  assert.equal(review.exclusion, 'malformed_or_empty_result');
  let commitCalls = 0;
  const terminal = applyTerminalGate(review, () => { commitCalls += 1; });
  assert.equal(terminal.status, 'operational_failure');
  assert.equal(terminal.phase6Committed, false);
  assert.equal(commitCalls, 0);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('N_actual=0 is terminal on both hosts and the loop cannot commit', async () => {
  for (const host of ['claude', 'codex']) {
    const { repo, installedRoot } = installPluginFixture();
    exercisePublicRoute(installedRoot, host, 'loop');
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const review = await runGenericReviewerFake({
      repo,
      installedRoot,
      behavior: 'unavailable',
    });
    let commitCalls = 0;
    const terminal = applyTerminalGate(review, () => { commitCalls += 1; });
    assert.equal(review.nActual, 0);
    assert.equal(terminal.status, 'operational_failure');
    assert.equal(terminal.verdict, null);
    assert.equal(terminal.phase6Committed, false);
    assert.equal(commitCalls, 0);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  }
});
