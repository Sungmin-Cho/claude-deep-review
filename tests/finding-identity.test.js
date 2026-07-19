'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const pluginRoot = resolve(__dirname, '..');
const modulePath = join(pluginRoot, 'hooks', 'scripts', 'lib', 'finding-identity.mjs');
const moduleUrl = pathToFileURL(modulePath).href;

async function loadIdentity() {
  return import(moduleUrl);
}

test('canonicalizeRepoPath normalizes backslashes to forward slashes', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('a\\b\\c.mjs', { repoRoot: '/repo' }), 'a/b/c.mjs');
});

test('canonicalizeRepoPath strips leading ./ segments', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('./src/a.js'), 'src/a.js');
  assert.equal(canonicalizeRepoPath('./././src/a.js'), 'src/a.js');
});

test('canonicalizeRepoPath collapses duplicate slashes', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('a//b///c.js'), 'a/b/c.js');
});

test('canonicalizeRepoPath rejects NUL bytes', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.throws(() => canonicalizeRepoPath('a\0b.js'), TypeError);
  assert.throws(() => canonicalizeRepoPath(''), TypeError);
});

test('canonicalizeRepoPath is idempotent', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  const once = canonicalizeRepoPath('a\\b\\.\\c.mjs', { repoRoot: '/repo' });
  const twice = canonicalizeRepoPath(once, { repoRoot: '/repo' });
  assert.equal(twice, once);
  assert.equal(once, 'a/b/c.mjs');
});

test('canonicalizeRepoPath relativizes an absolute path under repoRoot', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('/repo/src/a.js', { repoRoot: '/repo' }), 'src/a.js');
  assert.equal(canonicalizeRepoPath('/repo/src/a.js', { repoRoot: '/repo/' }), 'src/a.js');
  // Outside repoRoot: normalized but left absolute (no relativization applied).
  assert.equal(canonicalizeRepoPath('/other/src/a.js', { repoRoot: '/repo' }), 'other/src/a.js');
});

test('canonicalizeRepoPath case-folds only on win32, matching assertSamePath', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(
    canonicalizeRepoPath('SRC\\A.JS', { repoRoot: 'C:\\repo', platform: 'win32' }),
    'src/a.js',
  );
  assert.equal(
    canonicalizeRepoPath('SRC/A.JS', { repoRoot: '/repo', platform: 'linux' }),
    'SRC/A.JS',
  );
});

test('extractFindings extracts backtick-quoted file:line locations per severity section', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F534} Critical',
    '- unsafe edge at `src/a.js:14`',
    '### \u{1F7E1} Warning',
    '- missing test at `src/b.js:21`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['critical', 'src/a.js', 14],
    ['warning', 'src/b.js', 21],
  ]);
  assert.equal(findings[0].title_slug, 'unsafe-edge-at');
});

test('extractFindings extracts bare (non-backtick) file:line locations', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F534} Critical',
    '- unsafe edge at src/a.js:14 without backticks',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['critical', 'src/a.js', 14],
  ]);
});

test('extractFindings ignores lines outside a Critical/Warning section', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E2} Passed',
    '- everything at `src/c.js:5` looks fine',
    '### \u{1F534} Critical',
    '- real issue at `src/d.js:9`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['critical', 'src/d.js', 9],
  ]);
});

test('matchFindings matches identical severity+path+line as repeated', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'critical', path: 'src/a.js', line: 14, title_slug: 'unsafe-edge' }];
  const current = [{ severity: 'critical', path: 'src/a.js', line: 14, title_slug: 'unsafe-edge' }];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.added, []);
});

test('matchFindings matches within +-6 lines as repeated (boundary)', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'warning', path: 'src/b.js', line: 21, title_slug: 'x' }];
  const current = [{ severity: 'warning', path: 'src/b.js', line: 27, title_slug: 'y' }];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.added, []);
});

test('matchFindings treats +-7 lines as unmatched (resolved+added)', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'warning', path: 'src/b.js', line: 21, title_slug: 'x' }];
  const current = [{ severity: 'warning', path: 'src/b.js', line: 28, title_slug: 'y' }];
  const result = matchFindings(previous, current);
  assert.deepEqual(result.repeated, []);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.added.length, 1);
});

test('matchFindings prefers an exact title_slug match over a closer line distance', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'critical', path: 'src/a.js', line: 10, title_slug: 'stable-slug' }];
  const current = [
    { severity: 'critical', path: 'src/a.js', line: 10, title_slug: 'different-slug' },
    { severity: 'critical', path: 'src/a.js', line: 13, title_slug: 'stable-slug' },
  ];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  assert.equal(result.repeated[0][1].title_slug, 'stable-slug');
  assert.equal(result.repeated[0][1].line, 13);
  assert.equal(result.resolved.length, 0);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].title_slug, 'different-slug');
});

test('matchFindings performs 1:1 greedy matching without double-consuming a candidate', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [
    { severity: 'warning', path: 'src/a.js', line: 5, title_slug: 'p1' },
    { severity: 'warning', path: 'src/a.js', line: 10, title_slug: 'p2' },
  ];
  const current = [
    { severity: 'warning', path: 'src/a.js', line: 11, title_slug: 'c1' },
  ];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  // The closer previous entry (line 10, distance 1) wins the single current candidate
  // over the farther one (line 5, distance 6) — both are within tolerance.
  assert.equal(result.repeated[0][0].title_slug, 'p2');
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].title_slug, 'p1');
  assert.deepEqual(result.added, []);
});
