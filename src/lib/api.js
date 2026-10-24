// 浏览器端读 /api/v1。401 时默认跳去登录（login: false 时只抛错），其余错误抛出带中文说明的 Error。
export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function getJson(path, { signal, login = true } = {}) {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // 非 JSON 响应按状态码报错。
  }
  if (response.status === 401 && login) {
    location.assign(`/login/?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, '需要登录');
  }
  if (!response.ok) throw new ApiError(response.status, body?.error?.message || `请求失败（HTTP ${response.status}）`);
  return body;
}

// 写请求（登录、通行密钥管理）：发 JSON，出错时抛出带错误码的 ApiError，不自动跳转。
export async function sendJson(path, { method = 'POST', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let result = null;
  try {
    result = await response.json();
  } catch {
    // 非 JSON 响应按状态码报错。
  }
  if (!response.ok) throw new ApiError(response.status, result?.error?.message || `请求失败（HTTP ${response.status}）`, result?.error?.code ?? null);
  return result;
}

export async function getText(path, { signal } = {}) {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      message = (await response.json())?.error?.message || message;
    } catch {
      // 保留默认说明。
    }
    throw new ApiError(response.status, message);
  }
  return response.text();
}

// 只是界面提示；真正的权限由服务端会话决定。
export function signedIn() {
  return typeof document !== 'undefined' && document.cookie.split('; ').includes('xw7_signed_in=1');
}

// 数据里的外链只接受 https，避免 javascript: 之类的地址。
export function safeUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : undefined;
}

// 定时刷新：页面在后台时暂停，回到前台立刻刷新一次。
export function poll(task, interval) {
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    task();
    timer = setTimeout(run, interval);
  };
  const onVisible = () => {
    if (document.hidden) clearTimeout(timer);
    else run();
  };
  run();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
