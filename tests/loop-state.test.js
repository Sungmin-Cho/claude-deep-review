'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const pluginRoot = resolve(__dirname, '..');
const modulePath = join(pluginRoot, 'hooks', 'scripts', 'loop-state.mjs');
const moduleUrl = pathToFileURL(modulePath).href;
const temporaryRoots = new Set();

function temporaryDirectory(prefix = 'deep-review-loop-state-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadLoopState() {
  return import(moduleUrl);
}

function runCli(args) {
  const result = spawnSync(process.execPath, [modulePath, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

const REVIEW_REPORT = [
  '# Deep Review Report',
  '## Summary',
  '- **Verdict**: REQUEST_CHANGES',
  '- **Issues**: \u{1F534} 1건, \u{1F7E1} 2건, ℹ️ 3건',
  '### \u{1F534} Critical',
  '- unsafe edge at `src/a.js:14`',
  '### \u{1F7E1} Warning',
  '- missing test at `src/b.js:21`',
  '- path-safe issue at `src/space name Ω.js:28`',
].join('\n');

const RESPONSE_REPORT = [
  '# Response Report',
  '## Summary',
  '- **Items**: 수락 1건, 반박 2건, 보류 0건',
  '- **execution_path**: subagent',
  '- **implemented_count**: 1',
  '- **halted**: false',
  '',
  '## Item Responses',
  '',
  '### ITEM-1: unsafe edge',
  '- **Severity**: \u{1F534} Critical',
  '- **Source**: Opus only',
  '- **Decision**: ACCEPT',
  '- **Evidence**:',
  '  - files_read: `src/a.js:10-20`',
  '- **Action**: fixed null check',
  '- **Test**: node --test → PASS',
  '',
  '### ITEM-2: missing test',
  '- **Severity**: \u{1F7E1} Warning',
  '- **Source**: Opus only',
  '- **Decision**: REJECT',
  '- **Evidence**:',
  '  - files_read: `src/b.js:18-25`',
  '  - grep_results: `testHelper` — 3 call sites',
  '- **Action**: existing coverage in tests/b.spec.js already covers this path',
  '- **Test**: n/a',
  '',
  '### ITEM-3: no location reject',
  '- **Severity**: ℹ️ Info',
  '- **Source**: Human',
  '- **Decision**: REJECT',
  '- **Evidence**:',
  '  - grep_results: none',
  '- **Action**: not applicable, no specific location cited',
  '- **Test**: n/a',
].join('\n');

const RECURRING_FINDINGS = {
  schema_version: '1.0',
  payload: {
    findings: [
      {
        category: 'error-handling',
        severity: 'critical',
        example_files: ['src/a.js:14'],
      },
    ],
  },
};

function writeFixtures(root) {
  const reportsDir = join(root, '.deep-review', 'reports');
  const responsesDir = join(root, '.deep-review', 'responses');
  const tmpDir = join(root, '.deep-review', 'tmp');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const reviewPath = join(reportsDir, '2026-07-19-100000-review.md');
  const responsePath = join(responsesDir, '2026-07-19-100100-response.md');
  const recurringPath = join(root, '.deep-review', 'recurring-findings.json');
  writeFileSync(reviewPath, REVIEW_REPORT);
  writeFileSync(responsePath, RESPONSE_REPORT);
  writeFileSync(recurringPath, JSON.stringify(RECURRING_FINDINGS));
  return { reviewPath, responsePath, recurringPath, tmpDir };
}

test('record-round exits 2 when base_commit is missing (CLI)', () => {
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const result = runCli([
    'record-round', '--round-number', '1', '--review-report', reviewPath, '--state-dir', tmpDir,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.ok, false);
});

test('recordRound mints a loop_id on round 1 and echoes {loop_id, state_file}', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, responsePath, recurringPath, tmpDir } = writeFixtures(root);
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    responseReport: responsePath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
    recurringFindings: recurringPath,
  });
  assert.equal(typeof result.loop_id, 'string');
  assert.ok(result.loop_id.length > 0);
  assert.equal(result.state_file, resolve(tmpDir, `loop-${result.loop_id}-round-1.state.json`));

  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.equal(persisted.schema_version, 1);
  assert.equal(persisted.source, 'report-parse');
  assert.equal(persisted.loop_id, result.loop_id);
  assert.equal(persisted.round_number, 1);
  assert.equal(persisted.base_commit, 'deadbeef');
  assert.equal(persisted.verdict, 'REQUEST_CHANGES');
  assert.deepEqual(persisted.counts, { critical: 1, warning: 2, info: 3 });
});

test('recordRound reuses an explicit loopId on round 2 instead of minting a new one', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const result = recordRound({
    roundNumber: 2,
    reviewReport: reviewPath,
    loopId: 'fixed-loop-id-123',
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
  });
  assert.equal(result.loop_id, 'fixed-loop-id-123');
  assert.equal(result.state_file, resolve(tmpDir, 'loop-fixed-loop-id-123-round-2.state.json'));
});

