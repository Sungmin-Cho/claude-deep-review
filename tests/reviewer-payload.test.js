'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  cleanupGitFixtures,
  createGitFixture,
} = require('./helpers/git-fixture.js');

const pluginRoot = resolve(__dirname, '..');
const modulePath = join(pluginRoot, 'hooks', 'scripts', 'build-reviewer-payload.mjs');
const moduleUrl = pathToFileURL(modulePath).href;
const criteriaPath = join(
  pluginRoot,
  'skills',
  'deep-review-workflow',
  'references',
  'review-criteria.md',
);
const legacyExtractor = join(pluginRoot, 'hooks', 'scripts', 'extract-fp-doctrine.sh');
const temporaryRoots = new Set();

function temporaryDirectory(prefix = 'deep-review-payload-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadPayload() {
  return import(moduleUrl);
}

const VALID_CRITERIA = [
  'prefix',
  '<!-- fp-conservative:start -->',
  '도달이 불분명하면 강등하지 않는다.',
  '<!-- fp-conservative:end -->',
  'middle',
  '<!-- fp-doctrine:start -->',
  '- pre-existing 문제',
  '- 린터 스타일',
  '- 근거 없는 추측',
  '- 단순 취향',
  '<!-- fp-doctrine:end -->',
  'VOICE-6 confidence stays outside',
].join('\n');

