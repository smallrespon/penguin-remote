#!/usr/bin/env bash
# 打包发布产物：构建 dist/ → 组装可直接部署的目录 → 打 tarball。
# 产物：releases/penguin-remote-<version>.tar.gz，内含
#   dist/src/                      构建产物（tsc 输出，含 source map）
#   node_modules/                  仅生产依赖（hoisted 布局，解压即用）
#   package.json / pnpm-lock.yaml / pnpm-workspace.yaml
#   README.md / LICENSE / CHANGELOG.md / .env.example
#   scripts/start.sh               前台启动
#   deploy/penguin-remote.service  systemd user unit
# 部署：解压 → cp .env.example .env → 填配置 → bash scripts/start.sh
# 用法：bash scripts/package.sh [version]（默认取 package.json 的 version）
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUT="releases"
STAGE="$OUT/penguin-remote-$VERSION"
TARBALL="$OUT/penguin-remote-$VERSION.tar.gz"

echo "==> 构建（tsc）"
node_modules/.bin/tsc -p tsconfig.json

echo "==> 构建单文件可执行文件（Node SEA）"
bash scripts/build-sea.sh

echo "==> 组装 $STAGE"
rm -rf "$STAGE" "$TARBALL"
mkdir -p "$STAGE/dist"
# 只带运行时入口 dist/src/（dist/test/ 是测试编译产物，运行时不需要）
cp -r dist/src "$STAGE/dist/"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml README.md LICENSE CHANGELOG.md .env.example "$STAGE/"
cp -r scripts deploy "$STAGE/"

echo "==> 安装生产依赖（hoisted 布局，随包分发；--prod 不含 devDependencies）"
# @prismshadow/amsp 无安装脚本，--ignore-scripts 安全；部署机无需 pnpm 也能跑
(cd "$STAGE" && pnpm install --prod --frozen-lockfile --node-linker=hoisted --ignore-scripts)

echo "==> 打包 $TARBALL"
mkdir -p "$OUT"
(cd "$OUT" && tar -czf "penguin-remote-$VERSION.tar.gz" "penguin-remote-$VERSION")

ls -lh "$TARBALL" "$OUT"/penguin-remote-*-x64 2>/dev/null || true
