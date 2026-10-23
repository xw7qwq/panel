// 上游数据。刷题和题解是 GitHub Pages 上的公开 JSON，状态来自 macflare，
// 健康和记账由服务器定时推送进 KV（见 ingest.js），面板从不直接连自有服务器。
const USER_AGENT = 'xw7-panel/0.1 (+https://lucius7.dev)';

export class UpstreamError extends Error {
  constructor(source, status, message = `${source} 返回 ${status}`) {
    super(message);
    this.source = source;
    this.status = status;
  }
}

// 边缘缓存 ttl 秒；同一份 JSON 在一个机房里几分钟内只取一次。
export function fetchUpstream(url, { ttl = 300, accept = 'application/json' } = {}) {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    cf: ttl > 0 ? { cacheTtl: ttl, cacheEverything: true } : { cacheTtl: 0 },
  });
}

export async function upstreamJson(source, url, ttl = 300) {
  let response;
  try {
    response = await fetchUpstream(url, { ttl });
  } catch (error) {
    throw new UpstreamError(source, 502, `${source} 无法连接：${error.message}`);
  }
  if (!response.ok) throw new UpstreamError(source, response.status);
  try {
    return await response.json();
  } catch {
    throw new UpstreamError(source, 502, `${source} 返回的不是 JSON`);
  }
}

// ---- 刷题 ----

export function ojSummary(env) {
  return upstreamJson('oj', `${env.OJ_DATA_BASE}/summary.json`, 300);
}

// ---- 状态（macflare）----

export async function macStatus(env) {
  const request = new Request(`${env.MACFLARE_BASE}/api/now`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
  let response;
  try {
    // 同账户的 Worker 之间走 Service Binding，不经过公网。
    response = env.MACFLARE ? await env.MACFLARE.fetch(request) : await fetch(request);
  } catch (error) {
    throw new UpstreamError('macflare', 502, `macflare 无法连接：${error.message}`);
  }
  if (!response.ok) throw new UpstreamError('macflare', response.status);
  try {
    return await response.json();
  } catch {
    throw new UpstreamError('macflare', 502, 'macflare 返回的不是 JSON');
  }
}

// 对外只给听歌和在线状态；正在用的 App、电量和负载只在登录后可见。
export function publicMacStatus(status) {
  if (!status || status.status !== 'online') return { status: 'offline' };
  const music = status.music || {};
  return {
    status: 'online',
    updated_at: status.updated_at ?? null,
    collected_at: status.collected_at ?? null,
    music: {
      state: music.state ?? 'unavailable',
      track: music.track ?? null,
      artist: music.artist ?? null,
      artwork_url: music.artwork_url ?? null,
      track_url: music.track_url ?? null,
    },
  };
}

// ---- 健康、记账（服务器推送的快照）----

export function readSnapshot(env, name) {
  return env.PANEL_KV.get(`${name}:snapshot`, 'json');
}

// 原样转发整份快照时不解析：几百 KB 的 JSON 解析再序列化会吃掉大半 CPU 预算。
export function readSnapshotStream(env, name) {
  return env.PANEL_KV.getWithMetadata(`${name}:snapshot`, 'stream');
}

export function readHealthPublic(env) {
  return env.PANEL_KV.get('health:public', 'json');
}

// ---- 题解 ----

const SOLUTION_FILE = /^[\p{L}\p{N} _.,+()[\]'!&@#=~-]+(?:\/[\p{L}\p{N} _.,+()[\]'!&@#=~-]+)*\.(?:cpp|cc|cxx|c|h|hpp|py|java|rs|go|kt|js|ts|txt|md)$/u;

// 只允许读题解仓库里的源码文件，防止被当成任意代理。
export function solutionPath(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  const path = value.replace(/^\/+/, '');
  if (!SOLUTION_FILE.test(path) || path.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.'))) return null;
  return path;
}

export function solutionRawUrl(env, path) {
  return `${env.SOLUTIONS_RAW_BASE}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

// site-data.json 约 700 KB。解析一次后把精简索引放进 Cache API，之后一小时内直接读精简版。
// 题解索引：上游 site-data.json 约 700 KB，只在缓存过期时解析一次；
// 缓存里存的是已经包好信封的精简 JSON，命中时原样返回，不再解析。
const SOLUTIONS_TTL = 3600;

export async function solutionsIndexResponse(env, ctx) {
  const key = new Request(`https://panel.cache/solutions-index?v=2&base=${encodeURIComponent(env.SOLUTIONS_DATA_BASE)}`);
  const cache = globalThis.caches?.default;
  const hit = cache ? await cache.match(key) : null;
  if (hit) return hit;
  const site = await upstreamJson('solutions', `${env.SOLUTIONS_DATA_BASE}/site-data.json`, 900);
  const index = compactSolutions(site);
  const body = JSON.stringify({ data: index, updated_at: index.generated_at, source: 'solutions' });
  const response = new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${SOLUTIONS_TTL}` },
  });
  if (cache) ctx?.waitUntil?.(cache.put(key, response.clone()));
  return response;
}

export async function solutionsIndex(env, ctx) {
  const body = await (await solutionsIndexResponse(env, ctx)).json();
  return body.data;
}

export function compactSolutions(site) {
  const problems = Array.isArray(site?.problems) ? site.problems : [];
  const repo = site?.repository;
  const valid = repo && /^[\w.-]+$/.test(repo.owner || '') && /^[\w.-]+$/.test(repo.name || '');
  return {
    generated_at: site?.generatedAt ?? null,
    commit_count: site?.commitCount ?? null,
    repository: valid ? { url: `https://github.com/${repo.owner}/${repo.name}`, branch: /^[\w./-]+$/.test(repo.branch || '') ? repo.branch : 'main' } : null,
    count: problems.length,
    items: problems
      .filter((item) => solutionPath(item?.path))
      .map((item) => ({
        path: item.path,
        title: item.title || item.path.split('/').pop(),
        platform: item.platform || item.path.split('/')[0],
        language: item.language || null,
        submitted_at: item.submittedAt || null,
        problem_url: item.problemUrl || null,
      })),
  };
}

// ---- 博客 ----

// 只取 RSS 里最新的几篇；扫描到够数就停，不解析整份 XML。
export async function blogLatest(env, limit = 5) {
  const response = await fetchUpstream(env.BLOG_FEED, { ttl: 1800, accept: 'application/rss+xml, application/xml' });
  if (!response.ok) throw new UpstreamError('blog', response.status);
  return parseFeed(await response.text(), limit);
}

export function parseFeed(xml, limit = 5) {
  const items = [];
  const pattern = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while (items.length < limit && (match = pattern.exec(xml))) {
    const block = match[1];
    const pick = (tag) => {
      const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return found ? decodeXml(found[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : null;
    };
    const link = pick('link');
    if (!link || !/^https:\/\//.test(link)) continue;
    const date = pick('pubDate');
    const parsed = date ? Date.parse(date) : Number.NaN;
    items.push({ title: pick('title') || link, url: link, published_at: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(), description: pick('description') || '' });
  }
  return items;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}
