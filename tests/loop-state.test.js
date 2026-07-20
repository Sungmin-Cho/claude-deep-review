'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  existsSync,
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

const mutationModulePath = join(pluginRoot, 'hooks', 'scripts', 'mutation-protocol.mjs');
const mutationModuleUrl = pathToFileURL(mutationModulePath).href;

async function loadMutation() {
  return import(mutationModuleUrl);
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

test('recordRound captures a REJECT item whose location is a comma-separated MULTI-range backticked citation, anchored at the first range start (not skipped)', async () => {
  const { recordRound } = await loadLoopState();
  const root = temporaryDirectory();
  const reportsDir = join(root, '.deep-review', 'reports');
  const responsesDir = join(root, '.deep-review', 'responses');
  const tmpDir = join(root, '.deep-review', 'tmp');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(responsesDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const reviewPath = join(reportsDir, '2026-07-19-120000-review.md');
  const responsePath = join(responsesDir, '2026-07-19-120100-response.md');
  writeFileSync(reviewPath, REVIEW_REPORT);
  writeFileSync(responsePath, [
    '# Response Report',
    '## Summary',
    '- **Items**: 수락 0건, 반박 1건, 보류 0건',
    '- **implemented_count**: 0',
    '- **halted**: false',
    '',
    '### ITEM-1: multi-range reject',
    '- **Decision**: REJECT',
    '- **Evidence**:',
    '  - files_read: `src/a.js:1-2, 83-100`',
    '- **Action**: spans multiple ranges but is a single finding',
    '',
  ].join('\n'));
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    responseReport: responsePath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.equal(persisted.skipped_rejects, 0);
  assert.equal(persisted.rejected.length, 1);
  assert.equal(persisted.rejected[0].path, 'src/a.js');
  assert.equal(persisted.rejected[0].line, 1);
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

const ROUND1_REVIEW = [
  '# Deep Review Report',
  '## Summary',
  '- **Verdict**: REQUEST_CHANGES',
  '- **Issues**: \u{1F534} 1건, \u{1F7E1} 2건, ℹ️ 0건',
  '### \u{1F534} Critical',
  '- issue A at `src/a.js:10`',
  '### \u{1F7E1} Warning',
  '- issue B at `src/b.js:20`',
  '- issue C at `src/c.js:30`',
].join('\n');

const ROUND2_REVIEW = [
  '# Deep Review Report',
  '## Summary',
  '- **Verdict**: CONCERN',
  '- **Issues**: \u{1F534} 1건, \u{1F7E1} 2건, ℹ️ 0건',
  '### \u{1F534} Critical',
  '- issue A at `src/a.js:10`',
  '### \u{1F7E1} Warning',
  '- issue B at `src/b.js:23`',
  '- issue D at `src/d.js:5`',
].join('\n');

const EMPTY_APPROVE_REVIEW = [
  '# Deep Review Report',
  '## Summary',
  '- **Verdict**: APPROVE',
  '- **Issues**: \u{1F534} 0건, \u{1F7E1} 0건, ℹ️ 0건',
  '### \u{1F7E2} Passed',
  '- everything looks fine',
].join('\n');

function recordTwoRounds(root, review1, review2) {
  const reportsDir = join(root, '.deep-review', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const path1 = join(reportsDir, '2026-07-19-090000-review.md');
  const path2 = join(reportsDir, '2026-07-19-091000-review.md');
  writeFileSync(path1, review1);
  writeFileSync(path2, review2);
  const tmpDir = join(root, '.deep-review', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const round1 = runCli([
    'record-round', '--round-number', '1', '--review-report', path1,
    '--base-commit', 'deadbeef', '--state-dir', tmpDir,
  ]);
  assert.equal(round1.status, 0, round1.stderr);
  const round2 = runCli([
    'record-round', '--round-number', '2', '--review-report', path2,
    '--loop-id', round1.json.loop_id, '--base-commit', 'deadbeef', '--state-dir', tmpDir,
  ]);
  assert.equal(round2.status, 0, round2.stderr);
  return { round1, round2, tmpDir };
}

test('compare-rounds reports repeated/resolved/added and a >=0.5 repeat_ratio as stalled=true, progressed=true', () => {
  const root = temporaryDirectory();
  const { round1, round2 } = recordTwoRounds(root, ROUND1_REVIEW, ROUND2_REVIEW);
  const compared = runCli([
    'compare-rounds', '--previous', round1.json.state_file, '--current', round2.json.state_file,
  ]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(compared.json.repeated_count, 2);
  assert.equal(compared.json.resolved_count, 1);
  assert.equal(compared.json.added_count, 1);
  assert.equal(compared.json.larger_set_size, 3);
  assert.ok(Math.abs(compared.json.repeat_ratio - 2 / 3) < 1e-9);
  assert.equal(compared.json.stalled, true);
  assert.equal(compared.json.progressed, true);
});

test('compare-rounds rejects a loop_id mismatch as STALE_STATE', () => {
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const roundA = runCli([
    'record-round', '--round-number', '1', '--review-report', reviewPath,
    '--loop-id', 'loop-A', '--base-commit', 'deadbeef', '--state-dir', tmpDir,
  ]);
  const roundB = runCli([
    'record-round', '--round-number', '2', '--review-report', reviewPath,
    '--loop-id', 'loop-B', '--base-commit', 'deadbeef', '--state-dir', tmpDir,
  ]);
  const compared = runCli([
    'compare-rounds', '--previous', roundA.json.state_file, '--current', roundB.json.state_file,
  ]);
  assert.notEqual(compared.status, 0);
  assert.equal(compared.json.error.code, 'STALE_STATE');
});

test('compare-rounds rejects a base_commit mismatch (same loop_id/schema_version) as STALE_STATE', () => {
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const roundA = runCli([
    'record-round', '--round-number', '1', '--review-report', reviewPath,
    '--loop-id', 'loop-shared', '--base-commit', 'deadbeef', '--state-dir', tmpDir,
  ]);
  const roundB = runCli([
    'record-round', '--round-number', '2', '--review-report', reviewPath,
    '--loop-id', 'loop-shared', '--base-commit', 'cafebabe', '--state-dir', tmpDir,
  ]);
  const compared = runCli([
    'compare-rounds', '--previous', roundA.json.state_file, '--current', roundB.json.state_file,
  ]);
  assert.notEqual(compared.status, 0);
  assert.equal(compared.json.error.code, 'STALE_STATE');
});

test('compare-rounds treats an empty adjacent pair as stalled=false (larger_set_size=0)', () => {
  const root = temporaryDirectory();
  const { round1, round2 } = recordTwoRounds(root, EMPTY_APPROVE_REVIEW, EMPTY_APPROVE_REVIEW);
  const compared = runCli([
    'compare-rounds', '--previous', round1.json.state_file, '--current', round2.json.state_file,
  ]);
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(compared.json.larger_set_size, 0);
  assert.equal(compared.json.repeat_ratio, 0);
  assert.equal(compared.json.stalled, false);
  assert.equal(compared.json.progressed, false);
});

test('compare-rounds output is deterministic across repeated invocations on the same inputs', () => {
  const root = temporaryDirectory();
  const { round1, round2 } = recordTwoRounds(root, ROUND1_REVIEW, ROUND2_REVIEW);
  const first = runCli(['compare-rounds', '--previous', round1.json.state_file, '--current', round2.json.state_file]);
  const second = runCli(['compare-rounds', '--previous', round1.json.state_file, '--current', round2.json.state_file]);
  assert.deepEqual(
    { ...first.json, ok: undefined },
    { ...second.json, ok: undefined },
  );
});

// Round-savings simulation (SKILL §5 condition 7 / §6 rounds_saved): a
// split-only CONCERN round with no accepted actionable item skips Respond
// (spec §3 of SKILL — Respond skip semantics). collect-metrics on that
// lone round, with no --response-report, must surface accepted=0,
// implemented=0, halted=false — the exact trio condition 7 tests before
// starting another Review round. rounds_saved = max_rounds - executed_rounds
// is then a deterministic arithmetic fact from those loop-state outputs.
test('round-savings simulation: split-only CONCERN + skipped Respond triggers condition 7 inputs, rounds_saved = max - executed = 3', () => {
  const root = temporaryDirectory();
  const reportsDir = join(root, '.deep-review', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const splitOnlyConcern = [
    '# Deep Review Report',
    '## Summary',
    '- **Verdict**: CONCERN',
    '- **Issues**: \u{1F534} 0건, \u{1F7E1} 2건, ℹ️ 0건',
    '### \u{1F7E1} Warning',
    '- split opinion issue at `src/x.js:5`',
    '- split opinion issue two at `src/y.js:9`',
  ].join('\n');
  const reviewPath = join(reportsDir, '2026-07-19-080000-review.md');
  writeFileSync(reviewPath, splitOnlyConcern);

  const metrics = runCli(['collect-metrics', '--round-number', '1', '--review-report', reviewPath]);
  assert.equal(metrics.status, 0, metrics.stderr);
  assert.equal(metrics.json.verdict, 'CONCERN');
  // No --response-report was passed: Respond was skipped for this
  // split-only CONCERN round (SKILL §3), so these default to the
  // condition-7 trigger trio.
  assert.equal(metrics.json.accepted_count, 0);
  assert.equal(metrics.json.implemented_count, 0);
  assert.equal(metrics.json.halted, false);

  const conditionSevenFires = metrics.json.accepted_count === 0
    && metrics.json.implemented_count === 0
    && metrics.json.halted === false;
  assert.equal(conditionSevenFires, true);

  // Condition 7 fires immediately after round 1 metrics: the loop stops
  // before starting round 2, so exactly one round executed.
  const maxRounds = 4;
  const executedRounds = 1;
  const roundsSaved = maxRounds - executedRounds;
  assert.equal(roundsSaved, 3);
});

// --- W-cx3-2: ownership/liveness-based residue cleanup ---------------------
// cleanupResidue replaces the former age-only staleness heuristic. It mirrors
// mutation-protocol.mjs `classifyLiveness`: a residue file is removed only when
// its owning loop is *provably not live* (owner probes departed AND the last
// round is older than the staleness grace window). Every other classification —
// live, permission-blocked, foreign host, timeline-inconsistent, or a legacy
// state with no owner stamp — is kept (fail toward NOT deleting).
const HOUR_MS = 3_600_000;

function makeOwner(hostHash, now, ageMs = 0) {
  const startedAtMs = now - ageMs;
  return {
    host_hash: hostHash,
    // pid value is irrelevant to these tests — liveness is decided by the
    // injected processProbe, not a real process.kill.
    pid: String(process.pid),
    process_start_ms: String(Math.max(0, startedAtMs - 1000)),
    started_at: new Date(startedAtMs).toISOString(),
  };
}

function writeStateFile(tmpDir, { loopId, round = 1, owner }) {
  const state = {
    schema_version: 1,
    source: 'report-parse',
    loop_id: loopId,
    round_number: round,
    base_commit: 'deadbeef',
    verdict: 'CONCERN',
    counts: { critical: 0, warning: 1, info: 0 },
    findings: [],
    rejected: [],
    skipped_rejects: 0,
    ...(owner ? { owner } : {}),
  };
  const filePath = join(tmpDir, `loop-${loopId}-round-${round}.state.json`);
  writeFileSync(filePath, `${JSON.stringify(state)}\n`);
  return filePath;
}

function writePriorFile(tmpDir, { loopId, round = 1 }) {
  const filePath = join(tmpDir, `loop-${loopId}-round-${round}.prior.md`);
  writeFileSync(filePath, `<!-- PRIOR-CONTEXT v1 loop_id=${loopId} base_commit=deadbeef round=${round} -->\n`);
  return filePath;
}

function makeTmpDir() {
  const root = temporaryDirectory();
  const tmpDir = join(root, '.deep-review', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

const CLEANUP_NOW = Date.UTC(2026, 6, 19, 12, 0, 0);

test('cleanupResidue never deletes a live-but-idle owner even when its state is hours old (liveness beats age)', async () => {
  const { cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const tmpDir = makeTmpDir();
  const owner = makeOwner(currentHostHash(), CLEANUP_NOW, 4 * HOUR_MS);
  const stateFile = writeStateFile(tmpDir, { loopId: 'live-idle-loop', owner });
  const priorFile = writePriorFile(tmpDir, { loopId: 'live-idle-loop' });
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'live' }),
  });
  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(stateFile), true);
  assert.equal(existsSync(priorFile), true);
  assert.equal(result.kept.some((entry) => entry.reason === 'live'), true);
});

test('cleanupResidue deletes a provably-dead owner\'s stale residue (state + prior together)', async () => {
  const { cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const tmpDir = makeTmpDir();
  const owner = makeOwner(currentHostHash(), CLEANUP_NOW, 2 * HOUR_MS);
  const stateFile = writeStateFile(tmpDir, { loopId: 'dead-loop', owner });
  const priorFile = writePriorFile(tmpDir, { loopId: 'dead-loop' });
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'dead' }),
  });
  assert.equal(existsSync(stateFile), false);
  assert.equal(existsSync(priorFile), false);
  assert.equal(result.deleted.length, 2);
});

test('cleanupResidue keeps a dead-but-FRESH owner: the age gate spares residue younger than staleMs', async () => {
  const { cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const tmpDir = makeTmpDir();
  const owner = makeOwner(currentHostHash(), CLEANUP_NOW, 60_000);
  const stateFile = writeStateFile(tmpDir, { loopId: 'dead-fresh-loop', owner });
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'dead' }),
  });
  assert.equal(existsSync(stateFile), true);
  assert.deepEqual(result.deleted, []);
});

