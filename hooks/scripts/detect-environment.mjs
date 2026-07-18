import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectRuntimeHost, resolvePluginRoot } from './lib/runtime-context.mjs';
import { resolveExecutable, runProcess } from './lib/process.mjs';
import { git, parsePorcelainV1Z } from './lib/git.mjs';

const AGY_VERSION_TIMEOUT_MS = 3000;
const EMPTY_GIT_FIELDS = Object.freeze({
  staged: 0,
  unstaged: 0,
  untracked: 0,
  has_untracked: false,
  review_base: '',
  review_base_method: '',
  is_shallow: false,
});

function firstLine(buffer) {
  return buffer.toString('utf8').split(/\r?\n/, 1)[0].trim();
}

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

function compareCompanions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left.version[key] !== right.version[key]) {
      return left.version[key] - right.version[key];
    }
  }
  if (Boolean(left.version.prerelease) !== Boolean(right.version.prerelease)) {
    return left.version.prerelease ? -1 : 1;
  }
  if (left.version.prerelease !== right.version.prerelease) {
    return left.version.prerelease < right.version.prerelease ? -1 : 1;
  }
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function collectCompanions(cacheRoot) {
  if (!cacheRoot) return [];
  const versionRoot = join(cacheRoot, 'plugins', 'cache', 'openai-codex', 'codex');
  let entries;
  try {
    entries = readdirSync(versionRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const version = parseSemver(entry.name);
    if (!version) continue;
    const filePath = join(versionRoot, entry.name, 'scripts', 'codex-companion.mjs');
    if (isRegularFile(filePath)) candidates.push({ path: filePath, version });
  }
  return candidates;
}

function findCodexCompanion(env) {
  if (env.CODEX_COMPANION_PATH && isRegularFile(env.CODEX_COMPANION_PATH)) {
    return resolve(env.CODEX_COMPANION_PATH);
  }
  const home = env.HOME || env.USERPROFILE;
  const candidates = [
    ...collectCompanions(env.CODEX_HOME),
    ...collectCompanions(home ? join(home, '.claude') : ''),
  ];
  candidates.sort(compareCompanions);
  return candidates.at(-1)?.path || '';
}

async function detectAvailability(cwd, env) {
  const claudePath = resolveExecutable('claude', env) || '';
  const codexPath = resolveExecutable('codex', env) || '';
  const agyPath = resolveExecutable('agy', env) || '';
  const companionPath = findCodexCompanion(env);
  let agyVersion = '';
  if (agyPath) {
    const version = await runProcess(agyPath, ['--version'], {
      cwd,
      env,
      timeoutMs: AGY_VERSION_TIMEOUT_MS,
    });
    if (version.code === 0 && !version.timedOut) agyVersion = firstLine(version.stdout);
  }
  return {
    node_available: true,
    node_path: process.execPath,
    claude_cli: Boolean(claudePath),
    claude_cli_path: claudePath,
    codex_plugin: Boolean(companionPath),
    codex_companion_path: companionPath,
    codex_cli: Boolean(codexPath),
    codex_cli_path: codexPath,
    codex_installed: Boolean(companionPath || codexPath),
    agy_cli: Boolean(agyPath),
    agy_cli_path: agyPath,
    agy_version: agyVersion,
  };
}

async function hasGitWorktree(cwd, env) {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { env });
  return result.code === 0 && firstLine(result.stdout) === 'true';
}

async function hasHead(cwd, env) {
  const result = await git(cwd, ['rev-parse', '--verify', 'HEAD'], { env });
  return result.code === 0 && firstLine(result.stdout).length > 0;
}

