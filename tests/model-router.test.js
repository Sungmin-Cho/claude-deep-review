'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routerUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/model-router.mjs')).href;

function capability(overrides = {}) {
  return {
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'adversarial', 'classifier'], read_only_enforcement: 'process-contract',
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: true, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    unit: { target_kind: 'implementation-plan', path: 'docs/plan.md', byte_size: 20_000 },
    reviewer: { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
    risk: 'medium', size: 'small', policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability()],
    ...overrides,
  };
}

test('risk and size classifiers use deterministic high-risk signals and configurable thresholds', async () => {
  const { assessRisk, assessSize } = await import(routerUrl);
  assert.equal(assessRisk([{ path: 'src/auth/permissions.ts', diff: '+ destructive data operation' }]), 'high');
  assert.equal(assessRisk([{ path: 'docs/readme.md', content: 'typo correction' }]), 'low');
  assert.equal(assessSize({ target_kind: 'code-change', changed_lines: 101 }), 'small');
  assert.equal(assessSize({ target_kind: 'design-document', byte_size: 31 * 1024 }), 'medium');
  assert.equal(assessSize({ target_kind: 'code-change', changed_lines: 42 }, { code: [10, 20, 30] }), 'large');
});

// F3: preserved content-derived risk/size evidence must feed routing even when
// the reduced artifact carries no raw content or diff text.
test('F3: assessRisk honours a precomputed content_risk flag and assessSize falls back to line_count for code', async () => {
  const { assessRisk, assessSize } = await import(routerUrl);
  assert.equal(assessRisk([{ path: 'src/service.js', content_risk: 'high' }]), 'high');
  assert.equal(assessRisk([{ path: 'src/service.js', content_risk: 'low' }]), 'low');
  assert.equal(assessSize({ target_kind: 'code-change', line_count: 500 }), 'medium');
});

test('auto matrix routes kind × risk × size × role with symbolic tiers', async () => {
  const { routeReviewer } = await import(routerUrl);
  const cases = [
    ['code-change', 'low', 'tiny', 'standard', 'balanced', 'high'],
    ['code-change', 'high', 'small', 'adversarial', 'quality', 'xhigh'],
    ['design-document', 'high', 'medium', 'standard', 'maximum', 'xhigh'],
    ['implementation-plan', 'medium', 'large', 'standard', 'quality', 'high'],
    ['requirements-specification', 'low', 'small', 'standard', 'quality', 'high'],
    ['generic-document', 'low', 'small', 'standard', 'balanced', 'medium'],
    ['configuration-infrastructure', 'high', 'small', 'adversarial', 'quality', 'xhigh'],
  ];
  for (const [target_kind, risk, size, role, tier, effort] of cases) {
    const result = routeReviewer(request({
      unit: { target_kind }, risk, size,
      reviewer: { id: 'claude-opus', provider: 'claude', role, adapter_id: 'claude-cli' },
    }));
    assert.equal(result.protocol_version, '2.0');
    assert.equal(result.requested.model_tier, tier, target_kind);
    assert.equal(result.requested.effort, effort, target_kind);
  }
});

