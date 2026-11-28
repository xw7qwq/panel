// 把 xw7qwq 组织的仓库信息和文档同步到 Notion 的「仓库」数据库。
//
// 每个仓库是数据库里的一行，按「同步 ID」（owner/repo）认行：
// - 属性里只改写「最近推送」「最近提交」「开放 PR」「同步时间」，新仓库第一次出现时才填其余列；
// - 页面正文只改写「仓库文档（自动同步）」标题和「我的笔记」标题之间的状态说明，其余正文归用户；
// - 文档全文放在行页面下标题以「文档 · 」开头的子页面里，默认分支有新提交时整体重建。
// 私有仓库只同步元数据，不同步文件内容。从不删除行。

import { chunkBlocks } from './clients.mjs';
import { markdownToBlocks, splitFrontmatter } from './markdown.mjs';

export const SYNC_HEADING = '仓库文档（自动同步）';
export const NOTES_HEADING = '我的笔记';
export const DOC_PREFIX = '文档 · ';

// 每个仓库要镜像的文件。没列出的公开仓库默认只镜像 README。
export const DOCS = {
  panel: ['README.md'],
  ui: ['README.md'],
  blog: ['README.md', 'docs/*.zh-CN.md', 'docs/MACFLARE.md', 'src/content/posts/**/*.md', 'src/content/spec/zh/*.md'],
  oj: ['README.md', 'docs/*.md'],
  solutions: ['README.md', 'scripts/README.md'],
  health: ['README.md', 'DEPLOYMENT.md', 'GOOGLE_HEALTH.md', 'docs/*.md', 'docs/history/*.md'],
  macflare: ['README.md', 'CHANGELOG.md', 'docs/*.md'],
  ledger: ['README.md'],
  '.github': ['README.md', 'profile/README.md', 'CONTRIBUTING.md', 'docs/*.md'],
};

const MAX_FILE_BYTES = 200_000;

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function selectFiles(paths, patterns) {
  const matchers = patterns.map(globToRegExp);
  const selected = [];
  for (const pattern of matchers) {
    for (const path of paths) if (pattern.test(path) && !selected.includes(path)) selected.push(path);
  }
  return selected;
}

const plain = (value) => [{ type: 'text', text: { content: String(value).slice(0, 2000) } }];
const textOf = (block) => (block[block.type]?.rich_text ?? []).map((item) => item.plain_text ?? item.text?.content ?? '').join('');
const shortSha = (sha) => String(sha).slice(0, 7);

/** 从行页面的子块里找出同步区：两个标题的位置和中间的块。 */
export function findSyncSection(blocks) {
  const start = blocks.findIndex((block) => /^heading_/.test(block.type) && textOf(block).trim() === SYNC_HEADING);
  if (start < 0) return null;
  let end = blocks.findIndex((block, index) => index > start && /^heading_/.test(block.type) && textOf(block).trim() === NOTES_HEADING);
  if (end < 0) end = blocks.findIndex((block, index) => index > start && (/^heading_/.test(block.type) || block.type === 'child_page'));
  if (end < 0) end = blocks.length;
  return { heading: blocks[start], between: blocks.slice(start + 1, end) };
}

export function syncedSha(section) {
  for (const block of section?.between ?? []) {
    const match = /同步自 ([0-9a-f]{7})/.exec(textOf(block));
    if (match) return match[1];
  }
  return null;
}

export function rowProperties(repo, head, openPulls, now) {
  const properties = {
    最近推送: { date: { start: (repo.pushed_at ?? now).slice(0, 10) } },
    '开放 PR': { number: openPulls },
    同步时间: { date: { start: now } },
  };
  if (head) properties['最近提交'] = { rich_text: plain(`${shortSha(head.sha)} ${head.commit.message.split('\n')[0]}`) };
  if (repo.archived) properties['状态'] = { select: { name: '停用' } };
  return properties;
}

export function newRowProperties(repo) {
  const properties = {
    仓库: { title: plain(repo.name) },
    '同步 ID': { rich_text: plain(repo.full_name) },
    GitHub: { url: repo.html_url },
    可见性: { select: { name: repo.private ? '私有' : '公开' } },
    状态: { select: { name: repo.archived ? '停用' : '运行中' } },
  };
  if (repo.description) properties['作用'] = { rich_text: plain(repo.description) };
  if (repo.homepage) properties['网址'] = { url: repo.homepage };
  return properties;
}

export function linkResolver(repo, sha, path) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return (href) => {
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (!href || href.startsWith('#')) return null;
    const [target] = href.split('#');
    const parts = [];
    for (const part of (target.startsWith('/') ? target.slice(1) : dir + target).split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return `https://github.com/${repo.full_name}/blob/${sha}/${parts.map(encodeURIComponent).join('/')}`;
  };
}

