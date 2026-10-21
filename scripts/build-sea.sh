#!/usr/bin/env bash
# 构建单文件可执行文件（Node SEA，Single Executable Application）：
#   tsc 编译 → esbuild 打成单个 CJS → 生成 SEA blob → 注入 node 运行时副本。
# 产物：releases/penguin-remote-<platform>-<arch>（如 penguin-remote-linux-x64）
# 特性：不依赖目标机器的 Node/pnpm/npm，chmod +x 后直接运行。
# 注意：二进制与构建机的平台/架构绑定；跨平台需在目标平台重新构建。
# SEA 基底请用 nodejs.org 的官方 Node 构建（默认取 PATH 里的 node，
#  PenguinHarness 自带的 node 亦可——实测同为官方构建、哨兵一致）。
# 用法：bash scripts/build-sea.sh [node 可执行文件路径]
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_BIN="${1:-$(readlink -f "$(command -v node)")}"
# Node 24 的 SEA 哨兵（postject 靠它定位注入点；换大版本时需同步核对）
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
PLATFORM="$(node -p "process.platform + '-' + process.arch")"
OUT="releases/penguin-remote-$PLATFORM"
WORK="$(mktemp -d)"
trap 'rm -f "$WORK/index.cjs" "$WORK/sea-prep.blob" "$WORK/sea-config.json"' EXIT

echo "==> [1/4] 编译（tsc，直接调用避开 pnpm 安装预检）"
node_modules/.bin/tsc -p tsconfig.json

echo "==> [2/4] esbuild 打包成单文件 CJS（入口 dist/src/index.js）"
# 入口用 tsc 产物而非 TS 源码：import 的 './x.js' 才能原样解析
node_modules/.bin/esbuild dist/src/index.js \
  --bundle --platform=node --target=node24 --format=cjs \
  --outfile="$WORK/index.cjs" \
  --log-level=warning

echo "==> [3/4] 生成 SEA blob 并注入 node 运行时副本"
cat > "$WORK/sea-config.json" <<EOF
{
  "main": "$WORK/index.cjs",
  "output": "$WORK/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
EOF
node --experimental-sea-config "$WORK/sea-config.json"

mkdir -p releases
cp "$NODE_BIN" "$OUT"
node_modules/.bin/postject "$OUT" NODE_SEA_BLOB "$WORK/sea-prep.blob" \
  --sentinel-fuse "$SEA_FUSE"

echo "==> [4/4] 完成：$OUT"
chmod +x "$OUT"
ls -lh "$OUT"
