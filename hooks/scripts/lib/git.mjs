import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveExecutable, runProcess } from './process.mjs';

function assertGitArguments(repo, args) {
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new TypeError('repo must be a non-empty string');
  }
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
}

function gitCommand(options, env) {
  return options.gitBinary || resolveExecutable('git', env) || 'git';
}

export function git(repo, args, options = {}) {
  assertGitArguments(repo, args);
  const env = options.env ?? process.env;
  return runProcess(
    gitCommand(options, env),
    ['-C', resolve(repo), ...args.map(String)],
    {
      cwd: options.cwd,
      env,
      input: options.input,
      timeoutMs: options.timeoutMs,
    },
  );
}

export function gitSync(repo, args, options = {}) {
  assertGitArguments(repo, args);
  const env = options.env ?? process.env;
  const result = spawnSync(
    gitCommand(options, env),
    ['-C', resolve(repo), ...args.map(String)],
    {
      cwd: options.cwd,
      env,
      input: options.input,
      encoding: null,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      shell: false,
      timeout: options.timeoutMs,
      windowsHide: true,
    },
  );
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const spawnError = result.error && !timedOut;
  return {
    code: timedOut ? 124 : (spawnError ? 127 : (result.status ?? 127)),
    signal: result.signal,
    timedOut,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.concat([
      Buffer.from(result.stderr ?? []),
      spawnError ? Buffer.from(`${result.error.message}\n`) : Buffer.alloc(0),
    ]),
  };
}

export function splitNul(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) fields.push(buffer.subarray(start));
  return fields;
}

function utf8SequenceLength(buffer, index) {
  const first = buffer[index];
  if (first < 0x80) return 1;

  const second = buffer[index + 1];
  const third = buffer[index + 2];
  const fourth = buffer[index + 3];
  const continuation = (byte) => byte >= 0x80 && byte <= 0xbf;

  if (first >= 0xc2 && first <= 0xdf && continuation(second)) return 2;
  if (
    first === 0xe0
    && second >= 0xa0 && second <= 0xbf
    && continuation(third)
  ) return 3;
  if (
    ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef))
    && continuation(second)
    && continuation(third)
  ) return 3;
  if (
    first === 0xed
    && second >= 0x80 && second <= 0x9f
    && continuation(third)
  ) return 3;
  if (
    first === 0xf0
    && second >= 0x90 && second <= 0xbf
    && continuation(third)
    && continuation(fourth)
  ) return 4;
  if (
    first >= 0xf1 && first <= 0xf3
    && continuation(second)
    && continuation(third)
    && continuation(fourth)
  ) return 4;
  if (
    first === 0xf4
    && second >= 0x80 && second <= 0x8f
    && continuation(third)
    && continuation(fourth)
  ) return 4;
  return 0;
}

export function decodeGitPath(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  let decoded = '';
  for (let index = 0; index < buffer.length;) {
    const length = utf8SequenceLength(buffer, index);
    if (length > 0) {
      decoded += buffer.subarray(index, index + length).toString('utf8');
      index += length;
      continue;
    }
    const byte = buffer[index];
    decoded += String.fromCharCode(0xdc00 + byte);
    index += 1;
  }
  return decoded;
}

export function encodeGitPath(value) {
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  const encoded = [];
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xdc80 && unit <= 0xdcff) {
      encoded.push(Buffer.from([unit - 0xdc00]));
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encoded.push(Buffer.from(value.slice(index, index + 2), 'utf8'));
        index += 1;
        continue;
      }
    }
    encoded.push(Buffer.from(value[index], 'utf8'));
  }
  return Buffer.concat(encoded);
}

export function parsePorcelainV1Z(buffer) {
  const fields = splitNul(buffer);
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 3) continue;
    const indexStatus = String.fromCharCode(field[0]);
    const workTreeStatus = String.fromCharCode(field[1]);
    const record = {
      index: indexStatus,
      workTree: workTreeStatus,
      path: decodeGitPath(field.subarray(3)),
    };
    if (/[RC]/.test(indexStatus) || /[RC]/.test(workTreeStatus)) {
      index += 1;
      if (index >= fields.length) {
        throw new Error('truncated porcelain rename/copy record');
      }
      record.originalPath = decodeGitPath(fields[index]);
    }
    records.push(record);
  }
  return records;
}
