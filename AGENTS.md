# AGENTS.md

- 界面样式只用 Tailwind 4 工具类与 `web/src/style.css` 中 `@theme` 注册的 sulu 色系，保持亮色单主题，不加暗色模式
- MapLibre 6 的 Worker 地址经 `setWorkerUrl` 显式指定，升级或调整打包配置后先确认地图仍能加载
- 改动瓦片渲染后，在前台标签页实测加载耗时，后台标签页的 `requestAnimationFrame` 会被节流，地图不会请求瓦片
- 前端不直连第三方服务，新增上游时在 `server/src/index.ts` 加固定路径白名单与缓存时长，再由前端走 `/api`
- 站点公开访问，后端不得放开为任意地址转发，影像 COG 只允许 `sentinel-cogs` 中的 TCI 与 SCL
- 影像瓦片由后端渲染，sharp 含原生模块，在 `server/build.mjs` 中标为外部依赖，由 `deploy/deploy.sh` 在主机上按锁定版本安装，新增原生依赖照此处理
- 发布用 `pnpm release`，目标为腾讯云东京主机 `self-tcc-las01-tyo`；`sentinel2.c410.space` 的 DNS 在 Cloudflare，为不开代理的 A 记录
- pnpm 11 生成的 esbuild 命令行垫片不可用，后端打包经 `server/build.mjs` 调用 JS 接口
- `web/public/basemap/` 是从 `~/repo/osm-cn-basemap` 同步的生成物，改底图样式应改那个项目后执行 `node web/scripts/sync-basemap.mjs`，不直接编辑
