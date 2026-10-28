#!/usr/bin/env bash
# 打包脚本：产出
#   1) dist/mini-harness-<ver>.tar.gz   —— Linux / 通用（内含 install.sh）
#   2) dist/Mini-Harness-<ver>.dmg      —— macOS 双击安装（Installer.app）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${VERSION:-$(date +%Y%m%d-%H%M%S)}"
DIST="$ROOT/dist"

say(){ printf '\033[1;36m[package]\033[0m %s\n' "$*"; }

rm -rf "$DIST"; mkdir -p "$DIST"

# 1) 干净源码包（仅 git 已跟踪内容，不含 node_modules / 密钥 / 会话）
SRC="$DIST/_src"
mkdir -p "$SRC"
git -C "$ROOT" archive HEAD | tar -x -C "$SRC"
printf '%s\n' "$VERSION" > "$SRC/VERSION"
say "源码包已导出（$(find "$SRC" -type f | wc -l | tr -d ' ') 个文件）"

# 2) Linux / 通用 tarball
TARBALL="$DIST/mini-harness-${VERSION}.tar.gz"
tar -czf "$TARBALL" -C "$SRC" .
say "已生成 $TARBALL"

# 3) macOS DMG（仅 macOS 上执行）
if ! command -v hdiutil >/dev/null 2>&1; then
  say "当前不是 macOS（无 hdiutil），跳过 DMG，仅产出 tarball。"
  exit 0
fi

STAGE="$DIST/dmg-stage"
APP="$STAGE/Installer.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
mkdir -p "$MACOS" "$RES"
cp "$TARBALL" "$RES/mini-harness-src.tar.gz"

# 图标 jpg -> icns
if [ -f "$SRC/assets/icon.jpg" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICDIR="$(mktemp -d)/icon.iconset"; mkdir -p "$ICDIR"
  PNG="$(mktemp).png"; sips -s format png "$SRC/assets/icon.jpg" --out "$PNG" >/dev/null 2>&1 || true
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$PNG" --out "$ICDIR/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s*2)); sips -z $d $d "$PNG" --out "$ICDIR/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICDIR" -o "$RES/appicon.icns" >/dev/null 2>&1 || say "icns 生成失败（用默认图标）"
fi

# 安装序列：Terminal 里解压到 ~/mini-harness 并跑 setup.sh，装完停在终端等回车
cat > "$RES/install.command" <<'CMD'
#!/bin/bash
set -e
RES="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/mini-harness"
if [ ! -d "$DEST/.git" ] && [ ! -f "$DEST/setup.sh" ]; then
  mkdir -p "$DEST"
  tar -xzf "$RES/mini-harness-src.tar.gz" -C "$DEST" --strip-components=1
fi
cd "$DEST"
./setup.sh
echo
read -p "安装完成，按回车关闭本窗口"
CMD
chmod +x "$RES/install.command"

# 启动器：双击即弹 Terminal 运行 install.command
cat > "$MACOS/install" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
open -a Terminal "$RES/install.command"
LAUNCH
chmod +x "$MACOS/install"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Mini-Harness 安装</string>
  <key>CFBundleDisplayName</key><string>Mini-Harness 安装</string>
  <key>CFBundleIdentifier</key><string>com.mini-harness.installer</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>install</string>
  <key>CFBundleIconFile</key><string>appicon</string>
</dict></plist>
PLIST

# 附一个说明文件
cat > "$STAGE/README.txt" <<EOF
Mini-Harness ${VERSION}

双击「Mini-Harness 安装」App 开始安装。
安装会解压到 ~/mini-harness 并自动：
  1) 安装 pi@1.4.0
  2) 安装领域 skill
  3) 安装驾驶舱依赖并加固
  4) 生成桌面「训推引擎组 Harness」启动器

首次打开驾驶舱时填自己的 One API Key 即可（Base URL 已预填）。
安装过程需要联网。
EOF

DMG="$DIST/Mini-Harness-${VERSION}.dmg"
hdiutil create -volname "Mini-Harness" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
say "已生成 $DMG"
ls -lh "$TARBALL" "$DMG"