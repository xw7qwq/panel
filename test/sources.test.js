import assert from 'node:assert/strict';
import test from 'node:test';
import { compactSolutions, parseFeed, publicMacStatus, solutionPath, solutionRawUrl } from '../worker/sources.js';

test('feed parsing decodes CDATA and entities, skips unsafe links and bad dates', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[第一篇 <b>]]></title><link>https://blog.lucius7.cn/posts/a/</link><pubDate>Mon, 20 Oct 2026 12:00:00 GMT</pubDate></item>
    <item><title>A &amp; B</title><link>javascript:alert(1)</link></item>
    <item><title>坏日期</title><link>https://blog.lucius7.cn/posts/c/</link><pubDate>someday</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml, 5);
  assert.deepEqual(items.map((item) => item.title), ['第一篇 <b>', '坏日期']);
  assert.equal(items[0].published_at, '2026-10-20T12:00:00.000Z');
  assert.equal(items[1].published_at, null);
  assert.equal(parseFeed(xml, 1).length, 1);
});

test('solution paths must stay inside the repository and be source files', () => {
  assert.equal(solutionPath('AtCoder/C_-_Remove_and_Append.cpp'), 'AtCoder/C_-_Remove_and_Append.cpp');
  assert.equal(solutionPath('/Codeforces/1/A (2).cpp'), 'Codeforces/1/A (2).cpp');
  assert.equal(solutionPath('洛谷/P1001.cpp'), '洛谷/P1001.cpp');
  for (const value of ['../secret.cpp', 'a/../../b.cpp', '.github/x.cpp', 'a/.hidden/b.cpp', 'a.exe', 'a/b', '', null, `${'a'.repeat(300)}.cpp`]) {
    assert.equal(solutionPath(value), null, String(value));
  }
  assert.equal(solutionRawUrl({ SOLUTIONS_RAW_BASE: 'https://raw.example/x/main' }, 'A B/c#1.cpp'), 'https://raw.example/x/main/A%20B/c%231.cpp');
});

test('solutions index is compacted and keeps a validated repository link', () => {
  const index = compactSolutions({
    generatedAt: '2026-10-23T00:00:00Z',
    commitCount: 3,
    repository: { owner: 'xw7qwq', name: 'solutions', branch: 'main' },
    problems: [
      { path: 'AtCoder/a.cpp', platform: 'AtCoder', language: 'C++', title: 'A', problemUrl: 'https://atcoder.jp/', githubUrl: 'x', rawUrl: 'y', submittedAt: '2026-10-01T00:00:00+08:00' },
      { path: '../escape.cpp', platform: 'AtCoder' },
    ],
  });
  assert.deepEqual(index.repository, { url: 'https://github.com/xw7qwq/solutions', branch: 'main' });
  assert.equal(index.count, 2);
  assert.deepEqual(index.items, [{ path: 'AtCoder/a.cpp', title: 'A', platform: 'AtCoder', language: 'C++', submitted_at: '2026-10-01T00:00:00+08:00', problem_url: 'https://atcoder.jp/' }]);
  assert.equal(compactSolutions({ repository: { owner: 'x/../y', name: 'z' } }).repository, null);
});

test('public mac status only exposes presence and music', () => {
  const full = {
    status: 'online',
    updated_at: 'u',
    collected_at: 'c',
    active_app: 'Secret App',
    running_apps: ['A'],
    battery: { percent: 50 },
    music: { state: 'playing', track: 'T', artist: 'A', extra: 1 },
  };
  const visible = publicMacStatus(full);
  assert.deepEqual(Object.keys(visible), ['status', 'updated_at', 'collected_at', 'music']);
  assert.deepEqual(visible.music, { state: 'playing', track: 'T', artist: 'A', artwork_url: null, track_url: null });
  assert.deepEqual(publicMacStatus({ status: 'offline' }), { status: 'offline' });
  assert.deepEqual(publicMacStatus(null), { status: 'offline' });
});
