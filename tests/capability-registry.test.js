'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const registryUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/capability-registry.mjs')).href;

function detected(overrides = {}) {
  return {
    claude_cli: false, claude_cli_path: '', codex_cli: false, codex_cli_path: '',
    codex_plugin: false, codex_companion_path: '', agy_cli: false, agy_cli_path: '',
    agy_version: '', ...overrides,
  };
}

test('buildCapabilities emits five distinct protocol 2.0 adapter contracts', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const capabilities = buildCapabilities({
    detected: detected({
      claude_cli: true, claude_cli_path: '/tools/claude',
      codex_cli: true, codex_cli_path: '/tools/codex',
      codex_plugin: true, codex_companion_path: '/plugins/codex-companion.mjs',
      agy_cli: true, agy_cli_path: '/tools/agy', agy_version: 'agy 1.2.3',
    }),
    hostAssertions: { claudeNativeAgent: true, codexNativeGeneric: false },
    probes: {
      claude: { ok: true, version: 'Claude Code v2.3.4 (stable)', help: '  --effort <level>' },
      codex: { ok: true, version: 'codex-cli 0.42.0' },
    },
  });
  assert.equal(capabilities.length, 5);
  assert.deepEqual(capabilities.map((item) => item.adapter_id), [
    'claude-native-agent', 'claude-cli', 'codex-native-generic', 'codex-companion', 'agy-cli',
  ]);
  for (const item of capabilities) {
    assert.equal(item.protocol_version, '2.0');
    for (const field of ['provider', 'available', 'roles', 'model_selection', 'effort_selection', 'structured_output', 'read_only_enforcement']) {
      assert.ok(Object.hasOwn(item, field), `${item.adapter_id} missing ${field}`);
    }
  }
  assert.equal(capabilities[0].available, true);
  assert.equal(capabilities[1].effort_selection.transport, 'flag:--effort');
  assert.equal(capabilities[2].available, false);
  assert.equal(capabilities[3].model_selection.supported, false);
  assert.equal(capabilities[3].effort_selection.supported, false);
  assert.notEqual(capabilities[2].adapter_id, capabilities[3].adapter_id);
});

// F4: codex-native-generic must fail closed on model overrides — no dispatch
// path today transmits a model to the native generic subagent.
test('F4: codex-native-generic declares no model transport, matching the honest codex-companion contract', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const capabilities = buildCapabilities({
    detected: detected(),
    hostAssertions: { claudeNativeAgent: true, codexNativeGeneric: true },
  });
  const codexNativeGeneric = capabilities.find((item) => item.adapter_id === 'codex-native-generic');
  assert.equal(codexNativeGeneric.model_selection.supported, false);
  assert.equal(codexNativeGeneric.model_selection.transport, 'none');
});

test('host assertions are injected per run and absent assertions remain unknown', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const absent = buildCapabilities({ detected: detected() });
  assert.equal(absent.find((item) => item.adapter_id === 'claude-native-agent').available, 'unknown');
  assert.equal(absent.find((item) => item.adapter_id === 'codex-native-generic').available, 'unknown');
  const injected = buildCapabilities({ detected: detected(), hostAssertions: { claudeNativeAgent: false } });
  assert.equal(injected.find((item) => item.adapter_id === 'claude-native-agent').available, false);
});

test('probe parsing tolerates version variants and reports safe unknown/false states', async () => {
  const { parseVersion, detectEffortTransport, buildCapabilities } = await import(registryUrl);
  assert.equal(parseVersion('Claude Code v2.3.4 (stable)\nmore'), '2.3.4');
  assert.equal(parseVersion('codex-cli 0.42.0-beta.1'), '0.42.0-beta.1');
  assert.equal(parseVersion('development build'), 'development build');
  assert.equal(detectEffortTransport('set CLAUDE_CODE_EFFORT_LEVEL to low'), 'env:CLAUDE_CODE_EFFORT_LEVEL');
  assert.equal(detectEffortTransport('', false), 'unknown');

  const capabilities = buildCapabilities({
    detected: detected({ claude_cli: true, claude_cli_path: '/missing/claude' }),
    probes: { claude: { ok: false, error: 'ENOENT' } },
  });
  const claude = capabilities.find((item) => item.adapter_id === 'claude-cli');
  assert.equal(claude.available, false);
  assert.equal(claude.effort_selection.transport, 'unknown');
});

test('capability cache has protocol 2.0 and invalidates on path, mtime, or version changes', async () => {
  const { buildCapabilities, loadCapabilityCache, saveCapabilityCache } = await import(registryUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-capability-'));
  const file = path.join(temp, 'capabilities.json');
  const capabilities = buildCapabilities({ detected: detected() });
  const keys = { claude: { path: '/bin/claude', mtime_ms: 10, version: '1.0.0' } };
  saveCapabilityCache(file, capabilities, keys);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.protocol_version, '2.0');
  assert.deepEqual(
    loadCapabilityCache(file, keys),
    capabilities.filter((item) => !['claude-native-agent', 'codex-native-generic'].includes(item.adapter_id)),
  );
  for (const changed of [
    { claude: { path: '/other/claude', mtime_ms: 10, version: '1.0.0' } },
    { claude: { path: '/bin/claude', mtime_ms: 11, version: '1.0.0' } },
    { claude: { path: '/bin/claude', mtime_ms: 10, version: '1.0.1' } },
  ]) assert.equal(loadCapabilityCache(file, changed), null);
});
