#!/usr/bin/env bash
# 目标主机一次性初始化，可重复执行：安装 Caddy、rsync 与 Node.js 24，建立站点目录。
# 用法：ssh self-tcc-las01-tyo 'bash -s' < deploy/setup-host.sh
set -euo pipefail

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy rsync curl xz-utils >/dev/null

# Debian 13 自带的 nodejs 为 20.x，这里装官方 24.x 二进制包并校验摘要
want=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/linux-x64.tar.xz$/{print $2}')
ver=${want#node-}; ver=${ver%-linux-x64.tar.xz}
if [[ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$ver" ]]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$want" "https://nodejs.org/dist/latest-v24.x/$want"
  (cd "$tmp" && curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep " $want\$" | sha256sum -c -)
  mkdir -p /opt
  tar -xJf "$tmp/$want" -C /opt
  ln -sfn "/opt/${want%.tar.xz}" /opt/node
  rm -rf "$tmp"
fi
/opt/node/bin/node --version

mkdir -p /srv/sentinel2/web /srv/sentinel2/server /etc/caddy/sites

# 主配置只负责引入各站点文件，原 Debian 默认配置保留备份
if ! grep -q 'import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  [[ -f /etc/caddy/Caddyfile.debian-default ]] || cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.debian-default
  printf '# 各站点配置见 /etc/caddy/sites/\nimport /etc/caddy/sites/*.caddy\n' > /etc/caddy/Caddyfile
fi
systemctl enable --now caddy >/dev/null
echo "初始化完成"
