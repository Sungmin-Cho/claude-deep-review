import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function detectRuntimeHost(env = process.env) {
  if (env.CODEX_HOME || env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDE_CODE || env.CLAUDE_PLUGIN_ROOT) return 'claude';
  return 'unknown';
}

export function resolvePluginRoot({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const configured = env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT;
  return configured
    ? resolve(configured)
    : fileURLToPath(new URL('../../..', moduleUrl));
}

export function atomicWriteFile(filePath, data, options = {}) {
  const normalized = typeof options === 'string' ? { encoding: options } : options;
  const destination = resolve(filePath);
  const parent = dirname(destination);
  const mode = normalized.mode ?? 0o600;
  const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
  let descriptor;

  mkdirSync(parent, { recursive: true });
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, data, normalized.encoding ? { encoding: normalized.encoding } : undefined);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    chmodSync(destination, mode);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function makeSecureTempPath(prefix, suffix = '') {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('prefix must be a non-empty string');
  }
  if (typeof suffix !== 'string') {
    throw new TypeError('suffix must be a string');
  }

  const safePrefix = basename(prefix).replace(/[^A-Za-z0-9._-]+/g, '-') || 'deep-review';
  const directory = mkdtempSync(join(tmpdir(), `${safePrefix}-`));
  chmodSync(directory, 0o700);
  return join(directory, `${safePrefix}-${randomUUID()}${suffix}`);
}