test('cleanupResidue leaves ambiguous ownership untouched (EPERM=uncertain, foreign host, and legacy no-owner all kept)', async () => {
  const { cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const tmpDir = makeTmpDir();
  // uncertain (EPERM) — same host, old, but liveness cannot be established.
  const uncertainState = writeStateFile(tmpDir, {
    loopId: 'uncertain-loop',
    owner: makeOwner(currentHostHash(), CLEANUP_NOW, 5 * HOUR_MS),
  });
  // foreign host — short-circuits to 'foreign' before the probe runs.
  const foreignState = writeStateFile(tmpDir, {
    loopId: 'foreign-loop',
    owner: makeOwner('f'.repeat(64), CLEANUP_NOW, 5 * HOUR_MS),
  });
  // legacy residue with no owner stamp — ownership cannot be established.
  const legacyState = writeStateFile(tmpDir, { loopId: 'legacy-loop' });
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'eperm' }),
  });
  assert.deepEqual(result.deleted, []);
  assert.equal(existsSync(uncertainState), true);
  assert.equal(existsSync(foreignState), true);
  assert.equal(existsSync(legacyState), true);
});

test('cleanupResidue keeps an orphan prior.md whose loop has no state file (ownership unknowable)', async () => {
  const { cleanupResidue } = await loadLoopState();
  const tmpDir = makeTmpDir();
  const orphanPrior = writePriorFile(tmpDir, { loopId: 'orphan-loop' });
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'dead' }),
  });
  assert.equal(existsSync(orphanPrior), true);
  assert.deepEqual(result.deleted, []);
});