test('override precedence is reviewer CLI > provider CLI > global > project > user > auto', async () => {
  const { routeReviewer } = await import(routerUrl);
  const base = request({
    policy: {
      routing: { policy: 'auto' },
      project: { providers: { claude: { model: 'project-model', effort: 'medium' } } },
      user: { providers: { claude: { model: 'user-model', effort: 'low' } } },
    },
    capabilities: [capability({ model_selection: { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' } })],
  });
  assert.equal(routeReviewer(base).requested.model, 'project-model');
  const provider = structuredClone(base);
  provider.overrides.providers.claude = { model: 'provider-model', effort: 'high' };
  assert.equal(routeReviewer(provider).requested.model, 'provider-model');
  const reviewer = structuredClone(provider);
  reviewer.overrides.reviewers['claude-opus'] = { model: 'reviewer-model', effort: 'xhigh' };
  const resolved = routeReviewer(reviewer);
  assert.equal(resolved.requested.model, 'reviewer-model');
  assert.equal(resolved.requested.effort, 'xhigh');
  assert.equal(resolved.requested.source, 'cli-reviewer');
});

test('strict explicit unsupported values fail; fallback alone allows ordered substitution with provenance', async () => {
  const { routeReviewer } = await import(routerUrl);
  const explicit = request();
  explicit.overrides.providers.claude = { model: 'missing', effort: 'max' };
  assert.throws(() => routeReviewer(explicit), /ERROR_UNSUPPORTED_MODEL/);

  explicit.overrides.allow_fallback = true;
  const result = routeReviewer(explicit);
  assert.equal(result.resolved.model, 'deep');
  assert.equal(result.resolved.effort, 'max');
  assert.equal(result.fallback.occurred, true);
  assert.equal(result.fallback.reason, 'requested model unsupported by adapter');

  const effort = request({ capabilities: [capability({ effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh'], transport: 'flag:--effort' } })] });
  effort.overrides.providers.claude = { effort: 'max' };
  assert.throws(() => routeReviewer(effort), /ERROR_UNSUPPORTED_EFFORT/);
  effort.overrides.allow_fallback = true;
  assert.equal(routeReviewer(effort).resolved.effort, 'xhigh');
});

// F7: an explicit unknown effort alias (no lower supported level exists in
// EFFORT_ORDER) must be omitted with fallback provenance under
// allow_fallback, never silently forwarded to the adapter.
test('F7: an explicit unknown effort value is omitted under allow_fallback and throws without it', async () => {
  const { routeReviewer } = await import(routerUrl);
  const unknownEffort = request({
    capabilities: [capability({ effort_selection: { supported: true, levels: ['low', 'medium', 'high'], transport: 'flag:--effort' } })],
  });
  unknownEffort.overrides.providers.claude = { effort: 'turbo' };
  assert.throws(() => routeReviewer(unknownEffort), /ERROR_UNSUPPORTED_EFFORT/);

  unknownEffort.overrides.allow_fallback = true;
  const result = routeReviewer(unknownEffort);
  assert.equal(result.resolved.effort, null);
  assert.equal(result.fallback.occurred, true);
  assert.equal(result.fallback.reason, 'requested effort unsupported by adapter');
});

test('unknown transports and unavailable providers fail closed for explicit requests', async () => {
  const { routeReviewer } = await import(routerUrl);
  const unknown = request({ capabilities: [capability({ model_selection: { supported: 'unknown', aliases: [], catalog_complete: false, transport: 'unknown' } })] });
  unknown.overrides.providers.claude = { model: 'vendor-model' };
  assert.throws(() => routeReviewer(unknown), /ERROR_MODEL_TRANSPORT_UNAVAILABLE/);
  const unavailable = request({ capabilities: [capability({ available: false })] });
  assert.throws(() => routeReviewer(unavailable), /ERROR_PROVIDER_UNAVAILABLE/);
});

test('tier resolution follows project > user > adapter aliases and none aliases to minimal', async () => {
  const { routeReviewer } = await import(routerUrl);
  const project = request({ policy: {
    routing: { policy: 'auto' },
    project: { providers: { claude: { model_tiers: { quality: 'project-quality' } } } },
    user: { providers: { claude: { model_tiers: { quality: 'user-quality' } } } },
  }, capabilities: [capability({
    model_selection: { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
  })] });
  assert.equal(routeReviewer(project).resolved.model, 'project-quality');
  project.overrides.providers.claude = { effort: 'none' };
  assert.equal(routeReviewer(project).requested.effort, 'minimal');
});

// F4: codex-native-generic now honestly declares no verified model transport
// (model_selection.supported: false, transport: 'none', aliases: []). An
// explicit override must fail closed — with no adapter-alias or tier-map
// substitute available, it fails closed even when allow_fallback is set,
// which is a stricter (and still correct) reading of "fail closed until a
// verified transport exists". Automatic (non-explicit) routing is unaffected
// and keeps resolving to the provider default.
function codexNativeGenericCapability() {
  return {
    protocol_version: '2.0', adapter_id: 'codex-native-generic', provider: 'codex', available: true,
    roles: ['standard', 'adversarial'], read_only_enforcement: 'agent-tool-allowlist',
    model_selection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' },
    effort_selection: { supported: 'unknown', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], transport: 'unknown' },
  };
}

test('F4: an explicit model override targeting codex-native-generic fails closed; automatic routing is unaffected', async () => {
  const { routeReviewer } = await import(routerUrl);
  const reviewer = { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' };
  const explicit = request({
    unit: { target_kind: 'code-change' }, reviewer,
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: { codex: { model: 'gpt-explicit' } }, reviewers: {} },
    capabilities: [codexNativeGenericCapability()],
  });
  assert.throws(() => routeReviewer(explicit), /ERROR_UNSUPPORTED_MODEL/);

  // No adapter-alias or tier-map substitute is known for this adapter, so
  // allow_fallback cannot silently swap in an unverified model either.
  const withFallback = structuredClone(explicit);
  withFallback.overrides.allow_fallback = true;
  assert.throws(() => routeReviewer(withFallback), /ERROR_UNSUPPORTED_MODEL/);

  const automatic = request({
    unit: { target_kind: 'code-change' }, reviewer,
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [codexNativeGenericCapability()],
  });
  const automaticResult = routeReviewer(automatic);
  assert.equal(automaticResult.resolved.model, null);
});

test('buildRoutingPlan preserves the eligible reviewer set and emits protocol 2.0', async () => {
  const { buildRoutingPlan, renderRoutingExplanation } = await import(routerUrl);
  const reviewers = [
    { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
    { id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' },
  ];
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'generic-document', path: 'README.md', byte_size: 1000 }],
    reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability(), capability({ adapter_id: 'agy-cli', provider: 'agy', model_selection: { supported: true, aliases: ['a', 'b', 'c', 'd'], catalog_complete: false, transport: 'config:agy_model' }, effort_selection: { supported: false, levels: [], transport: 'none' } })],
  });
  assert.equal(plan.protocol_version, '2.0');
  assert.deepEqual(plan.routes.map((route) => route.reviewer_id), reviewers.map((reviewer) => reviewer.id));
  assert.match(renderRoutingExplanation(plan), /claude-opus/);
});
