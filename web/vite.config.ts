import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ProxyOptions } from 'vite';

/** 版本号取仓库根目录的 package.json，构建时间为打包时刻，二者显示在关于窗口 */
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ');

/** 所有上游数据经后端转发与缓存，开发时把 /api 转到本机后端 */
const apiProxy: Record<string, ProxyOptions> = {
  '/api': { target: 'http://127.0.0.1:8787' },
};

export default defineConfig({
  plugins: [tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { proxy: apiProxy },
});
