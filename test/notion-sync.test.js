// Notion 中转站：Markdown 转换和同步流程。
import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkBlocks, notionClient } from '../scripts/notion/clients.mjs';
import { markdownToBlocks, richText, splitFrontmatter } from '../scripts/notion/markdown.mjs';
import { DOC_PREFIX, NOTES_HEADING, SYNC_HEADING, findSyncSection, linkResolver, selectFiles, syncRepositories, syncedSha } from '../scripts/notion/sync.mjs';

const text = (items) => items.map((item) => item.text.content).join('');

test('markdown: headings, lists, todo, quote, code and divider', () => {
  const blocks = markdownToBlocks([
    '# 标题', '', '第一行', '第二行', '', '- 一', '1. 二', '- [x] 做完', '> 引用', '', '```sh', 'pnpm check', '```', '', '---', '#### 四级',
  ].join('\n'));
  assert.deepEqual(blocks.map((block) => block.type), ['heading_1', 'paragraph', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'code', 'divider', 'heading_3']);
  assert.equal(text(blocks[1].paragraph.rich_text), '第一行\n第二行');
  assert.equal(blocks[4].to_do.checked, true);
  assert.equal(blocks[6].code.language, 'shell');
  assert.equal(text(blocks[6].code.rich_text), 'pnpm check');
});

test('markdown: tables keep code cells with pipes and split past 100 rows', () => {
  const [table] = markdownToBlocks('| a | b |\n| --- | --- |\n| `x|y` | **z** |');
  assert.equal(table.table.table_width, 2);
  assert.equal(text(table.table.children[1].table_row.cells[0]), 'x|y');
  assert.equal(table.table.children[1].table_row.cells[1][0].annotations.bold, true);
  const rows = Array.from({ length: 150 }, (_, i) => `| ${i} |`).join('\n');
  const split = markdownToBlocks(`| n |\n| --- |\n${rows}`);
  assert.equal(split.length, 2);
  assert.ok(split.every((block) => block.table.children.length <= 100));
  assert.equal(text(split[1].table.children[0].table_row.cells[0]), 'n');
});

test('rich text: links, inline code, bare URLs and the 2000 character limit', () => {
  const items = richText('看 [面板](https://panel.lucius7.dev/) 和 `code`，以及 https://blog.lucius7.cn/。');
  assert.equal(items[1].text.link.url, 'https://panel.lucius7.dev/');
  assert.equal(items[3].annotations.code, true);
  assert.ok(items.some((item) => item.text.link?.url === 'https://blog.lucius7.cn/'));
  assert.equal(richText('[相对](docs/a.md)')[0].text.link, undefined);
  const long = richText('x'.repeat(4500));
  assert.deepEqual(long.map((item) => item.text.content.length), [2000, 2000, 500]);
});

test('relative links point at the file on GitHub', () => {
  const resolve = linkResolver({ full_name: 'xw7qwq/health' }, 'abc', 'docs/history/README.md');
  assert.equal(resolve('../provenance.md#top'), 'https://github.com/xw7qwq/health/blob/abc/docs/provenance.md');
  assert.equal(resolve('#local'), null);
  assert.equal(resolve('https://x.dev/'), 'https://x.dev/');
});

test('frontmatter is removed and its title kept', () => {
  assert.deepEqual(splitFrontmatter('---\ntitle: "九月"\ndate: 2026-09-30\n---\n正文'), { body: '正文', title: '九月' });
  assert.equal(splitFrontmatter('正文').title, null);
});

test('file selection follows the pattern order', () => {
  const paths = ['README.md', 'docs/b.md', 'docs/a.zh-CN.md', 'src/content/posts/zh/x/index.md', 'src/content/posts/zh/y.md', 'docs/deep/c.md'];
  assert.deepEqual(selectFiles(paths, ['README.md', 'docs/*.md']), ['README.md', 'docs/b.md', 'docs/a.zh-CN.md']);
  assert.deepEqual(selectFiles(paths, ['src/content/posts/**/*.md']), ['src/content/posts/zh/x/index.md', 'src/content/posts/zh/y.md']);
});

test('chunks respect the top-level and total block limits', () => {
  const table = { type: 'table', table: { children: new Array(99).fill({}) } };
  const chunks = chunkBlocks([...new Array(150).fill({ type: 'paragraph', paragraph: {} }), ...new Array(12).fill(table)]);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  assert.ok(chunks.every((chunk) => chunk.reduce((sum, block) => sum + 1 + (block[block.type].children?.length ?? 0), 0) <= 900));
  assert.equal(chunks.flat().length, 162);
});

const heading = (id, content) => ({ id, type: 'heading_2', heading_2: { rich_text: [{ plain_text: content }] } });
const paragraph = (id, content) => ({ id, type: 'paragraph', paragraph: { rich_text: [{ plain_text: content }] } });

test('sync section is found between the two headings', () => {
  const blocks = [paragraph('p0', '介绍'), heading('h1', SYNC_HEADING), paragraph('p1', '同步自 abcdef1，共 2 个文档'), heading('h2', NOTES_HEADING), paragraph('p2', '笔记')];
  const section = findSyncSection(blocks);
  assert.equal(section.heading.id, 'h1');
  assert.deepEqual(section.between.map((block) => block.id), ['p1']);
  assert.equal(syncedSha(section), 'abcdef1');
  assert.equal(findSyncSection([paragraph('p', 'x')]), null);
});