test('cleanupResidue keeps a whole loop when ANY of its rounds looks live (conservative grouping)', async () => {
  const { cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const tmpDir = makeTmpDir();
  // Round 1 owner reads dead+stale, round 2 owner reads live: the live round
  // must veto deletion of the entire loop's residue.
  const deadOwner = makeOwner(currentHostHash(), CLEANUP_NOW, 5 * HOUR_MS);
  const liveOwner = makeOwner(currentHostHash(), CLEANUP_NOW, 5 * HOUR_MS);
  const state1 = writeStateFile(tmpDir, { loopId: 'mixed-loop', round: 1, owner: deadOwner });
  const state2 = writeStateFile(tmpDir, { loopId: 'mixed-loop', round: 2, owner: liveOwner });
  let call = 0;
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    // First probe (round 1) dead, second probe (round 2) live.
    processProbe: () => (call++ === 0 ? { status: 'dead' } : { status: 'live' }),
  });
  assert.equal(existsSync(state1), true);
  assert.equal(existsSync(state2), true);
  assert.deepEqual(result.deleted, []);
});

test('cleanup-residue CLI is registered and returns a JSON summary (missing tmp dir → scanned 0)', () => {
  const root = temporaryDirectory();
  const tmpDir = join(root, '.deep-review', 'tmp'); // deliberately not created
  const result = runCli(['cleanup-residue', '--tmp-dir', tmpDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.scanned, 0);
  assert.deepEqual(result.json.deleted, []);
});

test('recordRound stamps a DURABLE session owner (pid=CLAUDE_PID + session_id), not the transient node parent', async () => {
  const { recordRound } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const sessionId = 'bcb554a2-0925-4f5e-8d18-10c89d9b8567';
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
    env: { CLAUDE_PID: '28048', CLAUDE_CODE_SESSION_ID: sessionId },
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.equal(typeof persisted.owner, 'object');
  assert.equal(persisted.owner.host_hash, currentHostHash());
  // The durable session pid (CLAUDE_PID), NOT this ephemeral node's ppid.
  assert.equal(persisted.owner.pid, '28048');
  assert.match(persisted.owner.process_start_ms, /^[0-9]+$/u);
  assert.equal(persisted.owner.session_id, sessionId);
  assert.equal(new Date(persisted.owner.started_at).toISOString(), persisted.owner.started_at);
});

test('recordRound falls keep-biased (owner=null) when NO durable session identity is resolvable, so cleanup never deletes it even when stale', async () => {
  const { recordRound, cleanupResidue } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
    env: {}, // neither CLAUDE_PID nor any session id → no durable anchor
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.equal(persisted.owner, null);
  // A null owner classifies as `manual` (keep). Age-only would have deleted a
  // provably-dead, hours-stale residue; the fallback is strictly less aggressive.
  const cleaned = cleanupResidue({
    tmpDir,
    now: Date.parse(persisted.owner?.started_at ?? new Date().toISOString()) + 5 * HOUR_MS,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'dead' }),
  });
  assert.deepEqual(cleaned.deleted, []);
  assert.equal(existsSync(result.state_file), true);
});

