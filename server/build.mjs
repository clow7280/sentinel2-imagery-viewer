// 用 esbuild 的 JS 接口把后端打成单文件，只有含原生模块的 sharp 不打包，部署时在主机上安装
// pnpm 11 生成的 esbuild 命令行垫片会把原生二进制当作 JS 执行，因此不走命令行
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/index.mjs',
  external: ['sharp'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
