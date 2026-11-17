#!/usr/bin/env bash
# 打包「桌边 Deskside」为免安装的 Windows 目录（dist/桌边-win32-x64/桌边.exe）
#
# 为什么要 staging：pnpm 的 node_modules 是软链接结构，electron-packager 直接打包会
# 把链接复制进 asar 导致运行时找不到模块。这里用 --node-linker=hoisted 装一份真实的
# 生产依赖，再对 staging 目录打包。
set -euo pipefail

cd "$(dirname "$0")"

NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  echo "错误：找不到 node。请先安装 Node.js 20+（https://nodejs.org 或 nvm）。" >&2
  exit 1
fi
if command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM_CMD=(corepack pnpm)
else
  echo "错误：找不到 pnpm。请执行 corepack enable，或 npm i -g pnpm。" >&2
  exit 1
fi
VER="$("$NODE" -p "require('./package.json').version")"
ELECTRON_VER="$("$NODE" -p "require('./node_modules/electron/package.json').version" 2>/dev/null || echo 38.8.6)"

STAGE="_stage"
APP="桌边"

echo "==> 清理 staging"
rm -rf "$STAGE" dist
mkdir -p "$STAGE"

echo "==> 拷贝应用文件"
cp -r main.js preload.js tts.js renderer assets "$STAGE"/

cat > "$STAGE/package.json" <<'JSON'
{
  "name": "desk-memo",
  "productName": "桌边",
  "version": "__VER__",
  "description": "常驻桌面的 AI 备忘录助理",
  "author": "Deskside contributors",
  "license": "MIT",
  "main": "main.js",
  "dependencies": {
    "msedge-tts": "2.1.1"
  }
}
JSON

"$NODE" -e "const fs=require('fs'),p='$STAGE/package.json';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('__VER__','$VER'))"

cat > "$STAGE/pnpm-workspace.yaml" <<'YAML'
onlyBuiltDependencies: []
YAML

echo "==> 安装生产依赖（hoisted，真实目录）"
cd "$STAGE"
"${PNPM_CMD[@]}" install --prod --node-linker=hoisted --ignore-scripts --reporter=silent

# pnpm 的元数据里记着本机绝对路径（store 位置、项目路径），不该随发行版发出去
# 注意：当前目录已经是 $STAGE，这里用相对路径
rm -f node_modules/.modules.yaml \
      node_modules/.pnpm-workspace-state.json \
      node_modules/.pnpm-workspace-state-v1.json \
      node_modules/.package-lock.json \
      node_modules/.yarn-integrity
rm -rf node_modules/.pnpm
cd ..

echo "==> electron-packager"
"$NODE" node_modules/@electron/packager/bin/electron-packager.js "$STAGE" "$APP" \
  --platform=win32 --arch=x64 --out=dist --overwrite \
  --app-version="$VER" --build-version="$VER" \
  --electron-version="$ELECTRON_VER" \
  --icon="assets/icon.ico" --asar --prune=true \
  --extra-resource="tts-server.py" \
  --win32metadata.CompanyName="Deskside" \
  --win32metadata.FileDescription="桌边 Deskside 桌面 AI 备忘录助理" \
  --win32metadata.ProductName="桌边 Deskside" \
  --win32metadata.InternalName="desk-memo" \
  --win32metadata.OriginalFilename="桌边.exe" \
  --quiet

echo "==> 完成："
ls -la "dist/$APP-win32-x64" | head -20
du -sh "dist/$APP-win32-x64" 2>/dev/null || true
