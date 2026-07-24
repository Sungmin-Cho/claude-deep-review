'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

function read(path) {
  return readFileSync(path, 'utf8');
}

function jobBlock(workflow, name) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `workflow job missing: ${name}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function matrixOperatingSystems(job) {
  const match = job.match(/^[ \t]+os:\s*\[([^\]]+)\]/mu);
  assert.ok(match, 'OS matrix missing');
  return match[1].split(',').map((value) => value.trim().replace(/^['"]|['"]$/gu, ''));
}

function workflowPaths(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const pullRequest = lines.findIndex((line) => /^\s{2}pull_request:\s*$/u.test(line));
  assert.notEqual(pullRequest, -1, 'pull_request trigger missing');
  const paths = lines.findIndex(
    (line, index) => index > pullRequest && /^\s{4}paths:\s*$/u.test(line),
  );
  assert.notEqual(paths, -1, 'pull_request.paths missing');
  const output = [];
  for (let index = paths + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{6}-\s+(.+?)\s*$/u);
    if (!match) break;
    output.push(match[1].replace(/^['"]|['"]$/gu, ''));
  }
  return output;
}

function releaseBlock(source, version) {
  const escaped = version.replaceAll('.', '\\.');
  const matches = [...source.matchAll(new RegExp(`^## \\[${escaped}\\] — 2026-07-11$`, 'gmu'))];
  assert.equal(matches.length, 1, `${version} release header must occur exactly once`);
  const start = matches[0].index;
  const next = source.slice(start + 1).search(/^## \[/mu);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function bulletCount(block, heading) {
  const start = block.indexOf(heading);
  assert.notEqual(start, -1, `release heading missing: ${heading}`);
  const tail = block.slice(start + heading.length);
  const next = tail.search(/^### /mu);
  const section = next < 0 ? tail : tail.slice(0, next);
  return [...section.matchAll(/^- /gmu)].length;
}

test('Codex manifest uses default hook discovery and registers no MCP server', () => {
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.deepEqual(JSON.parse(read('hooks/hooks.json')).hooks, {});
});

test('package contract uses Node 22 and keeps Bash out of npm test', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.deepEqual(manifest.engines, { node: '>=22' });
  assert.equal(manifest.scripts.test, 'node --test');
  assert.equal(manifest.scripts['test:legacy'], 'bash scripts/run-all-tests.sh');
});

test('bilingual runtime prerequisites disclose the enforced Git floor', () => {
  assert.match(read('README.md'), /Git 2\.45 or newer/u);
  assert.match(read('README.ko.md'), /Git 2\.45 이상/u);
});

