#!/usr/bin/env node
// 把 xw7qwq 组织的仓库同步到 Notion「仓库」数据库。用法见 README 的「Notion 中转站」一节。
//   NOTION_TOKEN=… NOTION_DATABASE_ID=… GITHUB_TOKEN=… node scripts/notion-sync.mjs [--force] [--dry-run]
import { githubClient, notionClient } from './notion/clients.mjs';
import { syncRepositories } from './notion/sync.mjs';

const args = new Set(process.argv.slice(2));
const token = process.env.NOTION_TOKEN?.trim();
if (!token) {
  console.log('没有设置 NOTION_TOKEN，跳过 Notion 同步。');
  process.exit(0);
}
const databaseId = process.env.NOTION_DATABASE_ID?.trim();
if (!databaseId) {
  console.error('需要 NOTION_DATABASE_ID：Notion「仓库」数据库的 ID。');
  process.exit(1);
}

const summary = await syncRepositories({
  github: githubClient({ token: process.env.GITHUB_TOKEN?.trim() }),
  notion: notionClient({ token }),
  databaseId,
  org: process.env.GITHUB_ORG?.trim() || 'xw7qwq',
  force: args.has('--force') || process.env.FORCE === 'true',
  dryRun: args.has('--dry-run') || process.env.DRY_RUN === 'true',
});
console.log(JSON.stringify(summary));
if (summary.failed.length) process.exit(1);
