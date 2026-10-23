import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app.js';
import { SCOPE } from './consent.js';
import { canonicalRedirect } from './http.js';
import { mcpHandler } from './mcp.js';

// 入口：OAuthProvider 负责 /mcp 的令牌校验、OAuth 元数据、令牌和客户端注册端点，其余请求交给 app。
// 资源地址依赖站点域名（SITE_ORIGIN），所以按环境变量在第一次请求时创建一次。
const providers = new Map();

function provider(origin) {
  if (!providers.has(origin)) {
    providers.set(
      origin,
      new OAuthProvider({
        apiRoute: '/mcp',
        apiHandler: mcpHandler,
        defaultHandler: app,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/oauth/token',
        clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: [SCOPE, 'offline_access'],
        requiredScopes: [SCOPE],
        resourceMetadata: {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ['header'],
          resource_name: 'xw7 面板',
        },
        clientIdMetadataDocumentEnabled: true,
        accessTokenTTL: 3600,
        refreshTokenTTL: 30 * 86_400,
      }),
    );
  }
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    const moved = canonicalRedirect(request, env.SITE_ORIGIN);
    if (moved) return moved;
    const origin = env.SITE_ORIGIN || new URL(request.url).origin;
    return provider(origin).fetch(request, env, ctx);
  },
};
