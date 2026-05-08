'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ULID_RE } = require('../scripts/validate-envelope-emit.js');
const {
  parseSourceArtifactSpec,
  tryReadEnvelopeRunId,
} = require('../hooks/scripts/wrap-recurring-findings-envelope.js');
const {
  wrapEnvelope,
  generateUlid,
  isEnvelope,
} = require('../hooks/scripts/envelope.js');

const WRAP_CLI = path.resolve(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'wrap-recurring-findings-envelope.js',
);
const VALIDATE_CLI = path.resolve(
  __dirname,
  '..',
  'scripts',
  'validate-envelope-emit.js',
);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dr-chain-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function runWrap(args) {
  return execFileSync('node', [WRAP_CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runValidate(file) {
  return execFileSync('node', [VALIDATE_CLI, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildSessionReceiptEnvelope(runId) {
  return {
    $schema: 'https://example/envelope.schema.json',
    schema_version: '1.0',
    envelope: {
      producer: 'deep-work',
      producer_version: '6.4.2',
      artifact_kind: 'session-receipt',
      run_id: runId,
      generated_at: new Date().toISOString(),
      schema: { name: 'session-receipt', version: '1.0' },
      git: { head: 'aaa1111', branch: 'main', dirty: false },
      provenance: { source_artifacts: [], tool_versions: { node: process.version } },
    },
    payload: {
      session_id: '2026-05-08T11-30-00',
      health_report: {
        scan_commit: 'aaa1111',
        ok: true,
      },
    },
  };
}

describe('envelope-chain — recurring-findings wrapped via wrap-recurring-findings-envelope.js', () => {
  it('emits a valid envelope and survives the validator', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, {
      updated_at: '2026-05-08T11:30:00Z',
      taxonomy_version: '1.0',
      findings: [
        {
          category: 'error-handling',
          severity: 'critical',
          occurrences: 4,
          example_files: ['src/api.ts:42'],
          description: 'try/catch missing',
          source_reports: ['2026-05-08-110000-review.md'],
        },
      ],
    });

    runWrap([
      '--payload-file', payload,
      '--output', out,
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.producer, 'deep-review');
    assert.equal(obj.envelope.artifact_kind, 'recurring-findings');
    assert.equal(obj.envelope.schema.name, 'recurring-findings');
    assert.match(obj.envelope.run_id, ULID_RE);
    assert.equal(obj.payload.taxonomy_version, '1.0');
    assert.equal(obj.payload.findings.length, 1);
    assert.ok(!('parent_run_id' in obj.envelope), 'parent_run_id absent when no source given');
  });

  it('accepts explicit --artifact-kind recurring-findings (default match)', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });

    runWrap([
      '--artifact-kind', 'recurring-findings',
      '--payload-file', payload,
      '--output', out,
    ]);

    runValidate(out);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.artifact_kind, 'recurring-findings');
  });

  it('rejects unknown --artifact-kind values', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'wrap.json');
    writeJson(payload, { findings: [] });
    let threw = false;
    try {
      execFileSync('node', [
        WRAP_CLI,
        '--artifact-kind', 'review-report',
        '--payload-file', payload,
        '--output', out,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', /--artifact-kind must be one of recurring-findings/);
    }
    assert.ok(threw, 'CLI must reject unknown artifact-kind');
    assert.ok(!fs.existsSync(out), 'no output file must be written on rejection');
  });
});

describe('envelope-chain — recurring-findings parent_run_id matches consumed session-receipt', () => {
  it('cross-plugin chain: recurring-findings.envelope.parent_run_id === session-receipt.envelope.run_id', () => {
    const dir = tmpDir();

    // Stand up a deep-work session-receipt envelope as deep-work would emit it.
    const sessRunId = generateUlid();
    const sessEnvelope = buildSessionReceiptEnvelope(sessRunId);
    const sessPath = path.join(dir, 'session-receipt.json');
    writeJson(sessPath, sessEnvelope);
    assert.equal(isEnvelope(sessEnvelope), true);
    // tryReadEnvelopeRunId requires identity gate.
    assert.equal(
      tryReadEnvelopeRunId(sessPath, { producer: 'deep-work', artifactKind: 'session-receipt' }),
      sessRunId,
    );
    // Self-consistency mode also extracts (envelope is internally consistent).
    assert.equal(
      tryReadEnvelopeRunId(sessPath, { selfConsistent: true }),
      sessRunId,
    );
    // No identity gate — refuses extraction by design (defense against future regression).
    assert.equal(tryReadEnvelopeRunId(sessPath), null);
    // Wrong producer — rejected.
    assert.equal(
      tryReadEnvelopeRunId(sessPath, { producer: 'deep-review', artifactKind: 'recurring-findings' }),
      null,
    );

    // recurring-findings: parent_run_id auto-detected from consumed session-receipt.
    const payload = path.join(dir, 'recurring-payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, {
      updated_at: '2026-05-08T11:30:00Z',
      taxonomy_version: '1.0',
      findings: [
        { category: 'test-coverage', severity: 'warning', occurrences: 3 },
      ],
    });
    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-session-receipt', sessPath,
    ]);

    runValidate(out);

    const recurring = JSON.parse(fs.readFileSync(out, 'utf8'));

    // CONTRACT TEST (handoff §3.3): recurring-findings.parent_run_id ===
    // consumed session-receipt.envelope.run_id.
    assert.equal(
      recurring.envelope.parent_run_id,
      sessRunId,
      'recurring-findings.parent_run_id must equal consumed session-receipt.envelope.run_id',
    );

    // session-receipt path must also be in source_artifacts with its run_id.
    const sa = recurring.envelope.provenance.source_artifacts;
    const sessSa = sa.find((s) => s.path === sessPath);
    assert.ok(sessSa, 'session-receipt path missing from source_artifacts');
    assert.equal(sessSa.run_id, sessRunId, 'session-receipt source_artifact run_id mismatch');
  });

  it('honors explicit --parent-run-id over auto-detected session-receipt run_id', () => {
    const dir = tmpDir();
    const sessRunId = generateUlid();
    const sessEnvelope = buildSessionReceiptEnvelope(sessRunId);
    const sessPath = path.join(dir, 'session-receipt.json');
    writeJson(sessPath, sessEnvelope);

    const explicit = generateUlid();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });
    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-session-receipt', sessPath,
      '--parent-run-id', explicit,
    ]);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(obj.envelope.parent_run_id, explicit);
    // session-receipt still in source_artifacts with its actual run_id.
    const sa = obj.envelope.provenance.source_artifacts;
    const sessSa = sa.find((s) => s.path === sessPath);
    assert.equal(sessSa.run_id, sessRunId);
  });

  it('legacy (non-envelope) session-receipt.json contributes path only, no run_id, no parent_run_id', () => {
    const dir = tmpDir();
    const sessPath = path.join(dir, 'session-receipt.json');
    // Legacy shape — no envelope wrapper.
    writeJson(sessPath, {
      session_id: '2026-05-08T11-30-00',
      health_report: { scan_commit: 'aaa1111', ok: true },
    });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });
    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-session-receipt', sessPath,
    ]);
    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(!('parent_run_id' in obj.envelope), 'parent_run_id must be absent for legacy session-receipt');
    const sa = obj.envelope.provenance.source_artifacts;
    const sessSa = sa.find((s) => s.path === sessPath);
    assert.ok(sessSa, 'legacy session-receipt path must still be in source_artifacts');
    assert.ok(!('run_id' in sessSa), 'legacy session-receipt must not contribute a run_id');
  });
});

