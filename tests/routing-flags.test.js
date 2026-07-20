'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routeUrl = pathToFileURL(path.join(root, 'hooks/scripts/public-route.mjs')).href;
const classifyUrl = pathToFileURL(path.join(root, 'hooks/scripts/classify-artifacts.mjs')).href;

test('review routing flags normalize repeated provider and canonical reviewer overrides', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const result = parsePublicRoute({
    entry: 'review', host: 'claude', cwd: root,
    argv: [
      '--routing', 'quality', '--model', 'claude=vendor=model=v2', '--effort', 'claude=high',
      '--model', 'agy=agy-pro', '--reviewer-model', 'claude-opus=best',
      '--reviewer-effort', 'codex-review=xhigh', '--reviewer-effort', 'codex-adversarial=max',
      '--reviewer-model', 'agy=agy-fast', '--allow-fallback', '--allow-classifier',
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides, {
    protocol_version: '2.0',
    routing_policy: 'quality',
    allow_fallback: true,
    allow_classifier: true,
    providers: {
      claude: { model: 'vendor=model=v2', effort: 'high' },
      agy: { model: 'agy-pro' },
    },
    reviewers: {
      'claude-opus': { model: 'best' },
      'codex-review': { effort: 'xhigh' },
      'codex-adversarial': { effort: 'max' },
      agy: { model: 'agy-fast' },
    },
  });
});

test('routing flags reject duplicates, unknown keys, and codex-only conflicts', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const parse = (argv) => parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
  assert.match(parse(['--model', 'claude=a', '--model', 'claude=b']).error, /duplicate/i);
  assert.match(parse(['--model', 'other=a']).error, /unknown provider/i);
  assert.match(parse(['--reviewer-model', 'claude-unknown=a']).error, /unknown reviewer/i);
  assert.match(parse(['--reviewer-model', 'claude-adversarial=a']).error, /unknown reviewer/i);
  assert.match(parse(['--codex-only', '--model', 'claude=a']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--routing', 'turbo']).ok, false);
});

// F9: a reviewer-level override whose reviewer maps to a provider disabled by
// --no-opus/--no-codex/--no-agy (including --codex-only expansion) must be
// rejected with the same conflict error as the provider-level checks.
test('F9: reviewer-level overrides conflicting with a disabled provider are rejected', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const parse = (argv) => parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
  assert.equal(parse(['--codex-only', '--reviewer-model', 'claude-opus=opus']).ok, false);
  assert.match(parse(['--codex-only', '--reviewer-model', 'claude-opus=opus']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--no-codex', '--reviewer-effort', 'codex-adversarial=high']).ok, false);
  assert.match(parse(['--no-codex', '--reviewer-effort', 'codex-adversarial=high']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--no-agy', '--reviewer-model', 'claude-opus=opus']).ok, true);
});

test('loop grammar continues to reject all new review routing flags', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  for (const argv of [['--routing', 'auto'], ['--model', 'claude=x'], ['--allow-fallback'], ['--allow-classifier']]) {
    assert.equal(parsePublicRoute({ entry: 'loop', host: 'codex', argv }).ok, false);
  }
});

test('classify CLI override parser round-trips normalized schema and rejects malformed input', async () => {
  const { parseArguments } = await import(classifyUrl);
  const overrides = {
    protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false,
    allow_classifier: false, providers: {}, reviewers: {},
  };
  assert.deepEqual(parseArguments(['--overrides-json', JSON.stringify(overrides)]).overrides, overrides);
  assert.throws(() => parseArguments(['--overrides-json', '{']), /overrides-json.*JSON/i);
  assert.throws(() => parseArguments(['--overrides-json', '{}']), /protocol_version/i);
});

// I4: --host-assertions-json is the only transport for native host tool
// assertions into the classify-artifacts.mjs subprocess. Validation happens
// inside runClassifyArtifactsCli (not parseArguments), so these assertions
// exercise the full async CLI entry point with a runtime.capabilities short
// circuit to avoid any real environment detection.
test('classify CLI --host-assertions-json rejects malformed JSON, non-object values, unknown keys, and non-boolean values', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-invalid-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const runtime = {
    capabilities: [{
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
      roles: ['standard'],
      model_selection: { supported: true, aliases: ['steady'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    }],
    reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
  };
  const run = (hostAssertionsJson) => runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--host-assertions-json', hostAssertionsJson],
    {},
    runtime,
  );
  await assert.rejects(run('{'), /--host-assertions-json must contain valid JSON/);
  await assert.rejects(run('null'), /claudeNativeAgent\/codexNativeGeneric/);
  await assert.rejects(run('[]'), /claudeNativeAgent\/codexNativeGeneric/);
  await assert.rejects(run('"x"'), /claudeNativeAgent\/codexNativeGeneric/);
  await assert.rejects(run('{"unknownKey":true}'), /claudeNativeAgent\/codexNativeGeneric/);
  await assert.rejects(run('{"claudeNativeAgent":"yes"}'), /claudeNativeAgent\/codexNativeGeneric/);
});

test('public skill forwards normalized routing overrides as one compact JSON argv value', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/deep-review/SKILL.md'), 'utf8');
  assert.match(skill, /--overrides-json/);
  assert.match(skill, /JSON\.stringify\(route\.overrides\)/);
  assert.match(skill, /single argv\s+value|single argument/i);
});

// ---------------------------------------------------------------------------
// F5: an explicit non-default --routing policy must become an applicable
// execution override; a policy-file-only routing policy (or --routing auto)
// must not.
// ---------------------------------------------------------------------------

function routingTestCapabilities() {
  return [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
}

const routingTestReviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];

test('F5: an explicit CLI --routing quality marks the plan explicit and upgrades the resolved tier', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-f5-cli-routing-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--routing', 'quality'] });
  assert.equal(route.ok, true);
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: routingTestCapabilities(), reviewers: routingTestReviewers },
  );
  assert.equal(result.routing_plan.explicit_overrides, true);
  const [firstRoute] = result.routing_plan.routes;
  assert.ok(
    ['quality', 'maximum'].includes(firstRoute.requested.model_tier) || /quality|maximum/.test(firstRoute.route_explanation),
    'quality routing policy must upgrade the resolved tier',
  );
});