test('recordRound is deterministic across repeated calls given identical explicit inputs (loop_id excepted)', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, responsePath, recurringPath, tmpDir } = writeFixtures(root);
  const args = {
    roundNumber: 3,
    reviewReport: reviewPath,
    responseReport: responsePath,
    loopId: 'stable-id',
    baseCommit: 'cafebabe',
    stateDir: tmpDir,
    recurringFindings: recurringPath,
  };
  const first = recordRound(args);
  const second = recordRound({ ...args, stateDir: temporaryDirectory() });
  const firstBody = JSON.parse(readFileSync(first.state_file, 'utf8'));
  const secondBody = JSON.parse(readFileSync(second.state_file, 'utf8'));
  assert.deepEqual(firstBody.findings, secondBody.findings);
  assert.deepEqual(firstBody.rejected, secondBody.rejected);
  assert.deepEqual(firstBody.counts, secondBody.counts);
  assert.equal(firstBody.verdict, secondBody.verdict);
  assert.equal(firstBody.skipped_rejects, secondBody.skipped_rejects);
});

test('recordRound attaches recurring-findings category and defaults to untagged', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir, recurringPath } = writeFixtures(root);
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
    recurringFindings: recurringPath,
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  const critical = persisted.findings.find((finding) => finding.severity === 'critical');
  assert.equal(critical.category, 'error-handling');
  const warning = persisted.findings.find((finding) => finding.severity === 'warning');
  assert.equal(warning.category, 'untagged');
  // category is metadata, excluded from identity fields used elsewhere.
  assert.equal(typeof critical.title_slug, 'string');
});

test('recordRound extracts the first backtick path:line-line token (start line) for a REJECT item and counts location-less REJECTs as skipped', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, responsePath, tmpDir } = writeFixtures(root);
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    responseReport: responsePath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.equal(persisted.rejected.length, 1);
  assert.equal(persisted.rejected[0].path, 'src/b.js');
  assert.equal(persisted.rejected[0].line, 18);
  assert.match(persisted.rejected[0].reason, /existing coverage/);
  assert.equal(persisted.skipped_rejects, 1);
});

test('recordRound with no response report yields rejected=[] and skipped_rejects=0', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.deepEqual(persisted.rejected, []);
  assert.equal(persisted.skipped_rejects, 0);
});

test('renderPriorContext writes a header with loop_id/base_commit/round and an advisory rejected section', async () => {
  const { recordRound, renderPriorContext } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, responsePath, tmpDir } = writeFixtures(root);
  const recorded = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    responseReport: responsePath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
  });
  const output = join(tmpDir, `loop-${recorded.loop_id}-round-1.prior.md`);
  const rendered = renderPriorContext({ stateFile: recorded.state_file, output });
  assert.equal(rendered.output_file, output);
  const body = readFileSync(output, 'utf8');
  const firstLine = body.split('\n')[0];
  assert.equal(
    firstLine,
    `<!-- PRIOR-CONTEXT v1 loop_id=${recorded.loop_id} base_commit=deadbeef round=1 -->`,
  );
  assert.match(body, /재검증 필수, 억제 금지/);
  assert.match(body, /src\/b\.js:18/);
});

test('renderPriorContext truncates with a marker when the body exceeds maxBytes', async () => {
  const { recordRound, renderPriorContext } = await loadLoopState();
  const root = temporaryDirectory();
  const { tmpDir } = writeFixtures(root);
  const manyFindings = [
    '# Deep Review Report',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    `- **Issues**: \u{1F534} 40건, \u{1F7E1} 0건, ℹ️ 0건`,
    '### \u{1F534} Critical',
    ...Array.from({ length: 40 }, (_, index) => `- issue number ${index} at \`src/file${index}.js:${index + 1}\` needs a fix with a fairly long descriptive title to pad bytes`),
  ].join('\n');
  const bigReviewPath = join(root, '.deep-review', 'reports', '2026-07-19-110000-review.md');
  writeFileSync(bigReviewPath, manyFindings);
  const recorded = recordRound({
    roundNumber: 1,
    reviewReport: bigReviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
  });
  const output = join(tmpDir, `loop-${recorded.loop_id}-round-1.prior.md`);
  const rendered = renderPriorContext({ stateFile: recorded.state_file, output, maxBytes: 512 });
  assert.equal(rendered.truncated, true);
  const body = readFileSync(output, 'utf8');
  assert.ok(Buffer.byteLength(body, 'utf8') <= 512 + 64);
  assert.match(body, /TRUNCATED/);
});

test('render-prior-context CLI is registered and produces the file (round trip)', () => {
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const recordResult = runCli([
    'record-round', '--round-number', '1', '--review-report', reviewPath,
    '--base-commit', 'deadbeef', '--state-dir', tmpDir,
  ]);
  assert.equal(recordResult.status, 0, recordResult.stderr);
  const outputFile = join(tmpDir, `loop-${recordResult.json.loop_id}-round-1.prior.md`);
  const renderResult = runCli([
    'render-prior-context', '--state-file', recordResult.json.state_file, '--output', outputFile,
  ]);
  assert.equal(renderResult.status, 0, renderResult.stderr);
  assert.equal(renderResult.json.output_file, outputFile);
  assert.match(readFileSync(outputFile, 'utf8'), /PRIOR-CONTEXT v1/);
});
