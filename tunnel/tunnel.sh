#!/usr/bin/env bash
# 建立到堡垒机的 SSH SOCKS 隧道，让本机 kubectl / pod 请求走内网，无需把堡垒机暴露公网。
# 用法：
#   tunnel.sh start       启动隧道（幂等）
#   tunnel.sh stop        停止
#   tunnel.sh status      查看状态
#   tunnel.sh check       连通性自检（kubectl get nodes 或 curl apiserver）
#   tunnel.sh env         输出代理环境变量（eval "$(tunnel.sh env)"）
#   tunnel.sh help
set -uo pipefail

CFG="${TUNNEL_CONFIG:-$HOME/.mini-harness/tunnel.env}"
PIDFILE="$HOME/.mini-harness/tunnel.pid"

say(){ printf '[tunnel] %s\n' "$*"; }
die(){ printf '[tunnel] 错误: %s\n' "$*" >&2; exit 1; }

load_cfg(){
  if [ ! -f "$CFG" ]; then
    die "缺少配置 ${CFG}。请先：mkdir -p ~/.mini-harness && cp tunnel/tunnel.env.example ~/.mini-harness/tunnel.env，再按自己的堡垒机填写。"
  fi
  # shellcheck disable=SC1090
  . "$CFG"
  : "${BASTION:=}" "${BASTION_PORT:=22}" "${SOCKS_PORT:=1080}" "${KEEPALIVE:=30}"
  [ -n "$BASTION" ] || die "$CFG 里 BASTION 为空，请填 user@host。"
}

socks_url(){ echo "socks5h://127.0.0.1:${SOCKS_PORT}"; }

is_running(){
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start(){
  load_cfg
  if is_running; then say "隧道已在运行 (pid $(cat "$PIDFILE"))。"; return 0; fi
  local args=(-N -f -D "127.0.0.1:${SOCKS_PORT}"
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval="$KEEPALIVE" -o ServerAliveCountMax=3
    -o ControlMaster=no
    -p "$BASTION_PORT")
  [ -n "${SSH_KEY:-}" ] && args+=(-i "$SSH_KEY")
  args+=("$BASTION")
  mkdir -p "$HOME/.mini-harness"
  if ! ssh "${args[@]}"; then die "SSH 隧道启动失败，请检查堡垒机连通性与密钥。" ; fi
  # 找到刚起的 ssh 进程写 pid（-f 后台化，用 pgrep 匹配）
  local pid; pid="$(pgrep -f "ssh .* -D 127.0.0.1:${SOCKS_PORT}" | tail -1)"
  [ -n "$pid" ] && echo "$pid" > "$PIDFILE"
  say "隧道已启动 (socks://127.0.0.1:${SOCKS_PORT} -> $BASTION)"
  say "下一步：eval \"\$(tunnel.sh env)\" 让当前终端走代理。"
}

stop(){
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE")"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
    rm -f "$PIDFILE"
    say "已停止隧道。"
  else
    say "没有运行中的隧道。"
  fi
}

status(){
  if is_running; then say "运行中 (pid $(cat "$PIDFILE")) -> $BASTION"; else say "未运行"; fi
}

env(){
  load_cfg
  echo "export HTTPS_PROXY=$(socks_url) ALL_PROXY=$(socks_url) NO_PROXY=localhost,127.0.0.1,::1"
}

check(){
  load_cfg
  local proxy; proxy="$(socks_url)"
  if command -v kubectl >/dev/null 2>&1; then
    HTTPS_PROXY="$proxy" ALL_PROXY="$proxy" NO_PROXY=localhost,127.0.0.1 kubectl get nodes --request-timeout=12 >/dev/null 2>&1 && { say "OK：kubectl 能通过隧道访问集群。"; return 0; }
    say "kubectl get nodes 失败（隧道未起、kubeconfig 未配、或代理不通）。"
  fi
  if [ -n "${KUBE_APISERVER:-}" ]; then
    local code; code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' --proxy "$proxy" "https://${KUBE_APISERVER#https://}/version" 2>/dev/null || true)"
    [ "$code" = "200" ] && { say "OK：apiserver 可达（HTTP $code）。"; return 0; }
    say "apiserver 探测返回 HTTP ${code:-失败}。"
  fi
  say "未检测到 kubectl，也未配置 KUBE_APISERVER，无法自检；请先 start 并确保 kubectl 在 PATH。"
  return 1
}

proxy_env_file(){ echo "$HOME/.mini-harness/proxy.env"; }

# 判断是否已在内网（kubectl 不经过代理也能直连集群 → 大概率就在堡垒机/VPN 上）
detect_inside(){
  command -v kubectl >/dev/null 2>&1 || return 1
  kubectl get nodes --request-timeout=8 >/dev/null 2>&1
}

# 一键打通：已在内网则什么都不做；否则（询问后或 -y 自动）建隧道并写出代理环境文件
auto(){
  local pfile; pfile="$(proxy_env_file)"
  if detect_inside; then
    rm -f "$pfile"
    say "已在内网（kubectl 直连成功），无需隧道。"
    return 0
  fi
  if [ ! -f "$CFG" ]; then
    rm -f "$pfile"
    say "不在内网，且缺少 ${CFG}。请先：cp tunnel/tunnel.env.example ~/.mini-harness/tunnel.env 并填 BASTION，再运行 tunnel.sh auto。"
    return 1
  fi
  load_cfg
  local doit=0
  if [ "${AUTO_TUNNEL:-0}" = "1" ] || [ "${1:-}" = "-y" ]; then
    doit=1
  else
    printf '检测到不在内网，是否通过堡垒机(%s)建立隧道？[y/N] ' "$BASTION" >&2
    read -r ans || true
    case "$ans" in y|Y) doit=1 ;; esac
  fi
  if [ "$doit" = "1" ]; then
    start || return 1
    { echo "export HTTPS_PROXY=$(socks_url)"; echo "export ALL_PROXY=$(socks_url)"; echo "export NO_PROXY=localhost,127.0.0.1,::1"; } > "$pfile"
    say "代理环境已写入 $pfile（start-hardened.sh / 桌面启动器会自动读取）。"
    check
    return $?
  fi
  rm -f "$pfile"
  say "已跳过隧道（本次会话内网工具可能不可用）。"
  return 1
}

case "${1:-help}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  check) check ;;
  env) env ;;
  auto) auto "${2:-}" ;;
  *) echo "用法: $0 {start|stop|status|check|env|auto [-y]}"; exit 0 ;;
esac
