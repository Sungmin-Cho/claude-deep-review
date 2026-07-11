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
const CMD_META_CHARACTERS = /([()\][!^"`<>&|;, *?])/g;
const CMD_LITERAL_PERCENT_ENV = 'DEEP_REVIEW_CMD_LITERAL_PERCENT_4BFE8C1A';
const POSIX_TERMINATION_GRACE_MS = 100;
const POSIX_CLOSE_GRACE_MS = 100;

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

function escapeCmdMetacharacters(value) {
  return String(value)
    .replace(CMD_META_CHARACTERS, '^$1')
    // cmd expands percent variables once. Expanding this reserved variable to
    // a percent after tokenization preserves literal `%NAME%` without a
    // recursive environment-variable expansion pass.
    .replaceAll('%', `%${CMD_LITERAL_PERCENT_ENV}%`);
}

function escapeCmdCommand(value) {
  return escapeCmdMetacharacters(value);
}

function escapeCmdArgument(value) {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, '$1$1');
  escaped = `"${escaped}"`;
  return escapeCmdMetacharacters(escaped);
}

function cmdTransportEnvironment(env) {
  const transported = {};
  const reserved = CMD_LITERAL_PERCENT_ENV.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== reserved) transported[key] = value;
  }
  transported[CMD_LITERAL_PERCENT_ENV] = '%';
  return transported;
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
    env: cmdTransportEnvironment(env),
    windowsVerbatimArguments: true,
  };
}

function terminateWindowsProcessTree(child, env) {
  if (child.pid) {
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
  child.kill();
}

function signalPosixProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch {
      // The process exited between the group signal and direct fallback.
    }
  }
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
    let closeSeen = false;
    let closeCode;
    let closeSignal;
    let hardKillSent = false;

    const child = spawn(prepared.command, prepared.args, {
      cwd: options.cwd,
      env: prepared.env || env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      detached: !IS_WINDOWS,
    });

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      spawnError = error;
    });

    let timeout;
    let escalation;
    let closeFallback;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (closeFallback) clearTimeout(closeFallback);
      if (spawnError) stderr.push(Buffer.from(`${spawnError.message}\n`));
      resolveResult({
        code: timedOut ? 124 : (code ?? 127),
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        if (IS_WINDOWS) {
          terminateWindowsProcessTree(child, env);
          return;
        }

        signalPosixProcessGroup(child, 'SIGTERM');
        escalation = setTimeout(() => {
          hardKillSent = true;
          signalPosixProcessGroup(child, 'SIGKILL');
          if (closeSeen) {
            finish(closeCode, closeSignal);
            return;
          }
          closeFallback = setTimeout(
            () => finish(closeCode, closeSignal),
            POSIX_CLOSE_GRACE_MS,
          );
          closeFallback.unref();
        }, POSIX_TERMINATION_GRACE_MS);
        escalation.unref();
      }, options.timeoutMs);
      timeout.unref();
    }

    child.once('close', (code, signal) => {
      closeSeen = true;
      closeCode = code;
      closeSignal = signal;
      if (!timedOut || IS_WINDOWS || hardKillSent) finish(code, signal);
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
