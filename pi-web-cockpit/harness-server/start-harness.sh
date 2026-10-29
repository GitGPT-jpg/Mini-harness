#!/usr/bin/env bash
set -euo pipefail
# 自有驾驶舱启动器（可移植）：脚本在 <BASE>/pi-web-cockpit/harness-server/ 下。
# 端口未监听则后台拉起 harness-server，再打开浏览器（带 token）。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PORT="${HARNESS_PORT:-8790}"

# Finder/LaunchServices 双击启动时 PATH 很精简，可能找不到 node；补上常见位置
for d in "$HOME/.local/share/pi-node/current/bin" /usr/local/bin /opt/homebrew/bin; do
  [ -x "$d/node" ] && PATH="$d:$PATH"
done
export PATH
command -v node >/dev/null 2>&1 || { echo "错误：未找到 node（需要 Node.js 22.19+）。" >&2; exit 1; }

TOKEN="$(cat "$HOME/.pi-web/pi-web-token" 2>/dev/null || true)"

# 端口已监听则直接打开；否则后台启动并等待就绪
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  mkdir -p "$HOME/.mini-harness"
  nohup node "$HERE/server.mjs" >> "$HOME/.mini-harness/server.log" 2>&1 &
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

URL="http://127.0.0.1:$PORT/"
[ -n "$TOKEN" ] && URL="http://127.0.0.1:$PORT/?token=$TOKEN"
[ "${HARNESS_NO_OPEN:-0}" = "1" ] || open "$URL"
