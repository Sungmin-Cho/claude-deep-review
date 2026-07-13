import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeGitPath, gitSync } from './lib/git.mjs';
import { scanSensitiveFiles } from './lib/sensitive-files.mjs';

const PUBLICATION_REF = 'refs/worktree/deep-review/mutation/v3/publication';
const PROTOCOL = 'deep-review-mutation-v3';
const RESERVED_PREFIX = PUBLICATION_REF.slice(0, -'publication'.length);
const RECORD_SEQUENCE_MAX = 4_294_967_295;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const OWNER_TOKEN_MAX_BYTES = 256;
const MAX_TARGETS = 256;
const PATH_MAX_BYTES = 4096;
const SLOT_MAX_BYTES = 1_048_576;
const PUBLICATION_MAX_BYTES = 8192;
const AUTHORITY_INVENTORY_MAX_BYTES = 1_048_576;
const CLI_REQUEST_MAX_BYTES = 1_310_720;
const CLI_REPO_MAX_BYTES = 131_072;
const MAX_CANDIDATES = 16;
const RESERVATION_NAME = '.mutation.operation.reserve';
const LOCK_NAME = '.mutation.lock';
const MARKER_NAME = 'v3-cutover-fence';
const SLOT_NAMES = Object.freeze({
  a: '.pending-mutation.v3.a.json',
  b: '.pending-mutation.v3.b.json',
});
const LEGACY_PREFIXES = Object.freeze([
  '.pending-mutation.json',
  '.pending-mutation.completed-',
  '.mutation.operation.reserve',
  '.mutation.lock',
  '.mutation.lock.quarantine-',
  '.mutation.lock.completed-',
  '.mutation.artifact.capture-',
  '.mutation.artifact.retiring-',
]);
const RECORD_PHASES = new Set([
  'cutover-anchor',
  'empty',
  'prepared',
  'committed',
  'recovery-attempt',
  'restored',
  'aborted',
]);
const SESSION_PHASES = new Set([
  'prepared',
  'committed',
  'recovery-attempt',
  'restored',
  'aborted',
]);
const CUTOVER_PHASES = new Set([
  'fences-bound',
  'slot-a',
  'slot-b',
  'mutual-slots',
  'ready',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX64_PATTERN = /^[0-9a-f]{64}$/u;
const OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROCESS_START_MS = Math.max(0, Math.trunc(Date.now() - (process.uptime() * 1000)));

class MutationProtocolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'MutationProtocolError';
    this.code = options.code || 'MUTATION_PROTOCOL_ERROR';
    this.manualRecovery = Boolean(options.manualRecovery);
    if (Array.isArray(options.failures)) this.failures = options.failures;
  }
}

function protocolError(message, code) {
  return new MutationProtocolError(message, { code });
}

function manualError(message, code = 'MANUAL_RECOVERY_REQUIRED') {
  return new MutationProtocolError(message + '; manual recovery required', {
    code,
    manualRecovery: true,
  });
}

function failureDescriptor(stage, error) {
  return {
    stage,
    code: error?.code || 'MUTATION_PROTOCOL_ERROR',
    message: error?.message || String(error),
    manual_recovery: Boolean(error?.manualRecovery),
  };
}

function asCompositeError(error, stage = 'primary') {
  if (Array.isArray(error?.failures)) return error;
  const composite = new MutationProtocolError(error?.message || String(error), {
    code: error?.code,
    manualRecovery: error?.manualRecovery,
    failures: [failureDescriptor(stage, error)],
  });
  composite.cause = error;
  return composite;
}

function appendProtocolFailure(primary, stage, secondary) {
  const composite = asCompositeError(primary);
  composite.failures.push(failureDescriptor(stage, secondary));
  if (stage === 'release') composite.releaseError = secondary;
  if (stage === 'failed-state-publication') composite.publicationError = secondary;
  return composite;
}

function serializeProtocolError(error) {
  const composite = asCompositeError(error);
  return {
    code: composite.code || 'MUTATION_PROTOCOL_ERROR',
    message: composite.message,
    manual_recovery: Boolean(composite.manualRecovery),
    failures: composite.failures.map((failure) => ({ ...failure })),
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function utf8Length(value) {
  return Buffer.byteLength(value, 'utf8');
}

function assertScalarString(value, label, options = {}) {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string');
  if (value.includes('\0')) throw new TypeError(label + ' must not contain NUL');
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(label + ' contains an unpaired surrogate');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(label + ' contains an unpaired surrogate');
    }
  }
  if (options.nonempty && value.length === 0) {
    throw new TypeError(label + ' must be non-empty');
  }
  if (options.maxBytes !== undefined && utf8Length(value) > options.maxBytes) {
    throw new TypeError(label + ' exceeds ' + options.maxBytes + ' bytes');
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(label + ' must be a plain object');
  }
  return value;
}

function canonicalDecimal(value, label, maximum, minimum = 0n) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(label + ' must be a canonical decimal string');
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > maximum) {
    throw new TypeError(label + ' is outside its supported range');
  }
  return value;
}

function canonicalRecordSequence(value) {
  return canonicalDecimal(value, 'record sequence', BigInt(RECORD_SEQUENCE_MAX));
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(label + ' must be a canonical lowercase UUID');
  }
  return value;
}

function canonicalOid(value, label = 'OID') {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) {
    throw new TypeError(label + ' must be a Git-derived OID');
  }
  return value;
}

function canonicalObjectFormat(value) {
  if (value !== 'sha1' && value !== 'sha256') {
    throw manualError('Git returned an unsupported object format');
  }
  return value;
}

function repositoryOid(preflight, value, label = 'OID') {
  canonicalOid(value, label);
  const expected = preflight.objectFormat === 'sha256' ? 64 : 40;
  if (value.length !== expected) {
    throw manualError(label + ' width does not match the repository object format');
  }
  return value;
}

function identityFromStat(metadata, label) {
  const dev = BigInt(metadata.dev);
  const ino = BigInt(metadata.ino);
  if (dev < 1n || dev > UINT64_MAX || ino < 1n || ino > UINT64_MAX) {
    throw manualError(label + ' has an unusable device/inode identity', 'INVALID_FILE_IDENTITY');
  }
  return { dev: dev.toString(), ino: ino.toString() };
}

function normalizeIdentity(value, label) {
  assertPlainObject(value, label);
  return {
    dev: canonicalDecimal(value.dev, label + '.dev', UINT64_MAX, 1n),
    ino: canonicalDecimal(value.ino, label + '.ino', UINT64_MAX, 1n),
  };
}

function identitiesEqual(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function canonicalJsonLine(value) {
  return Buffer.from(JSON.stringify(value) + '\n', 'utf8');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalFiles(files, options = {}) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (files.length > MAX_TARGETS) {
    throw new TypeError('target count exceeds 256');
  }
  const normalized = files.map((file) => {
    assertScalarString(file, 'mutation path', { nonempty: true, maxBytes: PATH_MAX_BYTES });
    return options.normalize === false ? file : normalizeTarget(file, options.platform);
  });
  normalized.sort(compareUtf8);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      if (options.rejectDuplicates) throw new TypeError('duplicate mutation path');
      normalized.splice(index, 1);
      index -= 1;
    }
  }
  return normalized;
}

function normalizeOwnerProcess(value) {
  assertPlainObject(value, 'owner_process');
  const allNull = value.host_hash === null
    && value.pid === null
    && value.process_start_ms === null;
  if (allNull) return { host_hash: null, pid: null, process_start_ms: null };
  if (value.host_hash === null || value.pid === null || value.process_start_ms === null) {
    throw new TypeError('owner_process must be all-null or all-non-null');
  }
  if (typeof value.host_hash !== 'string' || !HEX64_PATTERN.test(value.host_hash)) {
    throw new TypeError('owner_process.host_hash must be lowercase SHA-256');
  }
  return {
    host_hash: value.host_hash,
    pid: canonicalDecimal(value.pid, 'owner_process.pid', 4_294_967_295n, 1n),
    process_start_ms: canonicalDecimal(
      value.process_start_ms,
      'owner_process.process_start_ms',
      BigInt(Number.MAX_SAFE_INTEGER),
    ),
  };
}

function normalizeFenceInventory(value) {
  assertPlainObject(value, 'fence_inventory');
  if (typeof value.sha256 !== 'string' || !HEX64_PATTERN.test(value.sha256)) {
    throw new TypeError('fence_inventory.sha256 must be lowercase SHA-256');
  }
  if (!Number.isSafeInteger(value.entries) || value.entries < 0) {
    throw new TypeError('fence_inventory.entries must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new TypeError('fence_inventory.bytes must be a non-negative safe integer');
  }
  return { sha256: value.sha256, entries: value.entries, bytes: value.bytes };
}

function normalizeRecordCore(input) {
  assertPlainObject(input, 'record');
  if (input.schema_version !== 3) throw new TypeError('schema_version must be 3');
  if (input.slot !== 'a' && input.slot !== 'b') throw new TypeError('slot must be a or b');
  if (!RECORD_PHASES.has(input.phase)) throw new TypeError('invalid record phase');
  if (typeof input.cutover_id !== 'string' || !HEX64_PATTERN.test(input.cutover_id)) {
    throw new TypeError('cutover_id must be lowercase SHA-256');
  }
  const sessionId = input.session_id === null
    ? null
    : canonicalUuid(input.session_id, 'session_id');
  const ownerToken = input.owner_token === null
    ? null
    : assertScalarString(input.owner_token, 'owner token', {
      nonempty: true,
      maxBytes: OWNER_TOKEN_MAX_BYTES,
    });
  const startedAt = input.started_at === null
    ? null
    : assertScalarString(input.started_at, 'started_at', { nonempty: true, maxBytes: 64 });
  if (startedAt !== null && new Date(startedAt).toISOString() !== startedAt) {
    throw new TypeError('started_at must be canonical RFC3339 UTC');
  }
  const commitHash = input.commit_hash === null
    ? null
    : canonicalOid(input.commit_hash, 'commit_hash');
  if (!Number.isInteger(input.restore_attempts)
      || input.restore_attempts < 0 || input.restore_attempts > 3) {
    throw new TypeError('restore_attempts must be 0..3');
  }
  if (input.recovery_kind !== null
      && input.recovery_kind !== 'abort-prepared'
      && input.recovery_kind !== 'restore-committed') {
    throw new TypeError('invalid recovery_kind');
  }
  if (input.attempt_state !== null
      && input.attempt_state !== 'pending'
      && input.attempt_state !== 'failed') {
    throw new TypeError('invalid attempt_state');
  }
  const core = {
    schema_version: 3,
    slot: input.slot,
    phase: input.phase,
    cutover_id: input.cutover_id,
    session_id: sessionId,
    record_seq: canonicalRecordSequence(input.record_seq),
    owner_token: ownerToken,
    owner_process: normalizeOwnerProcess(input.owner_process),
    started_at: startedAt,
    commit_hash: commitHash,
    restore_attempts: input.restore_attempts,
    recovery_kind: input.recovery_kind,
    attempt_state: input.attempt_state,
    files: canonicalFiles(input.files, { normalize: false, rejectDuplicates: true }),
    fence_inventory: normalizeFenceInventory(input.fence_inventory),
    self_slot_identity: normalizeIdentity(input.self_slot_identity, 'self_slot_identity'),
    peer_slot_identity: input.peer_slot_identity === null
      ? null
      : normalizeIdentity(input.peer_slot_identity, 'peer_slot_identity'),
  };
  return core;
}

function validateRecordSemantics(record) {
  const idle = record.phase === 'cutover-anchor' || record.phase === 'empty';
  const ownerNull = record.owner_process.host_hash === null;
  if (idle) {
    if (record.session_id !== null || record.owner_token !== null || !ownerNull
        || record.started_at !== null || record.commit_hash !== null
        || record.restore_attempts !== 0 || record.recovery_kind !== null
        || record.attempt_state !== null || record.files.length !== 0
        || record.record_seq !== '0') {
      throw new TypeError('invalid idle record semantics');
    }
    return;
  }
  if (record.session_id === null || record.owner_token === null || ownerNull
      || record.started_at === null || record.files.length === 0) {
    throw new TypeError('active record is missing its immutable session payload');
  }
  if (record.phase === 'prepared' || record.phase === 'committed') {
    if (record.restore_attempts !== 0 || record.recovery_kind !== null
        || record.attempt_state !== null) {
      throw new TypeError('invalid prepared or committed record semantics');
    }
  } else if (record.phase === 'recovery-attempt') {
    if (record.restore_attempts < 1 || record.recovery_kind === null
        || record.attempt_state === null) {
      throw new TypeError('invalid recovery-attempt semantics');
    }
  } else if (record.phase === 'restored') {
    if (record.restore_attempts < 1 || record.recovery_kind !== 'restore-committed'
        || record.attempt_state !== null) {
      throw new TypeError('invalid restored semantics');
    }
  } else if (record.phase === 'aborted') {
    const direct = record.restore_attempts === 0 && record.recovery_kind === null;
    const recovered = record.restore_attempts >= 1 && record.recovery_kind === 'abort-prepared';
    if ((!direct && !recovered) || record.attempt_state !== null) {
      throw new TypeError('invalid aborted semantics');
    }
  }
}

export function recordCoreBytes(record) {
  const core = normalizeRecordCore(record);
  const bytes = canonicalJsonLine(core);
  if (bytes.length > SLOT_MAX_BYTES) throw new TypeError('record core exceeds slot byte cap');
  return bytes;
}

export function buildRecord(input) {
  const core = normalizeRecordCore(input);
  const digest = sha256(canonicalJsonLine(core));
  return {
    schema_version: core.schema_version,
    slot: core.slot,
    phase: core.phase,
    cutover_id: core.cutover_id,
    session_id: core.session_id,
    record_seq: core.record_seq,
    record_digest: digest,
    owner_token: core.owner_token,
    owner_process: core.owner_process,
    started_at: core.started_at,
    commit_hash: core.commit_hash,
    restore_attempts: core.restore_attempts,
    recovery_kind: core.recovery_kind,
    attempt_state: core.attempt_state,
    files: core.files,
    fence_inventory: core.fence_inventory,
    self_slot_identity: core.self_slot_identity,
    peer_slot_identity: core.peer_slot_identity,
  };
}

export function encodeRecord(record) {
  const built = buildRecord(record);
  if (record.record_digest !== built.record_digest) {
    throw new TypeError('record digest does not match canonical core bytes');
  }
  const bytes = canonicalJsonLine(built);
  if (bytes.length > SLOT_MAX_BYTES) throw new TypeError('record exceeds slot byte cap');
  return bytes;
}

export function decodeRecord(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('record bytes must be a Buffer');
  if (bytes.length === 0 || bytes.length > SLOT_MAX_BYTES) {
    throw new TypeError('record size is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new TypeError('record JSON is not canonical: ' + error.message);
  }
  const encoded = encodeRecord(parsed);
  if (!encoded.equals(bytes)) throw new TypeError('record bytes are not canonical');
  if (parsed.peer_slot_identity === null) {
    if (options.transition === 'initial-a') {
      if (parsed.slot !== 'a' || parsed.phase !== 'cutover-anchor') {
        throw new TypeError('null peer is valid only for initial slot A');
      }
    } else if (options.allowNullPeer !== true) {
      throw new TypeError('null peer is valid only for initial slot A');
    }
  } else if (options.transition === 'initial-a') {
    throw new TypeError('initial slot A requires a null peer');
  }
  return parsed;
}

function deriveLease(cutoverId, sessionId, recordSequence, recordDigest) {
  return sha256(Buffer.concat([
    Buffer.from('deep-review-session-lease-v1\0', 'utf8'),
    Buffer.from(cutoverId, 'ascii'),
    Buffer.from(sessionId, 'ascii'),
    Buffer.from(recordSequence, 'ascii'),
    Buffer.from(recordDigest, 'ascii'),
  ]));
}

function normalizeOperation(value, cutoverPhase) {
  if (value === null) return null;
  assertPlainObject(value, 'operation');
  const base = value.base_publication_oid === null
    ? null
    : canonicalOid(value.base_publication_oid, 'base_publication_oid');
  return {
    operation_id: canonicalUuid(value.operation_id, 'operation_id'),
    host_hash: HEX64_PATTERN.test(value.host_hash || '') ? value.host_hash : (() => {
      throw new TypeError('operation.host_hash must be lowercase SHA-256');
    })(),
    pid: canonicalDecimal(value.pid, 'operation.pid', 4_294_967_295n, 1n),
    process_start_ms: canonicalDecimal(
      value.process_start_ms,
      'operation.process_start_ms',
      BigInt(Number.MAX_SAFE_INTEGER),
    ),
    base_publication_oid: base,
  };
}

function normalizeSession(value, cutoverId) {
  if (value === null) return null;
  assertPlainObject(value, 'session');
  if (!SESSION_PHASES.has(value.phase)) throw new TypeError('invalid session phase');
  const normalized = {
    session_id: canonicalUuid(value.session_id, 'session.session_id'),
    phase: value.phase,
    record_seq: canonicalRecordSequence(value.record_seq),
    record_digest: HEX64_PATTERN.test(value.record_digest || '') ? value.record_digest : (() => {
      throw new TypeError('session.record_digest must be lowercase SHA-256');
    })(),
    lease_id: HEX64_PATTERN.test(value.lease_id || '') ? value.lease_id : (() => {
      throw new TypeError('session.lease_id must be lowercase SHA-256');
    })(),
  };
  if (normalized.lease_id !== deriveLease(
    cutoverId,
    normalized.session_id,
    normalized.record_seq,
    normalized.record_digest,
  )) {
    throw new TypeError('session lease does not match selected record');
  }
  return normalized;
}

function normalizePublicationCore(input) {
  assertPlainObject(input, 'publication');
  if (input.publication_schema !== 1) throw new TypeError('publication_schema must be 1');
  if (input.protocol !== PROTOCOL) throw new TypeError('invalid publication protocol');
  if (typeof input.cutover_id !== 'string' || !HEX64_PATTERN.test(input.cutover_id)) {
    throw new TypeError('invalid publication cutover_id');
  }
  if (!CUTOVER_PHASES.has(input.cutover_phase)) throw new TypeError('invalid cutover phase');
  const session = normalizeSession(input.session, input.cutover_id);
  const selectedSlot = input.selected_slot;
  const selectedSequence = input.selected_record_seq;
  const selectedDigest = input.selected_record_digest;
  if (session === null) {
    if (selectedSlot !== null || selectedSequence !== null || selectedDigest !== null) {
      throw new TypeError('idle publication selection must be all-null');
    }
  } else {
    if ((selectedSlot !== 'a' && selectedSlot !== 'b')
        || canonicalRecordSequence(selectedSequence) !== session.record_seq
        || typeof selectedDigest !== 'string' || !HEX64_PATTERN.test(selectedDigest)
        || selectedDigest !== session.record_digest) {
      throw new TypeError('publication selection does not match session');
    }
    if (input.cutover_phase !== 'ready') {
      throw new TypeError('cutover publication cannot contain a session');
    }
  }
  if (typeof input.fence_inventory_sha256 !== 'string'
      || !HEX64_PATTERN.test(input.fence_inventory_sha256)) {
    throw new TypeError('invalid publication fence digest');
  }
  const operation = normalizeOperation(input.operation, input.cutover_phase);
  if (input.cutover_phase === 'ready'
      && operation !== null
      && operation.base_publication_oid === null) {
    throw new TypeError('ready operation requires a base publication OID; null is fresh cutover only');
  }
  return {
    publication_schema: 1,
    protocol: PROTOCOL,
    cutover_id: input.cutover_id,
    publication_seq: canonicalDecimal(
      input.publication_seq,
      'publication sequence',
      UINT64_MAX,
    ),
    cutover_phase: input.cutover_phase,
    selected_slot: selectedSlot,
    selected_record_seq: selectedSequence,
    selected_record_digest: selectedDigest,
    session,
    operation,
    fence_inventory_sha256: input.fence_inventory_sha256,
  };
}

function publicationCoreBytes(publication) {
  return canonicalJsonLine(normalizePublicationCore(publication));
}

function buildPublication(input) {
  const core = normalizePublicationCore(input);
  const digest = sha256(canonicalJsonLine(core));
  return {
    publication_schema: core.publication_schema,
    protocol: core.protocol,
    cutover_id: core.cutover_id,
    publication_seq: core.publication_seq,
    publication_digest: digest,
    cutover_phase: core.cutover_phase,
    selected_slot: core.selected_slot,
    selected_record_seq: core.selected_record_seq,
    selected_record_digest: core.selected_record_digest,
    session: core.session,
    operation: core.operation,
    fence_inventory_sha256: core.fence_inventory_sha256,
  };
}

function encodePublication(publication) {
  const built = buildPublication(publication);
  if (publication.publication_digest !== undefined
      && publication.publication_digest !== built.publication_digest) {
    throw new TypeError('publication digest does not match canonical core bytes');
  }
  const bytes = canonicalJsonLine(built);
  if (bytes.length > PUBLICATION_MAX_BYTES) {
    throw new TypeError('publication exceeds byte cap');
  }
  return bytes;
}

function decodePublication(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PUBLICATION_MAX_BYTES) {
    throw new TypeError('publication size is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new TypeError('publication JSON is not canonical: ' + error.message);
  }
  const encoded = encodePublication(parsed);
  if (!encoded.equals(bytes)) throw new TypeError('publication bytes are not canonical');
  return parsed;
}

function normalizeTarget(file, platform = process.platform) {
  assertScalarString(file, 'mutation path', { nonempty: true, maxBytes: PATH_MAX_BYTES });
  if (isAbsolute(file) || win32.isAbsolute(file) || /^[A-Za-z]:/u.test(file)) {
    throw new TypeError('absolute mutation path is invalid: ' + file);
  }
  const portable = platform === 'win32' ? file.replaceAll('\\', '/') : file;
  const output = [];
  for (const segment of portable.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) throw new TypeError('mutation path escapes the repository');
      output.pop();
    } else {
      output.push(segment);
    }
  }
  if (output.length === 0) throw new TypeError('invalid mutation path');
  const normalized = output.join('/');
  if (utf8Length(normalized) > PATH_MAX_BYTES) {
    throw new TypeError('mutation path exceeds 4096 bytes');
  }
  return normalized;
}

