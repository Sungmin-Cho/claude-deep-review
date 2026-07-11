import { readFileSync } from 'node:fs';
import { atomicWriteFile } from './runtime-context.mjs';

function splitLines(text) {
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) break;
    lines.push({ body: match[1], ending: match[2] });
  }
  return lines;
}

function commentOffset(value) {
  let doubleQuoted = false;
  let singleQuoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (doubleQuoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (singleQuoted) {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (character === '"') doubleQuoted = true;
    else if (character === "'") singleQuoted = true;
    else if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) return index;
  }
  return value.length;
}

function decodeScalar(raw, lineNumber) {
  const value = raw.trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== 'string') throw new Error('not a string');
      return decoded;
    } catch {
      throw new Error(`invalid double-quoted config scalar at line ${lineNumber}`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`invalid single-quoted config scalar at line ${lineNumber}`);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseConfigText(text) {
  const lines = splitLines(text);
  const values = {};
  const records = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const { body } = lines[index];
    if (body === '' || /^[ \t]/.test(body) || body.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)(\s*:\s*)(.*)$/.exec(body);
    if (!match) continue;
    const [, key, delimiter, remainder] = match;
    if (records.has(key)) throw new Error(`duplicate config key ${key} at line ${index + 1}`);
    const comment = commentOffset(remainder);
    const valuePart = remainder.slice(0, comment);
    const trimmedEnd = valuePart.length - valuePart.trimEnd().length;
    const valueStart = key.length + delimiter.length;
    const valueEnd = valueStart + valuePart.length - trimmedEnd;
    values[key] = decodeScalar(valuePart, index + 1);
    records.set(key, {
      key,
      lineIndex: index,
      lineNumber: index + 1,
      valueStart,
      valueEnd,
    });
  }
  return { lines, records, values };
}

function encodeScalar(value, key) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  throw new TypeError(`config update ${key} must be a string, boolean, or null`);
}

function newlineFor(text, lines) {
  if (text.includes('\r\n')) return '\r\n';
  return lines.find((line) => line.ending)?.ending || '\n';
}

export function readTopLevelConfig(filePath) {
  const source = readFileSync(filePath, 'utf8');
  return parseConfigText(source).values;
}

export function patchTopLevelConfig(filePath, updates) {
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new TypeError('updates must be an object');
  }
  const entries = Object.entries(updates);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new TypeError(`invalid config key: ${key}`);
    }
    encodeScalar(value, key);
  }

  const source = readFileSync(filePath, 'utf8');
  const parsed = parseConfigText(source);
  const missing = [];
  for (const [key, value] of entries) {
    const record = parsed.records.get(key);
    if (!record) {
      missing.push([key, value]);
      continue;
    }
    const line = parsed.lines[record.lineIndex];
    line.body = `${line.body.slice(0, record.valueStart)}${encodeScalar(value, key)}${line.body.slice(record.valueEnd)}`;
  }

  if (missing.length > 0) {
    const newline = newlineFor(source, parsed.lines);
    const lastReview = parsed.records.get('last_review');
    let insertionIndex;
    if (lastReview) insertionIndex = lastReview.lineIndex;
    else {
      insertionIndex = -1;
      for (const record of parsed.records.values()) {
        insertionIndex = Math.max(insertionIndex, record.lineIndex);
      }
      insertionIndex += 1;
    }

    const insertionAtEnd = insertionIndex === parsed.lines.length;
    const hadFinalNewline = /(?:\r\n|\n|\r)$/.test(source);
    if (insertionAtEnd && parsed.lines.length > 0 && parsed.lines.at(-1).ending === '') {
      parsed.lines.at(-1).ending = newline;
    }
    const added = missing.map(([key, value], index) => ({
      body: `${key}: ${encodeScalar(value, key)}`,
      ending: (
        insertionAtEnd
        && !hadFinalNewline
        && index === missing.length - 1
      ) ? '' : newline,
    }));
    parsed.lines.splice(insertionIndex, 0, ...added);
  }

  const output = parsed.lines.map((line) => `${line.body}${line.ending}`).join('');
  atomicWriteFile(filePath, output, { encoding: 'utf8', mode: 0o600 });
}