test('F5: a policy-file-only routing policy and --routing auto stay non-explicit', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-f5-policy-routing-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const policyOnly = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    {
      capabilities: routingTestCapabilities(), reviewers: routingTestReviewers,
      projectPolicy: { routing: { policy: 'quality' } },
    },
  );
  assert.equal(policyOnly.routing_plan.explicit_overrides, false);

  const { parsePublicRoute } = await import(routeUrl);
  const autoRoute = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--routing', 'auto'] });
  assert.equal(autoRoute.ok, true);
  const autoResult = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(autoRoute.overrides), '--emit-routing-plan'],
    {},
    { capabilities: routingTestCapabilities(), reviewers: routingTestReviewers },
  );
  assert.equal(autoResult.routing_plan.explicit_overrides, false);
});

// ---------------------------------------------------------------------------
// G2: --no-opus/--no-codex/--no-agy (and --codex-only's expansion) must
// transport disabled providers to the preflight and exclude their reviewers
// from eligibility checks and the emitted routing plan.
// ---------------------------------------------------------------------------

function g2Capabilities() {
  return [
    {
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['steady'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
    {
      protocol_version: '2.0', adapter_id: 'codex-companion', provider: 'codex', available: true, roles: ['standard', 'adversarial'],
      model_selection: { supported: true, aliases: ['fast'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
      structured_output: true, read_only_enforcement: 'agent-tool-allowlist',
    },
    {
      protocol_version: '2.0', adapter_id: 'agy-cli', provider: 'agy', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['a'], catalog_complete: false, transport: 'config:agy_model' },
      effort_selection: { supported: false, levels: [], transport: 'none' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
  ];
}

const g2Reviewers = [
  { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
  { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-companion' },
  { id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' },
];

test('G2: --no-codex emits disabled_providers and excludes codex routes from the plan', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: ['--no-codex'] });
  assert.equal(route.ok, true);
  assert.deepEqual(route.overrides.disabled_providers, ['codex']);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g2-no-codex-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: g2Capabilities(), reviewers: g2Reviewers },
  );
  assert.deepEqual(result.routing_plan.routes.map((r) => r.reviewer_id).sort(), ['agy', 'claude-opus']);
  assert.equal(result.routing_plan.routes.some((r) => r.provider === 'codex'), false, 'no codex route must be emitted when --no-codex disables it');
});

test('G2: --codex-only yields disabled_providers [agy, claude] and a codex-only plan', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: ['--codex-only'] });
  assert.equal(route.ok, true);
  assert.deepEqual(route.overrides.disabled_providers, ['agy', 'claude']);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g2-codex-only-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: g2Capabilities(), reviewers: g2Reviewers },
  );
  assert.deepEqual(result.routing_plan.routes.map((r) => r.reviewer_id), ['codex-review'], 'only the codex reviewer must remain routable under --codex-only');
});