function normalizeTargets(files, platform = process.platform) {
  const targets = canonicalFiles(files, { platform });
  if (targets.length === 0) throw new TypeError('at least one mutation target is required');
  return targets;
}

function protocolPaths(repo) {
  assertScalarString(repo, 'repo', { nonempty: true, maxBytes: CLI_REPO_MAX_BYTES });
  const root = resolve(repo);
  const review = join(root, '.deep-review');
  return {
    repo: root,
    review,
    reservation: join(review, RESERVATION_NAME),
    lock: join(review, LOCK_NAME),
    marker: join(review, LOCK_NAME, MARKER_NAME),
    slotA: join(review, SLOT_NAMES.a),
    slotB: join(review, SLOT_NAMES.b),
  };
}

function normalizeGitResult(result) {
  if (!result || !Number.isInteger(result.code)) {
    throw new TypeError('gitRunner must return an object with an integer code');
  }
  return {
    code: result.code,
    stdout: Buffer.from(result.stdout || []),
    stderr: Buffer.from(result.stderr || []),
    timedOut: Boolean(result.timedOut),
  };
}

export function sanitizeGitEnvironment(environment = process.env) {
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!/^git_/iu.test(key)) sanitized[key] = value;
  }
  sanitized.GIT_TERMINAL_PROMPT = '0';
  sanitized.LC_ALL = 'C';
  return sanitized;
}

function childGitEnvironment(environment = process.env, indexFile) {
  const sanitized = sanitizeGitEnvironment(environment);
  const result = {
    ...sanitized,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  if (indexFile !== undefined) result.GIT_INDEX_FILE = indexFile;
  return Object.freeze(result);
}

function runGit(repo, args, options = {}) {
  const runner = options.gitRunner || gitSync;
  let result;
  try {
    result = runner(repo, args, {
      env: childGitEnvironment(options.env, options.indexFile),
      input: options.input,
      maxBuffer: options.maxBuffer,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw manualError('failed to execute Git: ' + error.message, 'GIT_EXECUTION_FAILED');
  }
  return normalizeGitResult(result);
}

function firstLine(buffer) {
  return buffer.toString('utf8').split(/\r?\n/u, 1)[0].trim();
}

function probeGitObject(preflight, oid, label = 'Git object') {
  repositoryOid(preflight, oid, label + ' OID');
  const result = runGit(
    preflight.repo,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      ...preflight,
      input: Buffer.from(oid + '\n', 'ascii'),
      maxBuffer: 512,
      timeoutMs: 5000,
    },
  );
  if (result.timedOut || result.code !== 0) {
    const detail = result.timedOut
      ? 'timed out'
      : (firstLine(result.stderr) || 'exit ' + result.code);
    throw manualError(label + ' probe failed: ' + detail);
  }
  if (result.stdout.length > 256 || result.stdout.includes(0x00)
      || result.stdout.includes(0x0d) || result.stdout.at(-1) !== 0x0a) {
    throw manualError(label + ' probe returned malformed output');
  }
  const line = result.stdout.subarray(0, -1).toString('ascii');
  if (line === oid + ' missing') return { status: 'missing' };
  const match = /^([0-9a-f]+) ([a-z]+) (0|[1-9][0-9]*)$/u.exec(line);
  if (!match || match[1] !== oid || !Number.isSafeInteger(Number(match[3]))) {
    throw manualError(label + ' probe returned foreign output');
  }
  return { status: 'present', type: match[2], size: Number(match[3]) };
}

function requireGit(repo, args, options = {}, label = 'Git command') {
  const result = runGit(repo, args, options);
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || 'exit ' + result.code;
    throw manualError(label + ' failed: ' + detail, 'GIT_COMMAND_FAILED');
  }
  return result;
}

export function parseGitVersion(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const match = /^git version ([0-9]+)\.([0-9]+)\.([0-9]+)(?:(?:\.[0-9A-Za-z][0-9A-Za-z.-]*)|(?:[ \t].*))?\r?\n?$/u.exec(text);
  if (!match) throw new TypeError('invalid git version output');
  return match.slice(1).map(Number);
}

export function requireGitFloor(value) {
  const version = parseGitVersion(value);
  const [major, minor] = version;
  if (major < 2 || (major === 2 && minor < 45)) {
    throw protocolError('git-floor-unavailable: Git 2.45.0 or newer is required', 'GIT_FLOOR_UNAVAILABLE');
  }
  return version;
}

export function parseReflogList(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('reflog list must be a Buffer');
  if (buffer.length > AUTHORITY_INVENTORY_MAX_BYTES) {
    throw new TypeError('reflog list exceeds byte cap');
  }
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0x0a) throw new TypeError('unterminated reflog list');
  if (buffer.includes(0x00)) throw new TypeError('NUL in reflog list');
  if (buffer.includes(0x0d)) throw new TypeError('CR in reflog list');
  const names = buffer.toString('utf8').slice(0, -1).split('\n');
  const seen = new Set();
  const reserved = [];
  for (const name of names) {
    if (name.length === 0) throw new TypeError('invalid reflog name');
    if (seen.has(name)) throw new TypeError('duplicate reflog name');
    seen.add(name);
    if (name === 'HEAD') {
      if (options.checkRef && !options.checkRef(name, true)) {
        throw new TypeError('invalid reflog name HEAD');
      }
      continue;
    }
    if (!name.startsWith('refs/')) throw new TypeError('invalid reflog name: ' + name);
    if (options.checkRef && !options.checkRef(name, false)) {
      throw new TypeError('invalid reflog name: ' + name);
    }
    if (name.startsWith(RESERVED_PREFIX)) reserved.push(name);
  }
  return reserved;
}

function gitPath(buffer, label) {
  let value = buffer.toString('utf8');
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (!value || /[\0\r\n]/u.test(value)) throw manualError('invalid Git ' + label);
  return value;
}

function physicalExistingPath(value, label) {
  try {
    return realpathSync.native(value);
  } catch (error) {
    throw manualError(label + ' could not be physically resolved: ' + error.message);
  }
}

function checkRef(repo, name, allowOneLevel, options) {
  const args = ['check-ref-format'];
  if (allowOneLevel) args.push('--allow-onelevel');
  args.push(name);
  return runGit(repo, args, options).code === 0;
}

function parseLiveRefs(buffer) {
  if (buffer.length > AUTHORITY_INVENTORY_MAX_BYTES) {
    throw manualError('reserved ref inventory exceeds byte cap');
  }
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0x0a || buffer.includes(0x00) || buffer.includes(0x0d)) {
    throw manualError('reserved ref inventory is malformed');
  }
  const refs = buffer.toString('utf8').slice(0, -1).split('\n');
  if (new Set(refs).size !== refs.length) throw manualError('reserved ref inventory is duplicated');
  for (const ref of refs) {
    if (!ref.startsWith(RESERVED_PREFIX)) throw manualError('reserved ref inventory escaped prefix');
  }
  return refs;
}

function inventoryAuthority(repo, options = {}) {
  const readInventory = () => {
    const liveResult = requireGit(
      repo,
      ['for-each-ref', '--format=%(refname)', RESERVED_PREFIX],
      { ...options, maxBuffer: 1_048_576, timeoutMs: 5000 },
      'reserved ref inventory',
    );
    const refs = parseLiveRefs(liveResult.stdout);
    const reflogResult = requireGit(
      repo,
      ['reflog', 'list'],
      { ...options, maxBuffer: 1_048_576, timeoutMs: 5000 },
      'reflog inventory',
    );
    const reflogs = parseReflogList(reflogResult.stdout, {
      checkRef: (name, allowOneLevel) => checkRef(repo, name, allowOneLevel, options),
    });
    return { refs, reflogs };
  };
  const { refs, reflogs } = readInventory();
  for (const name of new Set([...refs, ...reflogs, PUBLICATION_REF])) {
    const result = runGit(repo, ['reflog', 'exists', name], options);
    if (result.code === 0) {
      throw manualError('unexpected reserved reflog existence');
    }
    if (result.code !== 1) {
      throw manualError('reflog existence probe failed for reserved authority');
    }
  }
  const afterReflogResult = requireGit(
    repo,
    ['reflog', 'list'],
    { ...options, maxBuffer: 1_048_576, timeoutMs: 5000 },
    'post-probe reflog inventory',
  );
  const afterReflogs = parseReflogList(afterReflogResult.stdout, {
    checkRef: (name, allowOneLevel) => checkRef(repo, name, allowOneLevel, options),
  });
  if (afterReflogs.length !== reflogs.length
      || afterReflogs.some((name, index) => name !== reflogs[index])) {
    throw manualError('reserved ref or reflog inventory changed during inspection');
  }
  if (refs.some((name) => name !== PUBLICATION_REF)) {
    throw manualError('unexpected reserved live ref');
  }
  if (reflogs.length > 0) throw manualError('unexpected reserved reflog');
  return { refs, reflogs };
}

