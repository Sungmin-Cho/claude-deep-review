'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

function copyInstalledTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyInstalledTree(from, to);
    else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, statSync(from).mode & 0o777);
    } else {
      throw new Error(`unsupported installed fixture entry: ${from}`);
    }
  }
}

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
    copyInstalledTree(
      path.join(sourceRoot, relativePath),
      path.join(installedRoot, relativePath),
    );
  }
  copyFileSync(path.join(sourceRoot, 'package.json'), path.join(installedRoot, 'package.json'));
  assert.equal(path.basename(repo), 'deep review 공간 한글 Ω');
  return { repo, installedRoot };
}

function readInstalled(installedRoot, relativePath) {
  return readFileSync(path.join(installedRoot, relativePath), 'utf8');
}

async function loadInstalledRuntime(installedRoot) {
  const routeUrl = pathToFileURL(
    path.join(installedRoot, 'hooks', 'scripts', 'public-route.mjs'),
  ).href;
  const synthesisUrl = pathToFileURL(
    path.join(installedRoot, 'hooks', 'scripts', 'review-synthesis.mjs'),
  ).href;
  return {
    route: await import(routeUrl),
    synthesis: await import(synthesisUrl),
  };
}

async function exercisePublicRoute(installedRoot, host, route) {
  assert.ok(['claude', 'codex'].includes(host));
  assert.ok(['review', 'respond', 'loop'].includes(route));
  const { route: runtime } = await loadInstalledRuntime(installedRoot);
  const entry = route === 'loop' ? 'loop' : 'review';
  const argv = route === 'respond' ? ['--respond'] : [];
  const parsed = runtime.parsePublicRoute({ entry, argv, host });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.route, route);
  assert.equal(parsed.host, host);
}

function validReviewerReport() {
  return [
    '# Deep Review Report — 2026-07-18',
    '## Summary',
    '- **Verdict**: APPROVE',
    '- **Issues**: {🔴 0건, 🟡 0건, ℹ️ 0건}',
    '',
  ].join('\n');
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
  } else if (behavior === 'valid') {
    output = validReviewerReport();
  } else {
    throw new Error('unknown reviewer fake behavior');
  }

  const after = await captureFingerprint({
    repo,
    pluginRoot: installedRoot,
    mode: 'hybrid',
  });
  assert.equal(after.error, null);
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  return synthesis.evaluateReviewerAttempt({
    role: 'codex-review',
    output,
    beforeFingerprint: before,
    afterFingerprint: after,
  });
}

test('installed Claude and Codex routes execute the production route grammar in a spaces/Unicode fixture', async () => {
  const { repo, installedRoot } = installPluginFixture();
  for (const host of ['claude', 'codex']) {
    for (const route of ['review', 'respond', 'loop']) {
      await exercisePublicRoute(installedRoot, host, route);
    }
  }
  const codexManifest = JSON.parse(readInstalled(installedRoot, '.codex-plugin/plugin.json'));
  assert.deepEqual(codexManifest.interface.defaultPrompt, [
    '$deep-review:deep-review',
    '$deep-review:deep-review-loop',
  ]);
  assert.equal(Object.hasOwn(codexManifest, 'hooks'), false);
  assert.equal(Object.hasOwn(codexManifest, 'mcpServers'), false);
  const { route } = await loadInstalledRuntime(installedRoot);
  assert.equal(route.parsePublicRoute({
    entry: 'review', host: 'codex', argv: ['--ultracode', '--no-opus'],
  }).ok, false);
  assert.equal(route.parsePublicRoute({
    entry: 'loop', host: 'claude', argv: ['--respond'],
  }).ok, false);
  const reportPath = path.join(repo, 'review report 한글.md');
  writeFileSync(reportPath, validReviewerReport());
  const explicitReport = route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: [
      '--respond',
      '--codex',
      '--no-codex',
      'review report 한글.md',
      '--ultracode',
      '--no-opus',
    ],
  });
  assert.equal(explicitReport.ok, true);
  assert.equal(explicitReport.route, 'respond');
  assert.equal(explicitReport.reportPath, reportPath);
  assert.deepEqual(explicitReport.ignoredReviewerFlags, [
    '--codex', '--no-codex', '--ultracode', '--no-opus',
  ]);
  const missingReport = route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: ['--respond', '--codex', 'missing report.md'],
  });
  assert.equal(missingReport.ok, false);
  assert.match(missingReport.error, /existing file/u);
  assert.equal(route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: ['--respond', '--pr=7'],
  }).ok, false);
  assert.equal(route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: ['--respond', '--source=pr', '--pr=7'],
  }).ok, true);
});