describe('envelope-chain — multi-source aggregator (review reports as --source-artifact)', () => {
  it('records --source-artifact entries (markdown reports) in source_artifacts', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });

    const r1 = '.deep-review/reports/2026-05-08-110000-review.md';
    const r2 = '.deep-review/reports/2026-05-07-200000-review.md';
    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', r1,
      '--source-artifact', r2,
    ]);

    runValidate(out);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    assert.equal(sa.length, 2);
    assert.deepEqual(
      sa.map((s) => s.path).sort(),
      [r1, r2].sort(),
    );
    // Markdown paths can't be envelope-detected — no run_id.
    sa.forEach((s) => assert.ok(!('run_id' in s), `unexpected run_id on markdown source: ${s.path}`));
  });
});

describe('envelope-chain — parseSourceArtifactSpec', () => {
  it('parses path-only spec', () => {
    assert.deepEqual(
      parseSourceArtifactSpec('.deep-review/reports/foo-review.md'),
      { path: '.deep-review/reports/foo-review.md' },
    );
  });

  it('parses path:run_id spec when run_id is a valid ULID', () => {
    const ulid = '01JTKGZQ7NABCDEFGHJKMNPQRS';
    assert.deepEqual(
      parseSourceArtifactSpec(`some/path.json:${ulid}`),
      { path: 'some/path.json', run_id: ulid },
    );
  });

  it('treats trailing colon segment that is not a ULID as part of the path', () => {
    // Defense against URL-like or drive-letter-style paths.
    assert.deepEqual(
      parseSourceArtifactSpec('https://example.com/x.json:not-a-ulid'),
      { path: 'https://example.com/x.json:not-a-ulid' },
    );
  });

  it('returns null on empty', () => {
    assert.equal(parseSourceArtifactSpec(''), null);
    assert.equal(parseSourceArtifactSpec(null), null);
  });
});

