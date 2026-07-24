import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess } from './process.mjs';
import { readContainedFile, writeContainedFile } from './runtime-context.mjs';
import { ASSIGNMENT_ROLES } from './assignment-rubrics.mjs';

export const CAPABILITY_PROTOCOL_VERSION = '2.0';

const ALL_TARGETS = Object.freeze([
  'code-change', 'design-document', 'implementation-plan',
  'requirements-specification', 'architecture-decision-record', 'test-plan',
  'runbook-operations', 'research-note', 'configuration-infrastructure',
  'generic-document', 'generic-text-artifact', 'mixed',
]);
const REVIEW_ROLES = Object.freeze(['classifier', 'standard', 'adversarial', 'traceability', 'synthesizer']);

function assertion(value) {
  return value === true || value === false ? value : 'unknown';
}

export function parseVersion(output) {
  const text = String(output || '').trim();
  if (!text) return '';
  const match = /(?:^|[^0-9])v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/u.exec(text);
  return match?.[1] || text.split(/\r?\n/u, 1)[0].trim();
}

export function detectEffortTransport(help, probeSucceeded = true) {
  if (!probeSucceeded) return 'unknown';
  const text = String(help || '');
  const flag = /(?:^|\s)(--(?:effort|thinking-effort|reasoning-effort))(?:[=\s,]|$)/imu.exec(text);
  if (flag) return `flag:${flag[1]}`;
  const environment = /\b(CLAUDE_(?:CODE_)?EFFORT(?:_LEVEL)?)\b/u.exec(text);
  if (environment) return `env:${environment[1]}`;
  return 'none';
}

function baseCapability({ adapterId, provider, available, version = '', invocationModes, roles = REVIEW_ROLES,
  assignmentRoles = ASSIGNMENT_ROLES,
  modelSelection, effortSelection, structuredOutput = true, background = true,
  readOnlyEnforcement = 'process-contract', customPrompt = true, inlinePayload = true, repoRead = true }) {
  return {
    protocol_version: CAPABILITY_PROTOCOL_VERSION,
    adapter_id: adapterId,
    provider,
    available,
    version,
    invocation_modes: invocationModes,
    target_kinds: [...ALL_TARGETS],
    roles: [...roles],
    assignment_roles: [...assignmentRoles],
    model_selection: modelSelection,
    effort_selection: effortSelection,
    structured_output: structuredOutput,
    background,
    read_only_enforcement: readOnlyEnforcement,
    custom_prompt: customPrompt,
    inline_payload: inlinePayload,
    repo_read: repoRead,
  };
}

function cliAvailable(detectedAvailable, probe) {
  if (!detectedAvailable) return false;
  if (probe?.ok === false) return false;
  if (probe?.ok === true) return true;
  return 'unknown';
}

export function buildCapabilities({ detected = {}, hostAssertions = {}, probes = {} } = {}) {
  const claudeProbe = probes.claude || {};
  const codexProbe = probes.codex || {};
  return [
    baseCapability({
      adapterId: 'claude-native-agent', provider: 'claude',
      available: assertion(hostAssertions.claudeNativeAgent), invocationModes: ['agent'],
      modelSelection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'agent-parameter' },
      effortSelection: { supported: false, levels: [], transport: 'none' },
      background: false, readOnlyEnforcement: 'agent-tool-allowlist',
    }),
    baseCapability({
      adapterId: 'claude-cli', provider: 'claude',
      available: cliAvailable(detected.claude_cli, claudeProbe),
      version: parseVersion(claudeProbe.version), invocationModes: ['generic-review', 'agent'],
      modelSelection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'flag:--model' },
      effortSelection: {
        supported: claudeProbe.ok === true
          ? detectEffortTransport(claudeProbe.help, true) !== 'none'
          : 'unknown',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        transport: detectEffortTransport(claudeProbe.help, claudeProbe.ok === true),
      },
    }),
    baseCapability({
      adapterId: 'codex-native-generic', provider: 'codex',
      available: assertion(hostAssertions.codexNativeGeneric), invocationModes: ['generic-review'],
      modelSelection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' },
      effortSelection: { supported: 'unknown', levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], transport: 'unknown' },
      background: false, readOnlyEnforcement: 'agent-tool-allowlist',
    }),
    baseCapability({
      adapterId: 'codex-companion', provider: 'codex', available: Boolean(detected.codex_plugin),
      version: '', invocationModes: ['code-review'], roles: ['standard', 'adversarial'],
      assignmentRoles: ['standard', 'adversarial'],
      modelSelection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' },
      effortSelection: { supported: false, levels: [], transport: 'none' },
      structuredOutput: false, readOnlyEnforcement: 'companion-read-only', inlinePayload: false,
    }),
    baseCapability({
      adapterId: 'agy-cli', provider: 'agy', available: Boolean(detected.agy_cli),
      version: parseVersion(detected.agy_version), invocationModes: ['generic-review'],
      roles: ['standard', 'adversarial'],
      modelSelection: { supported: true, aliases: [], catalog_complete: false, transport: 'config:agy_model' },
      effortSelection: { supported: false, levels: [], transport: 'none' },
      structuredOutput: false, readOnlyEnforcement: 'privacy-preflight',
    }),
  ];
}