test('release CI has exact Node 22 native and Unix legacy matrices', () => {
  const primaryWorkflow = read('.github/workflows/tests.yml');
  const primary = jobBlock(primaryWorkflow, 'tests');
  assert.deepEqual(
    matrixOperatingSystems(primary),
    ['ubuntu-latest', 'macos-latest'],
  );
  assert.match(primary, /actions\/setup-node@v4/u);
  assert.match(primary, /node-version:\s*['"]22['"]/u);
  assert.match(primary, /run:\s*npm test(?:\s|$)/u);
  assert.doesNotMatch(primary, /\bbash\b|\bGit Bash\b/iu);

  const windowsShards = jobBlock(primaryWorkflow, 'windows-test-shards');
  assert.match(windowsShards, /runs-on:\s*windows-latest/u);
  assert.match(
    windowsShards,
    /timeout-minutes:\s*\$\{\{ matrix\.shard == 'group-07' && 60 \|\| 30 \}\}/u,
  );
  assert.match(windowsShards, /actions\/setup-node@v4/u);
  assert.match(windowsShards, /node-version:\s*['"]22['"]/u);
  assert.match(windowsShards, /node scripts\/run-windows-native-shard\.mjs/u);
  assert.doesNotMatch(windowsShards, /\bbash\b|\bGit Bash\b/iu);

  const windows = jobBlock(primaryWorkflow, 'windows-tests');
  assert.match(windows, /if:\s*\$\{\{ always\(\) \}\}/u);
  assert.match(windows, /needs:\s*windows-test-shards/u);
  assert.match(windows, /name:\s*native tests \(windows-latest\)/u);

  const legacy = jobBlock(primaryWorkflow, 'legacy-unix');
  assert.deepEqual(matrixOperatingSystems(legacy), ['ubuntu-latest', 'macos-latest']);
  assert.match(legacy, /run:\s*npm run test:legacy(?:\s|$)/u);
  assert.doesNotMatch(legacy, /windows-latest/u);

  const phase6Workflow = read('.github/workflows/phase6-protocol.yml');
  const phase6 = jobBlock(phase6Workflow, 'tests');
  assert.deepEqual(
    matrixOperatingSystems(phase6),
    ['ubuntu-latest', 'macos-latest', 'windows-latest'],
  );
  assert.match(phase6, /actions\/setup-node@v4/u);
  assert.match(phase6, /node-version:\s*['"]22['"]/u);
  assert.match(
    phase6,
    /node --test tests\/phase6-protocol\.test\.js tests\/respond-runtime\.test\.js tests\/skill-runtime-contract\.test\.js/u,
  );
  assert.doesNotMatch(phase6, /\bpython\b|\bpython3\b|PyYAML|\bbash\b/iu);
});

test('both workflows cover every release-relevant path class', () => {
  const required = [
    'docs/**',
    'README.md',
    'README.ko.md',
    'CHANGELOG.md',
    'CHANGELOG.ko.md',
    'CLAUDE.md',
    'AGENTS.md',
    'hooks/**',
    'hooks/scripts/test/**',
    'scripts/**',
    'commands/**',
    'skills/**',
    'agents/**',
    '.claude-plugin/**',
    '.codex-plugin/**',
    'package.json',
    'tests/**',
    '.github/workflows/**',
  ];
  for (const workflowPath of [
    '.github/workflows/tests.yml',
    '.github/workflows/phase6-protocol.yml',
  ]) {
    const actual = new Set(workflowPaths(read(workflowPath)));
    for (const pathClass of required) {
      assert.equal(actual.has(pathClass), true, `${workflowPath} misses ${pathClass}`);
    }
  }
});

test('release version is exactly 2.0.0 on all three package surfaces', () => {
  const versions = [
    JSON.parse(read('.claude-plugin/plugin.json')).version,
    JSON.parse(read('.codex-plugin/plugin.json')).version,
    JSON.parse(read('package.json')).version,
  ];
  assert.deepEqual(versions, ['2.0.0', '2.0.0', '2.0.0']);
});

test('evergreen bilingual READMEs advertise both native hosts and portable runtime', () => {
  const english = read('README.md');
  const korean = read('README.ko.md');
  assert.equal(english.split(/\r?\n/u)[0], '**English** | [한국어](./README.ko.md)');
  assert.equal(korean.split(/\r?\n/u)[0], '[English](./README.md) | **한국어**');

  const englishOrder = ['## Role in deep-suite', '## Install', '## Usage', '## Links', '## License'];
  const koreanOrder = ['## deep-suite에서의 역할', '## 설치', '## 사용법', '## 링크', '## 라이선스'];
  for (const [source, headings] of [[english, englishOrder], [korean, koreanOrder]]) {
    let cursor = -1;
    for (const heading of headings) {
      const next = source.indexOf(heading);
      assert.ok(next > cursor, `README section order invalid at ${heading}`);
      cursor = next;
    }
  }
  assert.deepEqual(
    [...english.matchAll(/^(#{2,3}) /gmu)].map((match) => match[1]),
    [...korean.matchAll(/^(#{2,3}) /gmu)].map((match) => match[1]),
  );

  for (const source of [english, korean]) {
    for (const entrypoint of [
      '/deep-review',
      '/deep-review --respond',
      '/deep-review-loop',
      '$deep-review:deep-review',
      '$deep-review:deep-review-loop',
    ]) assert.equal(source.includes(entrypoint), true, `README entrypoint missing: ${entrypoint}`);
    assert.match(source, /Node(?:\.js)? 22/u);
    assert.match(source, /Windows 11/u);
    assert.match(source, /Git Bash/u);
    assert.match(source, /review_model/u);
    assert.match(source, /fable/u);
    assert.doesNotMatch(source, /^## .*What's New|v\d+\.\d+\.\d+/gimu);
  }
});

test('bilingual 1.13.0 changelogs are structurally paired and user-observable', () => {
  const english = releaseBlock(read('CHANGELOG.md'), '1.13.0');
  const korean = releaseBlock(read('CHANGELOG.ko.md'), '1.13.0');
  for (const heading of ['### Added', '### Changed', '### Fixed']) {
    assert.equal(bulletCount(english, heading), 1);
  }
  for (const heading of ['### 추가', '### 변경', '### 수정']) {
    assert.equal(bulletCount(korean, heading), 1);
  }
  assert.deepEqual(
    ['### Added', '### Changed', '### Fixed'].map((heading) => bulletCount(english, heading)),
    ['### 추가', '### 변경', '### 수정'].map((heading) => bulletCount(korean, heading)),
  );
  for (const block of [english, korean]) {
    assert.match(block, /Codex/u);
    assert.match(block, /Node 22/u);
    assert.match(block, /Windows 11/u);
    assert.match(block, /Stage 5\.5/u);
    assert.doesNotMatch(
      block,
      /\b\d+\s*\/\s*\d+\b|\b\d+\s+tests?\b|npm test|self-review|dogfood|review-loop round|commit [0-9a-f]{7,}/iu,
    );
  }
});

function releaseBlockAnyDate(source, version) {
  const escaped = version.replaceAll('.', '\\.');
  const matches = [...source.matchAll(new RegExp(`^## \\[${escaped}\\] — \\d{4}-\\d{2}-\\d{2}$`, 'gmu'))];
  assert.equal(matches.length, 1, `${version} release header must occur exactly once`);
  const start = matches[0].index;
  const next = source.slice(start + 1).search(/^## \[/mu);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test('bilingual 1.14.0 changelogs are structurally paired and carry the convergence content anchor', () => {
  const english = releaseBlockAnyDate(read('CHANGELOG.md'), '1.14.0');
  const korean = releaseBlockAnyDate(read('CHANGELOG.ko.md'), '1.14.0');
  assert.match(english, /compare-rounds|convergence/u);
  assert.match(korean, /수렴/u);
  for (const block of [english, korean]) {
    assert.doesNotMatch(
      block,
      /\b\d+\s*\/\s*\d+\b|\b\d+\s+tests?\b|npm test|self-review|dogfood|review-loop round|commit [0-9a-f]{7,}/iu,
    );
  }
});

test('bilingual 1.15.0 release surfaces document artifact-aware routing Phase 2', () => {
  const english = releaseBlockAnyDate(read('CHANGELOG.md'), '1.15.0');
  const korean = releaseBlockAnyDate(read('CHANGELOG.ko.md'), '1.15.0');
  assert.equal(bulletCount(english, '### Added'), bulletCount(korean, '### 추가'));
  for (const block of [english, korean]) {
    for (const anchor of [
      /semantic/iu,
      /capability/iu,
      /model.{0,30}effort|effort.{0,30}model/iu,
      /review-policy\.yaml/iu,
      /no-flag|무플래그/iu,
      /shadow/iu,
      /secret|비밀/iu,
    ]) assert.match(block, anchor);
  }

  const readmes = [read('README.md'), read('README.ko.md')];
  for (const source of readmes) {
    for (const flag of [
      '--reviewer',
      '--model',
      '--reviewer-model',
      '--effort',
      '--routing',
      '--allow-fallback',
      '--allow-classifier',
    ]) assert.match(source, new RegExp(flag));
    assert.match(source, /review-policy\.yaml/u);
    assert.match(source, /^\.deep-review\/\*$/mu);
    assert.match(source, /^!\.deep-review\/review-policy\.yaml$/mu);
    assert.match(source, /shadow/iu);
  }
});

test('bilingual 2.0.0 release surfaces adaptive convergence and readiness receipts', () => {
  const english = releaseBlockAnyDate(read('CHANGELOG.md'), '2.0.0');
  const korean = releaseBlockAnyDate(read('CHANGELOG.ko.md'), '2.0.0');
  assert.deepEqual(
    ['### Added', '### Changed', '### Security'].map((heading) => bulletCount(english, heading)),
    ['### 추가', '### 변경', '### 보안'].map((heading) => bulletCount(korean, heading)),
  );
  for (const block of [english, korean]) {
    for (const anchor of [
      /adaptive/iu,
      /protocol `3\.0`/iu,
      /READY_FOR_IMPLEMENTATION/iu,
      /DOCUMENT_BLOCKED/iu,
      /readiness-receipt/iu,
      /static/iu,
      /shadow/iu,
      /critical/iu,
    ]) assert.match(block, anchor);
  }

  for (const source of [read('README.md'), read('README.ko.md')]) {
    assert.match(source, /--reviewer-strategy static/u);
    assert.match(source, /--readiness-receipt PATH/u);
    assert.match(source, /document_round_limit: 2/u);
    assert.match(source, /high_risk_document_round_limit: 3/u);
    assert.match(source, /READY_FOR_IMPLEMENTATION/u);
    assert.match(source, /DOCUMENT_BLOCKED/u);
  }
});

test('agent guides are concise, version-free, and use the portable version command', () => {
  for (const guide of ['CLAUDE.md', 'AGENTS.md']) {
    const source = read(guide);
    assert.ok(source.split(/\r?\n/u).length <= 100, `${guide} is not concise`);
    assert.match(source, /docs\/DOCS_RULE\.md/u);
    assert.match(source, /node -p "require\('\.\/package\.json'\)\.version"/u);
    assert.doesNotMatch(source, /\b\d+\.\d+\.\d+\b/u);
  }
});