export function preflightRepository({ repo, env, gitRunner }) {
  const inputPaths = protocolPaths(repo);
  let rootMetadata;
  try {
    rootMetadata = lstatSync(inputPaths.repo);
  } catch (error) {
    throw protocolError('repository path is unavailable: ' + error.message, 'INVALID_REPOSITORY');
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw protocolError('repository path must be a physical directory', 'INVALID_REPOSITORY');
  }
  const physicalRepo = physicalExistingPath(inputPaths.repo, 'repository');
  const options = { env, gitRunner };
  const versionResult = requireGit(physicalRepo, ['--version'], options, 'Git version probe');
  const gitVersion = requireGitFloor(versionResult.stdout);
  const objectFormat = canonicalObjectFormat(firstLine(requireGit(
    physicalRepo,
    ['rev-parse', '--show-object-format'],
    options,
    'Git object format probe',
  ).stdout));
  const bare = firstLine(requireGit(
    physicalRepo,
    ['rev-parse', '--is-bare-repository'],
    options,
    'bare repository probe',
  ).stdout);
  const inside = firstLine(requireGit(
    physicalRepo,
    ['rev-parse', '--is-inside-work-tree'],
    options,
    'worktree probe',
  ).stdout);
  if (bare !== 'false' || inside !== 'true') {
    throw protocolError('repository must be a non-bare worktree', 'INVALID_REPOSITORY');
  }
  const top = physicalExistingPath(gitPath(requireGit(
    physicalRepo,
    ['rev-parse', '--show-toplevel'],
    options,
  ).stdout, 'worktree root'), 'worktree root');
  if (top !== physicalRepo) throw protocolError('repository is not its physical worktree root');
  const gitDirectory = physicalExistingPath(gitPath(requireGit(
    physicalRepo,
    ['rev-parse', '--absolute-git-dir'],
    options,
  ).stdout, 'directory'), 'Git directory');
  const commonDirectory = physicalExistingPath(gitPath(requireGit(
    physicalRepo,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    options,
  ).stdout, 'common directory'), 'Git common directory');
  const objectsDirectory = physicalExistingPath(gitPath(requireGit(
    physicalRepo,
    ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
    options,
  ).stdout, 'objects directory'), 'Git objects directory');
  const indexOutput = gitPath(requireGit(
    physicalRepo,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    options,
  ).stdout, 'index path');
  const indexPath = isAbsolute(indexOutput) ? indexOutput : resolve(physicalRepo, indexOutput);
  const commonRelative = relative(commonDirectory, gitDirectory);
  if (!(gitDirectory === commonDirectory
      || (commonRelative && commonRelative !== '..'
        && !commonRelative.startsWith('..' + sep) && !isAbsolute(commonRelative)))) {
    throw protocolError('Git worktree/common directory topology is inconsistent');
  }
  if (objectsDirectory !== join(commonDirectory, 'objects')) {
    throw protocolError('Git object directory topology is inconsistent');
  }
  if (indexPath !== join(gitDirectory, 'index') || dirname(indexPath) !== gitDirectory) {
    throw protocolError('Git index topology is inconsistent');
  }
  if (existsSync(indexPath)) {
    const metadata = lstatSync(indexPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw protocolError('Git index must be a regular file');
    }
  } else if (runGit(
    physicalRepo,
    ['rev-parse', '--verify', 'HEAD'],
    options,
  ).code === 0) {
    throw protocolError('Git index is missing from a committed worktree');
  }
  const probe = runGit(
    physicalRepo,
    ['-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin', '-z'],
    { ...options, input: Buffer.from('start\0abort\0', 'latin1') },
  );
  if (probe.code !== 0) throw protocolError('Git transaction-control capability is unavailable');
  if (!checkRef(physicalRepo, PUBLICATION_REF, false, options)) {
    throw protocolError('publication ref format is unavailable');
  }
  const inventory = inventoryAuthority(physicalRepo, options);
  return {
    repo: physicalRepo,
    env: childGitEnvironment(env),
    gitVersion,
    objectFormat,
    gitDirectory,
    commonDirectory,
    objectsDirectory,
    indexPath,
    inventory,
    gitRunner,
  };
}

function descriptorIdentity(descriptor, label) {
  return identityFromStat(fstatSync(descriptor, { bigint: true }), label);
}

function pathIdentity(file, label) {
  return identityFromStat(lstatSync(file, { bigint: true }), label);
}

const defaultDurabilityFs = Object.freeze({
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync: (file) => realpathSync.native(file),
  writeSync,
});

function persistDurableDescriptor({
  descriptor,
  file,
  bytes,
  mode = 0o600,
  platform = process.platform,
  fsOps = defaultDurabilityFs,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new TypeError('durable descriptor bytes must be a non-empty Buffer');
  }
  const policy = durabilityPolicy(platform);
  let expectedIdentity;
  let descriptorOpen = true;
  try {
    expectedIdentity = identityFromStat(
      fsOps.fstatSync(descriptor, { bigint: true }),
      'durable file descriptor',
    );
    fsOps.ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsOps.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (written <= 0) throw new Error('short descriptor write');
      offset += written;
    }
    fsOps.fsyncSync(descriptor);
    if (policy.applyFileMode) fsOps.fchmodSync(descriptor, mode);
  } finally {
    if (descriptorOpen) {
      fsOps.closeSync(descriptor);
      descriptorOpen = false;
    }
  }

  if (policy.fsyncDirectory) {
    const directoryDescriptor = fsOps.openSync(dirname(file), 'r');
    try {
      fsOps.fsyncSync(directoryDescriptor);
    } finally {
      fsOps.closeSync(directoryDescriptor);
    }
  }

  const before = fsOps.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw manualError('durable file is not a regular non-link file');
  }
  if (fsOps.realpathSync(file) !== resolve(file)) {
    throw manualError('durable file path is not canonical');
  }
  const beforeIdentity = identityFromStat(before, 'durable file');
  if (!identitiesEqual(expectedIdentity, beforeIdentity) || Number(before.size) !== bytes.length) {
    throw manualError('durable file identity or size changed after close');
  }
  if (policy.applyFileMode && Number(before.mode & 0o777n) !== mode) {
    throw manualError('durable file has noncanonical POSIX mode');
  }

  const reopened = fsOps.openSync(file, policy.fileOpenFlag);
  let observed;
  try {
    const opened = fsOps.fstatSync(reopened, { bigint: true });
    const openedIdentity = identityFromStat(opened, 'reopened durable file');
    if (!identitiesEqual(expectedIdentity, openedIdentity)
        || Number(opened.size) !== bytes.length) {
      throw manualError('durable file identity or size changed while reopening');
    }
    observed = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < observed.length) {
      const count = fsOps.readSync(
        reopened,
        observed,
        offset,
        observed.length - offset,
        offset,
      );
      if (count <= 0) throw manualError('durable file was truncated after reopen');
      offset += count;
    }
    if (fsOps.readSync(reopened, Buffer.alloc(1), 0, 1, observed.length) !== 0) {
      throw manualError('durable file grew after reopen');
    }
  } finally {
    fsOps.closeSync(reopened);
  }

  const after = fsOps.lstatSync(file, { bigint: true });
  const afterIdentity = identityFromStat(after, 'durable file');
  if (!identitiesEqual(expectedIdentity, afterIdentity)
      || Number(after.size) !== bytes.length
      || !observed.equals(bytes)) {
    throw manualError('durable file identity or bytes changed after reopen');
  }
  return { bytes: observed, identity: expectedIdentity };
}

function fsyncParentDirectory(file) {
  if (!durabilityPolicy(process.platform).fsyncDirectory) return;
  const descriptor = openSync(dirname(file), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function platformMetadataTag(kind, platform = process.platform) {
  if (kind !== 'file' && kind !== 'directory') {
    throw new TypeError('metadata kind must be file or directory');
  }
  if (platform === 'win32') {
    return kind === 'file' ? 'win32-file-rw' : 'win32-dir-marker-owned';
  }
  return kind === 'file' ? 'posix-file-0600' : 'posix-dir-0700';
}

export function durabilityPolicy(platform = process.platform) {
  const windows = platform === 'win32';
  return Object.freeze({
    platform,
    fileOpenFlag: windows ? 'r+' : 'r',
    fileFsync: true,
    fileReopen: true,
    identityRecheck: true,
    applyFileMode: !windows,
    fsyncDirectory: !windows,
  });
}

export function framedTransportPolicy(platform = process.platform) {
  const argv = Object.freeze(['--request-stdin']);
  const commandLineCodeUnits = argv[0].length + 2;
  return Object.freeze({
    platform,
    argv,
    shell: false,
    transport: 'framed-stdin',
    commandLineCodeUnits,
    commandLineLimitCodeUnits: platform === 'win32' ? 32_767 : null,
    requestMaxBytes: CLI_REQUEST_MAX_BYTES,
  });
}

function readRegularFileBound(file, maximum, label, expectedMode = 0o600) {
  let before;
  try {
    before = lstatSync(file, { bigint: true });
  } catch (error) {
    throw manualError(label + ' is missing: ' + error.message, 'PROTOCOL_ARTIFACT_MISSING');
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw manualError(label + ' is not a regular non-link file', 'PROTOCOL_ARTIFACT_INVALID');
  }
  if (realpathSync.native(file) !== resolve(file)) {
    throw manualError(label + ' does not have a canonical physical path');
  }
  if (durabilityPolicy(process.platform).applyFileMode
      && Number(before.mode & 0o777n) !== expectedMode) {
    throw manualError(label + ' has noncanonical POSIX mode');
  }
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) {
    throw manualError(label + ' has an invalid size', 'PROTOCOL_ARTIFACT_OVERSIZED');
  }
  const beforeIdentity = identityFromStat(before, label);
  const descriptor = openSync(file, durabilityPolicy(process.platform).fileOpenFlag);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const openedIdentity = identityFromStat(opened, label);
    if (!identitiesEqual(beforeIdentity, openedIdentity) || Number(opened.size) !== size) {
      throw manualError(label + ' identity changed while opening', 'PROTOCOL_ARTIFACT_REPLACED');
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count <= 0) throw manualError(label + ' was truncated during read');
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, size) !== 0) {
      throw manualError(label + ' grew during read');
    }
    const after = lstatSync(file, { bigint: true });
    const afterIdentity = identityFromStat(after, label);
    if (!identitiesEqual(beforeIdentity, afterIdentity) || Number(after.size) !== size) {
      throw manualError(label + ' identity changed during read', 'PROTOCOL_ARTIFACT_REPLACED');
    }
    return {
      bytes,
      identity: beforeIdentity,
      size,
      metadataTag: platformMetadataTag('file'),
    };
  } finally {
    closeSync(descriptor);
  }
}

function canonicalReservation(identity) {
  return canonicalJsonLine({
    schema_version: 2,
    owner_token: '00000000-0000-4000-8000-000000000003',
    operation: 'v3-cutover-fence',
    created_at: '1970-01-01T00:00:00.000Z',
    host: '/deep-review-v3-fence/',
    pid: 1,
    process_started_at: '1970-01-01T00:00:00.000Z',
    process_instance: 'v3-cutover-fence',
    fence_identity: identity,
  });
}

function canonicalMarker(directoryIdentity, markerIdentity) {
  return canonicalJsonLine({
    schema_version: 1,
    kind: 'deep-review-v3-bash-fence',
    directory_identity: directoryIdentity,
    self_identity: markerIdentity,
  });
}

function validateReservation(file) {
  const snapshot = readRegularFileBound(file, 4096, 'Node cutover fence');
  let parsed;
  try {
    parsed = JSON.parse(snapshot.bytes.toString('utf8'));
  } catch (error) {
    throw manualError('Node cutover fence is not canonical JSON: ' + error.message);
  }
  if (!parsed.fence_identity || !identitiesEqual(
    normalizeIdentity(parsed.fence_identity, 'fence_identity'),
    snapshot.identity,
  ) || !canonicalReservation(snapshot.identity).equals(snapshot.bytes)) {
    throw manualError('Node cutover fence identity or bytes do not match');
  }
  return snapshot;
}

function validateLock(paths) {
  let directoryMetadata;
  try {
    directoryMetadata = lstatSync(paths.lock, { bigint: true });
  } catch (error) {
    throw manualError('Bash cutover fence directory is missing: ' + error.message);
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw manualError('Bash cutover fence is not a physical directory');
  }
  if (realpathSync.native(paths.lock) !== resolve(paths.lock)) {
    throw manualError('Bash cutover fence directory path is not canonical');
  }
  if (durabilityPolicy(process.platform).applyFileMode
      && Number(directoryMetadata.mode & 0o777n) !== 0o700) {
    throw manualError('Bash cutover fence directory has noncanonical POSIX mode');
  }
  const names = readdirSync(paths.lock);
  if (names.length !== 1 || names[0] !== MARKER_NAME) {
    throw manualError('Bash cutover fence directory is not exact');
  }
  const directoryIdentity = identityFromStat(directoryMetadata, 'Bash cutover fence directory');
  const marker = readRegularFileBound(paths.marker, 4096, 'Bash cutover fence marker');
  let parsed;
  try {
    parsed = JSON.parse(marker.bytes.toString('utf8'));
  } catch (error) {
    throw manualError('Bash cutover fence marker is not canonical JSON: ' + error.message);
  }
  if (!identitiesEqual(
    normalizeIdentity(parsed.directory_identity, 'directory_identity'),
    directoryIdentity,
  ) || !identitiesEqual(
    normalizeIdentity(parsed.self_identity, 'self_identity'),
    marker.identity,
  ) || !canonicalMarker(directoryIdentity, marker.identity).equals(marker.bytes)) {
    throw manualError('Bash cutover fence identity or bytes do not match');
  }
  return {
    directoryIdentity,
    directoryMetadataTag: platformMetadataTag('directory'),
    marker,
  };
}

function inspectLegacyTopology(paths) {
  if (!existsSync(paths.review)) return { kind: 'fresh' };
  const metadata = lstatSync(paths.review);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return { kind: 'manual', reason: 'legacy-not-quiescent' };
  }
  const names = readdirSync(paths.review);
  const expected = new Set([
    RESERVATION_NAME,
    LOCK_NAME,
    SLOT_NAMES.a,
    SLOT_NAMES.b,
  ]);
  for (const name of names) {
    if (expected.has(name)) continue;
    if (LEGACY_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))
        || name.startsWith('.pending-mutation.v3.')) {
      return { kind: 'manual', reason: 'legacy-not-quiescent' };
    }
  }
  const reservationExists = names.includes(RESERVATION_NAME);
  const lockExists = names.includes(LOCK_NAME);
  if (lockExists && !reservationExists) {
    return { kind: 'manual', reason: 'legacy-not-quiescent' };
  }
  if (!reservationExists) return { kind: 'fresh' };
  try {
    const reservation = validateReservation(paths.reservation);
    if (!lockExists) return { kind: 'node-fence', reservation };
    const lock = validateLock(paths);
    return { kind: 'fenced', reservation, lock };
  } catch {
    return { kind: 'manual', reason: 'legacy-not-quiescent' };
  }
}

function fenceBarrier(options, label) {
  if (typeof options.fenceHook !== 'function') return;
  try {
    options.fenceHook(label);
  } catch (error) {
    error.retainFenceResidue = true;
    throw error;
  }
}

function cutoverBarrier(options, label, retainOperation = true) {
  if (typeof options.cutoverHook !== 'function') return;
  try {
    options.cutoverHook(label);
  } catch (error) {
    if (retainOperation) error.retainOperation = true;
    throw error;
  }
}

function createReservation(paths, options) {
  const descriptor = openSync(paths.reservation, 'wx', 0o600);
  let handedOff = false;
  try {
    const identity = descriptorIdentity(descriptor, 'Node cutover fence');
    handedOff = true;
    persistDurableDescriptor({
      descriptor,
      file: paths.reservation,
      bytes: canonicalReservation(identity),
    });
  } finally {
    if (!handedOff) closeSync(descriptor);
  }
  fenceBarrier(options, 'node-fence-created');
  return validateReservation(paths.reservation);
}