describe('envelope-chain — tryReadEnvelopeRunId rejects corrupt envelope (W4 + C2 identity gate)', () => {
  const SELF = { selfConsistent: true };
  const STRICT_WORK = { producer: 'deep-work', artifactKind: 'session-receipt' };

  it('returns null for envelope with payload: null', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'corrupt.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        artifact_kind: 'session-receipt',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'session-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: null,
    });
    assert.strictEqual(tryReadEnvelopeRunId(corrupt, STRICT_WORK), null);
    assert.strictEqual(tryReadEnvelopeRunId(corrupt, SELF), null);
  });

  it('returns null for envelope with payload: array', () => {
    const dir = tmpDir();
    const corrupt = path.join(dir, 'corrupt.json');
    writeJson(corrupt, {
      schema_version: '1.0',
      envelope: { run_id: '01JTKEV0NHABCDEFGHJKMNPQRS' },
      payload: [1, 2, 3],
    });
    assert.strictEqual(tryReadEnvelopeRunId(corrupt, SELF), null);
  });

  it('returns the run_id for valid envelope under self-consistency mode', () => {
    const dir = tmpDir();
    const valid = path.join(dir, 'valid.json');
    writeJson(valid, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        artifact_kind: 'session-receipt',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'session-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { session_id: 's1' },
    });
    assert.strictEqual(
      tryReadEnvelopeRunId(valid, SELF),
      '01JTKEV0NHABCDEFGHJKMNPQRS',
    );
    assert.strictEqual(
      tryReadEnvelopeRunId(valid, STRICT_WORK),
      '01JTKEV0NHABCDEFGHJKMNPQRS',
    );
  });

  it('rejects foreign-producer envelope at session-receipt path under STRICT mode (C2)', () => {
    const dir = tmpDir();
    const foreign = path.join(dir, 'session-receipt.json');
    // A deep-evolve evolve-receipt envelope mistakenly placed at session-receipt path.
    writeJson(foreign, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-evolve',
        artifact_kind: 'evolve-receipt',
        run_id: '01JTKZZZZZZZZZZZZZZZZZZZZZ',
        schema: { name: 'evolve-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { canonical: false },
    });
    // Strict mode rejects (foreign producer).
    assert.strictEqual(tryReadEnvelopeRunId(foreign, STRICT_WORK), null);
    // Self-consistency mode passes (envelope itself is internally consistent).
    assert.strictEqual(
      tryReadEnvelopeRunId(foreign, SELF),
      '01JTKZZZZZZZZZZZZZZZZZZZZZ',
    );
  });

  it('rejects schema.name vs artifact_kind drift under self-consistency mode', () => {
    const dir = tmpDir();
    const drift = path.join(dir, 'drift.json');
    writeJson(drift, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        artifact_kind: 'session-receipt',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'something-else', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { ok: true },
    });
    assert.strictEqual(tryReadEnvelopeRunId(drift, SELF), null);
    assert.strictEqual(tryReadEnvelopeRunId(drift, STRICT_WORK), null);
  });

  it('rejects non-ULID run_id under both modes', () => {
    const dir = tmpDir();
    const badUlid = path.join(dir, 'bad-ulid.json');
    writeJson(badUlid, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        artifact_kind: 'session-receipt',
        run_id: 'not-a-ulid',
        schema: { name: 'session-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { ok: true },
    });
    assert.strictEqual(tryReadEnvelopeRunId(badUlid, STRICT_WORK), null);
    assert.strictEqual(tryReadEnvelopeRunId(badUlid, SELF), null);
  });

  it('refuses extraction when no identity gate is provided (regression guard)', () => {
    const dir = tmpDir();
    const valid = path.join(dir, 'valid.json');
    writeJson(valid, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        artifact_kind: 'session-receipt',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'session-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { ok: true },
    });
    // No options at all → null. Forces caller intent.
    assert.strictEqual(tryReadEnvelopeRunId(valid), null);
    // Empty options → null.
    assert.strictEqual(tryReadEnvelopeRunId(valid, {}), null);
  });

  it('returns null for non-existent file', () => {
    assert.strictEqual(tryReadEnvelopeRunId('/non-existent/foo.json', { selfConsistent: true }), null);
  });

  it('returns null for invalid JSON file', () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not valid json');
    assert.strictEqual(tryReadEnvelopeRunId(bad, { selfConsistent: true }), null);
  });
});