function countChanges(records) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const record of records) {
    if (record.index === '?' && record.workTree === '?') {
      untracked += 1;
      continue;
    }
    if (record.index !== ' ' && record.index !== '!') staged += 1;
    if (record.workTree !== ' ' && record.workTree !== '!') unstaged += 1;
  }
  let changeState = 'clean';
  if (staged > 0 && unstaged > 0) changeState = 'mixed';
  else if (staged > 0) changeState = 'staged';
  else if (unstaged > 0) changeState = 'unstaged';
  else if (untracked > 0) changeState = 'untracked-only';
  return {
    change_state: changeState,
    staged,
    unstaged,
    untracked,
    has_untracked: untracked > 0,
  };
}

async function determineReviewBase(cwd, env) {
  for (const remoteRef of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const verified = await git(cwd, ['rev-parse', '--verify', '--quiet', remoteRef], { env });
    if (verified.code !== 0) continue;
    const merged = await git(cwd, ['merge-base', 'HEAD', remoteRef], { env });
    const candidate = firstLine(merged.stdout);
    if (merged.code === 0 && candidate) {
      return { review_base: candidate, review_base_method: 'merge-base' };
    }
  }

  const countResult = await git(cwd, ['rev-list', '--count', 'HEAD'], { env });
  const count = Number(firstLine(countResult.stdout));
  if (countResult.code === 0 && Number.isInteger(count) && count > 1) {
    return { review_base: 'HEAD~1', review_base_method: 'head-parent' };
  }

  const emptyTree = await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], {
    env,
    input: Buffer.alloc(0),
  });
  const reviewBase = firstLine(emptyTree.stdout);
  if (emptyTree.code !== 0 || !/^[0-9a-f]+$/.test(reviewBase)) {
    throw new Error(`failed to compute repository empty-tree hash: ${firstLine(emptyTree.stderr)}`);
  }
  return { review_base: reviewBase, review_base_method: 'empty-tree' };
}

async function detectShallow(cwd, env) {
  const result = await git(cwd, ['rev-parse', '--is-shallow-repository'], { env });
  if (result.code === 0) return firstLine(result.stdout) === 'true';

  const shallowPath = await git(cwd, ['rev-parse', '--git-path', 'shallow'], { env });
  const value = firstLine(shallowPath.stdout);
  return shallowPath.code === 0 && value.length > 0 && existsSync(resolve(cwd, value));
}

export async function detectEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const workingDirectory = resolve(cwd);
  const common = {
    runtime_host: detectRuntimeHost(env),
    plugin_root: resolvePluginRoot({ env }),
    ...(await detectAvailability(workingDirectory, env)),
  };

  if (!(await hasGitWorktree(workingDirectory, env))) {
    return {
      ...common,
      is_git: false,
      has_commits: false,
      change_state: 'non-git',
      ...EMPTY_GIT_FIELDS,
    };
  }

  if (!(await hasHead(workingDirectory, env))) {
    return {
      ...common,
      is_git: true,
      has_commits: false,
      change_state: 'initial',
      ...EMPTY_GIT_FIELDS,
    };
  }

  const status = await git(
    workingDirectory,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { env },
  );
  if (status.code !== 0) {
    throw new Error(`failed to inspect Git status: ${firstLine(status.stderr)}`);
  }

  return {
    ...common,
    is_git: true,
    has_commits: true,
    ...countChanges(parsePorcelainV1Z(status.stdout)),
    ...(await determineReviewBase(workingDirectory, env)),
    is_shallow: await detectShallow(workingDirectory, env),
  };
}

function parseArguments(argv) {
  let cwd = process.cwd();
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cwd') {
      if (!argv[index + 1]) throw new Error('--cwd requires a value');
      cwd = argv[index + 1];
      index += 1;
    } else if (argument === '--format') {
      if (!argv[index + 1]) throw new Error('--format requires a value');
      format = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!['json', 'kv'].includes(format)) throw new Error('--format must be json or kv');
  return { cwd, format };
}

function formatKv(result) {
  return `${Object.entries(result)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await detectEnvironment({ cwd: options.cwd, env: process.env });
  process.stdout.write(options.format === 'json'
    ? `${JSON.stringify(result)}\n`
    : formatKv(result));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
