/**
 * ws-session-test.mjs — 纯 WebSocket 层冒烟测试（不走浏览器）。
 *
 * 验证 ws 协议的关键握手和行为：
 *   hello → ready → list_files(根)→ files → 媒体 /api/file → 结束
 *
 * 用法（需先有 server 在跑，或用环境变量指定）:
 *   node ws-session-test.mjs                        # 连 ws://localhost:${PORT:-8787}
 *   PORT=9000 node ws-session-test.mjs              # 自定义端口
 *   WS_ROOT=/abs/media.d  node ws-session-test.mjs  # 自定义媒体目录（默认 .pi-web/../media）
 *
 * 与仓库其它 test.mjs 一致：clientId 随机生成，端口可配，不依赖特定项目文件。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

// 媒体文件只要落到该客户端可访问的 cwd 下任意图片即可；默认用会话目录下
// 一张可能的图片，找不到也不致命（仅打印 fetch 状态）。
const MEDIA_PATH = process.env.WS_MEDIA_PATH;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);
let step = 0;

function log(...a) {
	console.log(`[ws-session ${step}]`, ...a);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, serverVersion:", m.serverVersion);
		// 用根列表暴露当前会话 cwd（path undefined → 根）
		ws.send(JSON.stringify({ type: "list_files", path: undefined }));
	} else if (m.type === "files") {
		log("files root:", m.path, "entries:", m.entries.length);
		if (MEDIA_PATH) {
			const r = await fetch(
				`${BASE}/api/file?clientId=${encodeURIComponent(clientId)}&path=${encodeURIComponent(MEDIA_PATH)}`,
			);
			log("media fetch:", r.status, r.headers.get("content-type"));
		} else {
			log("WS_MEDIA_PATH 未设置，跳过媒体下载探测");
		}
		ws.close();
		process.exit(0);
	} else if (m.type === "snapshot") {
		if (m.state?.cwd) log("snapshot cwd:", m.state.cwd);
	} else if (m.type === "notice") {
		log("notice:", m.text);
	}
});

ws.on("error", (e) => {
	log("ws error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	log("TIMEOUT");
	process.exit(1);
}, 8000);