describe('envelope-chain — Foreign envelope at session-receipt path (Round-1 C2 mirror)', () => {
  it('rejects foreign-producer envelope: parent_run_id NOT chained, source_artifact path-only', () => {
    const dir = tmpDir();
    const sessPath = path.join(dir, 'session-receipt.json');
    // Foreign envelope (deep-evolve evolve-receipt) mistakenly at session-receipt path.
    writeJson(sessPath, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-evolve',
        artifact_kind: 'evolve-receipt',
        run_id: '01JTK00000000000000000000Z',
        schema: { name: 'evolve-receipt', version: '1.0' },
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { canonical: false },
    });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });
    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-session-receipt', sessPath,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(
      !('parent_run_id' in obj.envelope),
      'parent_run_id MUST NOT be set when session-receipt is foreign-producer envelope',
    );
    const sa = obj.envelope.provenance.source_artifacts;
    const sessSa = sa.find((s) => s.path === sessPath);
    assert.ok(sessSa, 'session-receipt path must still appear in source_artifacts');
    assert.ok(
      !('run_id' in sessSa),
      'run_id MUST NOT be recorded for foreign-producer envelope (would corrupt trace)',
    );
  });
});

describe('envelope-chain — CLI ULID validation for --parent-run-id', () => {
  it('CLI rejects malformed --parent-run-id at boundary', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });
    let threw = false;
    try {
      execFileSync(
        'node',
        [
          WRAP_CLI,
          '--payload-file', payload,
          '--output', out,
          '--parent-run-id', 'not-a-ulid',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2, 'expected exit code 2 (usage error)');
      assert.match(
        err.stderr || '',
        /--parent-run-id must be 26-char Crockford Base32 ULID/,
        'stderr must explain rejection',
      );
    }
    assert.ok(threw, 'CLI must reject non-ULID --parent-run-id');
    assert.ok(!fs.existsSync(out), 'no output file must be written on rejection');
  });

  it('wrapEnvelope rejects non-ULID parentRunId at library boundary', () => {
    assert.throws(
      () => wrapEnvelope({
        artifactKind: 'recurring-findings',
        payload: { findings: [] },
        parentRunId: 'not-a-ulid',
        git: { head: 'abc1234', branch: 'main', dirty: false },
      }),
      /parentRunId must be 26-char Crockford Base32 ULID/,
    );
  });
});

