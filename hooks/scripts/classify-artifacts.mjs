#!/usr/bin/env node
// Artifact-aware routing — Phase 1 dry-run / explain executor.
//
// Discovers the current git change scope, classifies each artifact with the
// deterministic classifier, prints the §15.7 dry-run listing (or the §19.3
// explain view), and writes classification provenance JSON under
// `.deep-review/tmp/` for later phases to consume.
//
// This module NEVER executes a reviewer. It imports only discovery,
// classification, and environment detection — deliberately not any
// `run-*-reviewer` runner. That structural boundary is what makes `--dry-run`
// safe: there is no reviewer code path to reach.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyArtifact, classifyScope } from './lib/artifact-classify.mjs';
import { discoverArtifacts } from './lib/artifact-discover.mjs';
import { readArtifactWindows } from './lib/artifact-discover.mjs';
import {
  classifyWithSemantic,
  createClaudeCliSemanticAdapter,
  createSemanticCache,
  selectSemanticAdapter,
} from './lib/semantic-classify.mjs';
import { detectEnvironment } from './detect-environment.mjs';
import { CLASSIFICATION_VERSION } from './lib/target-taxonomy.mjs';
import {
  buildCapabilities,
  probeCapabilities,
} from './lib/capability-registry.mjs';
import { buildRoutingPlan, renderRoutingExplanation } from './lib/model-router.mjs';
import {
  loadReviewPolicy,
  loadUserConfig,
  mergeRoutingConfig,
} from './lib/review-policy.mjs';
import { atomicWriteFile } from './lib/runtime-context.mjs';

const SIGNAL_LABELS = {
  frontmatter: 'frontmatter',
  filename: 'filename',
  path: 'path',
  title: 'title',
  heading: 'headings',
  keyword: 'keywords',
  'code-extension': 'code extension',
  'git-diff': 'git diff',
};

