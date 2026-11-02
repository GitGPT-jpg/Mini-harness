#!/usr/bin/env bash
# 训推引擎组 Harness —— 一键安装 / 可移植部署脚本
# 用法：克隆仓库后在仓库根目录执行  ./setup.sh
set -euo pipefail

PI_PIN="1.4.0"                       # 决策2：固定安装验证过的 pi 版本（与原机一致）
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
COCKPIT="$HERE/pi-web-cockpit"
APP_NAME="训推引擎组 Harness"
ICON_SRC="$HERE/assets/icon.jpg"

say(){ printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[warn ]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
say "仓库根目录: $HERE"

# ---- 1) 基础依赖 ----
command -v git >/dev/null 2>&1 || die "缺少 git，请先安装。"
# 若 PATH 里没有 node，但机器上装过 pi（官方安装器自带 node），优先复用它的 node
if ! command -v node >/dev/null 2>&1; then
  for d in "${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin"; do
    if [ -x "$d/node" ]; then PATH="$d:$PATH"; export PATH; say "复用 pi 自带 Node: $d"; fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  die "缺少 Node.js (>=22.19)。可先用 pi 官方安装器获取（含 node）：curl -fsSL https://pi.dev/install | sh，或自行安装 Node 后重试。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  die "Node.js 版本过低（当前 $(node -v)），需要 >= 22.19。"
fi
command -v npm >/dev/null 2>&1 || die "缺少 npm。"
say "Node $(node -v) / npm $(npm -v) OK"

# ---- 2) 安装/校验 pi（固定 $PI_PIN）----
need_pi=1
if command -v pi >/dev/null 2>&1; then
  cur="$(pi --version 2>/dev/null | head -1 | tr -dc '0-9.')"
  if [ "$cur" = "$PI_PIN" ]; then need_pi=0; say "pi 已是 ${PI_PIN}（跳过）";
  else warn "检测到 pi $cur，期望 ${PI_PIN}，将安装固定版本。"; fi
fi
if [ "$need_pi" = 1 ]; then
  say "安装 pi@${PI_PIN}（npm 全局，--ignore-scripts）…"
  npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_PIN}" \
    || die "pi 安装失败，请检查 npm 全局安装权限或网络。"
fi
command -v pi >/dev/null 2>&1 || die "pi 安装后仍不在 PATH，请把 npm 全局 bin 目录加入 PATH 后重试。"
say "pi 版本: $(pi --version 2>/dev/null | head -1)"