describe('envelope-chain — CLI boundary validation (W3 mirror)', () => {
  function expectRejection(args, regex) {
    let threw = false;
    try {
      execFileSync('node', [WRAP_CLI, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.status, 2);
      assert.match(err.stderr || '', regex);
    }
    assert.ok(threw, 'expected CLI rejection');
  }

  it('rejects empty --session-id', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--session-id=',
      ],
      /--session-id value must be non-empty/,
    );
  });

  it('rejects empty --source-session-receipt', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--source-session-receipt=',
      ],
      /--source-session-receipt value must be non-empty/,
    );
  });

  it('rejects empty --output', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output=',
      ],
      /--output value must be non-empty/,
    );
  });

  it('rejects empty --payload-file', () => {
    expectRejection(
      [
        '--payload-file=',
        '--output', '/tmp/y.json',
      ],
      /--payload-file value must be non-empty/,
    );
  });

  it('rejects missing required --payload-file', () => {
    expectRejection(
      ['--output', '/tmp/y.json'],
      /missing required flag --payload-file/,
    );
  });

  it('rejects missing required --output', () => {
    expectRejection(
      ['--payload-file', '/tmp/x.json'],
      /missing required flag --output/,
    );
  });

  it('rejects empty --source-artifact (Codex Round-1 Q6 — repeatable flag boundary)', () => {
    // Previously, --source-artifact= was accepted then silently dropped by
    // parseSourceArtifactSpec returning null. Boundary rejection now mirrors
    // the W3 lesson on scalar flags.
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--source-artifact=',
      ],
      /--source-artifact value must be non-empty/,
    );
  });

  it('rejects empty --source-artifact even alongside valid entries', () => {
    expectRejection(
      [
        '--payload-file', '/tmp/x.json',
        '--output', '/tmp/y.json',
        '--source-artifact', 'valid/path.md',
        '--source-artifact=',
      ],
      /--source-artifact value must be non-empty/,
    );
  });
});

