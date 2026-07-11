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
const POSIX_GROUP_EXIT_POLL_MS = 10;
// A stuck process group must not keep a caller alive forever. This limit starts
// after SIGKILL; timing out reports that cleanup could not be confirmed.
const POSIX_GROUP_EXIT_HARD_DEADLINE_MS = 1000;
const POSIX_GROUP_EXIT_UNCONFIRMED_DIAGNOSTIC =
  'POSIX process group remained after SIGKILL; cleanup could not be confirmed before the hard deadline\n';

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

function isPosixProcessGroupGone(processGroupId) {
  if (!processGroupId) return false;
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
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
    let stdinError;
    let settled = false;
    let closeCode;
    let closeSignal;

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
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
        stdinError ??= error;
      }
    });

    let timeout;
    let escalation;
    let groupExitWait;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (groupExitWait) clearTimeout(groupExitWait);
      if (spawnError) stderr.push(Buffer.from(`${spawnError.message}\n`));
      if (stdinError) stderr.push(Buffer.from(`stdin error: ${stdinError.code || 'UNKNOWN'}\n`));
      resolveResult({
        code: timedOut ? 124 : (code ?? 127),
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };

    const waitForPosixProcessGroupExit = () => {
      const processGroupId = child.pid;
      if (!processGroupId) {
        stderr.push(Buffer.from(POSIX_GROUP_EXIT_UNCONFIRMED_DIAGNOSTIC));
        finish(closeCode, closeSignal);
        return;
      }

      const deadline = Date.now() + POSIX_GROUP_EXIT_HARD_DEADLINE_MS;
      const pollForExit = () => {
        if (isPosixProcessGroupGone(processGroupId)) {
          finish(closeCode, closeSignal);
          return;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          stderr.push(Buffer.from(POSIX_GROUP_EXIT_UNCONFIRMED_DIAGNOSTIC));
          finish(closeCode, closeSignal);
          return;
        }
        // Keep this timer referenced: resolving before ESRCH would let an
        // awaited caller exit while a detached descendant still survives.
        groupExitWait = setTimeout(
          pollForExit,
          Math.min(POSIX_GROUP_EXIT_POLL_MS, remainingMs),
        );
      };
      pollForExit();
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
          signalPosixProcessGroup(child, 'SIGKILL');
          waitForPosixProcessGroupExit();
        }, POSIX_TERMINATION_GRACE_MS);
      }, options.timeoutMs);
      timeout.unref();
    }

    child.once('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (!timedOut || IS_WINDOWS) finish(code, signal);
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