# ---- 3) 安装领域 skills 到 pi ----
mkdir -p "$HOME/.pi/agent/skills"
n_sk=0
for d in "$HERE"/skills/*/; do
  [ -f "$d/SKILL.md" ] || continue
  name="$(basename "$d")"
  rm -rf "$HOME/.pi/agent/skills/$name"
  cp -R "$d" "$HOME/.pi/agent/skills/$name"
  n_sk=$((n_sk+1))
done
say "已安装 $n_sk 个领域 skill 到 ~/.pi/agent/skills"

# ---- 4) 种入 Baidu One API 模型服务商（不覆盖已有配置，不含任何密钥）----
SEED_FILE="$HERE/pi-web-cockpit/config/models.oneapi.json" node <<'NODE'
const fs=require("fs"),os=require("os"),path=require("path");
const seed=JSON.parse(fs.readFileSync(process.env.SEED_FILE,"utf8"));
const mf=path.join(os.homedir(),".pi/agent/models.json");
let m={providers:{}};
try{ m=JSON.parse(fs.readFileSync(mf,"utf8")); }catch{}
m.providers=m.providers||{};
if(!m.providers.oneapi){
  m.providers.oneapi=seed.providers.oneapi;
  fs.mkdirSync(path.dirname(mf),{recursive:true});
  fs.writeFileSync(mf,JSON.stringify(m,null,2));
  console.log("[setup] 已写入 Baidu One API 服务商 + 模型目录（"+seed.providers.oneapi.models.length+" 个模型）");
}else{
  console.log("[setup] 已存在 oneapi 服务商，跳过（不覆盖你的配置）");
}
NODE

# ---- 5) 构建驾驶舱（pi-web-ui 源码：定制已全部在源码里，不再有 npm 包 + 补丁脚本）----
UI="$HERE/pi-web-ui"
[ -f "$UI/package.json" ] || die "缺少 $UI（仓库不完整？）"
if [ -d "$UI/node_modules" ]; then
  say "更新驾驶舱依赖…"
  ( cd "$UI" && npm install --no-audit --no-fund ) || die "驾驶舱依赖安装失败（网络 / npm 源？）"
else
  say "安装驾驶舱依赖（按 package-lock.json，首次较慢）…"
  ( cd "$UI" && npm ci --no-audit --no-fund ) || die "驾驶舱依赖安装失败（网络 / npm 源？）"
fi
say "构建驾驶舱…"
( cd "$UI" && npm run build >/tmp/pi-web-ui-build.log 2>&1 ) || die "驾驶舱构建失败，详见 /tmp/pi-web-ui-build.log"
[ -f "$UI/dist/server/index.js" ] || die "构建后仍缺少 $UI/dist/server/index.js"
say "驾驶舱构建完成。"

# ---- 5b) 停用推理场景用不到的风险 skill（移出 pi 技能发现目录，可逆：移回即恢复）----
# 驾驶舱服务端另有硬禁名单兜底；这里把它们挪走，让命令行 pi 也看不到。
SK_SRC="$HOME/.pi/agent/skills/pi-skills"
SK_OFF="$HOME/.pi/agent/skills.disabled"
for s in browser-tools transcribe brave-search gccli gdcli gmcli youtube-transcript; do
  if [ -d "$SK_SRC/$s" ]; then
    mkdir -p "$SK_OFF"
    rm -rf "${SK_OFF:?}/$s"
    mv "$SK_SRC/$s" "$SK_OFF/$s"
    say "已停用 skill: $s（移到 $SK_OFF）"
  fi
done

# ---- 5c) 知识库扩展 pi-llm-wiki：装 vendor 依赖（禁脚本）、删高危可选依赖、登记到 pi、写静默配置 ----
WIKI="$COCKPIT/vendor/pi-llm-wiki"
if [ -f "$WIKI/package.json" ]; then
  if [ ! -d "$WIKI/node_modules/node-html-markdown" ]; then
    say "安装 pi-llm-wiki 依赖（--omit=dev --ignore-scripts）…"
    ( cd "$WIKI" && npm install --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund ) \
      || warn "pi-llm-wiki 依赖安装失败，可稍后在 $WIKI 手动 npm install"
  fi
  WIKI="$WIKI" node <<'NODE'
const fs=require("fs"),os=require("os"),path=require("path");
const wiki=process.env.WIKI, nm=path.join(wiki,"node_modules");
// 高危可选依赖子树（@tobilu/qmd → node-llama-cpp → simple-git 的命令执行 CVE 等），知识库不需要
let removed=0;
const risky=["@tobilu","node-llama-cpp","simple-git","@simple-git","better-sqlite3","sqlite-vec","web-tree-sitter"];
for(const r of risky){const p=path.join(nm,r); if(fs.existsSync(p)){fs.rmSync(p,{recursive:true,force:true}); removed++;}}
if(fs.existsSync(nm)) for(const d of fs.readdirSync(nm)) if(d.startsWith("tree-sitter-")){fs.rmSync(path.join(nm,d),{recursive:true,force:true}); removed++;}
if(removed) console.log("[setup] pi-llm-wiki：已移除 "+removed+" 个高危可选依赖目录");
// 登记到 pi 全局 settings.json（绝对路径，去重；清掉 /tmp 与旧位置的登记），静默自动配置、不配 embedding = 纯本地
const sf=path.join(os.homedir(),".pi/agent/settings.json");
let st={}; try{ st=JSON.parse(fs.readFileSync(sf,"utf8")); }catch{}
const pkgs=new Set(st.packages||[]);
for(const p of [...pkgs]) if(p.includes("/tmp/")||(p.includes("pi-llm-wiki")&&p!==wiki)) pkgs.delete(p);
pkgs.add(wiki);
st.packages=[...pkgs];
st["llm-wiki"]={notices:false,autoRecall:true,trajectories:true,ambientPersonalVault:true,wikilinkValidation:"warn"};
fs.mkdirSync(path.dirname(sf),{recursive:true});
fs.writeFileSync(sf,JSON.stringify(st,null,2));
console.log("[setup] pi-llm-wiki：已登记扩展并写入静默配置（无 embedding，不外联）");
NODE
else
  warn "缺少 $WIKI，跳过知识库扩展。"
fi

# ---- 6) 生成 Mac 启动器 .app（放桌面；决策3：用 assets/icon.jpg）----
build_mac_app(){
  local DESKTOP="$HOME/Desktop"
  local APP="$DESKTOP/${APP_NAME}.app"
  local MACOS="$APP/Contents/MacOS" RES="$APP/Contents/Resources"
  rm -rf "$APP"
  mkdir -p "$MACOS" "$RES"
  # 6a) 图标 jpg -> icns
  if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
    local ICDIR; ICDIR="$(mktemp -d)/icon.iconset"; mkdir -p "$ICDIR"
    local png="$(mktemp).png"; sips -s format png "$ICON_SRC" --out "$png" >/dev/null 2>&1 || true
    for s in 16 32 64 128 256 512; do
      sips -z $s $s "$png" --out "$ICDIR/icon_${s}x${s}.png" >/dev/null 2>&1 || true
      local d=$((s*2)); sips -z $d $d "$png" --out "$ICDIR/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$ICDIR" -o "$RES/appicon.icns" >/dev/null 2>&1 || warn "icns 生成失败（图标将用默认）。"
  else
    warn "缺少 assets/icon.jpg 或 sips/iconutil，图标用默认。"
  fi
  # 6b) 启动器脚本（双击不弹终端黑窗；COCKPIT 绝对路径按本机生成）
  cat > "$MACOS/launcher" <<LAUNCH
#!/bin/bash
COCKPIT="$COCKPIT"
TOKENF="\$HOME/.pi-web/pi-web-token"
if ! lsof -nP -iTCP:8787 -sTCP:LISTEN -t >/dev/null 2>&1; then
  nohup "\$COCKPIT/start-hardened.sh" >/tmp/pi-web-harness.log 2>&1 &
fi
for i in \$(seq 1 30); do lsof -nP -iTCP:8787 -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 0.5; done
TOKEN="\$(cat "\$TOKENF" 2>/dev/null)"
open "http://localhost:8787/?token=\${TOKEN}"
LAUNCH
  chmod +x "$MACOS/launcher"
  # 6c) Info.plist
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.baidu.mini-harness.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>appicon</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
  touch "$APP"  # 刷新图标缓存
  say "已生成桌面启动器: $APP"
}
if [ "$OS" = "Darwin" ]; then build_mac_app || warn "生成 .app 失败，可手动运行 pi-web-cockpit/start-hardened.sh"; fi

# ---- 7) 启动服务并自动打开浏览器（装完即用；PI_WEB_NO_OPEN=1 可跳过自动打开）----
port_listening(){
  _PI_PORT="$1" node -e 'const n=require("net").connect({host:"127.0.0.1",port:+process.env._PI_PORT});n.setTimeout(1000,()=>process.exit(1));n.once("connect",()=>process.exit(0));n.once("error",()=>process.exit(1));' >/dev/null 2>&1
}
launch_and_open(){
  local PORT="${PI_WEB_PORT:-8787}"
  local TOKENF="$HOME/.pi-web/pi-web-token"
  if port_listening "$PORT"; then
    say "服务已在运行（:$PORT），复用。"
  else
    say "启动服务…"
    nohup "$COCKPIT/start-hardened.sh" >/tmp/pi-web-harness.log 2>&1 &
  fi
  for _ in {1..60}; do port_listening "$PORT" && break; sleep 0.5; done
  if ! port_listening "$PORT"; then
    warn "服务未在 :$PORT 就绪，可稍后手动运行 $COCKPIT/start-hardened.sh"
    return 1
  fi
  local TOKEN="$(cat "$TOKENF" 2>/dev/null || true)"
  local URL="http://localhost:$PORT/"
  [ -n "$TOKEN" ] && URL="http://localhost:$PORT/?token=${TOKEN}"
  if [ "${PI_WEB_NO_OPEN:-0}" = "1" ]; then
    say "服务已就绪（PI_WEB_NO_OPEN=1，跳过自动打开浏览器）：$URL"
    return 0
  fi
  if [ "$OS" = "Darwin" ]; then
    open "$URL" && say "已自动打开浏览器：$URL" || warn "自动打开失败，请手动访问：$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 && say "已自动打开浏览器：$URL" || warn "自动打开失败，请手动访问：$URL"
  else
    warn "未找到浏览器打开命令，请手动访问：$URL"
  fi
}
launch_and_open || warn "自动启动/打开失败，可手动运行 $COCKPIT/start-hardened.sh"

# ---- 8) 完成提示 ----
cat <<DONE

============================================================
 安装完成 ✅  —— ${APP_NAME}
------------------------------------------------------------
 本次已自动启动服务并打开浏览器（若未弹出，手动访问 http://localhost:8787）
 下次启动：
   • Mac：双击桌面「${APP_NAME}」图标
   • 或命令行： "$COCKPIT/start-hardened.sh"
 首次使用：
   页面会弹出「首次配置」对话框，已预选 Baidu One API，
   Base URL 已预填 https://oneapi-comate.baidu-int.com/v1，
   填入你自己的 One API Key 并保存即可。Key 仅存本机，不入库。
 连接内网（K8s）：
   只需本机有 kubectl 和可用的 kubeconfig（kubectl get nodes 能通）。
   在堡垒机上部署时，配好 kubeconfig 即可，无需额外配置。
   （若连 kubectl 都到不了集群，才用 "$HERE/tunnel/tunnel.sh" auto 兜底）
============================================================
DONE