test('recordRound with a session-id-only anchor (Codex, no durable pid) stamps pid=null and cleanup keeps it unprobed', async () => {
  const { recordRound, cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const result = recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
    env: { CODEX_COMPANION_SESSION_ID: sessionId }, // session id, no durable pid
  });
  const persisted = JSON.parse(readFileSync(result.state_file, 'utf8'));
  assert.equal(persisted.owner.host_hash, currentHostHash());
  assert.equal(persisted.owner.pid, null);
  assert.equal(persisted.owner.session_id, sessionId);
  // Unprobeable liveness → keep, even with a stale age and a dead probe.
  const cleaned = cleanupResidue({
    tmpDir,
    now: Date.now() + 5 * HOUR_MS,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'dead' }),
  });
  assert.deepEqual(cleaned.deleted, []);
  assert.equal(existsSync(result.state_file), true);
  assert.equal(cleaned.kept.some((entry) => entry.reason === 'session-id-only'), true);
});

test('a durable-pid owner recorded by record-round is deleted only once that pid probes departed AND stale (live probe keeps it)', async () => {
  const { recordRound, cleanupResidue } = await loadLoopState();
  const root = temporaryDirectory();
  const { reviewPath, tmpDir } = writeFixtures(root);
  const record = () => recordRound({
    roundNumber: 1,
    reviewReport: reviewPath,
    baseCommit: 'deadbeef',
    stateDir: tmpDir,
    loopId: 'durable-loop',
    env: { CLAUDE_PID: '28048', CLAUDE_CODE_SESSION_ID: 'bcb554a2-0925-4f5e-8d18-10c89d9b8567' },
  });
  const first = record();
  const staleNow = Date.now() + 5 * HOUR_MS;
  // Durable pid still live (loop merely idle) → keep despite hours-old state.
  const keptLive = cleanupResidue({
    tmpDir, now: staleNow, staleMs: HOUR_MS, processProbe: () => ({ status: 'live' }),
  });
  assert.deepEqual(keptLive.deleted, []);
  assert.equal(existsSync(first.state_file), true);
  // Durable pid departed AND stale → reclaimed.
  const deleted = cleanupResidue({
    tmpDir, now: staleNow, staleMs: HOUR_MS, processProbe: () => ({ status: 'dead' }),
  });
  assert.equal(deleted.deleted.includes(first.state_file), true);
  assert.equal(existsSync(first.state_file), false);
});

