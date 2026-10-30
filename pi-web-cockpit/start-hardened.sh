#!/usr/bin/env bash
# 训推引擎组 Harness 启动脚本：直接运行 pi-web-ui 源码构建产物（pi-web-ui/dist，由 setup.sh 构建）。
# 路径运行时自推导（可移植）：脚本在 <BASE>/pi-web-cockpit/ 下，agent 工作区取 <BASE>。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BASE="$(cd "$HERE/.." && pwd)"

# 访问口令：没显式设置就用 auto —— 服务端在 ~/.pi-web/pi-web-token 生成/复用（0600），
# 桌面启动器读同一个文件拼 ?token= 打开页面。
export PI_WEB_TOKEN="${PI_WEB_TOKEN:-auto}"
export PI_WEB_LOCALE="${PI_WEB_LOCALE:-zh}"
export PI_WEB_MANAGED=1
# 固定用随包的 pi SDK（与 setup.sh 安装、验证过的版本一致，不跟随机器上的全局 pi）
export PI_WEB_SDK=bundled
# 若已建堡垒机隧道（~/.mini-harness/proxy.env 存在），继承代理环境，子进程 kubectl 才能连内网
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
# 「连接集群」里保存的 kubeconfig：存在就用它（agent 直接 kubectl 即可连集群）
[ -f "$HOME/.pi-web/kubeconfig" ] && export KUBECONFIG="$HOME/.pi-web/kubeconfig"
# Finder/LaunchServices 双击启动时 PATH 很精简，可能找不到 node；补上常见位置
for d in "$HOME/.local/share/pi-node/current/bin" /usr/local/bin /opt/homebrew/bin; do
  [ -x "$d/node" ] && PATH="$d:$PATH"
done
export PATH
command -v node >/dev/null 2>&1 || { echo "错误：未找到 node（需要 Node.js 22.19+）。" >&2; exit 1; }
SERVER="$BASE/pi-web-ui/dist/server/index.js"
[ -f "$SERVER" ] || { echo "错误：未找到 $SERVER，请先在仓库根目录运行 ./setup.sh。" >&2; exit 1; }
exec node "$SERVER" --host 127.0.0.1 --port 8787 --cwd "$BASE" --no-browser "$@"
