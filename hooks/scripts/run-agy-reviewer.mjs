#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareAgyPrivacy } from './lib/agy-privacy.mjs';
import { captureFingerprint } from './lib/fingerprint.mjs';
import {
  estimateWindowsBatchCommandUnits,
  resolveExecutable,
  runProcess,
} from './lib/process.mjs';
import { atomicWriteFile, resolvePluginRoot } from './lib/runtime-context.mjs';

const BODY_LIMIT = 198_000;
const WINDOWS_CREATE_PROCESS_LIMIT = 32_767;
const WINDOWS_CMD_LIMIT = 8_191;
const WINDOWS_COMMAND_HEADROOM = 512;
const POSIX_PROMPT_ARGUMENT_LIMIT = 120 * 1024;
const READONLY_PREAMBLE = `READ-ONLY REVIEW MODE - ABSOLUTE, NON-NEGOTIABLE CONSTRAINT
============================================================
You are a code reviewer running in STRICT READ-ONLY mode. You MUST NOT modify
the workspace in ANY way. You are forbidden from creating, editing, deleting,
moving, renaming, staging, or committing files, and from running state-mutating
commands. Analyze and report in text only. Describe fixes in prose; never apply
them. Any workspace mutation invalidates this review.
============================================================
The review request follows below.
============================================================

`;
const AUTH_PATTERN = /Reauthentication required|do not currently have an active account|OAuth token expired|Please run.*agy.*login|Not signed in|Authentication failed/iu;
const UNSUPPORTED_MODEL_PATTERN = /unsupported[^\n]*(?:model|--model)|unknown[^\n]*(?:model|--model)|invalid[^\n]*model|unrecognized[^\n]*--model/iu;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9 ._/()-]+$/u;

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty NUL-free string`);
  }
  return value;
}

function positiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError('timeoutSeconds must be positive');
  return seconds;
}

function terminalStatus({ mutation, truncated, processResult }) {
  const stderr = processResult.stderr.toString('utf8');
  if (mutation) return 'mutated';
  if (truncated) return 'prompt_too_large';
  if (processResult.code === 124 || processResult.timedOut) return 'timeout';
  if (processResult.code !== 0 && AUTH_PATTERN.test(stderr)) return 'not_authenticated';
  if (processResult.code !== 0 || processResult.stdout.length === 0) return 'failed';
  return 'success';
}

function publishTerminalFiles(outputFile, processResult, status, warnings, mutationReason) {
  atomicWriteFile(outputFile, processResult.stdout, { mode: 0o600 });
  atomicWriteFile(`${outputFile}.status`, `${status}\n`, { encoding: 'utf8', mode: 0o600 });
  const stderrLines = processResult.stderr.toString('utf8').split(/\r?\n/u).filter(Boolean);
  const tail = [...warnings, ...stderrLines].slice(-5);
  atomicWriteFile(
    `${outputFile}.stderr-tail`,
    tail.length ? `${tail.join('\n')}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
  if (status === 'mutated') {
    atomicWriteFile(
      `${outputFile}.mutation-warning`,
      `mutated (${mutationReason || 'fingerprint drift'})\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } else {
    rmSync(`${outputFile}.mutation-warning`, { force: true });
  }
}

function fingerprintChanged(before, after) {
  if (before.error || after.error) return {
    changed: true,
    reason: before.error ? `pre-snapshot failed: ${before.error}` : `post-snapshot failed: ${after.error}`,
  };
  if (before.mode === 'off' && after.mode === 'off') return { changed: false, reason: '' };
  if (before.digest !== after.digest) return { changed: true, reason: 'fingerprint drift' };
  return { changed: false, reason: '' };
}

function processArguments({ promptContent, projectRoot, timeoutSeconds, model }) {
  const args = [
    '-p', promptContent,
    '--print-timeout', `${timeoutSeconds}s`,
    '--add-dir', projectRoot,
  ];
  if (model) args.push('--model', model);
  args.push('--dangerously-skip-permissions');
  return args;
}

export function windowsCommandLimit(binary) {
  return /\.(?:cmd|bat)$/iu.test(String(binary))
    ? WINDOWS_CMD_LIMIT
    : WINDOWS_CREATE_PROCESS_LIMIT;
}

export function estimateWindowsCommandUnits(binary, args) {
  if (/\.(?:cmd|bat)$/iu.test(String(binary))) {
    return estimateWindowsBatchCommandUnits(String(binary), args.map(String));
  }
  return (String(binary).length * 2) + 2 + args.reduce(
    (total, argument) => total + (String(argument).length * 2) + 3,
    0,
  );
}

function preparePromptTransport({ binary, body, projectRoot, timeoutSeconds, model, platform }) {
  const ordinaryLimit = Math.min(body.length, BODY_LIMIT);
  const build = (length) => {
    const promptContent = Buffer.concat([
      Buffer.from(READONLY_PREAMBLE),
      body.subarray(0, length),
    ]).toString('utf8');
    const args = processArguments({ promptContent, projectRoot, timeoutSeconds, model });
    return {
      args,
      promptContent,
      estimatedUnits: platform === 'win32'
        ? estimateWindowsCommandUnits(binary, args)
        : Buffer.byteLength(promptContent, 'utf8') + 1,
    };
  };

  const limit = platform === 'win32'
    ? windowsCommandLimit(binary)
    : POSIX_PROMPT_ARGUMENT_LIMIT;
  const budget = platform === 'win32'
    ? limit - WINDOWS_COMMAND_HEADROOM
    : limit;
  let low = 0;
  let high = ordinaryLimit;
  let best = build(0);
  if (best.estimatedUnits > budget) {
    return {
      ...best,
      safe: false,
      bodyBytes: 0,
      truncated: true,
      transportTruncated: true,
      limit,
    };
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(middle);
    if (candidate.estimatedUnits <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    ...best,
    safe: true,
    bodyBytes: high,
    truncated: body.length > high,
    transportTruncated: high < ordinaryLimit,
    limit,
  };
}

export async function runAgyReviewer(options = {}) {
  if (options.noAgy === true || options.codexOnly === true || options.enabled === false) {
    return {
      status: 'failed',
      attempted: false,
      privacyOutcome: 'skipped',
      code: null,
    };
  }

  const projectRoot = resolve(requiredString(options.projectRoot, 'projectRoot'));
  const pluginRoot = resolve(requiredString(options.pluginRoot, 'pluginRoot'));
  const promptFile = resolve(requiredString(options.promptFile, 'promptFile'));
  const outputFile = resolve(requiredString(options.outputFile, 'outputFile'));
  const configPath = resolve(options.configPath ?? join(projectRoot, '.deep-review', 'config.yaml'));
  const timeoutSeconds = positiveSeconds(options.timeoutSeconds ?? 900);
  const mode = options.mode ?? 'hybrid';
  const env = options.env ?? process.env;
  const warnings = [];
  const privacyPreparer = options.privacyPreparer ?? prepareAgyPrivacy;
  const fingerprintCapturer = options.fingerprintCapturer ?? captureFingerprint;
  const processRunner = options.processRunner ?? runProcess;

  const privacy = await privacyPreparer({
    repo: projectRoot,
    pluginRoot,
    configPath,
    approval: options.approval ?? 'auto',
    now: options.now,
  });
  if (!['auto_ack', 'acknowledged'].includes(privacy.outcome)) {
    return {
      status: 'failed',
      attempted: false,
      privacyOutcome: privacy.outcome,
      privacy,
      code: null,
    };
  }

  const binary = options.binary
    ? requiredString(options.binary, 'binary')
    : (resolveExecutable('agy', env) || 'agy');
  const body = readFileSync(promptFile);
  let model = options.model ?? '';
  if (typeof model !== 'string') throw new TypeError('model must be a string');
  if (model && !SAFE_MODEL_PATTERN.test(model)) {
    warnings.push('model contained unsupported characters and was omitted');
    model = '';
  }

  const before = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
  if (before.warning) warnings.push(before.warning);
  const finalPrivacy = await privacyPreparer({
    repo: projectRoot,
    pluginRoot,
    configPath,
    approval: 'auto',
    now: options.now,
  });
  if (
    !['auto_ack', 'acknowledged'].includes(finalPrivacy.outcome)
    || finalPrivacy.fingerprint !== privacy.fingerprint
  ) {
    return {
      status: 'failed',
      attempted: false,
      privacyOutcome: finalPrivacy.outcome,
      privacy: finalPrivacy,
      code: null,
    };
  }
  const promptTransport = preparePromptTransport({
    binary,
    body,
    projectRoot,
    timeoutSeconds,
    model,
    platform: options.platform ?? process.platform,
  });
  const truncated = promptTransport.truncated;
  if (body.length > BODY_LIMIT) {
    warnings.push(`prompt body exceeded ${BODY_LIMIT} bytes and was truncated`);
  }
  if (promptTransport.transportTruncated) {
    warnings.push('prompt body exceeded the safe host command-line argument budget and was truncated');
  }
  if (!promptTransport.safe) {
    const processResult = {
      code: 0,
      timedOut: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('host command-line argument budget is unavailable for the required arguments\n'),
    };
    const after = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
    const mutation = fingerprintChanged(before, after);
    const status = terminalStatus({ mutation: mutation.changed, truncated: true, processResult });
    publishTerminalFiles(outputFile, processResult, status, warnings, mutation.reason);
    return {
      status,
      attempted: false,
      privacyOutcome: finalPrivacy.outcome,
      code: null,
      timedOut: false,
      stdout: '',
      stderr: processResult.stderr.toString('utf8'),
      mutation: mutation.changed,
      mutationReason: mutation.reason,
      truncated: true,
      before,
      after,
    };
  }
  let processResult = await processRunner(
    binary,
    promptTransport.args,
    { cwd: projectRoot, env, timeoutMs: timeoutSeconds * 1000 },
  );
  const firstStderr = processResult.stderr.toString('utf8');
  let terminalPrivacy = finalPrivacy;
  if (
    model
    && processResult.code !== 0
    && processResult.code !== 124
    && !processResult.timedOut
    && !AUTH_PATTERN.test(firstStderr)
    && UNSUPPORTED_MODEL_PATTERN.test(firstStderr)
  ) {
    terminalPrivacy = await privacyPreparer({
      repo: projectRoot,
      pluginRoot,
      configPath,
      approval: 'auto',
      now: options.now,
    });
    if (
      ['auto_ack', 'acknowledged'].includes(terminalPrivacy.outcome)
      && terminalPrivacy.fingerprint === privacy.fingerprint
    ) {
      warnings.push(`agy rejected model ${model}; retried once without --model`);
      processResult = await processRunner(
        binary,
        processArguments({
          promptContent: promptTransport.promptContent,
          projectRoot,
          timeoutSeconds,
          model: '',
        }),
        { cwd: projectRoot, env, timeoutMs: timeoutSeconds * 1000 },
      );
    } else {
      warnings.push('agy model retry was blocked because privacy approval changed');
    }
  }
  const after = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
  if (after.warning && after.warning !== before.warning) warnings.push(after.warning);
  const mutation = fingerprintChanged(before, after);
  const status = terminalStatus({ mutation: mutation.changed, truncated, processResult });
  publishTerminalFiles(outputFile, processResult, status, warnings, mutation.reason);
  return {
    status,
    attempted: true,
    privacyOutcome: terminalPrivacy.outcome,
    code: processResult.code,
    timedOut: processResult.timedOut,
    stdout: processResult.stdout.toString('utf8'),
    stderr: processResult.stderr.toString('utf8'),
    mutation: mutation.changed,
    mutationReason: mutation.reason,
    truncated,
    before,
    after,
  };
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = {
      '--binary': 'binary',
      '--project-root': 'projectRoot',
      '--plugin-root': 'pluginRoot',
      '--config': 'configPath',
      '--prompt-file': 'promptFile',
      '--output': 'outputFile',
      '--mode': 'mode',
      '--model': 'model',
      '--approval': 'approval',
      '--timeout-seconds': 'timeoutSeconds',
    }[flag];
    if (!key || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${flag}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: run-agy-reviewer.mjs --binary FILE --project-root DIR --plugin-root DIR --prompt-file FILE --output FILE [--mode MODE] [--model MODEL] [--timeout-seconds N]\n');
    return;
  }
  options.pluginRoot ??= resolvePluginRoot();
  const result = await runAgyReviewer(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.attempted && result.code !== 0) process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`run-agy-reviewer.mjs: ${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  });
}

export const __testing = Object.freeze({
  BODY_LIMIT,
  POSIX_PROMPT_ARGUMENT_LIMIT,
  READONLY_PREAMBLE,
  estimateWindowsCommandUnits,
  fingerprintChanged,
  terminalStatus,
  windowsCommandLimit,
});
