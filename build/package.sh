#!/usr/bin/env bash
# 打包脚本：
#   1) dist/mini-harness-<ver>.tar.gz   —— Linux / 通用（内含 install.sh）
#   2) dist/Mini-Harness-<ver>.dmg      —— macOS：自举式 App + 拖入 Applications + 背景图/图标排布
# 版本号优先级：环境变量 VERSION > git tag > 仓库根 VERSION 文件 > 时间戳。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || true)}"
VERSION="${VERSION#v}"
VERSION="${VERSION:-$(cat "$ROOT/VERSION" 2>/dev/null || true)}"
VERSION="${VERSION:-$(date +%Y%m%d-%H%M%S)}"
DIST="$ROOT/dist"
APP_NAME="训推引擎组 Harness"
BG="$ROOT/build/dmg-background.png"

say(){ printf '\033[1;36m[package]\033[0m %s\n' "$*"; }

rm -rf "$DIST"; mkdir -p "$DIST"

# 1) 干净源码包（仅 git 已跟踪内容）
SRC="$DIST/_src"
mkdir -p "$SRC"
git -C "$ROOT" archive HEAD | tar -x -C "$SRC"
printf '%s\n' "$VERSION" > "$SRC/VERSION"
say "源码包已导出，版本 $VERSION"

# 2) Linux / 通用 tarball
TARBALL="$DIST/mini-harness-${VERSION}.tar.gz"
tar -czf "$TARBALL" -C "$SRC" .
say "已生成 $TARBALL"

# 3) macOS DMG（仅 macOS）
if ! command -v hdiutil >/dev/null 2>&1; then
  say "非 macOS（无 hdiutil），跳过 DMG，仅产出 tarball。"
  exit 0
fi

# 3a) 自举式 App
STAGE="$DIST/dmg-stage"
APP="$STAGE/${APP_NAME}.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
mkdir -p "$MACOS" "$RES"
cp "$TARBALL" "$RES/mini-harness-src.tar.gz"

if [ -f "$SRC/assets/icon.jpg" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICDIR="$(mktemp -d)/icon.iconset"; mkdir -p "$ICDIR"
  PNG="$(mktemp).png"; sips -s format png "$SRC/assets/icon.jpg" --out "$PNG" >/dev/null 2>&1 || true
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$PNG" --out "$ICDIR/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s*2)); sips -z $d $d "$PNG" --out "$ICDIR/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICDIR" -o "$RES/appicon.icns" >/dev/null 2>&1 || say "icns 生成失败（用默认图标）"
fi

cat > "$RES/install.command" <<'CMD'
#!/bin/bash
set -e
RES="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/mini-harness"
# 首次安装与升级都走这里：总是重新解包并跑幂等的 setup.sh（覆盖受管副本，明确执行更新）
mkdir -p "$DEST"
tar -xzf "$RES/mini-harness-src.tar.gz" -C "$DEST" --strip-components=1
cd "$DEST"
PI_WEB_NO_OPEN=1 ./setup.sh
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
if ! "$DEST/pi-web-cockpit/launch-harness.sh"; then
  echo "训推引擎组 Harness 未在 8787 端口就绪（端口可能被其它程序占用）。请查看 /tmp/pi-web-harness.log。"
  read -p "按回车关闭本窗口"
  exit 1
fi
echo
read -p "已启动，按回车关闭本窗口"
CMD
chmod +x "$RES/install.command"

cat > "$MACOS/harness" <<'LAUNCH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
DEST="$HOME/mini-harness"
# 构建产物在 = 已装好（start-hardened.sh 本身随源码入库，解压即在，不能拿它判断）。
# 版本不一致 = 需要升级：走 install.command 重新解包 + setup.sh（幂等）。
BUNDLED_VER="$(tar -xOzf "$RES/mini-harness-src.tar.gz" ./VERSION 2>/dev/null | tr -d '[:space:]')"
INSTALLED_VER="$(cat "$DEST/VERSION" 2>/dev/null | tr -d '[:space:]')"
if [ ! -f "$DEST/pi-web-ui/dist/server/index.js" ] || { [ -n "$BUNDLED_VER" ] && [ "$BUNDLED_VER" != "$INSTALLED_VER" ]; }; then
  open -a Terminal "$RES/install.command"
  exit 0
fi
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
"$DEST/pi-web-cockpit/launch-harness.sh" || {
  osascript -e 'display dialog "训推引擎组 Harness 未在 8787 端口就绪（端口可能被其它程序占用）。请查看 /tmp/pi-web-harness.log。" with title "训推引擎组 Harness" buttons {"好"} default button "好"' >/dev/null 2>&1
  exit 1
}
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

# 3b) RW 镜像 → 拷贝 → Finder 背景图/图标排布 → 转只读压缩
RW="$DIST/tmp.dmg"; MP="$DIST/mnt"
rm -f "$RW"; mkdir -p "$MP"
hdiutil create -size 120m -fs HFS+ -volname "${APP_NAME}" "$RW" >/dev/null
hdiutil attach "$RW" -nobrowse -mountpoint "$MP" >/dev/null
cp -R "$APP" "$MP/"
ln -sfn /Applications "$MP/Applications"
cat > "$MP/README.txt" <<EOF
${APP_NAME} ${VERSION}

把「${APP_NAME}」拖到右边的 Applications 文件夹，之后从启动台/应用程序打开。
首次打开会自动完成安装（需联网），之后双击即启动驾驶舱。
首次进入驾驶舱时填自己的 One API Key（Base URL 已预填）。
EOF

# 背景图 + 图标位置（Finder 排布；无 GUI 环境会静默跳过，不影响包）
if command -v osascript >/dev/null 2>&1 && [ -f "$BG" ]; then
  osascript >/dev/null 2>&1 <<OSA
tell application "Finder"
  set v to POSIX file "$MP" as alias
  open v
  delay 0.5
  set w to Finder window 1
  tell w
    set current view to icon view
    set toolbar visible to false
    set statusbar visible to false
    set bounds to {100, 100, 1100, 700}
    set background picture of its icon view options to POSIX file "$BG"
    set arrangement of its icon view options to not arranged
    set position of item "${APP_NAME}.app" to {230, 300}
    set position of item "Applications" to {680, 300}
  end tell
  close w
end tell
OSA
  sleep 1
fi

hdiutil detach "$MP" >/dev/null
DMG="$DIST/Mini-Harness-${VERSION}.dmg"
hdiutil convert "$RW" -format UDZO -o "$DMG" >/dev/null
rm -f "$RW"
say "已生成 $DMG"
ls -lh "$TARBALL" "$DMG"