function signalSummary(classification) {
  // Code/binary carry a ready-made human source phrase.
  if (/^(?:code extension|binary)/.test(classification.source)) return classification.source;
  const labels = [];
  for (const signal of classification.signals) {
    if (signal.weight <= 0) continue; // skip contradiction/negative markers
    const label = SIGNAL_LABELS[signal.type];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join(' + ') : classification.source;
}

function formatConfidence(value) {
  return value.toFixed(2);
}

/**
 * Classify every artifact in the given change scope.
 * Synchronous: the caller supplies `changeState` (and `reviewBase` for `clean`).
 */
export function classifyArtifactsScope(options = {}) {
  const {
    repo, changeState, reviewBase = '', filesFromZ, thresholds, generatedAt,
  } = options;
  const descriptors = discoverArtifacts({ repo, changeState, reviewBase, filesFromZ });

  const artifacts = descriptors.map((descriptor) => {
    const classification = classifyArtifact({
      path: descriptor.path,
      extension: descriptor.extension,
      content: descriptor.content,
      isBinary: descriptor.is_binary,
      gitStatus: descriptor.git_status,
      thresholds,
    });
    return {
      artifact_id: descriptor.artifact_id,
      path: descriptor.path,
      target_kind: classification.target_kind,
      confidence: classification.confidence,
      source: classification.source,
      needs_semantic: classification.needs_semantic,
      signal_summary: signalSummary(classification),
      signals: classification.signals,
      alternatives: classification.alternatives,
    };
  });

  return {
    classification_version: CLASSIFICATION_VERSION,
    generated_at: generatedAt ?? new Date().toISOString(),
    scope: classifyScope(artifacts),
    artifacts,
  };
}

/** Async additive orchestration. The synchronous Phase 1 export above remains unchanged. */
export async function classifyArtifactsScopeWithSemantic(options = {}) {
  const deterministic = classifyArtifactsScope(options);
  const descriptors = discoverArtifacts(options);
  const descriptorByPath = new Map(descriptors.map((descriptor) => [descriptor.path, descriptor]));
  const cache = options.semanticCache || createSemanticCache();
  const semanticAdapter = options.semanticAdapter
    || selectSemanticAdapter(options.capabilities, options.semanticAdapters);
  const artifacts = [];
  for (const artifact of deterministic.artifacts) {
    const descriptor = descriptorByPath.get(artifact.path);
    if (!artifact.needs_semantic) {
      artifacts.push({ ...artifact, semantic_status: 'not-needed' });
      continue;
    }
    let semanticDescriptor = descriptor;
    try {
      semanticDescriptor = {
        ...descriptor,
        semantic_windows: readArtifactWindows(descriptor, {
          repoRoot: resolve(options.repo),
          maxBytes: options.maxClassifierBytes || 24_576,
        }),
        sibling_paths: descriptors.filter((item) => item.path !== descriptor.path).map((item) => item.path),
      };
    } catch {
      artifacts.push({
        ...artifact,
        semantic_status: 'failed',
        semantic_error: 'artifact containment revalidation failed during bounded window read',
      });
      continue;
    }
    artifacts.push(await classifyWithSemantic({
      descriptor: semanticDescriptor,
      classification: artifact,
      pluginRoot: options.pluginRoot,
      adapter: semanticAdapter,
      timeoutMs: options.semanticTimeoutMs,
      maxBytes: options.maxClassifierBytes,
      thresholds: options.thresholds,
      cache,
    }));
  }
  return { ...deterministic, scope: classifyScope(artifacts), artifacts };
}

/**
 * §15.7 dry-run listing. Routing itself is Phase 2, so the "routing" section is
 * an honest deferral rather than a fabricated plan.
 */
export function formatDryRun(result) {
  const lines = [`Detected scope: ${result.scope}`, '', 'Artifacts:'];
  result.artifacts.forEach((artifact, index) => {
    lines.push(`${index + 1}. ${artifact.path}`);
    lines.push(`   kind: ${artifact.target_kind}`);
    lines.push(`   confidence: ${formatConfidence(artifact.confidence)}`);
    lines.push(`   source: ${artifact.signal_summary}`);
    if (artifact.semantic_status) lines.push(`   semantic: ${artifact.semantic_status}`);
    else if (artifact.needs_semantic) lines.push('   semantic: deferred (use --allow-classifier to opt in)');
  });
  lines.push('');
  lines.push(renderRoutingExplanation(result.routing_plan || {
    routing_policy: 'auto', shadow_mode: true, routes: [],
  }).trimEnd());
  return `${lines.join('\n')}\n`;
}

/**
 * §19.3 explain view. Same classification, with an explicit statement that
 * routing is not yet wired.
 */
export function formatExplainRouting(result) {
  const lines = [`Detected scope: ${result.scope}`, ''];
  for (const artifact of result.artifacts) {
    lines.push(`${artifact.path} → ${artifact.target_kind} (confidence ${formatConfidence(artifact.confidence)})`);
    lines.push(`  signals: ${artifact.signal_summary}`);
    lines.push(`  semantic: ${artifact.semantic_status || (artifact.needs_semantic ? 'deferred' : 'not-needed')}`);
  }
  lines.push('');
  lines.push(renderRoutingExplanation(result.routing_plan || {
    routing_policy: 'auto', shadow_mode: true, routes: [],
  }).trimEnd());
  return `${lines.join('\n')}\n`;
}

function defaultProvenancePath(repo) {
  return resolve(repo, '.deep-review', 'tmp', 'artifact-classification.json');
}

export function writeProvenance(result, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return outPath;
}

const VALUE_FLAGS = {
  '--repo': 'repo',
  '--change-state': 'changeState',
  '--review-base': 'reviewBase',
  '--out': 'out',
  '--format': 'format',
  '--files-from0': 'filesFrom',
  '--routing-plan-out': 'routingPlanOut',
};

// I3: allow provenance to be byte-identical across runs when a caller pins the
// timestamp via SOURCE_DATE_EPOCH (reproducible-builds convention). Unset ⇒
// wall-clock time as before.
function deterministicTimestamp(env) {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function validateOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--overrides-json must decode to an object');
  if (value.protocol_version !== '2.0') throw new Error('--overrides-json protocol_version must be "2.0"');
  for (const field of ['allow_fallback', 'allow_classifier']) {
    if (typeof value[field] !== 'boolean') throw new Error(`--overrides-json ${field} must be boolean`);
  }
  if (!['auto', 'fast', 'balanced', 'quality'].includes(value.routing_policy)) {
    throw new Error('--overrides-json routing_policy is invalid');
  }
  if (!value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)
      || !value.reviewers || typeof value.reviewers !== 'object' || Array.isArray(value.reviewers)) {
    throw new Error('--overrides-json providers and reviewers must be objects');
  }
  return value;
}

