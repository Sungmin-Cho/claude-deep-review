'use strict';

const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const runtimeUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'respond-runtime.mjs'),
).href;
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createFakeGh() {
  const directory = temporaryDirectory('deep-review-fake-gh-');
  const logPath = path.join(directory, 'calls.jsonl');
  const scriptPath = path.join(directory, 'fake-gh.cjs');
  writeFileSync(scriptPath, String.raw`
'use strict';
const fs = require('node:fs');

const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, stdin }) + '\n');

function send(value) {
  process.stdout.write(JSON.stringify(value));
}

if (argv[0] === 'repo' && argv[1] === 'view') {
  send({ nameWithOwner: 'acme/space-unicode' });
} else if (argv[0] === 'pr' && argv[1] === 'view') {
  send({ number: 17, url: 'https://github.com/acme/space-unicode/pull/17' });
} else if (argv[0] === 'api' && argv.includes('--paginate')) {
  const endpoint = argv.at(-1);
  if (process.env.FAKE_GH_FAIL_ENDPOINT && endpoint.includes(process.env.FAKE_GH_FAIL_ENDPOINT)) {
    process.stderr.write('forced endpoint failure: ' + endpoint + '\n');
    process.exitCode = 3;
  } else if (endpoint.endsWith('/reviews')) {
    send([{ id: 101, body: 'review "quoted"\n한글 Ω', user: { login: 'reviewer', type: 'User' } }]);
  } else if (endpoint.endsWith('/pulls/17/comments')) {
    send([{ id: 202, body: 'inline code\n두 번째 줄', path: 'src/a.js', line: 9 }]);
  } else if (endpoint.endsWith('/issues/17/comments')) {
    send([{ id: 303, body: 'issue comment $HOME; $(ignored)', user: { login: 'human', type: 'User' } }]);
  } else {
    process.stderr.write('unexpected endpoint: ' + endpoint + '\n');
    process.exitCode = 4;
  }
} else if (argv[0] === 'api' && argv.includes('--method')) {
  JSON.parse(stdin);
  send({ ok: true });
} else {
  process.stderr.write('unexpected argv: ' + JSON.stringify(argv) + '\n');
  process.exitCode = 5;
}
`);

  let ghBinary;
  if (process.platform === 'win32') {
    ghBinary = path.join(directory, 'fake-gh.cmd');
    writeFileSync(
      ghBinary,
      `@echo off\r\n"${process.execPath}" "%~dp0\\fake-gh.cjs" %*\r\n`,
    );
  } else {
    ghBinary = path.join(directory, 'fake-gh');
    writeFileSync(
      ghBinary,
      `#!${process.execPath}\nrequire(${JSON.stringify(scriptPath)});\n`,
    );
    chmodSync(ghBinary, 0o755);
  }
  return {
    ghBinary,
    logPath,
    env: { ...process.env, FAKE_GH_LOG: logPath },
  };
}

test('listReviewReports uses exact suffix, stat mtime, deterministic path ties, and limit', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-report-list-');
  const reports = path.join(repo, '.deep-review', 'reports');
  mkdirSync(reports, { recursive: true });

  const older = path.join(reports, '2026-07-12-120000-review.md');
  const tiedA = path.join(reports, 'a-review.md');
  const tiedB = path.join(reports, 'b-review.md');
  const newest = path.join(reports, 'z-review.md');
  for (const filePath of [older, tiedA, tiedB, newest]) writeFileSync(filePath, '# review\n');
  writeFileSync(path.join(reports, 'ignored-ultrareview.md'), '# not canonical\n');
  writeFileSync(path.join(reports, 'ignored-review.md.bak'), '# backup\n');
  mkdirSync(path.join(reports, 'directory-review.md'));

  const oldTime = new Date('2026-07-12T00:00:00.000Z');
  const tieTime = new Date('2026-07-13T00:00:00.000Z');
  const newTime = new Date('2026-07-14T00:00:00.000Z');
  utimesSync(older, oldTime, oldTime);
  utimesSync(tiedA, tieTime, tieTime);
  utimesSync(tiedB, tieTime, tieTime);
  utimesSync(newest, newTime, newTime);

  const listed = runtime.listReviewReports({ repo, limit: 3 });
  assert.deepEqual(listed.map((entry) => entry.path), [newest, tiedA, tiedB]);
  assert.deepEqual(listed.map((entry) => entry.name), [
    path.basename(newest),
    path.basename(tiedA),
    path.basename(tiedB),
  ]);
  assert.ok(listed[0].mtime_ms > listed[1].mtime_ms);
  assert.equal(listed[1].mtime_ms, listed[2].mtime_ms);
  assert.ok(listed.every((entry) => Number.isSafeInteger(entry.size_bytes)));
  assert.deepEqual(runtime.listReviewReports({ repo, limit: 0 }), []);
});

test('listReviewReports returns an empty list when the reports directory is absent', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-no-reports-');
  assert.deepEqual(runtime.listReviewReports({ repo, limit: 3 }), []);
  assert.throws(() => runtime.listReviewReports({ repo, limit: -1 }), /limit/u);
});

