'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const readinessUrl = pathToFileURL(path.join(root, 'hooks/scripts/document-readiness.mjs')).href;
const payloadUrl = pathToFileURL(path.join(root, 'hooks/scripts/build-reviewer-payload.mjs')).href;

function repoFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-readiness-'));
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.deep-review', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', '계획 Ω.md'), '# Plan\n\nImplement the safe migration.\n');
  return repo;
}

function report({
  verdict = 'CONCERN',
  critical = 0,
  warning = 1,
  info = 0,
  findings = [{
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: ['migration dry-run passes and rollback restores the prior schema'],
  }],
} = {}) {
  return [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    `- **Verdict**: ${verdict}`,
    `- **Issues**: 🔴 ${critical}건, 🟡 ${warning}건, ℹ️ ${info}건`,
    '',
    '## Artifact Gate',
    '```json',
    JSON.stringify({ schema_version: 1, findings }, null, 2),
    '```',
    '',
  ].join('\n');
}

function writeReport(repo, name, contents) {
  const file = path.join(repo, '.deep-review', 'reports', name);
  fs.writeFileSync(file, contents);
  return file;
}

test('Artifact Gate is singular, structured, and Critical is always pre-implementation', async () => {
  const { parseArtifactGate } = await import(readinessUrl);
  const parsed = parseArtifactGate(report());
  assert.equal(parsed.findings[0].stage, 'implementation_verification');
  assert.throws(() => parseArtifactGate(`${report()}\n${report()}`), /exactly one Artifact Gate/);
  assert.throws(() => parseArtifactGate(report({
    verdict: 'REQUEST_CHANGES',
    critical: 1,
    warning: 0,
    findings: [{
      id: 'DOC-C1',
      severity: 'critical',
      stage: 'implementation_verification',
      acceptance_evidence: ['evidence'],
    }],
  })), /Critical.*pre_implementation/);
  assert.throws(() => parseArtifactGate(report({
    findings: [{
      id: 'DOC-X',
      severity: 'warning',
      stage: 'invented',
      acceptance_evidence: ['evidence'],
    }],
  })), /stage/);
});

test('low-risk warning-only plan becomes READY and emits a sealed content-addressed receipt', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'plan-review.md', report());
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{
      path: reviewPath,
      reviewer_id: 'claude-opus',
      provider_family: 'claude',
    }],
    risk: 'low',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
    generatedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(created.status, 'READY_FOR_IMPLEMENTATION');
  assert.match(
    created.receipt_path.replaceAll('\\', '/'),
    /\/\.deep-review\/receipts\/document-readiness\/[a-f0-9]{64}-[a-f0-9]{64}\.json$/,
  );
  const onDisk = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
  assert.equal(
    path.basename(created.receipt_path, '.json'),
    `${onDisk.scope_sha256}-${onDisk.receipt_sha256}`,
  );
  assert.match(onDisk.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(onDisk.deferred_findings[0].finding_id, 'DOC-1');

  const verified = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  assert.equal(verified.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(verified.scope_sha256, onDisk.scope_sha256);
  assert.equal(verified.risk, 'low');
});

test('pre-implementation blockers and high-risk reviewer-family shortages produce DOCUMENT_BLOCKED without a receipt', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const blockedReport = writeReport(repo, 'blocked-review.md', report({
    warning: 1,
    findings: [{
      id: 'DOC-B1',
      severity: 'warning',
      stage: 'pre_implementation',
      acceptance_evidence: ['choose and document a rollback owner'],
    }],
  }));
  const blocked = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: blockedReport, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
  });
  assert.equal(blocked.status, 'DOCUMENT_BLOCKED');
  assert.equal(blocked.receipt_path, null);
  assert.deepEqual(blocked.blocking_finding_ids, ['DOC-B1']);

  const highReport = writeReport(repo, 'high-review.md', report({ verdict: 'APPROVE', warning: 0, findings: [] }));
  const shortage = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: highReport, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'high',
    requiredReviewers: 2,
    providerFamilyMinimum: 2,
  });
  assert.equal(shortage.status, 'DOCUMENT_BLOCKED');
  assert.ok(shortage.blocking_reasons.includes('required_reviewers'));
  assert.ok(shortage.blocking_reasons.includes('provider_families'));

  const cannotLowerRiskFloor = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: highReport, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'high',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
  });
  assert.equal(cannotLowerRiskFloor.status, 'DOCUMENT_BLOCKED');
  assert.ok(cannotLowerRiskFloor.blocking_reasons.includes('required_reviewers'));
});

test('stale document/report hashes, tampering, and symlink receipts fail with ERROR_READINESS_RECEIPT_STALE', async (t) => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);

  const makeReceipt = () => {
    const repo = repoFixture();
    const reviewPath = writeReport(repo, 'fixture-review.md', report());
    const created = createDocumentReadinessReceipt({
      repo,
      artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
      reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
      risk: 'low',
      requiredReviewers: 1,
      providerFamilyMinimum: 1,
    });
    return { repo, reviewPath, ...created };
  };

  await t.test('document changed', () => {
    const fixture = makeReceipt();
    fs.appendFileSync(path.join(fixture.repo, 'docs', '계획 Ω.md'), '\nchanged\n');
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receipt_path }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
  await t.test('report changed', () => {
    const fixture = makeReceipt();
    fs.appendFileSync(fixture.reviewPath, '\nchanged\n');
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receipt_path }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
  await t.test('receipt tampered', () => {
    const fixture = makeReceipt();
    const body = JSON.parse(fs.readFileSync(fixture.receipt_path, 'utf8'));
    body.risk = 'critical';
    fs.writeFileSync(fixture.receipt_path, JSON.stringify(body));
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receipt_path }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
  await t.test('receipt symlinked', { skip: process.platform === 'win32' }, () => {
    const fixture = makeReceipt();
    const link = path.join(fixture.repo, '.deep-review', 'receipts', 'document-readiness', 'link.json');
    fs.symlinkSync(fixture.receipt_path, link);
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: link }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
});

test('receipt creation rejects path escape and document symlinks', { skip: process.platform === 'win32' }, async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: '../outside.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  }), /repository-relative|outside/i);

  const target = path.join(repo, 'docs', '계획 Ω.md');
  const link = path.join(repo, 'docs', 'linked-plan.md');
  fs.symlinkSync(target, link);
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/linked-plan.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  }), /symlink/i);
});

