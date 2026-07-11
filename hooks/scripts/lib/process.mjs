import {
  accessSync,
  constants,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function environmentValue(env, name) {
  if (!IS_WINDOWS) return env[name];

  let value;
  const wanted = name.toLowerCase();
  for (const [key, candidate] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) value = candidate;
  }
  return value;
}

function isExecutableFile(filePath) {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (!IS_WINDOWS) accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(name, env) {
  if (!IS_WINDOWS || extname(name)) return [name];
  const pathExt = environmentValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  return pathExt
    .split(';')
    .filter(Boolean)
    .map((extension) => `${name}${extension}`);
}

export function resolveExecutable(name, env = process.env) {
  if (typeof name !== 'string' || name.length === 0) return null;

  const hasPathSeparator = name.includes('/') || name.includes('\\');
  const names = executableNames(name, env);
  if (isAbsolute(name) || hasPathSeparator) {
    for (const candidate of names) {
      const filePath = isAbsolute(candidate) ? candidate : resolve(candidate);
      if (isExecutableFile(filePath)) return filePath;
    }
    return null;
  }

  const pathValue = environmentValue(env, 'PATH');
  if (!pathValue) return null;
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, '') || '.';
    for (const candidate of names) {
      const filePath = join(directory, candidate);
      if (isExecutableFile(filePath)) return filePath;
    }
  }
  return null;
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META_CHARACTERS, '^$1');
}

function escapeCmdArgument(value) {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, '$1$1');
  escaped = `"${escaped}"`;
  return escaped.replace(CMD_META_CHARACTERS, '^$1');
}

function prepareSpawn(command, args, env) {
  const resolved = resolveExecutable(command, env) || command;
  if (!IS_WINDOWS || !/\.(?:cmd|bat)$/i.test(resolved)) {
    return {
      command: resolved,
      args,
      windowsVerbatimArguments: false,
    };
  }

  const comSpec = environmentValue(env, 'ComSpec')
    || environmentValue(process.env, 'ComSpec')
    || 'cmd.exe';
  const shellCommand = [
    escapeCmdCommand(resolved),
    ...args.map(escapeCmdArgument),
  ].join(' ');
  return {
    command: comSpec,
    args: ['/d', '/v:off', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

function terminateProcessTree(child, env) {
  if (IS_WINDOWS && child.pid) {
    const taskkill = resolveExecutable('taskkill.exe', env) || 'taskkill.exe';
    const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
      env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
}

export function runProcess(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    return Promise.reject(new TypeError('command must be a non-empty string'));
  }
  if (!Array.isArray(args)) {
    return Promise.reject(new TypeError('args must be an array'));
  }

  const env = options.env ?? process.env;
  const prepared = prepareSpawn(command, args.map(String), env);
  return new Promise((resolveResult) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let spawnError;
    let settled = false;

    const child = spawn(prepared.command, prepared.args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
    });

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      spawnError = error;
    });

    let timeout;
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, env);
      }, options.timeoutMs);
      timeout.unref();
    }

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (spawnError) stderr.push(Buffer.from(`${spawnError.message}\n`));
      resolveResult({
        code: timedOut ? 124 : (code ?? 127),
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