export function parseArguments(argv) {
  const options = { repo: '.', explainRouting: false, emitRoutingPlan: false, format: 'text' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--explain-routing') {
      options.explainRouting = true;
      continue;
    }
    if (argument === '--emit-routing-plan') {
      options.emitRoutingPlan = true;
      continue;
    }
    if (argument === '--overrides-json') {
      const raw = argv[index + 1];
      if (raw === undefined) throw new Error('--overrides-json requires a value');
      try {
        options.overrides = validateOverrides(JSON.parse(raw));
      } catch (error) {
        if (error.message.startsWith('--overrides-json')) throw error;
        throw new Error(`--overrides-json must contain valid JSON: ${error.message}`);
      }
      index += 1;
      continue;
    }
    const key = VALUE_FLAGS[argument];
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!['text', 'json'].includes(options.format)) throw new Error('--format must be text or json');
  return options;
}

function defaultRoutingPlanPath(repo) {
  return resolve(repo, '.deep-review', 'tmp', 'routing-plan.json');
}

function defaultReviewers(capabilities) {
  const reviewers = [];
  const has = (adapterId) => capabilities.some((item) => item.adapter_id === adapterId && item.available === true);
  if (has('claude-native-agent')) reviewers.push({ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-native-agent' });
  else if (has('claude-cli')) reviewers.push({ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' });
  if (has('codex-native-generic')) reviewers.push({ id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' });
  else if (has('codex-companion')) reviewers.push({ id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-companion' });
  if (has('codex-companion')) reviewers.push({ id: 'codex-adversarial', provider: 'codex', role: 'adversarial', adapter_id: 'codex-companion' });
  if (has('agy-cli')) reviewers.push({ id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' });
  return reviewers;
}

function hasExecutionOverride(overrides) {
  return Boolean(overrides && (
    Object.values(overrides.providers || {}).some((value) => value.model !== undefined || value.effort !== undefined)
    || Object.values(overrides.reviewers || {}).some((value) => value.model !== undefined || value.effort !== undefined)
  ));
}

export function routingPreflightDecision({ explicit, error } = {}) {
  if (error) return explicit ? { action: 'stop', error: error.message } : { action: 'continue', warning: error.message };
  return explicit ? { action: 'apply', error: null } : { action: 'shadow', error: null };
}

async function routingInputs(repo, env, runtime, knownEnvironment) {
  if (runtime.capabilities) return {
    capabilities: runtime.capabilities,
    reviewers: runtime.reviewers || defaultReviewers(runtime.capabilities),
    detected: runtime.detected,
  };
  const detected = knownEnvironment || await detectEnvironment({ cwd: repo, env });
  const probes = runtime.probes || await probeCapabilities({ detected, cwd: repo, env });
  const capabilities = buildCapabilities({
    detected,
    probes,
    hostAssertions: runtime.hostAssertions,
  });
  return { capabilities, reviewers: runtime.reviewers || defaultReviewers(capabilities), detected };
}

function routingPolicy(repo, env, overrides, runtime) {
  const defaults = {
    features: { semantic_classifier: true, automatic_model_routing: true, routing_shadow_mode: true },
    routing: { policy: 'auto', allow_fallback: false, require_read_only: true },
    providers: {}, constraints: {}, classification: {},
  };
  const user = runtime.userPolicy ?? loadUserConfig(env)?.policy ?? {};
  const project = runtime.projectPolicy ?? loadReviewPolicy(repo)?.policy ?? {};
  const merged = mergeRoutingConfig({ defaults, user, project, cli: overrides });
  return { ...merged, user, project };
}

export async function runClassifyArtifactsCli(argv = process.argv.slice(2), env = process.env, runtime = {}) {
  const options = parseArguments(argv);
  const repo = resolve(options.repo);

  let { changeState, reviewBase } = options;
  let environment;
  if (!changeState) {
    environment = await detectEnvironment({ cwd: repo, env });
    changeState = environment.change_state;
    reviewBase = reviewBase ?? environment.review_base;
  }

  // Explicit NUL-delimited target list (git `--pathspec-file-nul` convention).
  const filesFromZ = options.filesFrom === undefined
    ? undefined
    : readFileSync(resolve(options.filesFrom));
  const hasExplicitTargets = filesFromZ !== undefined && filesFromZ.length > 0;

  // W2: a non-git workspace has no diff to derive a scope from. Refuse to
  // materialize an empty `mixed` provenance file — require an explicit target
  // list and fail closed otherwise.
  if (changeState === 'non-git' && !hasExplicitTargets) {
    throw new Error(
      'non-git workspace has no git change scope to classify. '
      + 'Provide an explicit NUL-delimited target list via --files-from0 <file>.',
    );
  }

  const classificationOptions = {
    repo, changeState, reviewBase, filesFromZ, generatedAt: deterministicTimestamp(env),
  };
  const { capabilities, reviewers, detected } = await routingInputs(repo, env, runtime, environment);
  const policy = routingPolicy(repo, env, options.overrides, runtime);
  const semanticAdapters = { ...(runtime.semanticAdapters || {}) };
  const claudeCapability = capabilities.find((item) => item.adapter_id === 'claude-cli' && item.available === true);
  if (!semanticAdapters['claude-cli'] && detected?.claude_cli_path && claudeCapability) {
    semanticAdapters['claude-cli'] = createClaudeCliSemanticAdapter({
      binary: detected.claude_cli_path,
      cwd: repo,
      env,
      model: claudeCapability.model_selection?.aliases?.[0],
      effort: 'low',
      effortTransport: claudeCapability.effort_selection?.transport,
    });
  }
  const semanticEnabled = policy.features?.semantic_classifier !== false
    && (options.emitRoutingPlan || options.overrides?.allow_classifier);
  let result = semanticEnabled
    ? await classifyArtifactsScopeWithSemantic({
      ...classificationOptions,
      pluginRoot: runtime.pluginRoot,
      capabilities,
      semanticAdapters,
      semanticAdapter: runtime.semanticAdapter,
    })
    : classifyArtifactsScope(classificationOptions);

  // Never persist an unresolved empty non-git scope, even if the target list
  // resolved to nothing (all excluded / out-of-repo / binary-only-dropped).
  if (changeState === 'non-git' && result.artifacts.length === 0) {
    throw new Error('non-git target list resolved to zero classifiable artifacts; nothing to write.');
  }

  result = {
    ...result,
    artifacts: result.artifacts.map((artifact) => ({
      ...artifact,
      semantic_status: artifact.semantic_status || (artifact.needs_semantic ? 'deferred' : 'not-needed'),
    })),
  };

  const overrides = options.overrides || {
    protocol_version: '2.0', routing_policy: policy.routing?.policy || 'auto',
    allow_fallback: Boolean(policy.routing?.allow_fallback), allow_classifier: false,
    providers: {}, reviewers: {},
  };
  const explicit = hasExecutionOverride(overrides);
  for (const provider of Object.keys(overrides.providers || {})) {
    if (explicit && !reviewers.some((reviewer) => reviewer.provider === provider)) {
      throw new Error(`ERROR_PROVIDER_UNAVAILABLE: no eligible reviewer for explicit ${provider} override`);
    }
  }
  for (const reviewerId of Object.keys(overrides.reviewers || {})) {
    if (!reviewers.some((reviewer) => reviewer.id === reviewerId)) {
      throw new Error(`ERROR_PROVIDER_UNAVAILABLE: explicit reviewer ${reviewerId} is not eligible`);
    }
  }
  const routingPlan = buildRoutingPlan({ artifacts: result.artifacts, reviewers, policy, overrides, capabilities });
  routingPlan.explicit_overrides = explicit;
  routingPlan.apply_automatic = policy.features?.automatic_model_routing === true
    && policy.features?.routing_shadow_mode === false;
  result = { ...result, routing_plan: routingPlan };

  const outPath = options.out ? resolve(options.out) : defaultProvenancePath(repo);
  writeProvenance(result, outPath);

  if (options.emitRoutingPlan) {
    const routingPlanPath = options.routingPlanOut ? resolve(options.routingPlanOut) : defaultRoutingPlanPath(repo);
    atomicWriteFile(routingPlanPath, `${JSON.stringify(routingPlan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(options.explainRouting ? formatExplainRouting(result) : formatDryRun(result));
  }
  return result;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  runClassifyArtifactsCli().catch((error) => {
    process.stderr.write(`classify-artifacts: ${error.message}\n`);
    process.exitCode = 2;
  });
}