test('trusted installed reviewer output reaches the production one-reviewer approval path', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'valid' });
  assert.deepEqual(review, {
    role: 'codex-review',
    included: true,
    exclusion: null,
    verdict: 'APPROVE',
    issues: { critical: 0, warning: 0, info: 0 },
  });
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  assert.deepEqual(synthesis.synthesizeReviewAttempts([review]), {
    status: 'reviewed',
    n_actual: 1,
    verdict: 'APPROVE',
    phase6_allowed: true,
    exclusions: [],
  });
});

test('multi-reviewer synthesis requires materialized agreement and preserves split warnings', async () => {
  const { installedRoot } = installPluginFixture();
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  const attempts = [
    {
      role: 'codex-review',
      included: true,
      exclusion: null,
      verdict: 'CONCERN',
      issues: { critical: 0, warning: 1, info: 0 },
    },
    {
      role: 'agy',
      included: true,
      exclusion: null,
      verdict: 'APPROVE',
      issues: { critical: 0, warning: 0, info: 0 },
    },
  ];
  assert.deepEqual(synthesis.synthesizeReviewAttempts(attempts), {
    status: 'operational_failure',
    n_actual: 2,
    verdict: null,
    phase6_allowed: false,
    exclusions: [],
    error: 'consensus_required',
  });
  assert.deepEqual(synthesis.synthesizeReviewAttempts(attempts, {
    findings: [{ severity: 'warning', roles: ['codex-review'] }],
  }), {
    status: 'reviewed',
    n_actual: 2,
    verdict: 'CONCERN',
    phase6_allowed: true,
    exclusions: [],
  });
  const agreedAttempts = [
    attempts[0],
    {
      ...attempts[1],
      verdict: 'CONCERN',
      issues: { critical: 0, warning: 1, info: 0 },
    },
  ];
  assert.equal(synthesis.synthesizeReviewAttempts(agreedAttempts, {
    findings: [{ severity: 'warning', roles: ['codex-review', 'agy'] }],
  }).verdict, 'REQUEST_CHANGES');
  assert.deepEqual(synthesis.synthesizeReviewAttempts(attempts, {
    findings: [],
  }), {
    status: 'operational_failure',
    n_actual: 2,
    verdict: null,
    phase6_allowed: false,
    exclusions: [],
    error: 'consensus_required',
  });

  const criticalAttempts = [
    {
      role: 'codex-review',
      included: true,
      exclusion: null,
      verdict: 'REQUEST_CHANGES',
      issues: { critical: 1, warning: 0, info: 0 },
    },
    attempts[1],
  ];
  assert.equal(synthesis.synthesizeReviewAttempts(criticalAttempts, {
    findings: [],
  }).phase6_allowed, false);
  assert.equal(synthesis.synthesizeReviewAttempts(criticalAttempts, {
    findings: [{ severity: 'critical', roles: ['codex-review'] }],
  }).verdict, 'REQUEST_CHANGES');
});

test('Codex generic reviewer mutation is fingerprinted and excluded', async () => {
  const { repo, installedRoot } = installPluginFixture();
  await exercisePublicRoute(installedRoot, 'codex', 'review');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'mutate' });
  assert.deepEqual(review, {
    role: 'codex-review',
    included: false,
    exclusion: 'fingerprint_mismatch',
    verdict: null,
    issues: null,
  });
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  const terminal = synthesis.synthesizeReviewAttempts([review]);
  assert.deepEqual(terminal, {
    status: 'operational_failure',
    n_actual: 0,
    verdict: null,
    phase6_allowed: false,
    exclusions: [{ role: 'codex-review', reason: 'fingerprint_mismatch' }],
  });
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('malformed generic reviewer result fails closed with no Phase 6 commit', async () => {
  const { repo, installedRoot } = installPluginFixture();
  await exercisePublicRoute(installedRoot, 'codex', 'respond');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'malformed' });
  assert.equal(review.included, false);
  assert.equal(review.verdict, null);
  assert.equal(review.exclusion, 'malformed_or_empty_result');
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  const terminal = synthesis.synthesizeReviewAttempts([review]);
  assert.equal(terminal.status, 'operational_failure');
  assert.equal(terminal.phase6_allowed, false);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('N_actual=0 is terminal on both hosts and the loop cannot commit', async () => {
  for (const host of ['claude', 'codex']) {
    const { repo, installedRoot } = installPluginFixture();
    await exercisePublicRoute(installedRoot, host, 'loop');
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const review = await runGenericReviewerFake({
      repo,
      installedRoot,
      behavior: 'unavailable',
    });
    const { synthesis } = await loadInstalledRuntime(installedRoot);
    const terminal = synthesis.synthesizeReviewAttempts([review]);
    assert.equal(terminal.n_actual, 0);
    assert.equal(terminal.status, 'operational_failure');
    assert.equal(terminal.verdict, null);
    assert.equal(terminal.phase6_allowed, false);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  }
});