test('collect-metrics findings_signature agrees with record-round on a MULTI-range citation (first-range start line), not the old single-token line', async () => {
  const { recordRound, collectMetrics } = await loadLoopState();
  const root = temporaryDirectory();
  const reportsDir = join(root, '.deep-review', 'reports');
  const tmpDir = join(root, '.deep-review', 'tmp');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const reviewPath = join(reportsDir, '2026-07-20-090000-review.md');
  writeFileSync(reviewPath, [
    '# Deep Review Report',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    '- **Issues**: \u{1F534} 0건, \u{1F7E1} 1건, ℹ️ 0건',
    '### \u{1F7E1} Warning',
    '- multi-range finding at `src/multi.js:1-2, 83-100`',
  ].join('\n'));
  // record-round anchors the finding at the FIRST range start line (1).
  const recorded = recordRound({
    roundNumber: 1, reviewReport: reviewPath, baseCommit: 'deadbeef', stateDir: tmpDir,
  });
  const persisted = JSON.parse(readFileSync(recorded.state_file, 'utf8'));
  const finding = persisted.findings.find((entry) => entry.path === 'src/multi.js');
  assert.equal(finding.line, 1);
  // collectMetrics must emit the SAME location: bucket floor(1/7)=0, path src/multi.js.
  const metrics = collectMetrics({ roundNumber: 1, reviewReport: reviewPath });
  assert.equal(metrics.findings_signature.includes('warning:src/multi.js:0:untagged'), true);
  // The old single-token matcher would have captured a bogus `...83-` path at line 100.
  assert.equal(metrics.findings_signature.some((sig) => /83-/u.test(sig)), false);
});

