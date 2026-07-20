'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const claudeUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-claude-reviewer.mjs')).href;
const agyUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-agy-reviewer.mjs')).href;
const planUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-adapter-'));
  fs.mkdirSync(path.join(dir, 'project 리뷰 Ω'));
  fs.writeFileSync(path.join(dir, 'prompt 리뷰 Ω.txt'), 'untrusted review payload');
  return {
    dir,
    projectRoot: path.join(dir, 'project 리뷰 Ω'),
    promptFile: path.join(dir, 'prompt 리뷰 Ω.txt'),
    outputFile: path.join(dir, 'output 리뷰 Ω.txt'),
  };
}

function processResult(overrides = {}) {
  return { code: 0, timedOut: false, stdout: Buffer.from('review ok\n'), stderr: Buffer.alloc(0), ...overrides };
}

test('routing plan leaf validates protocol and maps only its canonical reviewer route', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const document = {
    protocol_version: '2.0', routes: [{
      reviewer_id: 'claude-opus', requested: { model: 'C:\\models\\품질=model', effort: 'high', source: 'cli-reviewer', model_source: 'cli-reviewer', effort_source: 'cli-reviewer' },
      resolved: { model: 'C:\\models\\품질=model', effort: 'high' },
      fallback: { allowed: false, occurred: false },
      transports: { model: 'flag:--model', effort: 'flag:--effort' },
    }],
  };
  const plan = parseExecutionPlanDocument(document, 'claude-opus');
  assert.equal(plan.model, 'C:\\models\\품질=model');
  assert.equal(plan.effort, 'high');
  assert.equal(plan.source, 'cli-reviewer');
  assert.throws(() => parseExecutionPlanDocument({ ...document, protocol_version: '1.0' }, 'claude-opus'), /protocol_version/);
  assert.throws(() => parseExecutionPlanDocument(document, 'agy'), /reviewer.*agy/i);
});

test('Claude execution plan forwards verified effort transport and normalizes unreported application', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: {
      model: 'vendor=model 품질', effort: 'xhigh', source: 'cli-provider', allowFallback: false,
      modelTransport: 'flag:--model', effortTransport: 'flag:--effort',
    },
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.equal(invocation.binary, '/fake/claude');
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 4), ['--model', 'vendor=model 품질', '--effort', 'xhigh']);
  assert.equal(result.requested_model, 'vendor=model 품질');
  assert.equal(result.resolved_effort, 'xhigh');
  assert.equal(result.applied_model, null);
  assert.equal(result.verification_status, 'provider-did-not-report');
});

test('Claude explicit effort fails closed without transport; allow-fallback omits it with provenance', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let calls = 0;
  const base = {
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    processRunner: async () => { calls += 1; return processResult(); },
  };
  await assert.rejects(runClaudeReviewer({ ...base, executionPlan: { model: 'm', effort: 'high', source: 'cli-provider', allowFallback: false, effortTransport: 'unknown' } }), /ERROR_EFFORT_TRANSPORT_UNAVAILABLE/);
  assert.equal(calls, 0);
  const fallback = await runClaudeReviewer({ ...base, executionPlan: { model: 'm', effort: 'high', source: 'cli-provider', allowFallback: true, effortTransport: 'none' } });
  assert.equal(calls, 1);
  assert.equal(fallback.fallback.occurred, true);
  assert.equal(fallback.resolved_effort, null);
  assert.equal(fallback.verification_status, 'fallback');
});

test('agy explicit unsupported model never retries unless fallback was authorized', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let calls = 0;
  const strict = await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    executionPlan: { model: 'unsupported-model', effort: null, source: 'cli-reviewer', allowFallback: false },
    privacyPreparer, fingerprintCapturer,
    processRunner: async () => { calls += 1; return processResult({ code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported model\n') }); },
  });
  assert.equal(calls, 1);
  assert.equal(strict.error_code, 'ERROR_UNSUPPORTED_MODEL');
  assert.equal(strict.verification_status, 'failed');

  calls = 0;
  const fallback = await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    executionPlan: { model: 'unsupported-model', effort: null, source: 'cli-provider', allowFallback: true },
    privacyPreparer, fingerprintCapturer,
    processRunner: async (_binary, args) => {
      calls += 1;
      return args.includes('--model')
        ? processResult({ code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported model\n') })
        : processResult();
    },
  });
  assert.equal(calls, 2);
  assert.equal(fallback.status, 'success');
  assert.equal(fallback.fallback.occurred, true);
  assert.equal(fallback.verification_status, 'fallback');
});

// ---------------------------------------------------------------------------
// H4: an execution plan's resolved model is authoritative, including null
// (provider default) — the legacy options.model must never resurrect a stale
// --model value once a plan is present.
// ---------------------------------------------------------------------------

test('H4: agy with an execution plan whose resolved model is null never falls back to legacy options.model', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let invocation;
  const result = await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    model: 'gemini-x',
    executionPlan: { model: null, effort: null, source: 'cli-provider', allowFallback: true },
    privacyPreparer, fingerprintCapturer,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.equal(invocation.args.includes('--model'), false);
  assert.equal(result.resolved_model, null);
});

test('H4: agy without an execution plan still honors the legacy options.model', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let invocation;
  await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    model: 'gemini-x',
    privacyPreparer, fingerprintCapturer,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'gemini-x']);
});

test('H4: agy with an execution plan whose model is explicitly set still lands in argv', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let invocation;
  await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    model: 'gemini-x',
    executionPlan: { model: 'explicit-plan-model', effort: null, source: 'cli-provider', allowFallback: true },
    privacyPreparer, fingerprintCapturer,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'explicit-plan-model']);
});

test('native Claude documentation states the real model-only override boundary', () => {
  const source = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/review-execution.md'), 'utf8');
  assert.match(source, /Agent\(code-reviewer\)[\s\S]{0,500}model parameter/i);
  assert.match(source, /effort[\s\S]{0,180}(?:unsupported|not support|지원하지)/i);
  assert.match(source, /explicit\s+effort[\s\S]{0,220}(?:strict|error|오류)/i);
});