test('writeResponseReport publishes complete UTF-8 content atomically without overwrite', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-response-write-');
  const timestamp = '2026-07-13T03:04:05.000Z';
  const firstContent = '# Response\n\nquotes "\'" and 한글 Ω\n';
  const first = runtime.writeResponseReport({ repo, content: firstContent, timestamp });
  assert.equal(first, path.join(repo, '.deep-review', 'responses', '2026-07-13-030405-response.md'));
  assert.equal(readFileSync(first, 'utf8'), firstContent);

  const secondContent = '# Second response\n';
  const second = runtime.writeResponseReport({ repo, content: secondContent, timestamp });
  assert.equal(second, path.join(repo, '.deep-review', 'responses', '2026-07-13-030405-01-response.md'));
  assert.equal(readFileSync(first, 'utf8'), firstContent);
  assert.equal(readFileSync(second, 'utf8'), secondContent);
  assert.deepEqual(readdirSync(path.dirname(first)).sort(), [path.basename(first), path.basename(second)].sort());
});

test('fetchPrReview uses argv-only gh calls and preserves review bodies as JSON data', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-fetch-pr-');
  const fake = createFakeGh();
  const source = await runtime.fetchPrReview({
    repo,
    pr: '17',
    ghBinary: fake.ghBinary,
    env: fake.env,
  });

  assert.equal(source.source, 'github-pr');
  assert.equal(source.repository, 'acme/space-unicode');
  assert.equal(source.pr, 17);
  assert.equal(source.url, 'https://github.com/acme/space-unicode/pull/17');
  assert.equal(source.reviews[0].body, 'review "quoted"\n한글 Ω');
  assert.equal(source.review_comments[0].body, 'inline code\n두 번째 줄');
  assert.equal(source.issue_comments[0].body, 'issue comment $HOME; $(ignored)');
  assert.deepEqual(source.errors, []);

  const calls = readJsonLines(fake.logPath);
  assert.ok(calls.some((call) => call.argv[0] === 'repo' && call.argv[1] === 'view'));
  assert.equal(calls.filter((call) => call.argv[0] === 'api').length, 3);
  for (const call of calls) {
    assert.equal(call.argv.includes('-c'), false);
    assert.equal(call.argv.some((arg) => arg.includes('review "quoted"')), false);
    assert.equal(call.stdin, '');
  }
});

test('fetchPrReview detects the PR with argv and records a partial endpoint failure', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-fetch-pr-detect-');
  const fake = createFakeGh();
  const source = await runtime.fetchPrReview({
    repo,
    ghBinary: fake.ghBinary,
    env: { ...fake.env, FAKE_GH_FAIL_ENDPOINT: '/pulls/17/comments' },
  });
  assert.equal(source.pr, 17);
  assert.equal(source.review_comments.length, 0);
  assert.equal(source.reviews.length, 1);
  assert.equal(source.issue_comments.length, 1);
  assert.equal(source.errors.length, 1);
  assert.match(source.errors[0].endpoint, /pulls\/17\/comments$/u);
  assert.ok(readJsonLines(fake.logPath).some((call) => call.argv[0] === 'pr' && call.argv[1] === 'view'));
});

test('fetchPrReview rejects malformed PR values before starting gh', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-invalid-pr-');
  const fake = createFakeGh();
  for (const pr of [0, -1, '01', '1.5', '17; touch nope', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      runtime.fetchPrReview({ repo, pr, ghBinary: fake.ghBinary, env: fake.env }),
      /PR number/u,
    );
  }
  assert.deepEqual(readJsonLines(fake.logPath), []);
});

test('postPrResponse passes comment content only through JSON stdin for issue and inline replies', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-post-pr-');
  const fake = createFakeGh();
  const body = 'Fixed "quoted" line\n한글 Ω\n$HOME; $(do-not-run)';

  const issueResult = await runtime.postPrResponse({
    repo,
    repository: 'acme/space-unicode',
    pr: 17,
    body,
    kind: 'issue',
    ghBinary: fake.ghBinary,
    env: fake.env,
  });
  assert.equal(issueResult, undefined);
  await runtime.postPrResponse({
    repo,
    repository: 'acme/space-unicode',
    pr: 17,
    body,
    kind: 'inline',
    commentId: 202,
    ghBinary: fake.ghBinary,
    env: fake.env,
  });

  const posts = readJsonLines(fake.logPath).filter((call) => call.argv.includes('--method'));
  assert.equal(posts.length, 2);
  assert.ok(posts[0].argv.includes('repos/acme/space-unicode/issues/17/comments'));
  assert.ok(posts[1].argv.includes('repos/acme/space-unicode/pulls/17/comments/202/replies'));
  for (const post of posts) {
    assert.deepEqual(JSON.parse(post.stdin), { body });
    assert.equal(post.argv.some((arg) => arg.includes(body)), false);
    assert.equal(post.argv.includes('-c'), false);
  }
});

test('postPrResponse validates repository, ids, kind, and body before gh', async () => {
  const runtime = await import(runtimeUrl);
  const repo = temporaryDirectory('deep-review-post-invalid-');
  const fake = createFakeGh();
  const base = {
    repo,
    repository: 'acme/space-unicode',
    pr: 17,
    body: 'response',
    kind: 'inline',
    commentId: 202,
    ghBinary: fake.ghBinary,
    env: fake.env,
  };
  for (const override of [
    { repository: 'acme/space;bad' },
    { pr: '17 && bad' },
    { body: '' },
    { kind: 'review' },
    { commentId: '2.2' },
  ]) {
    await assert.rejects(runtime.postPrResponse({ ...base, ...override }), /repository|PR number|body|kind|comment ID/u);
  }
  assert.deepEqual(readJsonLines(fake.logPath), []);
});