// --- P2-1: collect-metrics repo-root canonicalization parity with record-round -
// signatures() reuses the shared extractFindings() parser, which canonicalizes
// paths. Without a repo-root, collect-metrics left an absolute /repo/src/a.js as
// `repo/src/a.js` while record-round (given --repo-root) canonicalized it to
// `src/a.js` — diverging the backward-compat findings_signature and risking a
// distinct-citation collapse. collect-metrics now takes --repo-root and threads
// it into signatures() on the SAME basis as record-round (single source of truth).

function buildSingleCriticalReview(citation) {
  return [
    '# Deep Review Report',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    '- **Issues**: \u{1F534} 1건, \u{1F7E1} 0건, ℹ️ 0건',
    '### \u{1F534} Critical',
    `- unsafe edge at \`${citation}\``,
  ].join('\n');
}

test('collect-metrics --repo-root canonicalizes an absolute and a ./-prefixed citation to the SAME signature as a plain relative one, matching record-round (SSOT)', async () => {
  const { recordRound, collectMetrics } = await loadLoopState();
  const root = temporaryDirectory();
  const reportsDir = join(root, '.deep-review', 'reports');
  const tmpDir = join(root, '.deep-review', 'tmp');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const repoRoot = '/tmp/some/repo';

  const absReview = join(reportsDir, 'abs-review.md');
  const dotReview = join(reportsDir, 'dot-review.md');
  const relReview = join(reportsDir, 'rel-review.md');
  writeFileSync(absReview, buildSingleCriticalReview(`${repoRoot}/src/a.js:14`));
  writeFileSync(dotReview, buildSingleCriticalReview('./src/a.js:14'));
  writeFileSync(relReview, buildSingleCriticalReview('src/a.js:14'));

  // floor(14/7) = 2; no recurring-findings file → untagged.
  const expectedSig = ['critical:src/a.js:2:untagged'];
  const absMetrics = collectMetrics({ roundNumber: 1, reviewReport: absReview, repoRoot });
  const dotMetrics = collectMetrics({ roundNumber: 1, reviewReport: dotReview, repoRoot });
  const relMetrics = collectMetrics({ roundNumber: 1, reviewReport: relReview, repoRoot });
  assert.deepEqual(absMetrics.findings_signature, expectedSig);
  assert.deepEqual(dotMetrics.findings_signature, expectedSig);
  assert.deepEqual(relMetrics.findings_signature, expectedSig);

  // record-round on the same repo-root canonicalizes to the identical path, so
  // the signature path component is parity with record-round's finding path.
  const recorded = recordRound({
    roundNumber: 1, reviewReport: absReview, baseCommit: 'deadbeef', stateDir: tmpDir, repoRoot,
  });
  const persisted = JSON.parse(readFileSync(recorded.state_file, 'utf8'));
  assert.equal(persisted.findings[0].path, 'src/a.js');
  assert.equal(absMetrics.findings_signature[0], `critical:${persisted.findings[0].path}:2:untagged`);
});