function outputText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
}

async function runProbe(executable, args, options) {
  if (!executable) return { ok: false, error: 'not-detected' };
  try {
    const result = await options.run(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    return {
      ok: result.code === 0 && !result.timedOut,
      output: outputText(result.stdout),
      error: outputText(result.stderr),
      timed_out: Boolean(result.timedOut),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function probeCapabilities({ detected = {}, cwd = process.cwd(), env = process.env,
  run = runProcess, timeoutMs = 3000 } = {}) {
  const options = { cwd, env, run, timeoutMs };
  const [claudeVersion, claudeHelp, codexVersion] = await Promise.all([
    runProbe(detected.claude_cli_path, ['--version'], options),
    runProbe(detected.claude_cli_path, ['--help'], options),
    runProbe(detected.codex_cli_path, ['--version'], options),
  ]);
  return {
    claude: {
      ok: claudeVersion.ok && claudeHelp.ok,
      version: claudeVersion.output,
      help: claudeHelp.output,
      error: claudeVersion.error || claudeHelp.error,
    },
    codex: { ok: codexVersion.ok, version: codexVersion.output, error: codexVersion.error },
  };
}

export function capabilityCacheKeys(detected = {}, probes = {}) {
  const entries = {};
  for (const [name, pathKey, probeKey] of [
    ['claude', 'claude_cli_path', 'claude'],
    ['codex', 'codex_cli_path', 'codex'],
    ['agy', 'agy_cli_path', 'agy'],
  ]) {
    const executable = detected[pathKey];
    if (!executable) continue;
    let mtimeMs = null;
    try { mtimeMs = statSync(executable).mtimeMs; } catch { /* invalidates against a prior real file */ }
    entries[name] = {
      path: resolve(executable),
      mtime_ms: mtimeMs,
      version: parseVersion(probes[probeKey]?.version || (name === 'agy' ? detected.agy_version : '')),
    };
  }
  return entries;
}

function sameKeys(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function loadCapabilityCache(repoRoot, filePath, invalidationKeys) {
  try {
    const cache = JSON.parse(readContainedFile(repoRoot, filePath).toString('utf8'));
    if (cache.protocol_version !== CAPABILITY_PROTOCOL_VERSION
        || !Array.isArray(cache.capabilities)
        || !sameKeys(cache.invalidation_keys, invalidationKeys)) return null;
    if (cache.capabilities.some((item) => (
      item.protocol_version !== CAPABILITY_PROTOCOL_VERSION
      || !Array.isArray(item.assignment_roles)
    ))) return null;
    return cache.capabilities;
  } catch {
    return null;
  }
}

export function saveCapabilityCache(repoRoot, filePath, capabilities, invalidationKeys) {
  if (!Array.isArray(capabilities)) throw new TypeError('capabilities must be an array');
  // H8: codex-companion availability derives purely from detected.codex_plugin
  // (a different file than the keyed claude/codex/agy CLI paths+mtime), so a
  // cache hit would otherwise reuse a stale companion entry when the
  // companion is installed/removed without touching the keyed CLIs. It is a
  // free detection derivative like the native adapters below — never persist
  // it; the cache-hit merge in classify-artifacts.mjs rebuilds it fresh from
  // this run's detected values every time.
  const cacheable = capabilities.filter((item) => !['claude-native-agent', 'codex-native-generic', 'codex-companion'].includes(item.adapter_id));
  // Cache storage excludes host assertions. Return-time callers should rebuild
  // and inject native entries on every run rather than trusting this file.
  const document = {
    protocol_version: CAPABILITY_PROTOCOL_VERSION,
    invalidation_keys: invalidationKeys,
    capabilities: cacheable,
  };
  writeContainedFile(repoRoot, filePath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}