function createLock(paths, options) {
  mkdirSync(paths.lock, { mode: 0o700 });
  fsyncParentDirectory(paths.lock);
  fenceBarrier(options, 'bash-directory-created');
  const directoryIdentity = pathIdentity(paths.lock, 'Bash cutover fence directory');
  const descriptor = openSync(paths.marker, 'wx', 0o600);
  let handedOff = false;
  try {
    const markerIdentity = descriptorIdentity(descriptor, 'Bash cutover fence marker');
    handedOff = true;
    persistDurableDescriptor({
      descriptor,
      file: paths.marker,
      bytes: canonicalMarker(directoryIdentity, markerIdentity),
    });
  } finally {
    if (!handedOff) closeSync(descriptor);
  }
  fenceBarrier(options, 'bash-marker-created');
  return validateLock(paths);
}

function ensureFences(paths, topology, options) {
  if (topology.kind === 'manual') return topology;
  mkdirSync(paths.review, { recursive: true, mode: 0o700 });
  let reservation = topology.reservation;
  let lock = topology.lock;
  try {
    if (!reservation) reservation = createReservation(paths, options);
    if (!lock) lock = createLock(paths, options);
  } catch (error) {
    if (error.retainFenceResidue) throw error;
    return { kind: 'manual', reason: 'legacy-not-quiescent', error };
  }
  const finalTopology = inspectLegacyTopology(paths);
  if (finalTopology.kind !== 'fenced') {
    return { kind: 'manual', reason: 'legacy-not-quiescent' };
  }
  return finalTopology;
}

function encodeFenceInventory(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('fence inventory entries must be a nonempty array');
  }
  const encoded = entries.map((entry) => {
    assertPlainObject(entry, 'fence inventory entry');
    if (entry.kind !== 'file' && entry.kind !== 'directory') {
      throw new TypeError('fence inventory entry kind is invalid');
    }
    const relativePath = assertScalarString(entry.relativePath, 'fence inventory path', {
      nonempty: true,
      maxBytes: PATH_MAX_BYTES,
    });
    const allowedTags = new Set([
      'posix-file-0600',
      'posix-dir-0700',
      'win32-file-rw',
      'win32-dir-marker-owned',
    ]);
    if (!allowedTags.has(entry.metadataTag)) {
      throw new TypeError('fence inventory metadata tag is invalid');
    }
    const identity = normalizeIdentity(entry.identity, 'fence inventory identity');
    if (!Buffer.isBuffer(entry.payload)) {
      throw new TypeError('fence inventory payload must be a Buffer');
    }
    return Buffer.concat([
      Buffer.from(
        entry.kind + '\0' + relativePath + '\0' + entry.metadataTag + '\0'
          + identity.dev + '\0' + identity.ino + '\0' + entry.payload.length + '\0',
        'utf8',
      ),
      entry.payload,
      Buffer.from([0]),
    ]);
  });
  encoded.sort(Buffer.compare);
  return Buffer.concat([Buffer.from('deep-review-v3-fences-v1\0'), ...encoded]);
}

function fenceInventory(paths) {
  const reservation = validateReservation(paths.reservation);
  const lock = validateLock(paths);
  const entries = [
    {
      kind: 'file',
      relativePath: RESERVATION_NAME,
      metadataTag: reservation.metadataTag,
      identity: reservation.identity,
      payload: reservation.bytes,
    },
    {
      kind: 'directory',
      relativePath: LOCK_NAME,
      metadataTag: lock.directoryMetadataTag,
      identity: lock.directoryIdentity,
      payload: Buffer.alloc(0),
    },
    {
      kind: 'file',
      relativePath: LOCK_NAME + '/' + MARKER_NAME,
      metadataTag: lock.marker.metadataTag,
      identity: lock.marker.identity,
      payload: lock.marker.bytes,
    },
  ];
  const stream = encodeFenceInventory(entries);
  if (stream.length > 4096) throw manualError('fence inventory exceeds byte cap');
  return {
    sha256: sha256(stream),
    entries: 3,
    bytes: reservation.bytes.length + lock.marker.bytes.length,
  };
}

function readAuthority(preflight) {
  const result = runGit(
    preflight.repo,
    ['rev-parse', '--verify', '--quiet', PUBLICATION_REF],
    preflight,
  );
  if (result.code === 1) return null;
  if (result.code !== 0) throw manualError('publication ref could not be read');
  const oid = firstLine(result.stdout);
  repositoryOid(preflight, oid, 'publication OID');
  const type = requireGit(
    preflight.repo,
    ['cat-file', '-t', oid],
    preflight,
    'publication object type',
  );
  if (firstLine(type.stdout) !== 'blob') throw manualError('publication ref does not name a blob');
  const blob = requireGit(
    preflight.repo,
    ['cat-file', 'blob', oid],
    { ...preflight, maxBuffer: PUBLICATION_MAX_BYTES + 1 },
    'publication object read',
  ).stdout;
  let publication;
  try {
    publication = decodePublication(blob);
  } catch (error) {
    throw manualError('publication blob is foreign or noncanonical: ' + error.message);
  }
  return { oid, bytes: blob, publication };
}

export function buildUpdateRefInput({ oldOid, newOid, headOid }) {
  canonicalOid(newOid, 'new OID');
  let input = 'start\0';
  if (headOid !== undefined) {
    if (headOid !== null) canonicalOid(headOid, 'HEAD OID');
    input += 'verify HEAD\0' + (headOid || '') + '\0';
  }
  if (oldOid === null) {
    input += 'create ' + PUBLICATION_REF + '\0' + newOid + '\0prepare\0commit\0';
    return Buffer.from(input, 'latin1');
  }
  canonicalOid(oldOid, 'old OID');
  input += 'update ' + PUBLICATION_REF + '\0' + newOid + '\0'
    + oldOid + '\0prepare\0commit\0';
  return Buffer.from(input, 'latin1');
}

function hashPublication(preflight, publication, counter) {
  if (counter.count >= MAX_CANDIDATES) {
    throw protocolError('publication candidate cap exhausted', 'PUBLICATION_CANDIDATE_CAP');
  }
  const built = buildPublication(publication);
  const bytes = encodePublication(built);
  const hashed = requireGit(
    preflight.repo,
    ['hash-object', '-w', '--stdin'],
    { ...preflight, input: bytes },
    'publication candidate write',
  );
  counter.count += 1;
  const oid = firstLine(hashed.stdout);
  repositoryOid(preflight, oid, 'publication candidate OID');
  const check = requireGit(
    preflight.repo,
    ['cat-file', 'blob', oid],
    { ...preflight, maxBuffer: PUBLICATION_MAX_BYTES + 1 },
    'publication candidate verification',
  ).stdout;
  if (!check.equals(bytes)) throw manualError('publication candidate verification mismatch');
  return { oid, bytes, publication: built };
}

function checkedAuthorityInventory(preflight, counter, stage, purpose) {
  try {
    const inventory = inventoryAuthority(preflight.repo, preflight);
    if (typeof counter.transitionHook === 'function') {
      counter.transitionHook({ stage, purpose });
    }
    return inventory;
  } catch (error) {
    counter.frozen = true;
    throw manualError(
      'reserved authority inventory freeze: ' + error.message,
      'AUTHORITY_INVENTORY_FROZEN',
    );
  }
}

function casAuthority(
  preflight,
  oldAuthority,
  publication,
  counter,
  purpose = 'publication-transition',
  headGuard,
) {
  const candidate = hashPublication(preflight, publication, counter);
  checkedAuthorityInventory(preflight, counter, 'after-pre-inventory', purpose);
  const transaction = runGit(
    preflight.repo,
    ['-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin', '-z'],
    {
      ...preflight,
      input: buildUpdateRefInput({
        oldOid: oldAuthority ? oldAuthority.oid : null,
        newOid: candidate.oid,
        headOid: headGuard,
      }),
    },
  );
  if (transaction.code !== 0) {
    throw protocolError('publication compare-and-swap lost', 'PUBLICATION_CAS_LOST');
  }
  const observed = readAuthority(preflight);
  if (!observed || observed.oid !== candidate.oid || !observed.bytes.equals(candidate.bytes)) {
    throw manualError('publication post-CAS verification failed');
  }
  if (typeof counter.transitionHook === 'function') {
    try {
      counter.transitionHook({ stage: 'before-post-inventory', purpose });
    } catch (error) {
      counter.frozen = true;
      throw error;
    }
  }
  checkedAuthorityInventory(preflight, counter, 'after-post-inventory', purpose);
  return observed;
}

function nextPublicationSequence(publication) {
  const current = BigInt(publication.publication_seq);
  if (current >= UINT64_MAX) throw manualError('publication sequence exhausted');
  return (current + 1n).toString();
}

export function currentHostHash() {
  const value = hostname().trim().normalize('NFC').toLowerCase();
  if (!value || value.includes('\0')) throw protocolError('hostname is invalid');
  return sha256(Buffer.concat([
    Buffer.from('deep-review-host-v1\0', 'utf8'),
    Buffer.from(value, 'utf8'),
  ]));
}

export function processStartMs() {
  return PROCESS_START_MS;
}

function currentOperation(baseOid) {
  return {
    operation_id: randomUUID(),
    host_hash: currentHostHash(),
    pid: String(process.pid),
    process_start_ms: String(PROCESS_START_MS),
    base_publication_oid: baseOid,
  };
}

function operationMatchesId(operation, operationId) {
  return Boolean(operation && operationId && operation.operation_id === operationId);
}

function defaultProcessProbe(pid) {
  try {
    process.kill(Number(pid), 0);
    return {
      status: 'live',
      startMs: pid === String(process.pid) ? PROCESS_START_MS : undefined,
    };
  } catch (error) {
    if (error && error.code === 'ESRCH') return { status: 'dead' };
    if (error && error.code === 'EPERM') return { status: 'eperm' };
    return { status: 'unknown' };
  }
}

function sessionTimelineConsistent(owner, now = Date.now()) {
  if (!owner || typeof owner !== 'object') return false;
  const processStartMs = Number(owner.process_start_ms);
  const startedAt = Date.parse(owner.started_at);
  return Number.isFinite(now)
    && Number.isSafeInteger(processStartMs)
    && processStartMs >= 0
    && Number.isFinite(startedAt)
    && processStartMs <= startedAt
    && processStartMs <= now
    && startedAt <= now;
}

export function classifyLiveness(owner, options = {}) {
  if (!owner || typeof owner !== 'object') return 'manual';
  const now = options.now === undefined ? Date.now() : options.now;
  if (!sessionTimelineConsistent(owner, now)) return 'manual';
  if (owner.host_hash !== currentHostHash()) return 'foreign';
  const probe = (options.processProbe || defaultProcessProbe)(owner.pid);
  if (probe.status === 'eperm') return 'uncertain';
  if (probe.status === 'dead') return 'departed';
  if (probe.status !== 'live') return 'manual';
  if (probe.startMs !== undefined && String(probe.startMs) !== String(owner.process_start_ms)) {
    return 'uncertain';
  }
  return 'live';
}

function slotPath(paths, slot) {
  return slot === 'a' ? paths.slotA : paths.slotB;
}

function readSlot(paths, slot, options = {}) {
  const snapshot = readRegularFileBound(slotPath(paths, slot), SLOT_MAX_BYTES, 'protocol slot ' + slot);
  let record;
  try {
    record = decodeRecord(snapshot.bytes, options);
    validateRecordSemantics(record);
  } catch (error) {
    throw manualError('protocol slot ' + slot + ' is torn or noncanonical: ' + error.message);
  }
  if (record.slot !== slot || !identitiesEqual(record.self_slot_identity, snapshot.identity)) {
    throw manualError('protocol slot ' + slot + ' self identity mismatch');
  }
  return { slot, path: slotPath(paths, slot), identity: snapshot.identity, bytes: snapshot.bytes, record };
}

function validateRecordFence(record, publication, inventory) {
  if (record.cutover_id !== publication.cutover_id
      || record.fence_inventory.sha256 !== inventory.sha256
      || record.fence_inventory.entries !== inventory.entries
      || record.fence_inventory.bytes !== inventory.bytes) {
    throw manualError('protocol slot fence or cutover binding mismatch');
  }
}

function inspectSlotCandidate(paths, slot) {
  try {
    return readSlot(paths, slot);
  } catch (error) {
    const snapshot = readRegularFileBound(
      slotPath(paths, slot),
      SLOT_MAX_BYTES,
      'protocol slot ' + slot,
    );
    return {
      slot,
      path: slotPath(paths, slot),
      identity: snapshot.identity,
      bytes: snapshot.bytes,
      record: null,
      torn: true,
      error,
    };
  }
}

function inspectReadyState(preflight, paths, authority, inventory, options = {}) {
  const publication = authority.publication;
  if (publication.cutover_phase !== 'ready') {
    throw manualError('cutover is not ready');
  }
  const a = inspectSlotCandidate(paths, 'a');
  const b = inspectSlotCandidate(paths, 'b');
  const valid = [a, b].filter((slot) => slot.record !== null);
  if (valid.length === 0) throw manualError('both protocol slots are torn');
  for (const slot of valid) validateRecordFence(slot.record, publication, inventory);
  if (valid.length === 2) {
    if (!identitiesEqual(a.record.peer_slot_identity, b.identity)
        || !identitiesEqual(b.record.peer_slot_identity, a.identity)) {
      throw manualError('protocol slot peer binding mismatch');
    }
  } else {
    const survivor = valid[0];
    const torn = survivor.slot === 'a' ? b : a;
    if (!identitiesEqual(survivor.record.peer_slot_identity, torn.identity)) {
      throw manualError('surviving slot cannot prove torn peer identity');
    }
    if (publication.session !== null && publication.selected_slot !== survivor.slot) {
      throw manualError('selected protocol slot is torn');
    }
  }
  let selectedRecord = null;
  if (publication.session !== null) {
    const selected = publication.selected_slot === 'a' ? a : b;
    selectedRecord = selected.record;
    if (selectedRecord.session_id !== publication.session.session_id
        || selectedRecord.phase !== publication.session.phase
        || selectedRecord.record_seq !== publication.selected_record_seq
        || selectedRecord.record_digest !== publication.selected_record_digest) {
      throw manualError('selected record does not bind publication session');
    }
    if (deriveLease(
      publication.cutover_id,
      selectedRecord.session_id,
      selectedRecord.record_seq,
      selectedRecord.record_digest,
    ) !== publication.session.lease_id) {
      throw manualError('selected record lease mismatch');
    }
    const timelineValid = sessionTimelineConsistent({
      ...selectedRecord.owner_process,
      started_at: selectedRecord.started_at,
    }, options.now === undefined ? Date.now() : options.now);
    if (!timelineValid) {
      throw manualError('selected record has an inconsistent session timeline');
    }
    if (selectedRecord.commit_hash !== null) {
      repositoryOid(preflight, selectedRecord.commit_hash, 'selected commit_hash');
    }
  }
  return {
    status: 'ready',
    authority,
    publication,
    selectedRecord,
    slots: [a, b],
    fence_inventory: inventory,
    preflight,
    paths,
  };
}

function rereadContextAuthority(context, purpose) {
  const observed = readAuthority(context.preflight);
  if (!observed || observed.oid !== context.authority.oid
      || !observed.bytes.equals(context.authority.bytes)) {
    throw manualError('publication authority changed during ' + purpose);
  }
  context.authority = observed;
  return observed;
}

