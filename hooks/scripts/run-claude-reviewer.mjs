#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveExecutable, runProcess } from './lib/process.mjs';
import { atomicWriteFile, resolvePluginRoot } from './lib/runtime-context.mjs';
import { loadExecutionPlan } from './lib/execution-plan.mjs';

const AUTH_PATTERN = /Reauthentication required|do not currently have an active account|OAuth token expired|Please run.*claude.*login|Not signed in|Authentication failed/iu;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty NUL-free string`);
  }
  return value;
}

function positiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TypeError('timeoutSeconds must be positive');
  }
  return seconds;
}

function stderrTail(stderr) {
  return stderr.split(/\r?\n/u).filter(Boolean).slice(-5).join('\n');
}

function classify(result) {
  const stderr = result.stderr.toString('utf8');
  if (result.code === 124 || result.timedOut) return 'timeout';
  if (result.code !== 0 && AUTH_PATTERN.test(stderr)) return 'not_authenticated';
  if (result.code !== 0 || result.stdout.length === 0) return 'failed';
  return 'success';
}

function publishResult(outputFile, result, status) {
  atomicWriteFile(outputFile, result.stdout, { mode: 0o600 });
  atomicWriteFile(`${outputFile}.status`, `${status}\n`, { encoding: 'utf8', mode: 0o600 });
  const tail = stderrTail(result.stderr.toString('utf8'));
  atomicWriteFile(
    `${outputFile}.stderr-tail`,
    tail ? `${tail}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function runClaudeReviewer(options = {}) {
  const projectRoot = resolve(requiredString(options.projectRoot, 'projectRoot'));
  const pluginRoot = resolve(requiredString(options.pluginRoot, 'pluginRoot'));
  const promptFile = resolve(requiredString(options.promptFile, 'promptFile'));
  const outputFile = resolve(requiredString(options.outputFile, 'outputFile'));
  const executionPlan = options.executionPlan || null;
  // H4B: when an execution plan is supplied, its resolved model is
  // authoritative — including null (provider default). The legacy
  // options.model ?? 'opus' only applies when no plan is present; it must
  // never resurrect a stale model once a plan deliberately resolved to null.
  // Mirrors the agy fix (d0459e9) in run-agy-reviewer.mjs.
  const model = executionPlan
    ? (executionPlan.model ?? '')
    : requiredString(options.model ?? 'opus', 'model');
  if (typeof model !== 'string') throw new TypeError('model must be a string');
  const agent = requiredString(options.agent ?? 'code-reviewer', 'agent');
  const timeoutSeconds = positiveSeconds(options.timeoutSeconds ?? 1200);
  const env = { ...(options.env ?? process.env) };
  const processRunner = options.processRunner ?? runProcess;
  const binary = options.binary
    ? requiredString(options.binary, 'binary')
    : (resolveExecutable('claude', env) || 'claude');
  const prompt = readFileSync(promptFile);

  const args = [
    '-p',
    '--plugin-dir', pluginRoot,
    '--agent', agent,
  ];
  if (model) args.push('--model', model);
  let resolvedEffort = executionPlan?.effort ?? null;
  let executionFallback = null;
  if (resolvedEffort) {
    const effortTransport = executionPlan.effortTransport || 'unknown';
    if (effortTransport.startsWith('flag:')) {
      args.push(effortTransport.slice('flag:'.length), resolvedEffort);
    } else if (effortTransport.startsWith('env:')) {
      env[effortTransport.slice('env:'.length)] = resolvedEffort;
    } else if (executionPlan.source?.startsWith('cli-') && !executionPlan.allowFallback) {
      throw new Error('ERROR_EFFORT_TRANSPORT_UNAVAILABLE: explicit effort cannot be sent to Claude CLI');
    } else {
      executionFallback = {
        occurred: true,
        requested: { effort: resolvedEffort },
        applied: { effort: null },
        reason: 'effort transport unavailable; effort omitted',
      };
      resolvedEffort = null;
    }
  }
  args.push(
    '--permission-mode', 'dontAsk',
    '--add-dir', projectRoot,
    '--tools', 'Read,Glob,Grep,Bash',
    '--output-format', 'text',
  );
  const processResult = await processRunner(binary, args, {
    cwd: projectRoot,
    env,
    input: prompt,
    timeoutMs: timeoutSeconds * 1000,
  });
  const status = classify(processResult);
  publishResult(outputFile, processResult, status);
  return {
    status,
    code: processResult.code,
    timedOut: processResult.timedOut,
    stdout: processResult.stdout.toString('utf8'),
    stderr: processResult.stderr.toString('utf8'),
    outputFile,
    requested_model: executionPlan?.requestedModel ?? executionPlan?.model ?? (model || null),
    resolved_model: model || null,
    applied_model: null,
    requested_effort: executionPlan?.requestedEffort ?? executionPlan?.effort ?? null,
    resolved_effort: resolvedEffort,
    applied_effort: null,
    verification_status: executionFallback ? 'fallback' : 'provider-did-not-report',
    fallback: executionFallback || executionPlan?.routingFallback || { occurred: false },
  };
}

export function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = {
      '--project-root': 'projectRoot',
      '--plugin-root': 'pluginRoot',
      '--prompt-file': 'promptFile',
      '--output': 'outputFile',
      '--model': 'model',
      '--agent': 'agent',
      '--timeout-seconds': 'timeoutSeconds',
      '--timeout': 'timeoutSeconds',
      '--binary': 'binary',
      '--routing-plan': 'routingPlan',
      '--reviewer-id': 'reviewerId',
    }[flag];
    if (!key || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${flag}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  if (Boolean(values.routingPlan) !== Boolean(values.reviewerId)) {
    throw new Error('--routing-plan and --reviewer-id must be provided together');
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: run-claude-reviewer.mjs --project-root DIR --plugin-root DIR --prompt-file FILE --output FILE [--model MODEL] [--routing-plan FILE --reviewer-id ID] [--agent NAME] [--timeout-seconds N]\n');
    return;
  }
  options.pluginRoot ??= resolvePluginRoot();
  if (options.routingPlan) options.executionPlan = loadExecutionPlan(options.routingPlan, options.reviewerId);
  const result = await runClaudeReviewer(options);
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`run-claude-reviewer.mjs: ${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  });
}