function fakeWorld({ rows, pageBlocks }) {
  const calls = [];
  const repos = [
    { name: 'panel', full_name: 'xw7qwq/panel', default_branch: 'main', private: false, archived: false, pushed_at: '2026-11-26T00:00:00Z', html_url: 'https://github.com/xw7qwq/panel' },
    { name: 'ledger-data', full_name: 'xw7qwq/ledger-data', default_branch: 'main', private: true, archived: false, pushed_at: '2026-10-24T00:00:00Z', html_url: 'https://github.com/xw7qwq/ledger-data' },
    { name: 'newone', full_name: 'xw7qwq/newone', default_branch: 'main', private: false, archived: false, pushed_at: '2026-11-27T00:00:00Z', html_url: 'https://github.com/xw7qwq/newone', description: '新的' },
  ];
  const github = {
    async json(path) {
      if (path.startsWith('/orgs/')) return repos;
      if (path.includes('/commits/')) return { sha: path.includes('panel') ? 'abcdef1234' : '1111111999', commit: { message: 'feat: x\n\nbody' } };
      if (path.includes('/pulls')) return [{}];
      if (path.includes('/git/trees/')) return { tree: [{ type: 'blob', path: 'README.md', size: 10 }, { type: 'blob', path: 'src/a.js', size: 10 }] };
      throw new Error(`unexpected ${path}`);
    },
    async raw() { return '# 标题\n\n正文'; },
  };
  let created = 0;
  const notion = {
    async queryAll() { return rows; },
    async children(id) { return pageBlocks[id] ?? []; },
    async append(id, blocks, after) { calls.push(['append', id, blocks.length, after]); },
    async call(method, path, body) {
      calls.push([method, path, body]);
      if (method === 'POST' && path === '/pages') return { id: `new-${++created}` };
      return {};
    },
  };
  return { github, notion, calls };
}

test('sync updates rows, creates missing ones and rebuilds stale documents', async () => {
  const row = (id, repo) => ({ id, properties: { '同步 ID': { rich_text: [{ plain_text: repo }] } } });
  const world = fakeWorld({
    rows: [row('row-panel', 'xw7qwq/panel'), row('row-ledger', 'xw7qwq/ledger-data')],
    pageBlocks: {
      'row-panel': [heading('h1', SYNC_HEADING), paragraph('p1', '首次同步尚未运行。'), heading('h2', NOTES_HEADING), { id: 'old', type: 'child_page', child_page: { title: `${DOC_PREFIX}README.md` } }, { id: 'mine', type: 'child_page', child_page: { title: '我的页面' } }],
    },
  });
  const summary = await syncRepositories({ ...world, databaseId: 'db', org: 'xw7qwq', log: () => {}, now: '2026-11-28T10:00:00.000Z' });
  assert.deepEqual(summary, { repos: 3, created: 1, updated: 2, docsRebuilt: 2, docsSkipped: 0, failed: [] });

  const patch = world.calls.find(([method, path]) => method === 'PATCH' && path === '/pages/row-panel');
  assert.equal(patch[2].properties['最近提交'].rich_text[0].text.content, 'abcdef1 feat: x');
  assert.equal(patch[2].properties['开放 PR'].number, 1);
  assert.equal(patch[2].properties['作用'], undefined, '用户填的列不被改写');

  // 私有仓库只更新属性，不读文件。
  assert.ok(world.calls.some(([method, path]) => method === 'PATCH' && path === '/pages/row-ledger'));
  assert.ok(!world.calls.some(([method, path, body]) => method === 'POST' && body?.parent?.page_id === 'row-ledger'));

  const docPages = world.calls.filter(([method, path, body]) => method === 'POST' && path === '/pages' && body.parent.page_id === 'row-panel');
  assert.equal(docPages.length, 1);
  assert.equal(docPages[0][2].properties.title[0].text.content, `${DOC_PREFIX}README.md`);
  assert.ok(world.calls.some(([method, path, body]) => method === 'PATCH' && path === '/blocks/old' && body.archived));
  assert.ok(!world.calls.some(([, path]) => path === '/blocks/mine'), '用户自己的子页面不动');
  assert.ok(world.calls.some(([method, path]) => method === 'DELETE' && path === '/blocks/p1'));
  assert.ok(world.calls.some(([kind, id, , after]) => kind === 'append' && id === 'row-panel' && after === 'h1'));

  const newRow = world.calls.find(([method, path, body]) => method === 'POST' && path === '/pages' && body.parent.database_id === 'db');
  assert.equal(newRow[2].properties['同步 ID'].rich_text[0].text.content, 'xw7qwq/newone');
  assert.equal(newRow[2].properties['作用'].rich_text[0].text.content, '新的');
});

test('sync skips documents already at the current commit', async () => {
  const world = fakeWorld({
    rows: [{ id: 'row-panel', properties: { '同步 ID': { rich_text: [{ plain_text: 'xw7qwq/panel' }] } } }],
    pageBlocks: { 'row-panel': [heading('h1', SYNC_HEADING), paragraph('p1', '同步自 abcdef1，共 1 个文档'), heading('h2', NOTES_HEADING)] },
  });
  const summary = await syncRepositories({ ...world, databaseId: 'db', org: 'xw7qwq', log: () => {}, dryRun: true });
  assert.equal(summary.docsSkipped, 1);
  assert.equal(summary.created, 2);
  assert.ok(world.calls.every(([method]) => method !== 'PATCH' && method !== 'DELETE'), 'dry run 不写 Notion');
});

test('notion client retries on 429 and paces requests', async () => {
  let attempts = 0;
  const waits = [];
  const client = notionClient({
    token: 'secret_x',
    wait: async (ms) => { waits.push(ms); },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).host, 'api.notion.com');
      assert.equal(init.headers.authorization, 'Bearer secret_x');
      attempts++;
      if (attempts === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await client.call('GET', '/users/me'), { ok: true });
  assert.equal(attempts, 2);
  assert.ok(waits.includes(2000));
  assert.throws(() => notionClient({ token: '' }), /NOTION_TOKEN/);
});