function reinspectReadyContext(context, purpose, authorityAlreadyRead = false) {
  if (!authorityAlreadyRead) rereadContextAuthority(context, purpose);
  const topology = inspectLegacyTopology(context.paths);
  if (topology.kind !== 'fenced') {
    throw manualError('ready-state legacy topology changed during ' + purpose);
  }
  const inventory = fenceInventory(context.paths);
  checkedAuthorityInventory(
    context.preflight,
    context.counter,
    'after-ready-reinspection',
    purpose,
  );
  const inspection = inspectReadyState(
    context.preflight,
    context.paths,
    context.authority,
    inventory,
    context.inspectionOptions,
  );
  context.inventory = inventory;
  context.inspection = inspection;
  return inspection;
}

function reinspectOperationContext(context, purpose) {
  rereadContextAuthority(context, purpose);
  if (context.authority.publication.cutover_phase === 'ready') {
    return reinspectReadyContext(context, purpose, true);
  }
  checkedAuthorityInventory(
    context.preflight,
    context.counter,
    'after-operation-reinspection',
    purpose,
  );
  context.inspection = null;
  return null;
}

function createSlot(paths, slot, makeRecord) {
  const file = slotPath(paths, slot);
  const descriptor = openSync(file, 'wx', 0o600);
  let record;
  let handedOff = false;
  try {
    const identity = descriptorIdentity(descriptor, 'protocol slot ' + slot);
    record = buildRecord(makeRecord(identity));
    handedOff = true;
    persistDurableDescriptor({ descriptor, file, bytes: encodeRecord(record) });
  } finally {
    if (!handedOff) closeSync(descriptor);
  }
  const read = readSlot(paths, slot, {
    transition: slot === 'a' && record.peer_slot_identity === null ? 'initial-a' : undefined,
  });
  return read;
}

function writeSlot(paths, slot, recordInput, options = {}) {
  const file = slotPath(paths, slot);
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw manualError('protocol slot ' + slot + ' is not writable regular state');
  }
  const beforeIdentity = identityFromStat(before, 'protocol slot ' + slot);
  const descriptor = openSync(file, 'r+');
  let handedOff = false;
  try {
    const descriptorIdentityValue = descriptorIdentity(descriptor, 'protocol slot ' + slot);
    if (!identitiesEqual(beforeIdentity, descriptorIdentityValue)) {
      throw manualError('protocol slot ' + slot + ' identity changed while opening');
    }
    if (typeof options.slotWriteHook === 'function') {
      options.slotWriteHook({ path: file, fd: descriptor });
    }
    const record = buildRecord({
      ...recordInput,
      slot,
      self_slot_identity: beforeIdentity,
    });
    handedOff = true;
    persistDurableDescriptor({ descriptor, file, bytes: encodeRecord(record) });
    const after = lstatSync(file, { bigint: true });
    const afterIdentity = identityFromStat(after, 'protocol slot ' + slot);
    if (!identitiesEqual(afterIdentity, beforeIdentity)) {
      throw manualError('protocol slot ' + slot + ' was replaced during descriptor write');
    }
    const verified = readSlot(paths, slot);
    if (verified.record.record_digest !== record.record_digest) {
      throw manualError('protocol slot write verification mismatch');
    }
    if (typeof options.slotWriteAfterHook === 'function') {
      options.slotWriteAfterHook({ path: file, record: verified.record });
    }
    return verified;
  } finally {
    if (!handedOff) closeSync(descriptor);
  }
}

function idleRecord(slot, phase, cutoverId, inventory, selfIdentity, peerIdentity) {
  return {
    schema_version: 3,
    slot,
    phase,
    cutover_id: cutoverId,
    session_id: null,
    record_seq: '0',
    owner_token: null,
    owner_process: { host_hash: null, pid: null, process_start_ms: null },
    started_at: null,
    commit_hash: null,
    restore_attempts: 0,
    recovery_kind: null,
    attempt_state: null,
    files: [],
    fence_inventory: inventory,
    self_slot_identity: selfIdentity,
    peer_slot_identity: peerIdentity,
  };
}

function cutoverId(preflight, inventory) {
  return sha256(Buffer.concat([
    Buffer.from('deep-review-v3-cutover-v1\0', 'utf8'),
    Buffer.from(preflight.gitDirectory, 'utf8'),
    Buffer.from(inventory.sha256, 'ascii'),
  ]));
}

function emptyPublication(cutover, inventory, operation) {
  return {
    publication_schema: 1,
    protocol: PROTOCOL,
    cutover_id: cutover,
    publication_seq: '0',
    cutover_phase: 'fences-bound',
    selected_slot: null,
    selected_record_seq: null,
    selected_record_digest: null,
    session: null,
    operation,
    fence_inventory_sha256: inventory.sha256,
  };
}

function replacePublication(publication, changes, sequenceChange = true) {
  return {
    ...publication,
    ...changes,
    publication_seq: sequenceChange
      ? nextPublicationSequence(publication)
      : publication.publication_seq,
    publication_digest: undefined,
  };
}

function acquireOperation(preflight, authority, counter) {
  if (authority.publication.operation !== null) {
    throw protocolError('publication operation is already owned', 'MUTATION_BUSY');
  }
  const operation = currentOperation(authority.oid);
  return casAuthority(
    preflight,
    authority,
    replacePublication(authority.publication, { operation }, false),
    counter,
    'operation-acquire',
  );
}

function releaseOperation(context) {
  if (!context.authority.publication.operation) return;
  if (context.counter.frozen) {
    throw manualError('reserved authority inventory is frozen', 'AUTHORITY_INVENTORY_FROZEN');
  }
  reinspectOperationContext(context, 'operation release precondition');
  const headGuard = Object.hasOwn(context, 'authorityHeadGuard')
    ? context.authorityHeadGuard
    : (context.inspection && context.inspection.selectedRecord
      ? context.inspection.selectedRecord.commit_hash
      : undefined);
  const operation = context.authority.publication.operation;
  let next;
  if (!context.changed && operation.base_publication_oid
      && !operationProjectionChanged(context.preflight, context.authority)) {
    const base = probeGitObject(
      context.preflight,
      operation.base_publication_oid,
      'operation base publication',
    );
    if (base.status === 'present') {
      if (base.type !== 'blob') {
        throw manualError('operation base publication does not name a blob');
      }
      checkedAuthorityInventory(
        context.preflight,
        context.counter,
        'after-pre-inventory',
        'operation-release',
      );
      const transaction = runGit(
        context.preflight.repo,
        ['-c', 'core.logAllRefUpdates=false', 'update-ref', '--stdin', '-z'],
        {
          ...context.preflight,
          input: buildUpdateRefInput({
            oldOid: context.authority.oid,
            newOid: operation.base_publication_oid,
            headOid: headGuard,
          }),
        },
      );
      if (transaction.code !== 0) throw manualError('operation base-OID release failed');
      const restored = readAuthority(context.preflight);
      if (!restored || restored.oid !== operation.base_publication_oid) {
        throw manualError('operation base-OID release verification failed');
      }
      if (typeof context.counter.transitionHook === 'function') {
        try {
          context.counter.transitionHook({
            stage: 'before-post-inventory',
            purpose: 'operation-release',
          });
        } catch (error) {
          context.counter.frozen = true;
          throw error;
        }
      }
      checkedAuthorityInventory(
        context.preflight,
        context.counter,
        'after-post-inventory',
        'operation-release',
      );
      context.authority = restored;
      context.inspection = null;
      reinspectOperationContext(context, 'operation release');
      return;
    }
  }
  next = replacePublication(
    context.authority.publication,
    { operation: null },
    false,
  );
  context.authority = casAuthority(
    context.preflight,
    context.authority,
    next,
    context.counter,
    'operation-release',
    headGuard,
  );
  context.inspection = null;
  reinspectOperationContext(context, 'operation release');
}

function operationOwnerForLiveness(operation) {
  const processStartMs = Number(operation.process_start_ms);
  if (!Number.isFinite(processStartMs)
      || !Number.isSafeInteger(processStartMs)
      || processStartMs < 0) {
    throw protocolError('cutover operation process_start_ms is invalid', 'MUTATION_BUSY');
  }
  const processStart = new Date(processStartMs);
  if (!Number.isFinite(processStart.getTime())) {
    throw protocolError(
      'cutover operation process_start_ms is not Date-representable',
      'MUTATION_BUSY',
    );
  }
  return {
    ...operation,
    started_at: processStart.toISOString(),
  };
}

function operationProjectionChanged(preflight, authority) {
  const operation = authority.publication.operation;
  if (!operation || !operation.base_publication_oid) return true;
  const probe = probeGitObject(preflight, operation.base_publication_oid, 'operation base publication');
  if (probe.status === 'missing') return true;
  if (probe.type !== 'blob') throw manualError('operation base publication does not name a blob');
  const result = requireGit(
    preflight.repo,
    ['cat-file', 'blob', operation.base_publication_oid],
    { ...preflight, maxBuffer: PUBLICATION_MAX_BYTES + 1 },
    'operation base publication read',
  );
  try {
    const equivalent = buildPublication({
      ...authority.publication,
      publication_digest: undefined,
      operation: null,
    });
    return !encodePublication(equivalent).equals(result.stdout);
  } catch {
    return true;
  }
}

function publicationWithCurrentOperationBase(context, publication) {
  if (publication.operation === null) return publication;
  const base = hashPublication(
    context.preflight,
    {
      ...publication,
      publication_digest: undefined,
      operation: null,
    },
    context.counter,
  );
  return {
    ...publication,
    publication_digest: undefined,
    operation: {
      ...publication.operation,
      base_publication_oid: base.oid,
    },
  };
}

function validateOperationReceipt(preflight, authority) {
  const publication = authority.publication;
  const operation = publication.operation;
  if (operation === null) return;
  if (operation.base_publication_oid === null) {
    if (publication.cutover_phase === 'ready') {
      throw manualError('ready operation has a null base publication OID');
    }
    return;
  }
  const probe = probeGitObject(preflight, operation.base_publication_oid, 'operation base publication');
  if (probe.status === 'missing') return;
  if (probe.type !== 'blob') {
    throw manualError('operation base publication does not name a blob');
  }
  const result = requireGit(
    preflight.repo,
    ['cat-file', 'blob', operation.base_publication_oid],
    { ...preflight, maxBuffer: PUBLICATION_MAX_BYTES + 1 },
    'operation base publication read',
  );
  let base;
  try {
    base = decodePublication(result.stdout);
  } catch (error) {
    throw manualError('operation base publication is foreign: ' + error.message);
  }
  const projection = buildPublication({
    ...publication,
    publication_digest: undefined,
    operation: null,
  });
  if (base.operation !== null
      || !encodePublication(projection).equals(result.stdout)) {
    throw manualError('operation base publication binding mismatch');
  }
}

function ownOrAcquireCutoverOperation(
  preflight,
  authority,
  counter,
  expectedOperationId,
  options = {},
) {
  const operation = authority.publication.operation;
  if (operation === null) return acquireOperation(preflight, authority, counter);
  validateOperationReceipt(preflight, authority);
  if (operationMatchesId(operation, expectedOperationId)) return authority;
  const liveness = classifyLiveness(operationOwnerForLiveness(operation), {
    now: options.now,
    processProbe: options.processProbe,
  });
  if (liveness !== 'departed') {
    throw protocolError('cutover operation is ' + liveness, 'MUTATION_BUSY');
  }
  const reconciled = casAuthority(
    preflight,
    authority,
    replacePublication(authority.publication, { operation: null }, false),
    counter,
    'operation-reconcile',
  );
  return acquireOperation(preflight, reconciled, counter);
}

function advanceCutover(
  preflight,
  paths,
  authority,
  inventory,
  counter,
  expectedOperationId,
  options = {},
  onOperationOwned = () => {},
) {
  let current = ownOrAcquireCutoverOperation(
    preflight,
    authority,
    counter,
    expectedOperationId,
    options,
  );
  onOperationOwned(current.publication.operation.operation_id);
  const publication = () => current.publication;
  if (publication().cutover_phase === 'fences-bound') {
    let a;
    if (existsSync(paths.slotA)) {
      a = readSlot(paths, 'a', { transition: 'initial-a' });
    } else {
      a = createSlot(paths, 'a', (self) => idleRecord(
        'a',
        'cutover-anchor',
        publication().cutover_id,
        inventory,
        self,
        null,
      ));
    }
    validateRecordFence(a.record, publication(), inventory);
    cutoverBarrier(options, 'slot-a-captured');
    current = casAuthority(
      preflight,
      current,
      replacePublication(publication(), { cutover_phase: 'slot-a' }),
      counter,
    );
  }
  if (publication().cutover_phase === 'slot-a') {
    const a = readSlot(paths, 'a', { transition: 'initial-a' });
    let b;
    if (existsSync(paths.slotB)) {
      b = readSlot(paths, 'b');
    } else {
      b = createSlot(paths, 'b', (self) => idleRecord(
        'b',
        'cutover-anchor',
        publication().cutover_id,
        inventory,
        self,
        a.identity,
      ));
    }
    if (!identitiesEqual(b.record.peer_slot_identity, a.identity)) {
      throw manualError('slot B cutover binding mismatch');
    }
    cutoverBarrier(options, 'slot-b-captured');
    current = casAuthority(
      preflight,
      current,
      replacePublication(publication(), { cutover_phase: 'slot-b' }),
      counter,
    );
  }
  if (publication().cutover_phase === 'slot-b') {
    const b = readSlot(paths, 'b');
    let a;
    let mutualA;
    try {
      a = readSlot(paths, 'a', { transition: 'initial-a' });
      mutualA = writeSlot(paths, 'a', idleRecord(
        'a',
        'cutover-anchor',
        publication().cutover_id,
        inventory,
        a.identity,
        b.identity,
      ), options);
      cutoverBarrier(options, 'mutual-a-written');
    } catch (error) {
      if (error.retainOperation) throw error;
      mutualA = readSlot(paths, 'a');
      if (mutualA.record.phase !== 'cutover-anchor') throw error;
    }
    if (!identitiesEqual(mutualA.record.peer_slot_identity, b.identity)) {
      throw manualError('slot A mutual binding failed');
    }
    current = casAuthority(
      preflight,
      current,
      replacePublication(publication(), { cutover_phase: 'mutual-slots' }),
      counter,
    );
  }
  if (publication().cutover_phase === 'mutual-slots') {
    const a = readSlot(paths, 'a');
    const b = readSlot(paths, 'b');
    const emptyB = writeSlot(paths, 'b', idleRecord(
      'b',
      'empty',
      publication().cutover_id,
      inventory,
      b.identity,
      a.identity,
    ), options);
    if (!identitiesEqual(emptyB.record.peer_slot_identity, a.identity)) {
      throw manualError('slot B ready binding failed');
    }
    current = casAuthority(
      preflight,
      current,
      replacePublication(publication(), { cutover_phase: 'ready', operation: null }),
      counter,
      'cutover-ready',
    );
    cutoverBarrier(options, 'ready-published', false);
  }
  return current;
}

