import { json } from './http.js';
import { TOOLS, ToolError } from './tools.js';

// 只读 MCP 服务（Streamable HTTP，无状态）：每个 POST 是一条 JSON-RPC 消息，直接返回 JSON，不开 SSE 流。
// 访问令牌由 OAuthProvider 在进入这里之前校验。
export const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'xw7-panel', title: 'xw7 面板', version: '0.1.0' };

const INSTRUCTIONS = [
  '这是 Lucius7 的个人面板 lucius7.dev 的只读数据接口，覆盖刷题统计、题解源码、Mac 当前状态、健康指标和记账。',
  '先用 get_overview 看全局，再按需调用各栏目的工具。所有工具都只读，不能修改任何数据。',
  '日期按 UTC+8；金额是账本的主币种；健康数据里的 null 表示没有记录，不是 0。',
].join('\n');

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export const mcpHandler = {
  fetch(request, env, ctx) {
    return handleMcp(request, env, ctx);
  },
};

export async function handleMcp(request, env, ctx) {
  if (request.method === 'GET' || request.method === 'DELETE') {
    // 不提供服务端推送流，也没有会话可以删除。
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return rpcResponse(error(null, INVALID_REQUEST, '不接受跨站请求'), 403);
  const version = request.headers.get('MCP-Protocol-Version');
  if (version && !PROTOCOL_VERSIONS.includes(version)) return rpcResponse(error(null, INVALID_REQUEST, `不支持的协议版本 ${version}`), 400);

  let message;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return rpcResponse(error(null, PARSE_ERROR, '请求体不是合法的 JSON'), 400);
  }
  // 2025-03-26 允许批量消息，之后的版本去掉了；两种都接受。
  const batch = Array.isArray(message);
  const messages = batch ? message : [message];
  if (!messages.length) return rpcResponse(error(null, INVALID_REQUEST, '空的批量请求'), 400);
  const replies = [];
  for (const item of messages) {
    const reply = await dispatch(item, env, ctx);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return rpcResponse(batch ? replies : replies[0]);
}

function rpcResponse(body, status = 200) {
  return json(body, { status });
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function negotiate(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

export function listTools() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

async function dispatch(message, env, ctx) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return error(message?.id ?? null, INVALID_REQUEST, '不是 JSON-RPC 2.0 消息');
  // 客户端对服务端请求的回应：我们从不发请求，直接忽略。
  if (typeof message.method !== 'string') return 'result' in message || 'error' in message ? null : error(message.id ?? null, INVALID_REQUEST, '缺少 method');
  const notification = !('id' in message);
  const { id } = message;
  try {
    switch (message.method) {
      case 'initialize':
        return result(id, {
          protocolVersion: negotiate(message.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return notification ? null : result(id, {});
      case 'tools/list':
        return result(id, { tools: listTools() });
      case 'tools/call':
        return await callTool(id, message.params, env, ctx);
      default:
        if (message.method.startsWith('notifications/') || notification) return null;
        return error(id, METHOD_NOT_FOUND, `没有这个方法：${message.method}`);
    }
  } catch (cause) {
    console.error(cause);
    return notification ? null : error(id, INTERNAL_ERROR, '服务器内部错误');
  }
}

async function callTool(id, params, env, ctx) {
  const tool = TOOLS.find((item) => item.name === params?.name);
  if (!tool) return error(id, INVALID_PARAMS, `没有这个工具：${params?.name}`);
  const args = params.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) return error(id, INVALID_PARAMS, 'arguments 必须是对象');
  try {
    const data = await tool.run(args, env, ctx);
    const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : { items: data };
    return result(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: structured });
  } catch (cause) {
    if (cause instanceof ToolError) return result(id, { content: [{ type: 'text', text: cause.message }], isError: true });
    throw cause;
  }
}
