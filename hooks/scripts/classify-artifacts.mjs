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
import { detectEnvironment } from './detect-environment.mjs';
import { CLASSIFICATION_VERSION } from './lib/target-taxonomy.mjs';

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
    if (artifact.needs_semantic) lines.push('   note: semantic classifier deferred to Phase 2');
  });
  lines.push('');
  lines.push('Routing: not yet implemented — model/effort routing arrives in Phase 2.');
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
    if (artifact.needs_semantic) {
      lines.push('  semantic: deferred to Phase 2 (deterministic confidence below the confirm threshold)');
    }
  }
  lines.push('');
  lines.push('Routing plan: not yet implemented.');
  lines.push('Model/effort routing (§13) and reviewer selection arrive in Phase 2;');
  lines.push('Phase 1 performs deterministic classification only.');
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

function parseArguments(argv) {
  const options = { repo: '.', explainRouting: false, format: 'text' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--explain-routing') {
      options.explainRouting = true;
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

export async function runClassifyArtifactsCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const repo = resolve(options.repo);

  let { changeState, reviewBase } = options;
  if (!changeState) {
    const environment = await detectEnvironment({ cwd: repo, env });
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

  const result = classifyArtifactsScope({
    repo, changeState, reviewBase, filesFromZ, generatedAt: deterministicTimestamp(env),
  });

  // Never persist an unresolved empty non-git scope, even if the target list
  // resolved to nothing (all excluded / out-of-repo / binary-only-dropped).
  if (changeState === 'non-git' && result.artifacts.length === 0) {
    throw new Error('non-git target list resolved to zero classifiable artifacts; nothing to write.');
  }

  const outPath = options.out ? resolve(options.out) : defaultProvenancePath(repo);
  writeProvenance(result, outPath);

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