test('collect-metrics without --repo-root leaves plain relative-path signatures unchanged (backward compatible)', async () => {
  const { collectMetrics } = await loadLoopState();
  const root = temporaryDirectory();
  const reportsDir = join(root, '.deep-review', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reviewPath = join(reportsDir, 'rel-only-review.md');
  writeFileSync(reviewPath, buildSingleCriticalReview('src/a.js:14'));
  const metrics = collectMetrics({ roundNumber: 1, reviewReport: reviewPath });
  assert.deepEqual(metrics.findings_signature, ['critical:src/a.js:2:untagged']);
});

test('collect-metrics CLI accepts --repo-root and threads it into the signature basis', () => {
  const root = temporaryDirectory();
  const reportsDir = join(root, '.deep-review', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const repoRoot = '/tmp/cli/repo';
  const reviewPath = join(reportsDir, 'cli-review.md');
  writeFileSync(reviewPath, buildSingleCriticalReview(`${repoRoot}/src/a.js:14`));
  const metrics = runCli([
    'collect-metrics', '--round-number', '1', '--review-report', reviewPath, '--repo-root', repoRoot,
  ]);
  assert.equal(metrics.status, 0, metrics.stderr);
  assert.deepEqual(metrics.json.findings_signature, ['critical:src/a.js:2:untagged']);
});

// --- P2-2: retryable residue cleanup (advisory-first deletion ordering) ---------
// Within a deletion group, the advisory .prior.md file(s) are removed FIRST and
// the state file(s) only after every advisory removal succeeds. A mid-group
// advisory removal failure (EPERM/EBUSY, e.g. Windows) must therefore leave the
// state file intact so the loop stays retryable — never orphan a .prior.md whose
// state owner was already reaped (which the no-owner branch keeps forever).

test('cleanupResidue preserves the state file (retryable) and records errors[] when an advisory .prior.md removal fails', async () => {
  const { cleanupResidue } = await loadLoopState();
  const { currentHostHash } = await loadMutation();
  const tmpDir = makeTmpDir();
  const owner = makeOwner(currentHostHash(), CLEANUP_NOW, 2 * HOUR_MS);
  const stateFile = writeStateFile(tmpDir, { loopId: 'partial-fail-loop', owner });
  const priorFile = writePriorFile(tmpDir, { loopId: 'partial-fail-loop' });
  const result = cleanupResidue({
    tmpDir,
    now: CLEANUP_NOW,
    staleMs: HOUR_MS,
    processProbe: () => ({ status: 'dead' }),
    // Advisory removal fails; state removal (if ever reached) would succeed.
    removeFile: (file) => {
      if (file === priorFile) {
        const error = new Error('EPERM: operation not permitted');
        error.code = 'EPERM';
        throw error;
      }
      rmSync(file, { force: true });
    },
  });
  // The state file is preserved so the next round re-evaluates ownership and retries.
  assert.equal(existsSync(stateFile), true);
  assert.equal(result.deleted.includes(stateFile), false);
  // The advisory removal failure is recorded, not swallowed.
  assert.equal(result.errors.some((entry) => entry.path === priorFile && entry.code === 'EPERM'), true);
  // The preserved state file is surfaced (retry-pending), keeping scanned accounting complete.
  assert.equal(result.kept.some((entry) => entry.path === stateFile), true);
  assert.equal(result.scanned, result.deleted.length + result.kept.length + result.errors.length);
});

test('cleanup-residue missing tmp dir early-return includes a uniform errors:[] key', () => {
  const root = temporaryDirectory();
  const tmpDir = join(root, '.deep-review', 'tmp'); // deliberately not created
  const result = runCli(['cleanup-residue', '--tmp-dir', tmpDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.errors, []);
});
