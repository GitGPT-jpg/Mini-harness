#!/usr/bin/env bash
# Start or open the managed Harness instance without handing its token to an
# unrelated local listener. setup.sh and packaged launchers delegate here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PI_WEB_PORT:-8787}"
TOKEN_FILE="${PI_WEB_TOKEN_FILE:-$HOME/.pi-web/pi-web-token}"
LOG_FILE="${PI_WEB_LOG_FILE:-/tmp/pi-web-harness.log}"
NO_OPEN="${PI_WEB_NO_OPEN:-0}"
UPGRADE=0

say() {
	printf '[harness] %s\n' "$*"
}

fail() {
	printf '[harness] %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: launch-harness.sh [--upgrade] [--no-open]

--upgrade  Gracefully replace a verified Harness process before starting.
--no-open  Start or verify the service but do not open a browser.
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--upgrade)
			UPGRADE=1
			;;
		--no-open)
			NO_OPEN=1
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			fail "未知参数：$1"
			;;
	esac
	shift
done

case "$PORT" in
	''|*[!0-9]*)
		fail "PI_WEB_PORT 必须是 1-65535 之间的整数。"
		;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
	fail "PI_WEB_PORT 必须是 1-65535 之间的整数。"
fi

command -v lsof >/dev/null 2>&1 || fail "缺少 lsof，无法安全确认端口归属。"
command -v node >/dev/null 2>&1 || fail "缺少 node，无法确认 Harness 健康状态。"
[ -f "$HERE/start-hardened.sh" ] || fail "缺少启动脚本：$HERE/start-hardened.sh"

listener_pids() {
	lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

listener_exists() {
	[ -n "$(listener_pids)" ]
}

is_owned_listener() {
	local pid="$1"
	local uid
	local command

	uid="$(ps -p "$pid" -o uid= 2>/dev/null | tr -d '[:space:]')" || return 1
	[ "$uid" = "$(id -u)" ] || return 1
	command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
	[ -n "$command" ] || return 1

	case "$command" in
		*"$ROOT/pi-web-ui/dist/server/index.js"* ) ;;
		* ) return 1 ;;
	esac
	case "$command" in
		*"--host 127.0.0.1"* ) ;;
		* ) return 1 ;;
	esac
	case "$command" in
		*"--port $PORT"* ) ;;
		* ) return 1 ;;
	esac
	case "$command" in
		*"--cwd $ROOT"* ) ;;
		* ) return 1 ;;
	esac
	case "$command" in
		*"--no-browser"* ) ;;
		* ) return 1 ;;
	esac
}

all_listeners_owned() {
	local pids="${1:-$(listener_pids)}"
	local pid
	[ -n "$pids" ] || return 1
	while IFS= read -r pid; do
		[ -n "$pid" ] || continue
		is_owned_listener "$pid" || return 1
	done <<< "$pids"
	return 0
}

harness_healthy() {
	HARNESS_HEALTH_PORT="$PORT" node -e '
const http = require("http");
const port = Number(process.env.HARNESS_HEALTH_PORT);
const request = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    try {
      const health = JSON.parse(body);
      process.exit(response.statusCode === 200 && health?.ok === true && health?.app === "mini-harness" ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
});
request.on("timeout", () => { request.destroy(); process.exit(1); });
request.on("error", () => process.exit(1));
' >/dev/null 2>&1
}

wait_for_healthy_owned_listener() {
	local attempt
	for ((attempt = 0; attempt < 60; attempt += 1)); do
		if all_listeners_owned && harness_healthy; then
			return 0
		fi
		sleep 0.5
	done
	return 1
}

stop_owned_listener() {
	local pids
	local pid
	pids="$(listener_pids)"
	all_listeners_owned "$pids" || return 1

	while IFS= read -r pid; do
		[ -n "$pid" ] || continue
		# Re-check immediately before signalling: a PID can be reused.
		is_owned_listener "$pid" || return 1
		kill -TERM "$pid"
	done <<< "$pids"

	local attempt
	for ((attempt = 0; attempt < 24; attempt += 1)); do
		if ! listener_exists; then
			return 0
		fi
		sleep 0.5
	done
	return 1
}

start_server() {
	say "启动 Harness 服务（127.0.0.1:$PORT）…"
	PI_WEB_PORT="$PORT" nohup "$HERE/start-hardened.sh" >>"$LOG_FILE" 2>&1 &
}

ensure_service() {
	local pids
	pids="$(listener_pids)"
	if [ -z "$pids" ]; then
		start_server
	elif ! all_listeners_owned "$pids"; then
		fail "端口 :$PORT 被未知进程占用；为避免泄露访问口令，已拒绝打开浏览器。"
	elif [ "$UPGRADE" = 1 ] || ! harness_healthy; then
		say "替换已验证归属的 Harness 旧进程…"
		stop_owned_listener || fail "已验证的 Harness 进程未在超时内退出；未启动第二个服务。"
		start_server
	else
		say "复用已验证的 Harness 服务（:$PORT）。"
	fi

	wait_for_healthy_owned_listener || fail "Harness 未在 :$PORT 就绪，请查看 $LOG_FILE。"
}

ensure_service

if [ "$NO_OPEN" = "1" ]; then
	say "服务已就绪：http://127.0.0.1:$PORT/"
	exit 0
fi

# Check both identity predicates immediately before reading the local token.
all_listeners_owned && harness_healthy || fail "Harness 监听进程已变化；为避免泄露访问口令，已取消打开浏览器。"
[ -r "$TOKEN_FILE" ] || fail "服务已就绪但未找到访问口令文件：$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"
ENCODED_TOKEN="$(HARNESS_TOKEN="$TOKEN" node -e 'process.stdout.write(encodeURIComponent(process.env.HARNESS_TOKEN || ""))')"
OPEN_URL="http://127.0.0.1:$PORT/"
[ -n "$ENCODED_TOKEN" ] && OPEN_URL="${OPEN_URL}?token=${ENCODED_TOKEN}"

# Re-check after token encoding to narrow the listener-replacement window.
all_listeners_owned && harness_healthy || fail "Harness 监听进程已变化；为避免泄露访问口令，已取消打开浏览器。"
if command -v open >/dev/null 2>&1; then
	open "$OPEN_URL"
elif command -v xdg-open >/dev/null 2>&1; then
	xdg-open "$OPEN_URL" >/dev/null 2>&1
else
	fail "未找到浏览器打开命令；服务已就绪但未自动打开浏览器。"
fi
say "已打开 Harness 浏览器页面。"