test('receipt creation requires explicit risk and rejects duplicated or forged reviewer evidence', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  const base = {
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
  };
  assert.throws(() => createDocumentReadinessReceipt(base), /risk is required/);
  assert.throws(() => createDocumentReadinessReceipt({
    ...base,
    risk: 'high',
    reports: [
      ...base.reports,
      { path: reviewPath, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
  }), /duplicate reviewer report path or content hash/);
  assert.throws(() => createDocumentReadinessReceipt({
    ...base,
    risk: 'low',
    reports: [{ path: reviewPath, reviewer_id: 'codex-review', provider_family: 'claude' }],
  }), /reviewer\/provider identity mismatch/);
});

test('a self-resealed high-risk receipt cannot lower risk or remove reviewer evidence', async () => {
  const {
    canonicalStringify,
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const claudeReport = writeReport(repo, 'fixture-review.md', report());
  const codexReport = writeReport(repo, 'fixture-codex-review.md', report({
    verdict: 'APPROVE',
    warning: 0,
    findings: [],
  }));
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudeReport, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexReport, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'high',
  });
  const receipt = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
  receipt.risk = 'low';
  receipt.reports = receipt.reports.slice(0, 1);
  receipt.deferred_findings = [];
  receipt.reviewer_requirements = {
    required_reviewers: 1,
    provider_family_minimum: 1,
    actual_reviewers: 1,
    actual_provider_families: 1,
  };
  const { receipt_sha256: ignored, ...body } = receipt;
  receipt.receipt_sha256 = createHash('sha256')
    .update(Buffer.from(canonicalStringify(body), 'utf8'))
    .digest('hex');
  fs.writeFileSync(created.receipt_path, `${canonicalStringify(receipt)}\n`);
  assert.throws(
    () => verifyReadinessReceipt({ repo, receiptPath: created.receipt_path }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );
});

test('implementation APPROVE is floored until every deferred acceptance item has fresh evidence', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
    evaluateDeferredAcceptance,
    gateImplementationVerdict,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  });
  const verifiedReceipt = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  fs.writeFileSync(path.join(repo, 'implementation.js'), 'export const migrated = true;\n');
  fs.writeFileSync(path.join(repo, 'migration-test.tap'), 'ok 1 - migration rollback roundtrip\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const pending = evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [],
    repo,
    implementationArtifacts,
  });
  const implementationScopeSha256 = pending.implementation_scope_sha256;
  const evidenceSha256 = createHash('sha256')
    .update(fs.readFileSync(path.join(repo, 'migration-test.tap')))
    .digest('hex');
  assert.equal(pending.complete, false);
  assert.deepEqual(pending.pending_finding_ids, ['DOC-1']);
  const floored = gateImplementationVerdict({
    status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
  }, pending);
  assert.equal(floored.verdict, 'CONCERN');
  assert.equal(floored.deferred_acceptance_floor, true);

  const complete = evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [{
      finding_id: 'DOC-1',
      implementation_scope_sha256: implementationScopeSha256,
      verification_results: [{
        criterion: 'migration dry-run passes and rollback restores the prior schema',
        status: 'passed',
        evidence_path: 'migration-test.tap',
        evidence_sha256: evidenceSha256,
      }],
    }],
    repo,
    implementationArtifacts,
    implementationScopeSha256,
  });
  assert.equal(complete.complete, true);
  assert.throws(() => evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [{
      finding_id: 'DOC-1',
      implementation_scope_sha256: implementationScopeSha256,
      verification_results: [{
        criterion: 'verified',
        status: 'passed',
        evidence_path: 'migration-test.tap',
        evidence_sha256: evidenceSha256,
      }],
    }],
    repo,
    implementationArtifacts,
    implementationScopeSha256,
  }), /does not satisfy/);
  fs.appendFileSync(path.join(repo, 'implementation.js'), '// changed\n');
  assert.throws(() => evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [],
    repo,
    implementationArtifacts,
    implementationScopeSha256,
  }), /scope SHA-256 is stale/);
  assert.equal(gateImplementationVerdict({
    status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
  }, complete).verdict, 'APPROVE');
});

test('verified readiness receipt is injected into implementation payload as trusted bounded JSON', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const { buildReviewerPayload } = await import(payloadUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  });
  const payload = buildReviewerPayload({
    pluginRoot: root,
    repo,
    readinessReceipt: created.receipt_path,
    diff: 'IMPLEMENTATION DIFF',
  });
  const prompt = fs.readFileSync(payload.promptFile, 'utf8');
  assert.match(prompt, /VERIFIED DOCUMENT READINESS RECEIPT/);
  assert.match(prompt, /"finding_id": "DOC-1"/);
  assert.ok(prompt.trimEnd().endsWith('IMPLEMENTATION DIFF'));
});
