'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const wrapper = path.join(root, 'hooks', 'scripts', 'wrap-recurring-findings-envelope.js');

function receiptEnvelope(runId) {
  return {
    $schema: 'https://example.invalid/envelope.json',
    schema_version: '1.0',
    envelope: {
      producer: 'deep-work',
      producer_version: '6.9.4',
      artifact_kind: 'session-receipt',
      run_id: runId,
      generated_at: '2026-07-13T00:00:00Z',
      schema: { name: 'session-receipt', version: '1.0' },
      git: { head: 'abc1234', branch: 'main', dirty: false },
      provenance: { source_artifacts: [], tool_versions: { node: process.version } },
    },
    payload: { session_id: 'session', health_report: { ok: true } },
  };
}

test('Stage 5.5 discovers the canonical receipt and newest 20 reports without a shell', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-stage55-'));
  const project = path.join(parent, 'deep review 반복 Ω');
  const reportsDir = path.join(project, '.deep-review', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const payload = path.join(project, '.deep-review', 'payload.json');
  const output = path.join(project, '.deep-review', 'recurring-findings.json');
  fs.writeFileSync(payload, JSON.stringify({
    updated_at: '2026-07-13T00:00:00Z',
    taxonomy_version: '1.0',
    findings: [],
  }));

  for (let index = 0; index < 25; index += 1) {
    const name = `2026-07-13-${String(index).padStart(6, '0')}-review.md`;
    fs.writeFileSync(path.join(reportsDir, name), `# report ${index}\n`);
  }
  fs.writeFileSync(path.join(reportsDir, 'zzzz-not-report.md'), '# unrelated\n');

  const older = path.join(project, '.deep-work', '2026-07-13T00-00-00', 'session-receipt.json');
  const newest = path.join(project, '.deep-work', '2026-07-13T01-00-00', 'session-receipt.json');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.mkdirSync(path.dirname(newest), { recursive: true });
  fs.writeFileSync(older, JSON.stringify(receiptEnvelope('01J00000000000000000000000')));
  fs.writeFileSync(newest, JSON.stringify(receiptEnvelope('01J00000000000000000000001')));

  const result = spawnSync(process.execPath, [
    wrapper,
    '--payload-file', payload,
    '--output', output,
    '--discover-sources-from', project,
    '--source-artifact', `${path.join(reportsDir, '2026-07-13-000024-review.md')}:01J00000000000000000000002`,
  ], {
    cwd: project,
    env: { ...process.env, SHELL: '/bin/zsh' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /shopt|command not found/i);

  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.envelope.parent_run_id, '01J00000000000000000000001');
  const sources = artifact.envelope.provenance.source_artifacts;
  assert.equal(sources.length, 21);
  assert.equal(sources[0].path, newest);
  assert.equal(sources[0].run_id, '01J00000000000000000000001');
  const expectedReports = Array.from({ length: 20 }, (_, offset) => (
    path.join(reportsDir, `2026-07-13-${String(24 - offset).padStart(6, '0')}-review.md`)
  ));
  assert.deepEqual(sources.slice(1).map((entry) => entry.path), expectedReports);
  assert.equal(sources[1].run_id, '01J00000000000000000000002', 'explicit source run_id overrides discovery');
});

test('discoverSources excludes the opt-in session doc from recurring-findings provenance', () => {
  const { discoverSources } = require(wrapper);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-stage55-sd-'));
  const project = path.join(parent, 'proj');
  const reportsDir = path.join(project, '.deep-review', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const canonical = path.join(reportsDir, '2026-07-19-100000-review.md');
  const sessionDoc = path.join(reportsDir, 'loop-sess-Q-review.md');
  fs.writeFileSync(canonical, '# canonical\n');
  fs.writeFileSync(sessionDoc, '# derived session aggregate\n');

  const discovered = discoverSources(project);
  assert.deepEqual(discovered.reports, [canonical]);
  assert.equal(discovered.reports.includes(sessionDoc), false);
});

test('Stage 5.5 executable reference is shell-free and delegates discovery to the wrapper', () => {
  const source = fs.readFileSync(
    path.join(root, 'skills', 'deep-review-workflow', 'references', 'recurring-findings-export.md'),
    'utf8',
  );
  assert.doesNotMatch(source, /```(?:sh|shell|bash)/i);
  // Anchored at {plugin_root}. The bare-basename spelling this used to pin was the
  // arbitrary-code-execution shape the reference guard exists to catch: `node <name>`
  // resolves against cwd, cwd is the analysed workspace, and a planted file there runs
  // with the caller's permissions. The flags are unchanged — only the path moved.
  assert.match(
    source,
    /node \{plugin_root\}\/hooks\/scripts\/wrap-recurring-findings-envelope\.js --payload-file FILE --output FILE --discover-sources-from PROJECT_ROOT/,
  );
  assert.doesNotMatch(source, /(?<![\/])\bnode wrap-recurring-findings-envelope\.js/,
    'the unanchored spelling must not come back');
  assert.match(source, /payload.{0,100}preserv/is);
  assert.match(source, /nonzero|non-zero/i);
});
