#!/usr/bin/env bash
# 前台启动 Bridge：加载 .env → 准备目录 → 跑构建产物。
# 单独跑：bash scripts/start.sh（Ctrl-C / SIGTERM 退出）；
# 常驻：用 deploy/penguin-remote.service（systemd user unit）。
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f dist/src/index.js ]]; then
  echo "缺少构建产物 dist/src/index.js，先执行：pnpm build" >&2
  exit 1
fi

if [[ -f .env ]]; then
  # .env 里可能有 AMSP_API_KEY，收紧到仅本人可读
  chmod 600 .env
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "未找到 .env（可复制 .env.example）：改用当前环境变量" >&2
fi

mkdir -p "${STATE_DIR:-state}" logs
exec node --enable-source-maps dist/src/index.js