function writeCriteria(root, text) {
  const file = join(
    root,
    'skills',
    'deep-review-workflow',
    'references',
    'review-criteria.md',
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function doctrineFromPrompt(prompt) {
  const match = prompt.match(
    /===== REVIEW SUPPRESSION DOCTRINE =====\n([\s\S]*?)(?=\n=====|$)/,
  );
  return match?.[1].trimEnd() ?? '';
}

test('anchor extraction requires one ordered non-empty pair for both blocks', async () => {
  const { buildReviewerPayload } = await loadPayload();
  const invalidCases = new Map([
    ['doctrine missing', VALID_CRITERIA.replace('<!-- fp-doctrine:end -->', '')],
    ['doctrine duplicated', `${VALID_CRITERIA}\n<!-- fp-doctrine:start -->\nextra\n<!-- fp-doctrine:end -->`],
    ['doctrine reversed', VALID_CRITERIA
      .replace('<!-- fp-doctrine:start -->', 'TEMP')
      .replace('<!-- fp-doctrine:end -->', '<!-- fp-doctrine:start -->')
      .replace('TEMP', '<!-- fp-doctrine:end -->')],
    ['doctrine empty', VALID_CRITERIA.replace('- pre-existing 문제\n- 린터 스타일\n- 근거 없는 추측\n- 단순 취향', '   ')],
    ['conservative missing', VALID_CRITERIA.replace('<!-- fp-conservative:end -->', '')],
    ['conservative duplicated', `${VALID_CRITERIA}\n<!-- fp-conservative:start -->\nextra\n<!-- fp-conservative:end -->`],
    ['conservative reversed', VALID_CRITERIA
      .replace('<!-- fp-conservative:start -->', 'TEMP')
      .replace('<!-- fp-conservative:end -->', '<!-- fp-conservative:start -->')
      .replace('TEMP', '<!-- fp-conservative:end -->')],
    ['conservative empty', VALID_CRITERIA.replace('도달이 불분명하면 강등하지 않는다.', '   ')],
  ]);

  for (const [name, source] of invalidCases) {
    const root = temporaryDirectory(`deep-review-anchor-${name}-`);
    writeCriteria(root, source);
    const result = buildReviewerPayload({ pluginRoot: root, diff: 'diff' });
    const prompt = readFileSync(result.promptFile, 'utf8');
    assert.deepEqual(
      result.warnings,
      ['fp-doctrine extraction failed (injection skipped)'],
      name,
    );
    assert.equal(doctrineFromPrompt(prompt), '', name);
    assert.doesNotMatch(prompt, /REVIEW SUPPRESSION DOCTRINE/, name);
  }
});

test('all legacy semantic doctrine gates fail closed with the same warning', async () => {
  const { buildReviewerPayload, extractFalsePositiveDoctrine } = await loadPayload();
  const invalidCases = [
    VALID_CRITERIA.replace('- 단순 취향\n', ''),
    VALID_CRITERIA.replace('pre-existing', 'existing'),
    VALID_CRITERIA.replace('린터', 'formatter'),
    VALID_CRITERIA.replace('추측', 'guess'),
    VALID_CRITERIA.replace('취향', 'preference'),
    VALID_CRITERIA.replace('강등하지 않는다', '강등한다'),
    VALID_CRITERIA.replace('- 단순 취향', '- 단순 취향\n- VOICE-6 confidence'),
  ];

  for (const [index, source] of invalidCases.entries()) {
    assert.throws(() => extractFalsePositiveDoctrine(source), Error, `case ${index}`);
    const root = temporaryDirectory(`deep-review-semantic-${index}-`);
    writeCriteria(root, source);
    const result = buildReviewerPayload({ pluginRoot: root, diff: 'diff' });
    assert.deepEqual(
      result.warnings,
      ['fp-doctrine extraction failed (injection skipped)'],
      `case ${index}`,
    );
    assert.equal(doctrineFromPrompt(readFileSync(result.promptFile, 'utf8')), '');
  }
});

test('Node doctrine output is byte-identical to the Unix legacy oracle', { skip: process.platform === 'win32' }, async () => {
  const { extractFalsePositiveDoctrine } = await loadPayload();
  const source = readFileSync(criteriaPath, 'utf8');
  const legacy = spawnSync('bash', [legacyExtractor, criteriaPath], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(extractFalsePositiveDoctrine(source), legacy.stdout);

  const editedPath = join(temporaryDirectory('deep-review-doctrine-edit-'), 'criteria.md');
  const edited = source.replace(/^- .*취향.*\n/m, '');
  writeFileSync(editedPath, edited);
  assert.throws(() => extractFalsePositiveDoctrine(edited), /fp-doctrine/i);
  const rejected = spawnSync('bash', [legacyExtractor, editedPath], {
    encoding: 'utf8',
    shell: false,
  });
  assert.notEqual(rejected.status, 0);
});

test('builder reads only the canonical review-criteria path below the absolute plugin root', async () => {
  const { buildReviewerPayload } = await loadPayload();
  const root = temporaryDirectory('deep-review-canonical-source-');
  writeCriteria(root, VALID_CRITERIA.replace('- 단순 취향', '- 단순 취향 CANONICAL_SOURCE_SENTINEL'));
  writeFileSync(join(root, 'decoy.md'), VALID_CRITERIA.replace('- 단순 취향', '- 단순 취향 DECOY'));

  const result = buildReviewerPayload({ pluginRoot: root, diff: 'diff body' });
  const prompt = readFileSync(result.promptFile, 'utf8');
  assert.deepEqual(result.warnings, []);
  assert.match(prompt, /CANONICAL_SOURCE_SENTINEL/);
  assert.doesNotMatch(prompt, /DECOY/);
});

test('payload sections have the exact load-bearing order, omit empties, and keep diff last', async () => {
  const { assembleReviewerPayload } = await loadPayload();
  const payload = assembleReviewerPayload({
    doctrine: 'DOCTRINE',
    changeFiles: '{"path":"x"}\n',
    context: 'RULES',
    diff: 'DIFF',
  });
  const headers = [
    'REVIEW SUPPRESSION DOCTRINE',
    'CHANGED FILES (cross-file context)',
    'PROJECT RULES / CONTRACT / HEALTH',
    'DIFF UNDER REVIEW',
  ];
  let previous = -1;
  for (const header of headers) {
    const offset = payload.indexOf(`===== ${header} =====`);
    assert.ok(offset > previous, header);
    previous = offset;
  }
  assert.ok(payload.indexOf('DIFF') > payload.indexOf('RULES'));
  assert.equal(payload.trimEnd().endsWith('DIFF'), true);

  const diffOnly = assembleReviewerPayload({ doctrine: '', changeFiles: '', context: '', diff: 'ONLY' });
  assert.doesNotMatch(diffOnly, /REVIEW SUPPRESSION DOCTRINE/);
  assert.doesNotMatch(diffOnly, /CHANGED FILES/);
  assert.doesNotMatch(diffOnly, /PROJECT RULES/);
  assert.match(diffOnly, /DIFF UNDER REVIEW/);
  assert.equal(diffOnly.trimEnd().endsWith('ONLY'), true);
});

test('a 230000-byte diff leaves doctrine inside the first 198000 bytes', async () => {
  const { assembleReviewerPayload } = await loadPayload();
  const payload = assembleReviewerPayload({
    doctrine: 'DOCTRINE_SENTINEL',
    changeFiles: '{"path":"x"}',
    context: 'RULES',
    diff: `DIFF_SENTINEL\n${'x'.repeat(230000)}`,
  });
  assert.match(Buffer.from(payload).subarray(0, 198000).toString(), /DOCTRINE_SENTINEL/);
  assert.ok(payload.indexOf('DOCTRINE_SENTINEL') < payload.indexOf('DIFF_SENTINEL'));
});

test('builder writes a private atomic prompt and CLI emits exactly one JSON object', async () => {
  const { buildReviewerPayload } = await loadPayload();
  const repo = createGitFixture('payload cli 공간 Ω');
  writeFileSync(join(repo, 'new file Ω.txt'), 'new\n');
  const contextFile = join(temporaryDirectory('deep-review-context-'), 'context.txt');
  const diffFile = join(temporaryDirectory('deep-review-diff-'), 'diff.txt');
  writeFileSync(contextFile, 'CONTEXT');
  writeFileSync(diffFile, 'DIFF');

  const direct = buildReviewerPayload({
    pluginRoot,
    repo,
    changeState: 'untracked-only',
    contextFile,
    diffFile,
  });
  assert.equal(direct.changeFilesCount, 1);
  assert.deepEqual(direct.warnings, []);
  assert.match(readFileSync(direct.promptFile, 'utf8'), /new file Ω\.txt/);
  if (process.platform !== 'win32') assert.equal(statSync(direct.promptFile).mode & 0o777, 0o600);

  const cli = spawnSync(process.execPath, [
    modulePath,
    '--plugin-root', pluginRoot,
    '--repo', repo,
    '--change-state', 'untracked-only',
    '--context-file', contextFile,
    '--diff-file', diffFile,
  ], { encoding: 'utf8', shell: false });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.equal(cli.stdout.trim().split('\n').length, 1);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.changeFilesCount, 1);
  assert.deepEqual(result.warnings, []);
  assert.equal(readFileSync(result.promptFile, 'utf8').trimEnd().endsWith('DIFF'), true);
});

test('change-file enrichment failure is fail-soft while the final payload still writes', async () => {
  const { buildReviewerPayload } = await loadPayload();
  const repo = createGitFixture('payload fail soft');
  const result = buildReviewerPayload({
    pluginRoot,
    repo,
    changeState: 'clean',
    diff: 'CORE DIFF',
  });
  assert.equal(result.changeFilesCount, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^change-files construction failed \(section skipped\):/);
  const prompt = readFileSync(result.promptFile, 'utf8');
  assert.doesNotMatch(prompt, /CHANGED FILES/);
  assert.equal(prompt.trimEnd().endsWith('CORE DIFF'), true);
});