export async function syncRepositories({ github, notion, databaseId, org, force = false, dryRun = false, log = console.log, now = new Date().toISOString() }) {
  const repos = (await github.json(`/orgs/${org}/repos?per_page=100&type=all&sort=full_name`))
    .filter((repo) => !repo.fork);
  const rows = await notion.queryAll(databaseId);
  const byId = new Map();
  for (const row of rows) {
    const id = (row.properties['同步 ID']?.rich_text ?? []).map((item) => item.plain_text).join('').trim();
    if (id) byId.set(id, row);
  }
  const summary = { repos: repos.length, created: 0, updated: 0, docsRebuilt: 0, docsSkipped: 0, failed: [] };

  for (const repo of repos) {
    try {
      const head = await github.json(`/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`).catch(() => null);
      const pulls = await github.json(`/repos/${repo.full_name}/pulls?state=open&per_page=100`).catch(() => []);
      let row = byId.get(repo.full_name);
      if (!row) {
        log(`新仓库 ${repo.full_name}：创建一行`);
        summary.created++;
        if (dryRun) continue;
        row = await notion.call('POST', '/pages', {
          parent: { database_id: databaseId },
          properties: { ...newRowProperties(repo), ...rowProperties(repo, head, pulls.length, now) },
          children: [
            { object: 'block', type: 'heading_2', heading_2: { rich_text: plain(SYNC_HEADING) } },
            { object: 'block', type: 'paragraph', paragraph: { rich_text: plain('等待首次同步。') } },
            { object: 'block', type: 'heading_2', heading_2: { rich_text: plain(NOTES_HEADING) } },
          ],
        });
      } else {
        summary.updated++;
        if (!dryRun) await notion.call('PATCH', `/pages/${row.id}`, { properties: rowProperties(repo, head, pulls.length, now) });
      }

      if (repo.private || !head) { log(`${repo.full_name}：只同步元数据`); continue; }
      await syncDocuments({ github, notion, repo, row, head, force, dryRun, log, now, summary });
    } catch (error) {
      log(`${repo.full_name} 失败：${error.message}`);
      summary.failed.push(repo.full_name);
    }
  }
  return summary;
}

async function syncDocuments({ github, notion, repo, row, head, force, dryRun, log, now, summary }) {
  const sha = shortSha(head.sha);
  const blocks = await notion.children(row.id);
  let section = findSyncSection(blocks);
  if (!force && syncedSha(section) === sha) {
    summary.docsSkipped++;
    log(`${repo.full_name}：文档已是 ${sha}，跳过`);
    return;
  }
  const tree = await github.json(`/repos/${repo.full_name}/git/trees/${head.sha}?recursive=1`);
  const files = tree.tree.filter((entry) => entry.type === 'blob' && entry.size <= MAX_FILE_BYTES);
  const paths = selectFiles(files.map((entry) => entry.path), DOCS[repo.name] ?? ['README.md']);
  log(`${repo.full_name}：同步 ${paths.length} 个文档（${sha}）`);
  summary.docsRebuilt++;
  if (dryRun) return;

  const documents = [];
  for (const path of paths) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const source = await github.raw(`/repos/${repo.full_name}/contents/${encoded}?ref=${head.sha}`);
    const { body, title } = splitFrontmatter(source);
    documents.push({ path, title, blocks: markdownToBlocks(body, { resolveLink: linkResolver(repo, head.sha, path) }) });
  }

  // 先建新的子页面，再归档旧的，中途失败时旧内容还在。
  const old = blocks.filter((block) => block.type === 'child_page' && block.child_page.title.startsWith(DOC_PREFIX));
  for (const document of documents) {
    const sourceUrl = `https://github.com/${repo.full_name}/blob/${head.sha}/${document.path.split('/').map(encodeURIComponent).join('/')}`;
    const intro = {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '🔁' },
        rich_text: [
          ...plain(`自动镜像自 ${repo.full_name} 的 `),
          { type: 'text', text: { content: document.path, link: { url: sourceUrl } } },
          ...plain(`（${sha}）。这一页会在下次同步时整页重建，笔记请写在上一级页面。`),
        ],
      },
    };
    const [first, ...rest] = chunkBlocks([intro, ...document.blocks]);
    const name = document.title ? `${document.path}｜${document.title}` : document.path;
    const page = await notion.call('POST', '/pages', {
      parent: { page_id: row.id },
      icon: { type: 'emoji', emoji: '📄' },
      properties: { title: plain(DOC_PREFIX + name) },
      children: first,
    });
    if (rest.length) await notion.append(page.id, rest.flat());
  }
  for (const block of old) await notion.call('PATCH', `/blocks/${block.id}`, { archived: true });

  const status = {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: plain(`同步自 ${sha}，共 ${documents.length} 个文档，${now.slice(0, 16).replace('T', ' ')} UTC。全文在本页底部「${DOC_PREFIX}…」子页面里，每次仓库有新提交时整页重建。`),
    },
  };
  if (!section) {
    await notion.append(row.id, [
      { object: 'block', type: 'heading_2', heading_2: { rich_text: plain(SYNC_HEADING) } },
      status,
    ]);
    return;
  }
  for (const block of section.between) {
    if (block.type !== 'child_page' && block.type !== 'child_database') await notion.call('DELETE', `/blocks/${block.id}`);
  }
  await notion.append(row.id, [status], section.heading.id);
}
