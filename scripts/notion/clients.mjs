// GitHub REST 和 Notion API 的最小客户端，只用 Node 自带的 fetch。
// 令牌只发给各自的主机，错误信息里不带令牌。

export class HttpError extends Error {
  constructor(service, status, message) {
    super(`${service} ${status}: ${message}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(service, url, init, { fetchImpl, attempts = 5, wait = sleep }) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error' });
    } catch (error) {
      if (attempt >= attempts) throw new HttpError(service, 0, error.message);
      await wait(1000 * attempt);
      continue;
    }
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= attempts) {
      const body = await response.text().catch(() => '');
      let message = body.slice(0, 300);
      try { message = JSON.parse(body).message ?? message; } catch { /* 不是 JSON */ }
      throw new HttpError(service, response.status, message);
    }
    const after = Number(response.headers.get('retry-after'));
    await wait(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
  }
}

export function githubClient({ token, fetchImpl = fetch, wait } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'xw7-notion-relay',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const get = async (path, accept) => request('GitHub', `https://api.github.com${path}`, {
    headers: accept ? { ...headers, accept } : headers,
  }, { fetchImpl, wait });
  return {
    async json(path) { return (await get(path)).json(); },
    async raw(path) { return (await get(path, 'application/vnd.github.raw')).text(); },
  };
}

export function notionClient({ token, fetchImpl = fetch, wait = sleep, interval = 350 } = {}) {
  if (!token || /\s/.test(token)) throw new Error('NOTION_TOKEN 没有设置');
  let last = 0;
  const call = async (method, path, body) => {
    // Notion 允许每个集成平均每秒 3 次请求。
    const now = Date.now();
    if (now - last < interval) await wait(interval - (now - last));
    last = Date.now();
    const response = await request('Notion', `https://api.notion.com/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': '2022-06-28',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { fetchImpl, wait });
    return response.json();
  };
  return {
    call,
    async queryAll(databaseId, body = {}) {
      const results = [];
      let cursor;
      do {
        const page = await call('POST', `/databases/${databaseId}/query`, { ...body, page_size: 100, start_cursor: cursor });
        results.push(...page.results);
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return results;
    },
    async children(blockId) {
      const results = [];
      let cursor;
      do {
        const query = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
        const page = await call('GET', `/blocks/${blockId}/children${query}`);
        results.push(...page.results);
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return results;
    },
    async append(blockId, blocks, after) {
      // 分批发送，指定 after 时按顺序接在它后面。
      let anchor = after;
      for (const children of chunkBlocks(blocks)) {
        const body = { children };
        if (anchor) body.after = anchor;
        const result = await call('PATCH', `/blocks/${blockId}/children`, body);
        if (anchor) anchor = result.results.at(-1)?.id ?? anchor;
      }
    },
  };
}

/** 按 Notion 的请求上限分批：每批最多 100 个顶层块、合计（含表格行）不超过 900 个块。 */
export function chunkBlocks(blocks, { top = 100, total = 900 } = {}) {
  const chunks = [];
  let current = [];
  let count = 0;
  for (const block of blocks) {
    const size = 1 + (block[block.type]?.children?.length ?? 0);
    if (current.length && (current.length >= top || count + size > total)) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(block);
    count += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