function prepareReady(options = {}) {
  const preflight = preflightRepository(options);
  const paths = protocolPaths(preflight.repo);
  const counter = {
    count: 0,
    frozen: false,
    transitionHook: options.authorityTransitionHook,
  };
  let ownedOperationId = null;
  let authority = readAuthority(preflight);
  let topology = inspectLegacyTopology(paths);
  if (topology.kind === 'manual') {
    return { status: 'manual', reason: 'legacy-not-quiescent' };
  }
  if (authority !== null && topology.kind !== 'fenced') {
    return { status: 'manual', reason: 'legacy-not-quiescent' };
  }
  if (authority === null) {
    if (existsSync(paths.slotA) || existsSync(paths.slotB)) {
      return { status: 'manual', reason: 'legacy-not-quiescent' };
    }
    topology = ensureFences(paths, topology, options);
    if (topology.kind !== 'fenced') {
      return { status: 'manual', reason: 'legacy-not-quiescent' };
    }
  }
  const inventory = topology.kind === 'fenced' ? fenceInventory(paths) : null;
  if (inventory !== null) fenceBarrier(options, 'fence-inventory-bound');
  if (authority === null) {
    const id = cutoverId(preflight, inventory);
    const operation = currentOperation(null);
    ownedOperationId = operation.operation_id;
    authority = casAuthority(
      preflight,
      null,
      emptyPublication(id, inventory, operation),
      counter,
      'cutover-create',
    );
    cutoverBarrier(options, 'authority-created');
  } else {
    if (authority.publication.fence_inventory_sha256 !== inventory.sha256) {
      return { status: 'manual', reason: 'fence-binding-mismatch' };
    }
  }
  try {
    if (authority.publication.cutover_phase !== 'ready') {
      authority = advanceCutover(
        preflight,
        paths,
        authority,
        inventory,
        counter,
        ownedOperationId,
        options,
        (operationId) => { ownedOperationId = operationId; },
      );
      if (authority.publication.operation === null) {
        authority = acquireOperation(preflight, authority, counter);
      }
      ownedOperationId = authority.publication.operation.operation_id;
    } else {
      const readyBeforeOperation = inspectReadyState(
        preflight,
        paths,
        authority,
        inventory,
        options,
      );
      if (readyBeforeOperation.selectedRecord?.commit_hash === null
          && currentCommit(preflight) !== null) {
        throw manualError('selected commit_hash is null outside a zero-commit repository');
      }
      if (authority.publication.operation === null) {
        authority = acquireOperation(preflight, authority, counter);
      } else {
        authority = ownOrAcquireCutoverOperation(
          preflight,
          authority,
          counter,
          null,
          options,
        );
      }
      ownedOperationId = authority.publication.operation.operation_id;
    }
    const inspection = inspectReadyState(preflight, paths, authority, inventory, options);
    return {
      status: 'ready',
      inspection,
      preflight,
      paths,
      authority,
      inventory,
      counter,
      inspectionOptions: { now: options.now },
      ownedOperationId,
      changed: operationProjectionChanged(preflight, authority),
    };
  } catch (error) {
    if (error instanceof MutationProtocolError && error.code === 'MUTATION_BUSY') {
      return { status: 'manual', reason: 'operation-busy' };
    }
    try {
      const latest = readAuthority(preflight);
      if (!error.retainOperation
          && latest
          && operationMatchesId(latest.publication.operation, ownedOperationId)) {
        const cleanup = {
          preflight,
          paths,
          authority: latest,
          inventory,
          counter,
          changed: operationProjectionChanged(preflight, latest),
        };
        releaseOperation(cleanup);
      }
    } catch (releaseError) {
      error = appendProtocolFailure(error, 'release', releaseError);
    }
    throw error;
  }
}

export function ensureCutover(options = {}) {
  try {
    const context = prepareReady(options);
    if (context.status !== 'ready') return context;
    releaseOperation(context);
    return { status: 'ready' };
  } catch (error) {
    if (error instanceof MutationProtocolError || error instanceof TypeError) {
      return {
        status: 'manual',
        reason: error.message || error.code || 'foreign-protocol-state',
        message: error.message,
        error: serializeProtocolError(error),
      };
    }
    throw error;
  }
}

export function inspectProtocol(options = {}) {
  const preflight = preflightRepository(options);
  const paths = protocolPaths(preflight.repo);
  const topology = inspectLegacyTopology(paths);
  if (topology.kind !== 'fenced') {
    return { status: 'manual', reason: 'legacy-not-quiescent' };
  }
  const inventory = fenceInventory(paths);
  const authority = readAuthority(preflight);
  if (!authority) return { status: 'manual', reason: 'publication-missing' };
  const inspection = inspectReadyState(preflight, paths, authority, inventory, options);
  return {
    status: 'ready',
    publication: inspection.publication,
    selectedRecord: inspection.selectedRecord,
    slots: inspection.slots.map((slot) => ({
      slot: slot.slot,
      identity: slot.identity,
      record: slot.record,
    })),
    fence_inventory: inventory,
    publication_oid: authority.oid,
  };
}

function targetFilesystemPath(repo, file) {
  return join(repo, ...file.split('/'));
}

function requireRegularTarget(repo, file) {
  let current = repo;
  const segments = file.split('/');
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      throw protocolError('mutation target parent is unavailable: ' + file);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw protocolError('mutation target has an unsafe parent: ' + file);
    }
  }
  const target = targetFilesystemPath(repo, file);
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch (error) {
    throw protocolError('mutation target must be an existing regular file: ' + file);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw protocolError('mutation target must be an existing regular file: ' + file);
  }
  const root = realpathSync.native(repo);
  const physical = realpathSync.native(target);
  const within = relative(root, physical);
  if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
    throw protocolError('mutation target physically escapes the repository: ' + file);
  }
}

function requireRegularTargets(repo, files) {
  for (const file of files) requireRegularTarget(repo, file);
}

function literalPathspec(file) {
  return ':(literal)' + file;
}