describe('envelope-chain — --source-artifact auto-harvest with self-consistency', () => {
  it('auto-harvests envelope run_id from path-only --source-artifact (envelope file)', () => {
    const dir = tmpDir();
    // Simulate a deep-work session-receipt envelope at the path.
    const sessRunId = generateUlid();
    const sessPath = path.join(dir, 'session-receipt.json');
    writeJson(sessPath, {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-work',
        producer_version: '6.4.2',
        artifact_kind: 'session-receipt',
        run_id: sessRunId,
        generated_at: new Date().toISOString(),
        schema: { name: 'session-receipt', version: '1.0' },
        git: { head: 'aaa1111', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: { node: process.version } },
      },
      payload: { session_id: 's1' },
    });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', sessPath,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    // --source-artifact (generic) doesn't auto-set parent_run_id (only
    // --source-session-receipt does); but run_id is auto-harvested via
    // self-consistency.
    assert.ok(
      !('parent_run_id' in obj.envelope),
      'generic --source-artifact must not set parent_run_id (use --source-session-receipt for chain)',
    );
    const sa = obj.envelope.provenance.source_artifacts;
    const sessSa = sa.find((s) => s.path === sessPath);
    assert.ok(sessSa, 'envelope path must be in source_artifacts');
    assert.equal(sessSa.run_id, sessRunId, 'run_id must be auto-harvested via self-consistency check');
  });

  it('records path-only when --source-artifact path is markdown (legacy file)', () => {
    const dir = tmpDir();
    const reportPath = path.join(dir, 'review-report.md');
    fs.writeFileSync(reportPath, '# Review Report\n\nSome findings.\n');

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', reportPath,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    const repSa = sa.find((s) => s.path === reportPath);
    assert.ok(repSa, 'markdown path must be recorded');
    assert.ok(!('run_id' in repSa), 'no run_id for non-envelope source');
  });

  it('records path-only when --source-artifact path is foreign envelope without self-consistency', () => {
    const dir = tmpDir();
    const inconsistent = path.join(dir, 'inconsistent.json');
    // schema.name does NOT match artifact_kind (drift).
    writeJson(inconsistent, {
      schema_version: '1.0',
      envelope: {
        producer: 'some-plugin',
        artifact_kind: 'kind-a',
        run_id: '01JTKEV0NHABCDEFGHJKMNPQRS',
        schema: { name: 'kind-b', version: '1.0' },  // drift!
        git: { head: 'abc1234', branch: 'main', dirty: false },
        provenance: { source_artifacts: [], tool_versions: {} },
      },
      payload: { x: 1 },
    });

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', inconsistent,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    const incSa = sa.find((s) => s.path === inconsistent);
    assert.ok(incSa);
    assert.ok(!('run_id' in incSa), 'self-consistency check must reject drift');
  });

  it('respects explicit --source-artifact path:run_id over auto-harvest', () => {
    const dir = tmpDir();
    const explicitUlid = '01JTKR9CD3EFGHJKMNPQRSTVWX';
    const someFile = path.join(dir, 'some-file.json');
    fs.writeFileSync(someFile, '{}');

    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });

    runWrap([
      '--payload-file', payload,
      '--output', out,
      '--source-artifact', `${someFile}:${explicitUlid}`,
    ]);

    const obj = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sa = obj.envelope.provenance.source_artifacts;
    const found = sa.find((s) => s.path === someFile);
    assert.equal(found.run_id, explicitUlid);
  });
});

describe('envelope-chain — atomic write (C1 mirror)', () => {
  it('does not leave a .tmp file after successful write', () => {
    const dir = tmpDir();
    const payload = path.join(dir, 'payload.json');
    const out = path.join(dir, 'recurring-findings.json');
    writeJson(payload, { taxonomy_version: '1.0', findings: [] });
    runWrap([
      '--payload-file', payload,
      '--output', out,
    ]);
    assert.ok(fs.existsSync(out), 'final output must exist');
    const tmpResidue = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(tmpResidue, [], `tmp residue left behind: ${JSON.stringify(tmpResidue)}`);
  });
});

describe('envelope-chain — wrapEnvelope intra-plugin chain via lib', () => {
  it('builds recurring-findings envelope with multiple source_artifacts (review reports + session-receipt)', () => {
    const sessPath = '.deep-work/2026-05-08T11-30-00/session-receipt.json';
    const sessRunId = generateUlid();
    const r1 = '.deep-review/reports/2026-05-08-110000-review.md';
    const r2 = '.deep-review/reports/2026-05-07-200000-review.md';

    const env = wrapEnvelope({
      artifactKind: 'recurring-findings',
      payload: {
        updated_at: '2026-05-08T11:30:00Z',
        taxonomy_version: '1.0',
        findings: [],
      },
      parentRunId: sessRunId,
      sourceArtifacts: [
        { path: sessPath, run_id: sessRunId },
        { path: r1 },
        { path: r2 },
      ],
      git: { head: 'abc1234', branch: 'main', dirty: false },
    });
    assert.equal(env.envelope.parent_run_id, sessRunId);
    const ids = env.envelope.provenance.source_artifacts.map((sa) => ({ path: sa.path, run_id: sa.run_id }));
    assert.deepEqual(ids, [
      { path: sessPath, run_id: sessRunId },
      { path: r1, run_id: undefined },
      { path: r2, run_id: undefined },
    ]);
  });
});