test('G2: no disable flags at all keeps today\'s byte-identical plan (every eligible reviewer routed)', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: [] });
  assert.equal(route.ok, true);
  assert.equal(route.overrides, undefined);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g2-no-flags-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    { capabilities: g2Capabilities(), reviewers: g2Reviewers },
  );
  assert.deepEqual(result.routing_plan.routes.map((r) => r.reviewer_id).sort(), ['agy', 'claude-opus', 'codex-review']);
});

// ---------------------------------------------------------------------------
// J3: an explicit effort override that targets the claude provider (or the
// claude-opus reviewer) cannot be transported by claude-native-agent
// (effort_selection.supported is always false there); when the Claude CLI
// adapter is available AND can transport the requested effort, claude-opus
// must be bound to it instead of the native agent. Absent an explicit effort
// request, native-first precedence stays byte-identical. These tests omit
// `reviewers` from the runtime stub so defaultReviewers() itself is exercised.
// ---------------------------------------------------------------------------

function j3Capabilities({ claudeCliEffortSupported = true } = {}) {
  return [
    {
      protocol_version: '2.0', adapter_id: 'claude-native-agent', provider: 'claude', available: true,
      roles: ['standard'],
      model_selection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'agent-parameter' },
      effort_selection: { supported: false, levels: [], transport: 'none' },
      structured_output: true, read_only_enforcement: 'agent-tool-allowlist',
    },
    {
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
      roles: ['standard'],
      model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: {
        supported: claudeCliEffortSupported,
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        transport: 'flag:--effort',
      },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
  ];
}

test('J3: an explicit claude effort override binds claude-opus to claude-cli when the native agent cannot transport it', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j3-effort-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--effort', 'claude=high'] });
  assert.equal(route.ok, true);

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: j3Capabilities() },
  );
  const claudeRoute = result.routing_plan.routes.find((r) => r.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist');
  assert.equal(claudeRoute.adapter_id, 'claude-cli', 'an explicit supported effort must bind claude-opus to the transport-capable CLI adapter');
  assert.equal(claudeRoute.resolved.effort, 'high');
});

test('J3: with no explicit effort override, claude-opus stays on the native agent (byte-identical precedence)', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j3-no-effort-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    { capabilities: j3Capabilities() },
  );
  const claudeRoute = result.routing_plan.routes.find((r) => r.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist');
  assert.equal(claudeRoute.adapter_id, 'claude-native-agent', 'absent an explicit effort request, native-first precedence must stay unchanged');
});

test('J3: an explicit claude effort override keeps claude-native-agent (and surfaces the honest transport error) when the CLI adapter cannot transport effort either', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j3-unsupported-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--effort', 'claude=high'] });
  assert.equal(route.ok, true);

  await assert.rejects(
    runClassifyArtifactsCli(
      ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
      {},
      { capabilities: j3Capabilities({ claudeCliEffortSupported: false }) },
    ),
    /ERROR_UNSUPPORTED_EFFORT|ERROR_EFFORT_TRANSPORT_UNAVAILABLE/,
    'when neither claude adapter can transport the explicit effort, the router must surface the honest error rather than silently succeeding',
  );
});
