#!/usr/bin/env bash
# 本机构建并发布到东京主机：同步前端静态文件与后端单文件包，安装 Caddy 站点与 systemd 单元后重启。
# 后端的 sharp 含原生模块，不进单文件包，按本机锁定的版本在主机上安装。
# 用法：pnpm release，首次部署前先执行 setup-host.sh
set -euo pipefail

HOST=${DEPLOY_HOST:-self-tcc-las01-tyo}
cd "$(dirname "$0")/.."

pnpm -r build

rsync -az --delete web/dist/ "$HOST:/srv/sentinel2/web/"
SHARP=$(node -p "require('./server/node_modules/sharp/package.json').version")
printf '{"private":true,"dependencies":{"sharp":"%s"}}\n' "$SHARP" >server/dist/package.json
rsync -az server/dist/index.mjs server/dist/package.json "$HOST:/srv/sentinel2/server/"
ssh "$HOST" "cd /srv/sentinel2/server && export PATH=/opt/node/bin:\$PATH &&
  [ \"\$(node -p \"require('./node_modules/sharp/package.json').version\" 2>/dev/null)\" = '$SHARP' ] ||
  npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error"
rsync -az deploy/sentinel2.caddy "$HOST:/etc/caddy/sites/sentinel2.caddy"
rsync -az deploy/sentinel2-api.service "$HOST:/etc/systemd/system/sentinel2-api.service"

ssh "$HOST" 'set -e
systemctl daemon-reload
systemctl enable sentinel2-api >/dev/null
systemctl restart sentinel2-api
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1 || { cat /tmp/caddy-validate.log; exit 1; }
systemctl reload caddy
sleep 1
curl -fsS http://127.0.0.1:8787/api/health && echo
systemctl --no-pager --lines=0 status sentinel2-api caddy | grep -E "●|Active:"'
