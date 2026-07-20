'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const classifyUrl = pathToFileURL(path.join(root, 'hooks/scripts/classify-artifacts.mjs')).href;
const routeUrl = pathToFileURL(path.join(root, 'hooks/scripts/public-route.mjs')).href;
const claudeUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-claude-reviewer.mjs')).href;
const modelRouterUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/model-router.mjs')).href;

function claudeCapability() {
  return {
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'classifier'], model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  };
}

test('dry-run and explain render real routing plans without Phase 2 defer text', async () => {
  const { formatDryRun, formatExplainRouting } = await import(classifyUrl);
  const result = {
    scope: 'generic-document', artifacts: [{ path: 'README.md', target_kind: 'generic-document', confidence: 0.6, signal_summary: 'headings', needs_semantic: true, semantic_status: 'deferred' }],
    routing_plan: { protocol_version: '2.0', routing_policy: 'auto', shadow_mode: true, routes: [{ reviewer_id: 'claude-opus', resolved: { model: 'steady', effort: 'medium' }, route_explanation: 'generic route', fallback: { occurred: false } }] },
  };
  for (const output of [formatDryRun(result), formatExplainRouting(result)]) {
    assert.match(output, /Routing (?:plan|policy)/i);
    assert.match(output, /claude-opus/);
    assert.doesNotMatch(output, /not yet implemented|arrives in Phase 2|deferred to Phase 2/i);
  }
});

test('public override → emit-routing-plan → leaf argv applies explicit model and effort', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const { runClaudeReviewer } = await import(claudeUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-routing-public-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const planPath = path.join(repo, '.deep-review', 'tmp', 'routing-plan.json');
  const route = parsePublicRoute({
    entry: 'review', host: 'claude', cwd: repo,
    argv: ['--model', 'claude=vendor=model 품질', '--effort', 'claude=xhigh'],
  });
  assert.equal(route.ok, true);
  await runClassifyArtifactsCli([
    '--repo', repo, '--change-state', 'non-git', '--files-from0', files,
    '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan', '--routing-plan-out', planPath,
  ], {}, {
    capabilities: [claudeCapability()],
    reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
  });
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.equal(plan.protocol_version, '2.0');
  assert.equal(plan.routes[0].transports.effort, 'flag:--effort');

  const promptFile = path.join(repo, 'prompt.txt');
  const outputFile = path.join(repo, 'output.txt');
  fs.writeFileSync(promptFile, 'payload');
  // JS callers load the same leaf plan helper used by the CLI surface.
  const { loadExecutionPlan } = await import(pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href);
  const executionPlan = loadExecutionPlan(planPath, 'claude-opus');
  let argv;
  await runClaudeReviewer({ projectRoot: repo, pluginRoot: root, promptFile, outputFile, binary: '/fake/claude', executionPlan,
    processRunner: async (_binary, args) => { argv = args; return { code: 0, timedOut: false, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }; } });
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4), ['--model', 'vendor=model 품질', '--effort', 'xhigh']);
});

// I4: --host-assertions-json is the internal preflight argv transport for
// native host tool assertions. These tests deliberately omit
// runtime.capabilities (it takes full precedence and would bypass the flag
// entirely) and instead stub runtime.probes to avoid any real subprocess
// probing of an installed claude/codex/agy binary, restricting PATH so
// environment detection cannot discover one either.
const SAFE_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);

test('I4: --host-assertions-json threads native Claude agent availability into the routing plan', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-native-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--host-assertions-json', '{"claudeNativeAgent":true}'],
    { PATH: SAFE_SYSTEM_PATH },
    { probes: { claude: { ok: false }, codex: { ok: false } } },
  );
  const claudeRoute = result.routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist once the native agent host assertion is true');
  assert.equal(claudeRoute.adapter_id, 'claude-native-agent');
});

test('I4: omitting --host-assertions-json leaves adapter selection unchanged (claude-cli chosen when only the CLI capability is available)', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-absent-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-fake-claude-bin-'));
  const claudeScript = path.join(binDir, 'claude');
  fs.writeFileSync(claudeScript, '#!/bin/sh\necho "Claude Code v9.9.9"\n');
  if (process.platform !== 'win32') fs.chmodSync(claudeScript, 0o755);

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files],
    { PATH: `${binDir}${path.delimiter}${SAFE_SYSTEM_PATH}` },
    { probes: { claude: { ok: true, version: 'Claude Code v9.9.9', help: '' }, codex: { ok: false } } },
  );
  const claudeRoute = result.routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist when the CLI capability is available');
  assert.equal(claudeRoute.adapter_id, 'claude-cli');
});

test('shadow routing defaults to report-only and preflight failures stop only explicit overrides', async () => {
  const { routingPreflightDecision } = await import(classifyUrl);
  assert.deepEqual(routingPreflightDecision({ explicit: false, error: new Error('probe failed') }), { action: 'continue', warning: 'probe failed' });
  assert.deepEqual(routingPreflightDecision({ explicit: true, error: new Error('unsupported') }), { action: 'stop', error: 'unsupported' });
  assert.deepEqual(routingPreflightDecision({ explicit: true }), { action: 'apply', error: null });
});

test('workflow/report contracts wire conditional routing plan consumption while preserving no-flag argv', () => {
  const execution = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/review-execution.md'), 'utf8');
  const report = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/report-format.md'), 'utf8');
  const legacyClaude = 'run-claude-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --model REVIEW_MODEL --agent code-reviewer --timeout-seconds 1200';
  assert.ok(execution.includes(legacyClaude), 'no-flag Claude dispatch changed');
  assert.match(execution, /--emit-routing-plan/);
  assert.match(execution, /--routing-plan \.deep-review\/tmp\/routing-plan\.json --reviewer-id/);
  assert.match(execution, /explicit_overrides[\s\S]{0,80}apply_automatic/u);
  assert.match(execution, /apply_automatic[^\n]{0,120}/);
  assert.match(report, /## Routing Plan/);
  assert.match(report, /## Provenance/);
  assert.match(report, /requested-but-unverified/);
});

// F3: risk assessment must see artifact content evidence even though the
// reduced provenance artifacts only carry non-sensitive scalar fields.
test('F3: high-risk content under a neutral filename still routes as high risk', async () => {
  const { classifyArtifactsScope } = await import(classifyUrl);
  const { buildRoutingPlan } = await import(modelRouterUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-f3-content-risk-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src', 'service.js'),
    '// runs the payment migration workflow\nfunction run() { return true; }\n',
  );

  const result = classifyArtifactsScope({ repo, changeState: 'non-git', filesFromZ: Buffer.from('src/service.js\0') });
  const artifact = result.artifacts.find((item) => item.path === 'src/service.js');
  assert.equal(artifact.content_risk, 'high', 'neutral filename must still carry high content risk');
  assert.doesNotMatch(JSON.stringify(artifact), /payment migration workflow/, 'reduced artifact must not persist raw content');

  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
  const plan = buildRoutingPlan({
    artifacts: result.artifacts, reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities,
  });
  assert.match(plan.routes[0].route_explanation, /\/high\//);
});
