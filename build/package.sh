#!/usr/bin/env bash
# 打包脚本：
#   1) dist/mini-harness-<ver>.tar.gz   —— Linux / 通用（内含 install.sh）
#   2) dist/Mini-Harness-<ver>.dmg      —— macOS：自举式「训推引擎组 Harness.app」+ 拖入 Applications 的经典布局
# 版本号优先级：环境变量 VERSION > 仓库根 VERSION 文件 > 时间戳。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${VERSION:-$(cat "$ROOT/VERSION" 2>/dev/null || true)}"
VERSION="${VERSION:-$(date +%Y%m%d-%H%M%S)}"
DIST="$ROOT/dist"
APP_NAME="训推引擎组 Harness"

say(){ printf '\033[1;36m[package]\033[0m %s\n' "$*"; }

rm -rf "$DIST"; mkdir -p "$DIST"

# 1) 干净源码包（仅 git 已跟踪内容）
SRC="$DIST/_src"
mkdir -p "$SRC"
git -C "$ROOT" archive HEAD | tar -x -C "$SRC"
printf '%s\n' "$VERSION" > "$SRC/VERSION"
say "源码包已导出（$(find "$SRC" -type f | wc -l | tr -d ' ') 个文件），版本 $VERSION"

# 2) Linux / 通用 tarball
TARBALL="$DIST/mini-harness-${VERSION}.tar.gz"
tar -czf "$TARBALL" -C "$SRC" .
say "已生成 $TARBALL"

# 3) macOS DMG（仅 macOS）
if ! command -v hdiutil >/dev/null 2>&1; then
  say "非 macOS（无 hdiutil），跳过 DMG，仅产出 tarball。"
  exit 0
fi

STAGE="$DIST/dmg-stage"
APP="$STAGE/${APP_NAME}.app"
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

# 首次安装：Terminal 里解压到 ~/mini-harness 跑 setup.sh，装完直接启动驾驶舱
cat > "$RES/install.command" <<'CMD'
#!/bin/bash
set -e
RES="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/mini-harness"
if [ ! -f "$DEST/setup.sh" ]; then
  mkdir -p "$DEST"
  tar -xzf "$RES/mini-harness-src.tar.gz" -C "$DEST" --strip-components=1
fi
cd "$DEST"
./setup.sh
# 装完直接启动
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
if ! lsof -ti tcp:8787 >/dev/null 2>&1; then
  nohup "$DEST/pi-web-cockpit/start-hardened.sh" >/tmp/pi-web-harness.log 2>&1 &
fi
for i in $(seq 1 30); do lsof -ti tcp:8787 >/dev/null 2>&1 && break; sleep 0.5; done
TOKEN="$(cat "$HOME/.pi-web/pi-web-token" 2>/dev/null)"
open "http://localhost:8787/?token=${TOKEN}"
echo
read -p "已启动，按回车关闭本窗口"
CMD
chmod +x "$RES/install.command"

# 日常启动：已安装则直接起驾驶舱；未安装则弹 Terminal 走首次安装
cat > "$MACOS/harness" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DEST="$HOME/mini-harness"
if [ ! -f "$DEST/pi-web-cockpit/start-hardened.sh" ]; then
  open -a Terminal "$RES/install.command"
  exit 0
fi
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
if ! lsof -ti tcp:8787 >/dev/null 2>&1; then
  nohup "$DEST/pi-web-cockpit/start-hardened.sh" >/tmp/pi-web-harness.log 2>&1 &
fi
for i in $(seq 1 30); do lsof -ti tcp:8787 >/dev/null 2>&1 && break; sleep 0.5; done
TOKEN="$(cat "$HOME/.pi-web/pi-web-token" 2>/dev/null)"
open "http://localhost:8787/?token=${TOKEN}"
LAUNCH
chmod +x "$MACOS/harness"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.mini-harness.app</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>harness</string>
  <key>CFBundleIconFile</key><string>appicon</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

# 经典「拖到 Applications」布局
ln -sfn /Applications "$STAGE/Applications"
cat > "$STAGE/README.txt" <<EOF
${APP_NAME} ${VERSION}

把「${APP_NAME}」拖到右边的 Applications 文件夹，之后从启动台/应用程序打开。
首次打开会自动完成安装（需联网），之后双击即启动驾驶舱。
首次进入驾驶舱时填自己的 One API Key（Base URL 已预填）。
EOF

DMG="$DIST/Mini-Harness-${VERSION}.dmg"
hdiutil create -volname "${APP_NAME}" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
say "已生成 $DMG"
ls -lh "$TARBALL" "$DMG"