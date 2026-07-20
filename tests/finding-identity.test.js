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

test('canonicalizeRepoPath caseFold:false yields a case-PRESERVING display path on win32 (still repo-relativized)', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  // Reproduces the win32 findings_signature regression: the DISPLAY path must
  // keep `Ω` (and mixed case) verbatim so the signature reads identically on
  // every OS. The repoRoot prefix still folds+strips on win32 (one root on a
  // case-insensitive filesystem); only the surviving remainder stays verbatim.
  assert.equal(
    canonicalizeRepoPath('src/space name Ω.js', { repoRoot: '/repo', platform: 'win32', caseFold: false }),
    'src/space name Ω.js',
  );
  assert.equal(
    canonicalizeRepoPath('C:\\Repo\\SRC\\A.JS', { repoRoot: 'c:\\repo', platform: 'win32', caseFold: false }),
    'SRC/A.JS',
  );
});

test('canonicalizeRepoPath default (caseFold:true) still folds case on win32 for IDENTITY', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  // The identity default is retained so finding-identity.test.js:54 and any
  // direct identity use keep win32 case-insensitive keys; `Ω`→`ω`.
  assert.equal(
    canonicalizeRepoPath('src/space name Ω.js', { repoRoot: '/repo', platform: 'win32' }),
    'src/space name ω.js',
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

test('extractFindings extracts a ranged backticked location `path:START-END` using the start line', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- ranged citation at `src/a.js:14-20`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['warning', 'src/a.js', 14],
  ]);
});

test('extractFindings captures a comma-separated MULTI-range backticked citation using the FIRST range start line (no phantom findings)', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- multi-range citation at `src/a.js:1-2, 83-100`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  // Exactly one finding: the extra ranges must never mint phantom findings.
  assert.equal(findings.length, 1);
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['warning', 'src/a.js', 1],
  ]);
});

test('extractFindings captures a THREE-range backticked citation as one finding at the first start line', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F534} Critical',
    '- three ranges at `pkg/mod.ts:5-9, 40-41, 77-90`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'pkg/mod.ts');
  assert.equal(findings[0].line, 5);
});

test('extractFindings leaves single-range and plain backticked citations unchanged alongside a multi-range one', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- plain at `src/p.js:7`',
    '- ranged at `src/r.js:10-14`',
    '- multi at `src/m.js:3-4, 30-31`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.path, finding.line]), [
    ['src/p.js', 7],
    ['src/r.js', 10],
    ['src/m.js', 3],
  ]);
});

test('extractFindings does not register unquoted numeric prose (e.g. "backoff at 3:30") as a finding', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- backoff at 3:30',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings, []);
});

test('extractFindings yields a case-PRESERVING display path on win32 (findings_signature stays platform-independent)', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- path-safe issue at `src/space name Ω.js:28`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo', platform: 'win32' });
  // The signature's only platform-dependent component is finding.path; keeping
  // `Ω` verbatim here is exactly what makes findings_signature identical on
  // win32 and posix.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'src/space name Ω.js');
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

test('matchFindings folds path case on win32 (case-insensitive-filesystem IDENTITY preserved with case-preserving display paths)', async () => {
  const { matchFindings } = await loadIdentity();
  // Findings now carry case-preserving display paths, so the win32-only
  // case-insensitive identity match must live in matchFindings: two citations
  // of the same file differing only in case are ONE finding on win32.
  const previous = [{ severity: 'warning', path: 'src/Space Name Ω.js', line: 28, title_slug: 'path-safe-issue-at' }];
  const current = [{ severity: 'warning', path: 'src/space name ω.js', line: 28, title_slug: 'path-safe-issue-at' }];
  const result = matchFindings(previous, current, { platform: 'win32' });
  assert.equal(result.repeated.length, 1);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.added, []);
});

test('matchFindings keeps path comparison case-sensitive on posix (case-differing paths are distinct findings)', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'warning', path: 'src/Foo.js', line: 10, title_slug: 'x' }];
  const current = [{ severity: 'warning', path: 'src/foo.js', line: 10, title_slug: 'y' }];
  const result = matchFindings(previous, current, { platform: 'linux' });
  assert.deepEqual(result.repeated, []);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.added.length, 1);
});