function nulPathBuffer(files, literal = false) {
  const chunks = [];
  for (const file of files) {
    chunks.push(encodeGitPath(literal ? literalPathspec(file) : file), Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

function indexEntries(preflight, file, options = {}) {
  return requireGit(
    preflight.repo,
    ['ls-files', '--stage', '-z', '--', literalPathspec(file)],
    { ...preflight, indexFile: options.indexFile },
    'Git index inspection',
  ).stdout;
}

function requireTargetsAbsentFromIndex(preflight, files, options = {}) {
  for (const file of files) {
    if (indexEntries(preflight, file, options).length > 0) {
      throw protocolError(
        'mutation target is already present in the index: ' + file,
        'MUTATION_TARGET_ALREADY_INDEXED',
      );
    }
  }
}

function fullIndexStage(preflight, indexFile) {
  return requireGit(
    preflight.repo,
    ['ls-files', '--stage', '-z'],
    { ...preflight, indexFile },
    'complete Git index projection',
  ).stdout;
}

function unrelatedIndexProjection(buffer, targets) {
  const targetBytes = targets.map((target) => encodeGitPath(target));
  const records = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index < buffer.length && buffer[index] !== 0) continue;
    const record = buffer.subarray(start, index);
    start = index + 1;
    if (record.length === 0) continue;
    const separator = record.indexOf(0x09);
    if (separator < 0) throw manualError('Git index projection is malformed');
    const rawPath = record.subarray(separator + 1);
    if (targetBytes.some((target) => target.equals(rawPath))) continue;
    records.push(record, Buffer.from([0]));
  }
  return Buffer.concat(records);
}

function dynamicObjectHashes(preflight, indexFile) {
  const options = { ...preflight, indexFile };
  const emptyBlob = firstLine(requireGit(
    preflight.repo,
    ['hash-object', '-t', 'blob', '--stdin'],
    { ...options, input: Buffer.alloc(0) },
    'empty blob hash derivation',
  ).stdout);
  const emptyTree = firstLine(requireGit(
    preflight.repo,
    ['hash-object', '-t', 'tree', '--stdin'],
    { ...options, input: Buffer.alloc(0) },
    'empty tree hash derivation',
  ).stdout);
  canonicalOid(emptyBlob);
  canonicalOid(emptyTree);
  return { emptyBlob, emptyTree };
}

function currentCommit(preflight, indexFile) {
  const options = { ...preflight, indexFile };
  const head = runGit(preflight.repo, ['rev-parse', '--verify', 'HEAD'], options);
  if (head.code === 0) return canonicalOid(firstLine(head.stdout), 'HEAD OID');
  const symbolic = runGit(preflight.repo, ['symbolic-ref', '-q', 'HEAD'], options);
  if (symbolic.code === 0) {
    const reference = firstLine(symbolic.stdout);
    if (!reference.startsWith('refs/')) throw manualError('Git returned an invalid HEAD ref');
    const present = runGit(
      preflight.repo,
      ['show-ref', '--verify', '--quiet', reference],
      options,
    );
    if (present.code === 1) return null;
    throw manualError('Git HEAD ref exists but its commit could not be resolved');
  }
  throw manualError('Git HEAD inspection failed');
}

function protocolIntentToAdd({
  preflight,
  file,
  indexFile,
  platform = process.platform,
  capturedCommit,
}) {
  const target = normalizeTarget(file, platform);
  const options = { ...preflight, indexFile };
  const status = requireGit(
    preflight.repo,
    ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--', literalPathspec(target)],
    options,
    'Git intent-to-add status inspection',
  ).stdout;
  const statusEnd = status.indexOf(0);
  const first = status.subarray(0, statusEnd < 0 ? status.length : statusEnd).toString('utf8');
  if (!/^1 \.[AD] /u.test(first)) return false;
  const hashes = dynamicObjectHashes(preflight, indexFile);
  if (capturedCommit !== undefined && capturedCommit !== null) {
    repositoryOid(preflight, capturedCommit, 'captured commit OID');
  }
  const tree = capturedCommit === undefined
    ? (currentCommit(preflight, indexFile) || hashes.emptyTree)
    : (capturedCommit || hashes.emptyTree);
  const raw = requireGit(
    preflight.repo,
    ['diff-index', '--cached', '--raw', '-z', tree, '--', literalPathspec(target)],
    options,
    'Git intent-to-add raw inspection',
  ).stdout;
  const metadataEnd = raw.indexOf(0);
  const metadata = raw.subarray(0, metadataEnd < 0 ? raw.length : metadataEnd).toString('ascii');
  const fields = metadata.split(' ');
  return fields.length >= 5
    && fields[0] === ':000000'
    && fields[3] === hashes.emptyBlob
    && fields[4] === 'A';
}

export function isProtocolIntentToAdd({ repo, file, env, gitRunner, indexFile, platform }) {
  const preflight = preflightRepository({ repo, env, gitRunner });
  return protocolIntentToAdd({ preflight, file, indexFile, platform });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function beginIndexTransaction(preflight) {
  const indexPath = preflight.indexPath;
  const lockPath = indexPath + '.lock';
  const shadowPath = join(
    dirname(indexPath),
    '.' + basename(indexPath) + '.deep-review-' + randomUUID() + '.shadow',
  );
  let lockDescriptor;
  try {
    lockDescriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    throw manualError('Git index restore lock acquisition failed: ' + error.message);
  }
  const transaction = {
    indexPath,
    lockPath,
    shadowPath,
    lockDescriptor,
    lockIdentity: fstatSync(lockDescriptor),
    originalMode: 0o600,
  };
  try {
    if (existsSync(indexPath)) {
      transaction.originalMode = statSync(indexPath).mode & 0o777;
      copyFileSync(indexPath, shadowPath, constants.COPYFILE_EXCL);
    }
    return transaction;
  } catch (error) {
    abortIndexTransaction(transaction);
    throw manualError('Git index shadow initialization failed: ' + error.message);
  }
}

function ownsIndexLock(transaction) {
  try {
    return sameFileIdentity(lstatSync(transaction.lockPath), transaction.lockIdentity);
  } catch {
    return false;
  }
}

function closeIndexLock(transaction) {
  if (transaction.lockDescriptor === undefined) return;
  closeSync(transaction.lockDescriptor);
  transaction.lockDescriptor = undefined;
}

function abortIndexTransaction(transaction) {
  try {
    closeIndexLock(transaction);
  } catch {
    // The primary transaction evidence remains authoritative.
  }
  try {
    rmSync(transaction.shadowPath, { force: true });
  } catch {
    // Best effort cleanup of a private index shadow.
  }
  try {
    if (existsSync(transaction.lockPath) && ownsIndexLock(transaction)) {
      unlinkSync(transaction.lockPath);
    }
  } catch {
    // Never remove an index sentinel without ownership proof.
  }
}

function releaseUnchangedIndexTransaction(transaction) {
  rmSync(transaction.shadowPath, { force: true });
  if (!ownsIndexLock(transaction)) throw manualError('Git index lock was replaced');
  closeIndexLock(transaction);
  unlinkSync(transaction.lockPath);
}

function publishIndexTransaction(transaction) {
  const bytes = readFileSync(transaction.shadowPath);
  ftruncateSync(transaction.lockDescriptor, 0);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(
      transaction.lockDescriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
  }
  fsyncSync(transaction.lockDescriptor);
  if (durabilityPolicy(process.platform).applyFileMode) {
    fchmodSync(transaction.lockDescriptor, transaction.originalMode);
  }
  closeIndexLock(transaction);
  rmSync(transaction.shadowPath, { force: true });
  if (!ownsIndexLock(transaction)) throw manualError('Git index lock was replaced');
  renameSync(transaction.lockPath, transaction.indexPath);
}

function restoreEntries({ preflight, state, platform = process.platform }) {
  const transaction = beginIndexTransaction(preflight);
  try {
    const restoreList = [];
    for (const file of state.files) {
      if (protocolIntentToAdd({
        preflight,
        file,
        indexFile: transaction.shadowPath,
        platform,
        capturedCommit: state.commit_hash,
      })) {
        restoreList.push(file);
      }
    }
    if (restoreList.length === 0) {
      releaseUnchangedIndexTransaction(transaction);
      return [];
    }
    const result = runGit(
      preflight.repo,
      ['update-index', '--force-remove', '-z', '--stdin'],
      {
        ...preflight,
        indexFile: transaction.shadowPath,
        input: nulPathBuffer(restoreList),
      },
    );
    if (result.code !== 0) {
      throw protocolError(
        'Git update-index restore failed: ' + (firstLine(result.stderr) || result.code),
        'RESTORE_UPDATE_INDEX_FAILED',
      );
    }
    const residual = state.files.filter((file) => protocolIntentToAdd({
      preflight,
      file,
      indexFile: transaction.shadowPath,
      platform,
      capturedCommit: state.commit_hash,
    }));
    if (residual.length > 0) throw protocolError('restore left protocol intent-to-add entries');
    publishIndexTransaction(transaction);
    return restoreList;
  } catch (error) {
    abortIndexTransaction(transaction);
    throw error;
  }
}

function normalizeOwnerToken(ownerToken, generate = false) {
  if ((ownerToken === undefined || ownerToken === null) && generate) return randomUUID();
  return assertScalarString(ownerToken, 'owner token', {
    nonempty: true,
    maxBytes: OWNER_TOKEN_MAX_BYTES,
  });
}

function selectedSlotInspection(context) {
  const inspection = inspectReadyState(
    context.preflight,
    context.paths,
    context.authority,
    context.inventory,
    context.inspectionOptions,
  );
  context.inspection = inspection;
  return inspection;
}

function sessionObject(record) {
  return {
    session_id: record.session_id,
    phase: record.phase,
    record_seq: record.record_seq,
    record_digest: record.record_digest,
    lease_id: deriveLease(
      record.cutover_id,
      record.session_id,
      record.record_seq,
      record.record_digest,
    ),
  };
}

function recordPayload(record) {
  return {
    cutover_id: record.cutover_id,
    session_id: record.session_id,
    owner_token: record.owner_token,
    owner_process: record.owner_process,
    started_at: record.started_at,
    commit_hash: record.commit_hash,
    files: record.files,
    fence_inventory: record.fence_inventory,
  };
}

function nextRecordSequenceForContext(context, firstSession) {
  const inspection = selectedSlotInspection(context);
  const sequences = inspection.slots
    .filter((slot) => slot.record !== null)
    .map((slot) => Number(slot.record.record_seq));
  const maximum = Math.max(...sequences);
  if (firstSession && maximum > RECORD_SEQUENCE_MAX - 8) {
    throw protocolError('record-sequence-exhausted', 'RECORD_SEQUENCE_EXHAUSTED');
  }
  const base = inspection.selectedRecord
    ? Number(inspection.selectedRecord.record_seq)
    : maximum;
  if (!Number.isSafeInteger(base) || base >= RECORD_SEQUENCE_MAX) {
    throw protocolError('record-sequence-exhausted', 'RECORD_SEQUENCE_EXHAUSTED');
  }
  return String(base + 1);
}

function inactiveSlot(context, firstSession) {
  const inspection = context.inspection || selectedSlotInspection(context);
  if (inspection.publication.selected_slot) {
    return inspection.publication.selected_slot === 'a' ? 'b' : 'a';
  }
  const [a, b] = inspection.slots;
  if (a.record === null) return 'a';
  if (b.record === null) return 'b';
  const aSequence = Number(a.record.record_seq);
  const bSequence = Number(b.record.record_seq);
  if (aSequence === bSequence) return 'a';
  return aSequence < bSequence ? 'a' : 'b';
}

function publishRecord(context, baseRecord, changes, transitionLabel, options = {}) {
  const sequence = nextRecordSequenceForContext(context, Boolean(options.firstSession));
  const targetSlot = inactiveSlot(context, Boolean(options.firstSession));
  const peerSlot = targetSlot === 'a' ? 'b' : 'a';
  const peer = context.inspection.slots.find((slot) => slot.slot === peerSlot);
  const input = {
    schema_version: 3,
    slot: targetSlot,
    phase: changes.phase,
    ...recordPayload(baseRecord),
    record_seq: sequence,
    restore_attempts: changes.restore_attempts,
    recovery_kind: changes.recovery_kind,
    attempt_state: changes.attempt_state,
    self_slot_identity: context.inspection.slots.find((slot) => slot.slot === targetSlot).identity,
    peer_slot_identity: peer.identity,
  };
  const written = writeSlot(context.paths, targetSlot, input, options);
  const next = publicationWithCurrentOperationBase(context, replacePublication(
    context.authority.publication,
    {
    selected_slot: targetSlot,
    selected_record_seq: written.record.record_seq,
    selected_record_digest: written.record.record_digest,
    session: sessionObject(written.record),
    },
  ));
  context.authority = casAuthority(
    context.preflight,
    context.authority,
    next,
    context.counter,
    'publication-transition',
    Object.hasOwn(options, 'authorityHeadGuard')
      ? options.authorityHeadGuard
      : written.record.commit_hash,
  );
  context.changed = true;
  context.inspection = null;
  if (typeof options.transitionHook === 'function') options.transitionHook(transitionLabel);
  reinspectReadyContext(context, 'record publication ' + transitionLabel);
  return written.record;
}

function releaseSession(context, options = {}) {
  const selected = selectedSlotInspection(context).selectedRecord;
  const next = publicationWithCurrentOperationBase(context, replacePublication(
    context.authority.publication,
    {
      selected_slot: null,
      selected_record_seq: null,
      selected_record_digest: null,
      session: null,
    },
  ));
  context.authority = casAuthority(
    context.preflight,
    context.authority,
    next,
    context.counter,
    'publication-transition',
    Object.hasOwn(options, 'authorityHeadGuard')
      ? options.authorityHeadGuard
      : (selected ? selected.commit_hash : undefined),
  );
  context.changed = true;
  context.inspection = null;
  reinspectReadyContext(context, 'session release');
}

function requireReadyContext(options) {
  const context = prepareReady(options);
  if (context.status !== 'ready') {
    throw manualError('mutation lifecycle is not ready: ' + context.reason);
  }
  return context;
}

export function buildPerformCapacityRecord(token, targets) {
  const maximumIdentity = {
    dev: UINT64_MAX.toString(),
    ino: UINT64_MAX.toString(),
  };
  return buildRecord({
    schema_version: 3,
    slot: 'a',
    phase: 'prepared',
    cutover_id: '0'.repeat(64),
    session_id: '00000000-0000-4000-8000-000000000004',
    record_seq: '1',
    owner_token: token,
    owner_process: {
      host_hash: '0'.repeat(64),
      pid: '4294967295',
      process_start_ms: String(Number.MAX_SAFE_INTEGER),
    },
    started_at: '1970-01-01T00:00:00.000Z',
    commit_hash: null,
    restore_attempts: 0,
    recovery_kind: null,
    attempt_state: null,
    files: targets,
    fence_inventory: {
      sha256: '0'.repeat(64),
      entries: 3,
      bytes: 4096,
    },
    self_slot_identity: maximumIdentity,
    peer_slot_identity: maximumIdentity,
  });
}

function requireRecordCapacity(token, targets) {
  encodeRecord(buildPerformCapacityRecord(token, targets));
}

function requirePerformHeadroomBeforeOperation(preflight, options = {}) {
  const paths = protocolPaths(preflight.repo);
  const authority = readAuthority(preflight);
  if (!authority || authority.publication.cutover_phase !== 'ready'
      || authority.publication.session !== null) {
    return;
  }
  if (authority.publication.operation !== null) {
    validateOperationReceipt(preflight, authority);
    const liveness = classifyLiveness(
      operationOwnerForLiveness(authority.publication.operation),
      { now: options.now, processProbe: options.processProbe },
    );
    if (liveness !== 'departed') return;
  }
  const topology = inspectLegacyTopology(paths);
  if (topology.kind !== 'fenced') return;
  const inspection = inspectReadyState(
    preflight,
    paths,
    authority,
    fenceInventory(paths),
    options,
  );
  const maximum = Math.max(...inspection.slots
    .filter((slot) => slot.record !== null)
    .map((slot) => Number(slot.record.record_seq)));
  if (maximum > RECORD_SEQUENCE_MAX - 8) {
    throw protocolError('record-sequence-exhausted', 'RECORD_SEQUENCE_EXHAUSTED');
  }
}

function preflightPerform({
  repo,
  files,
  ownerToken,
  env,
  gitRunner,
  platform,
  now,
  processProbe,
}) {
  const token = normalizeOwnerToken(ownerToken, true);
  const targets = normalizeTargets(files, platform);
  requireRecordCapacity(token, targets);
  const preflight = preflightRepository({ repo, env, gitRunner });
  requireRegularTargets(preflight.repo, targets);
  requireTargetsAbsentFromIndex(preflight, targets);
  requirePerformHeadroomBeforeOperation(preflight, { now, processProbe });
  return { token, targets, preflight };
}

function rollbackProducerHeadDrift(context, error, options) {
  let record;
  try {
    record = selectedSlotInspection(context).selectedRecord;
  } catch {
    return error;
  }
  if (!record || currentCommit(context.preflight) === record.commit_hash) return error;
  let combined = asCompositeError(error);
  try {
    recoverOwnedSession(context, record, {
      ...options,
      allowProducerHeadDriftRollback: true,
    });
  } catch (rollbackError) {
    combined = appendProtocolFailure(combined, 'producer-head-drift-rollback', rollbackError);
  }
  return combined;
}

function acquireProducerHeadDriftRollback(context) {
  const observed = readAuthority(context.preflight);
  if (!observed || observed.oid !== context.authority.oid
      || !observed.bytes.equals(context.authority.bytes)) {
    throw manualError('publication authority changed before producer HEAD-drift rollback');
  }
  if (observed.publication.operation !== null) {
    throw manualError('publication operation was acquired before producer HEAD-drift rollback');
  }
  context.authority = acquireOperation(context.preflight, observed, context.counter);
  context.changed = operationProjectionChanged(context.preflight, context.authority);
  context.inspection = null;
  reinspectReadyContext(context, 'producer HEAD-drift rollback acquire');
}

export function performMutation(options = {}) {
  const initial = preflightPerform(options);
  const context = requireReadyContext(options);
  let result;
  let primaryError;
  let capturedCommit;
  try {
    const ready = selectedSlotInspection(context);
    if (ready.publication.session !== null) {
      throw protocolError('another mutation session is already active', 'MUTATION_BUSY');
    }
    if (typeof options.underOperationHook === 'function') options.underOperationHook();
    requireRegularTargets(context.preflight.repo, initial.targets);
    requireTargetsAbsentFromIndex(context.preflight, initial.targets);
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    const preparedBase = {
      cutover_id: ready.publication.cutover_id,
      session_id: sessionId,
      owner_token: initial.token,
      owner_process: {
        host_hash: currentHostHash(),
        pid: String(process.pid),
        process_start_ms: String(PROCESS_START_MS),
      },
      started_at: startedAt,
      commit_hash: currentCommit(context.preflight),
      files: initial.targets,
      fence_inventory: context.inventory,
    };
    const prepared = publishRecord(
      context,
      preparedBase,
      {
        phase: 'prepared',
        restore_attempts: 0,
        recovery_kind: null,
        attempt_state: null,
      },
      'prepared',
      { ...options, firstSession: true },
    );
    capturedCommit = prepared.commit_hash;
    try {
      requireCapturedCommit(context.preflight, prepared);
      requireRegularTargets(context.preflight.repo, initial.targets);
      requireTargetsAbsentFromIndex(context.preflight, initial.targets);
    } catch (error) {
      const protocolEntries = initial.targets.filter((file) => protocolIntentToAdd({
        preflight: context.preflight,
        file,
        platform: options.platform,
        capturedCommit: prepared.commit_hash,
      }));
      if (protocolEntries.length > 0) throw error;
      publishRecord(
        context,
        prepared,
        {
          phase: 'aborted',
          restore_attempts: 0,
          recovery_kind: null,
          attempt_state: null,
        },
        'aborted:direct:0',
        options,
      );
      releaseSession(context);
      throw protocolError(
        'mutation target raced into the index after prepared publication',
        'MUTATION_TARGET_ALREADY_INDEXED',
      );
    }
    const unrelatedBeforeAdd = unrelatedIndexProjection(
      fullIndexStage(context.preflight),
      initial.targets,
    );
    let addFailure = null;
    try {
      requireCapturedCommit(context.preflight, prepared);
      requireRegularTargets(context.preflight.repo, initial.targets);
      const add = runGit(
        context.preflight.repo,
        ['add', '-f', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'],
        {
          ...context.preflight,
          input: nulPathBuffer(initial.targets, true),
        },
      );
      if (add.code !== 0) {
        throw protocolError(
          'partial git add failed: ' + (firstLine(add.stderr) || add.code),
          'MUTATION_ADD_FAILED',
        );
      }
      const missing = initial.targets.filter((file) => !protocolIntentToAdd({
        preflight: context.preflight,
        file,
        platform: options.platform,
        capturedCommit: prepared.commit_hash,
      }));
      if (missing.length > 0) {
        throw protocolError('partial git add verification failed', 'MUTATION_ADD_FAILED');
      }
      requireCapturedCommit(context.preflight, prepared);
      const unrelatedAfterAdd = unrelatedIndexProjection(
        fullIndexStage(context.preflight),
        initial.targets,
      );
      if (!unrelatedAfterAdd.equals(unrelatedBeforeAdd)) {
        throw protocolError(
          'git add changed unrelated index staging',
          'MUTATION_ADD_FAILED',
        );
      }
      requireCapturedCommit(context.preflight, prepared);
    } catch (error) {
      addFailure = error;
    }
    if (addFailure) {
      let combined = asCompositeError(addFailure);
      let pending;
      try {
        pending = publishRecord(
          context,
          prepared,
          {
            phase: 'recovery-attempt',
            restore_attempts: 1,
            recovery_kind: 'abort-prepared',
            attempt_state: 'pending',
          },
          'recovery-attempt:abort-prepared:pending:1',
          options,
        );
      } catch (publicationError) {
        throw appendProtocolFailure(
          combined,
          'pending-intent-publication',
          publicationError,
        );
      }
      try {
        restoreEntries({ preflight: context.preflight, state: pending, platform: options.platform });
      } catch (restoreError) {
        combined = appendProtocolFailure(combined, 'rollback', restoreError);
        try {
          publishRecord(
            context,
            pending,
            {
              phase: 'recovery-attempt',
              restore_attempts: 1,
              recovery_kind: 'abort-prepared',
              attempt_state: 'failed',
            },
            'recovery-attempt:abort-prepared:failed:1',
            options,
          );
        } catch (publicationError) {
          combined = appendProtocolFailure(
            combined,
            'failed-state-publication',
            publicationError,
          );
        }
        throw combined;
      }
      try {
        publishRecord(
          context,
          pending,
          {
            phase: 'aborted',
            restore_attempts: 1,
            recovery_kind: 'abort-prepared',
            attempt_state: null,
          },
          'aborted:abort-prepared:1',
          options,
        );
      } catch (publicationError) {
        throw appendProtocolFailure(combined, 'terminal-publication', publicationError);
      }
      try {
        releaseSession(context);
      } catch (releaseError) {
        throw appendProtocolFailure(combined, 'session-release', releaseError);
      }
      throw combined;
    }
    if (typeof options.performBoundaryHook === 'function') {
      options.performBoundaryHook('before-committed-publication');
    }
    publishRecord(
      context,
      prepared,
      {
        phase: 'committed',
        restore_attempts: 0,
        recovery_kind: null,
        attempt_state: null,
      },
      'committed',
      options,
    );
    result = {
      status: 'committed',
      owner_token: initial.token,
      files: initial.targets,
    };
  } catch (error) {
    primaryError = rollbackProducerHeadDrift(context, error, options);
  }
  try {
    releaseOperation(context);
  } catch (releaseError) {
    if (primaryError) {
      primaryError = appendProtocolFailure(primaryError, 'operation-release', releaseError);
    } else {
      primaryError = rollbackProducerHeadDrift(
        context,
        asCompositeError(releaseError, 'operation-release'),
        options,
      );
      if (Object.hasOwn(context, 'authorityHeadGuard')) {
        try {
          releaseOperation(context);
        } catch (retryError) {
          primaryError = appendProtocolFailure(
            primaryError,
            'operation-release-retry',
            retryError,
          );
        }
      }
    }
  }
  if (!primaryError && result?.status === 'committed') {
    if (typeof options.performReturnHook === 'function') {
      options.performReturnHook('before-final-head-guard');
    }
    const observedHead = currentCommit(context.preflight);
    if (observedHead !== capturedCommit) {
      primaryError = protocolError(
        'HEAD changed before perform success return',
        'CAPTURED_COMMIT_MISMATCH',
      );
      try {
        acquireProducerHeadDriftRollback(context);
        primaryError = rollbackProducerHeadDrift(context, primaryError, options);
      } catch (rollbackError) {
        primaryError = appendProtocolFailure(
          asCompositeError(primaryError),
          'producer-head-drift-rollback-acquire',
          rollbackError,
        );
      }
      try {
        releaseOperation(context);
      } catch (releaseError) {
        primaryError = appendProtocolFailure(
          asCompositeError(primaryError),
          'producer-head-drift-operation-release',
          releaseError,
        );
      }
    }
  }
  if (primaryError) throw asCompositeError(primaryError);
  return result;
}

function nextRecoveryPending(context, record, options = {}) {
  let kind;
  let attempt;
  if (record.phase === 'prepared') {
    kind = 'abort-prepared';
    attempt = 1;
  } else if (record.phase === 'committed') {
    kind = 'restore-committed';
    attempt = 1;
  } else if (record.phase === 'recovery-attempt' && record.attempt_state === 'pending') {
    return record;
  } else if (record.phase === 'recovery-attempt' && record.attempt_state === 'failed') {
    if (record.restore_attempts >= 3) return null;
    kind = record.recovery_kind;
    attempt = record.restore_attempts + 1;
  } else {
    return record;
  }
  return publishRecord(
    context,
    record,
    {
      phase: 'recovery-attempt',
      restore_attempts: attempt,
      recovery_kind: kind,
      attempt_state: 'pending',
    },
    'recovery-attempt:' + kind + ':pending:' + attempt,
    options,
  );
}

function verifyTerminalIndex(preflight, record, platform) {
  const residual = record.files.filter((file) => protocolIntentToAdd({
    preflight,
    file,
    platform,
    capturedCommit: record.commit_hash,
  }));
  if (residual.length > 0) {
    throw protocolError(
      'terminal verification found residual intent-to-add entries',
      'TERMINAL_INDEX_VERIFICATION_FAILED',
    );
  }
}

function requireCapturedCommit(preflight, record) {
  const observed = currentCommit(preflight);
  if (observed !== record.commit_hash) {
    throw protocolError(
      'captured commit does not match current HEAD',
      'CAPTURED_COMMIT_MISMATCH',
    );
  }
}

function requireTargetsAbsentFromCommit(preflight, commit, files) {
  if (commit === null) return;
  repositoryOid(preflight, commit, 'observed HEAD OID');
  for (const file of files) {
    const result = requireGit(
      preflight.repo,
      ['ls-tree', '--full-tree', '--name-only', '-z', commit, '--', literalPathspec(file)],
      { ...preflight, maxBuffer: PATH_MAX_BYTES + 1 },
      'observed HEAD target inspection',
    );
    if (result.stdout.length !== 0) {
      throw protocolError(
        'moved HEAD now owns a mutation target: ' + file,
        'CAPTURED_COMMIT_TARGET_CONFLICT',
      );
    }
  }
}

function requiredRecoverySequenceValues(record) {
  if (record.phase === 'prepared' || record.phase === 'committed') return 6;
  if (record.phase === 'recovery-attempt' && record.attempt_state === 'pending') {
    return (2 * (3 - record.restore_attempts)) + 1;
  }
  if (record.phase === 'recovery-attempt'
      && record.attempt_state === 'failed'
      && record.restore_attempts < 3) {
    return 2 * (3 - record.restore_attempts);
  }
  return 0;
}

function requireRecoveryHeadroom(record) {
  const required = requiredRecoverySequenceValues(record);
  if (Number(record.record_seq) > RECORD_SEQUENCE_MAX - required) {
    throw protocolError('record-sequence-exhausted', 'RECORD_SEQUENCE_EXHAUSTED');
  }
}

function sessionRecoveryDisposition(record, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const defaultStaleMs = record.phase === 'committed' ? 1_200_000 : 3_600_000;
  const configuredStaleMs = record.phase === 'committed'
    ? options.reviewTimeoutMs
    : options.lockStaleMs;
  const staleMs = configuredStaleMs === undefined
    ? (options.staleMs === undefined ? defaultStaleMs : options.staleMs)
    : configuredStaleMs;
  if (!Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs < 0) {
    throw new TypeError('auto-recovery time thresholds are invalid');
  }
  const liveness = classifyLiveness({
    ...record.owner_process,
    started_at: record.started_at,
  }, {
    now,
    processProbe: options.processProbe,
  });
  const age = now - Date.parse(record.started_at);
  if (liveness === 'live' || liveness === 'uncertain') {
    return { status: 'active', reason: liveness };
  }
  if (liveness !== 'departed') {
    return { status: 'manual', reason: 'session-' + liveness };
  }
  if (age < staleMs) return { status: 'active', reason: liveness };
  return { status: 'recover' };
}

function requireRecoveryHeadroomBeforeOperation(options, mode, token) {
  const preflight = preflightRepository(options);
  const authority = readAuthority(preflight);
  if (!authority || authority.publication.cutover_phase !== 'ready'
      || authority.publication.session === null) {
    return;
  }
  if (authority.publication.operation !== null) {
    validateOperationReceipt(preflight, authority);
    operationOwnerForLiveness(authority.publication.operation);
  }
  const paths = protocolPaths(preflight.repo);
  const topology = inspectLegacyTopology(paths);
  if (topology.kind !== 'fenced') return;
  const inspection = inspectReadyState(
    preflight,
    paths,
    authority,
    fenceInventory(paths),
    options,
  );
  if (mode === 'restore' && inspection.selectedRecord.owner_token !== token) {
    throw protocolError(
      'owner token does not match active mutation session',
      'OWNER_TOKEN_MISMATCH',
    );
  }
  if (mode === 'auto'
      && sessionRecoveryDisposition(inspection.selectedRecord, options).status !== 'recover') return;
  requireCapturedCommit(preflight, inspection.selectedRecord);
  requireRecoveryHeadroom(inspection.selectedRecord);
}

function recoverOwnedSession(context, record, options = {}) {
  requireRecoveryHeadroom(record);
  const observedHead = currentCommit(context.preflight);
  const headMoved = observedHead !== record.commit_hash;
  if (!headMoved || !options.allowProducerHeadDriftRollback) {
    requireCapturedCommit(context.preflight, record);
  }
  const transitionOptions = headMoved
    ? { ...options, authorityHeadGuard: observedHead }
    : options;
  if (headMoved) {
    context.authorityHeadGuard = observedHead;
    requireTargetsAbsentFromCommit(context.preflight, observedHead, record.files);
  }
  if (record.phase === 'restored' || record.phase === 'aborted') {
    verifyTerminalIndex(context.preflight, record, transitionOptions.platform);
    releaseSession(context, transitionOptions);
    return { status: 'restored' };
  }
  if (record.phase === 'recovery-attempt'
      && record.attempt_state === 'failed'
      && record.restore_attempts === 3) {
    return { status: 'manual', reason: 'restore-attempts-exhausted' };
  }
  const pending = nextRecoveryPending(context, record, transitionOptions);
  if (!pending) return { status: 'manual', reason: 'restore-attempts-exhausted' };
  const kind = pending.recovery_kind;
  const attempt = pending.restore_attempts;
  try {
    restoreEntries({
      preflight: context.preflight,
      state: pending,
      platform: transitionOptions.platform,
    });
  } catch (error) {
    const primary = protocolError('restore attempt failed: ' + error.message, 'RESTORE_FAILED');
    try {
      publishRecord(
        context,
        pending,
        {
          phase: 'recovery-attempt',
          restore_attempts: attempt,
          recovery_kind: kind,
          attempt_state: 'failed',
        },
        'recovery-attempt:' + kind + ':failed:' + attempt,
        transitionOptions,
      );
    } catch (publicationError) {
      throw appendProtocolFailure(primary, 'failed-state-publication', publicationError);
    }
    throw primary;
  }
  if (typeof transitionOptions.recoveryHook === 'function') {
    transitionOptions.recoveryHook('after-index-before-terminal');
  }
  const terminalPhase = kind === 'abort-prepared' ? 'aborted' : 'restored';
  publishRecord(
    context,
    pending,
    {
      phase: terminalPhase,
      restore_attempts: attempt,
      recovery_kind: kind,
      attempt_state: null,
    },
    terminalPhase + ':' + kind + ':' + attempt,
    transitionOptions,
  );
  releaseSession(context, transitionOptions);
  if (typeof transitionOptions.recoveryHook === 'function') {
    transitionOptions.recoveryHook('after-session-release');
  }
  return { status: 'restored' };
}

export function restoreMutation(options = {}) {
  const token = normalizeOwnerToken(options.ownerToken, false);
  requireRecoveryHeadroomBeforeOperation(options, 'restore', token);
  const context = requireReadyContext(options);
  let result;
  let primaryError;
  try {
    const ready = selectedSlotInspection(context);
    if (ready.publication.session === null) {
      result = { status: 'noop' };
    } else {
      const record = ready.selectedRecord;
      if (record.owner_token !== token) {
        throw protocolError('owner token does not match active mutation session', 'OWNER_TOKEN_MISMATCH');
      }
      result = recoverOwnedSession(context, record, options);
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    releaseOperation(context);
  } catch (releaseError) {
    if (primaryError) primaryError = appendProtocolFailure(primaryError, 'release', releaseError);
    else throw asCompositeError(releaseError, 'release');
  }
  if (primaryError) throw asCompositeError(primaryError);
  return result;
}

export function autoRecover(options = {}) {
  try {
    requireRecoveryHeadroomBeforeOperation(options, 'auto');
  } catch (error) {
    if (error instanceof MutationProtocolError
        && /inconsistent session timeline/u.test(error.message)) {
      return { status: 'manual', reason: 'session-manual' };
    }
    throw error;
  }
  const context = requireReadyContext(options);
  let result;
  let primaryError;
  try {
    const ready = selectedSlotInspection(context);
    if (ready.publication.session === null) {
      result = { status: 'noop' };
    } else {
      const record = ready.selectedRecord;
      const disposition = sessionRecoveryDisposition(record, options);
      if (disposition.status === 'recover') {
        result = recoverOwnedSession(context, record, options);
      } else {
        result = disposition;
      }
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    releaseOperation(context);
  } catch (releaseError) {
    if (primaryError) primaryError = appendProtocolFailure(primaryError, 'release', releaseError);
    else throw asCompositeError(releaseError, 'release');
  }
  if (primaryError) throw asCompositeError(primaryError);
  return result;
}

export function recoveryCrashOutcome({ kind, row, attempt }) {
  if (kind !== 'abort-prepared' && kind !== 'restore-committed') {
    throw new TypeError('invalid recovery kind');
  }
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
    throw new TypeError('invalid recovery attempt');
  }
  const oldRows = new Set(['before-attempt-write', 'after-attempt-write']);
  return {
    kind,
    row,
    attempt,
    authority: oldRows.has(row) ? 'OLD' : 'NEW',
    indexAuthorized: !oldRows.has(row),
  };
}

export function normalRestorePlan({ phase, tokenMatches }) {
  if (!tokenMatches) {
    return { phase, tokenMatches: false, firstTransition: null, indexAction: false };
  }
  const plan = {
    phase,
    tokenMatches: true,
    firstTransition: null,
    indexAction: false,
  };
  if (phase === 'prepared') {
    plan.firstTransition = 'abort-prepared:pending:1';
    plan.indexAction = true;
  } else if (phase === 'committed') {
    plan.firstTransition = 'restore-committed:pending:1';
    plan.indexAction = true;
  } else if (phase === 'pending') {
    plan.firstTransition = 'replay-pending';
    plan.indexAction = true;
  } else if (phase === 'failed-1') {
    plan.firstTransition = 'pending:2';
    plan.indexAction = true;
  } else if (phase === 'failed-3') {
    plan.firstTransition = null;
    plan.indexAction = false;
  }
  return plan;
}

function normalizeCliRequest(input) {
  assertPlainObject(input, 'CLI request');
  if (input.protocol !== PROTOCOL) throw new TypeError('invalid CLI protocol');
  const commands = new Set([
    'ensure-cutover',
    'perform',
    'restore',
    'auto-recover',
    'scan-sensitive',
  ]);
  if (!commands.has(input.command)) throw new TypeError('invalid CLI command');
  const repo = assertScalarString(input.repo, 'CLI repo', {
    nonempty: true,
    maxBytes: CLI_REPO_MAX_BYTES,
  });
  const ownerToken = input.owner_token === null
    ? null
    : assertScalarString(input.owner_token, 'owner token', {
      nonempty: true,
      maxBytes: OWNER_TOKEN_MAX_BYTES,
    });
  const files = canonicalFiles(input.files, {
    normalize: input.command === 'perform' || input.command === 'scan-sensitive',
    rejectDuplicates: true,
  });
  if (input.command === 'perform') {
    if (files.length === 0) throw new TypeError('perform requires target files');
  } else if (input.command === 'restore') {
    if (ownerToken === null || files.length !== 0) {
      throw new TypeError('restore requires an owner token and no files');
    }
  } else if (input.command !== 'scan-sensitive') {
    if (ownerToken !== null || files.length !== 0) {
      throw new TypeError('command does not accept owner token or files');
    }
  }
  return {
    protocol: PROTOCOL,
    command: input.command,
    repo,
    owner_token: ownerToken,
    files,
  };
}

function encodeCliPayload(input) {
  const normalized = normalizeCliRequest(input);
  const bytes = canonicalJsonLine(normalized);
  if (bytes.length > CLI_REQUEST_MAX_BYTES) throw new TypeError('CLI request exceeds byte cap');
  return bytes;
}

export function buildCliRequest(input) {
  const payload = encodeCliPayload(input);
  const header = Buffer.from(
    PROTOCOL + ' ' + payload.length + ' ' + sha256(payload) + '\n',
    'ascii',
  );
  if (header.length > 128) throw new TypeError('CLI request header exceeds byte cap');
  return Buffer.concat([header, payload]);
}

function parseFramedRequest(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('CLI input must be a Buffer');
  if (bytes.length > CLI_REQUEST_MAX_BYTES + 129) {
    throw new TypeError('CLI request exceeds byte cap');
  }
  const newline = bytes.indexOf(0x0a);
  if (newline < 0 || newline + 1 > 128) throw new TypeError('invalid CLI request header');
  const header = bytes.subarray(0, newline).toString('ascii');
  if (header.includes('\r')) throw new TypeError('invalid CLI request header');
  const match = /^deep-review-mutation-v3 (0|[1-9][0-9]*) ([0-9a-f]{64})$/u.exec(header);
  if (!match) throw new TypeError('invalid CLI request header');
  const declared = Number(match[1]);
  if (!Number.isSafeInteger(declared) || declared > CLI_REQUEST_MAX_BYTES) {
    throw new TypeError('invalid CLI payload length');
  }
  const payload = bytes.subarray(newline + 1);
  if (payload.length !== declared) throw new TypeError('CLI payload length or trailing bytes mismatch');
  if (sha256(payload) !== match[2]) throw new TypeError('CLI payload digest mismatch');
  let parsed;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    throw new TypeError('CLI payload JSON is invalid: ' + error.message);
  }
  const normalized = normalizeCliRequest(parsed);
  if (!encodeCliPayload(normalized).equals(payload)) {
    throw new TypeError('CLI payload is not canonical');
  }
  return normalized;
}

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(65_536);
    const count = readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > CLI_REQUEST_MAX_BYTES + 129) {
      throw new TypeError('CLI request exceeds byte cap');
    }
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function dispatchCli(request) {
  if (request.command === 'ensure-cutover') {
    return ensureCutover({ repo: request.repo });
  }
  if (request.command === 'perform') {
    return performMutation({
      repo: request.repo,
      files: request.files,
      ownerToken: request.owner_token,
    });
  }
  if (request.command === 'restore') {
    return restoreMutation({ repo: request.repo, ownerToken: request.owner_token });
  }
  if (request.command === 'auto-recover') {
    return autoRecover({ repo: request.repo });
  }
  return {
    status: 'scanned',
    sensitive_files: scanSensitiveFiles({
      pluginRoot: PLUGIN_ROOT,
      files: request.files,
    }),
  };
}

function runCli(argv) {
  try {
    const transport = framedTransportPolicy(process.platform);
    if (argv.length !== transport.argv.length
        || argv.some((value, index) => value !== transport.argv[index])) {
      throw new TypeError('the only supported CLI form is --request-stdin');
    }
    const request = parseFramedRequest(readBoundedStdin());
    const result = dispatchCli(request);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: serializeProtocolError(error),
    }) + '\n');
    process.exitCode = 1;
  }
}

function isMainModule() {
  return process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

export { scanSensitiveFiles };

export const __testing = Object.freeze({
  buildCliRequest,
  buildPerformCapacityRecord,
  encodeFenceInventory,
  buildPublication,
  buildRecord,
  buildUpdateRefInput,
  classifyLiveness,
  currentHostHash,
  decodePublication,
  decodeRecord,
  encodePublication,
  encodeRecord,
  inspectProtocol,
  normalRestorePlan,
  parseGitVersion,
  parseReflogList,
  durabilityPolicy,
  persistDurableDescriptor,
  framedTransportPolicy,
  platformMetadataTag,
  preflightRepository,
  processStartMs,
  publicationCoreBytes,
  recordCoreBytes,
  recoveryCrashOutcome,
  requireGitFloor,
  sanitizeGitEnvironment,
  serializeProtocolError,
  validateRecordSemantics,
});

if (isMainModule()) runCli(process.argv.slice(2));
