import svelte from '@astrojs/svelte';
import { defineConfig } from 'astro/config';

// 页面全部静态生成，数据在浏览器里通过 /api/v1 读取；动态部分由 worker/ 处理。
export default defineConfig({
  site: 'https://lucius7.dev',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [svelte()],
  vite: {
    ssr: { noExternal: ['@xw7/ui'] },
  },
});
