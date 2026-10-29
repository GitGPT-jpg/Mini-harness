/**
 * live-test.mjs — 纯 WebSocket 层端到端冒烟测试（不走浏览器）。
 *
 * 验证：hello → ready → set_cwd → read_file（文本预览）→ 媒体 /api/file → 结束
 *
 * 用法（需先有 server 在跑，或用环境变量指定）:
 *   node live-test.mjs                              # 连 ws://localhost:${PORT:-8787}
 *   PORT=9000 node live-test.mjs                    # 自定义端口
 *   WS_CWD=/path/node live-test.mjs                 # set_cwd 目标（默认当前目录）
 *   WS_READ=sub/dir/file.txt  node live-test.mjs    # read_file 的路径
 *   WS_MEDIA=sub/dir/pic.jpg  node live-test.mjs    # 可选：媒体文件，用于验证 /api/file 下载
 *
 * clientId 随机生成，不依赖特定项目，便于反复跑。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

const clientId = randomUUID();
const CWD = process.env.WS_CWD ?? process.cwd();
const READ_PATH = process.env.WS_READ;
const MEDIA_PATH = process.env.WS_MEDIA;

const ws = new WebSocket(WS_URL);
let step = 0;

function log(...a) {
	console.log(`[live ${step}]`, ...a);
}

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, serverVersion:", m.serverVersion);
		ws.send(JSON.stringify({ type: "set_cwd", path: CWD }));
	} else if (m.type === "notice" && step === 0) {
		log("set_cwd notice:", m.text);
		step = 1;
		ws.send(JSON.stringify({ type: "read_file", path: READ_PATH ?? "" }));
	} else if (m.type === "file_content" && step === 1) {
		log("file_content:", JSON.stringify({ name: m.name, truncated: m.truncated, binary: m.binary, lines: m.lines }));
		step = 2;
		if (MEDIA_PATH) {
			const url = `/api/file?clientId=${encodeURIComponent(clientId)}&path=${encodeURIComponent(MEDIA_PATH)}`;
			const r = await fetch(`${BASE}${url}`);
			log("media url:", url);
			log("media fetch:", r.status, r.headers.get("content-type"));
			const buf = Buffer.from(await r.arrayBuffer());
			log("bytes:", buf.length, "magic:", buf.subarray(0, 4).toString("hex"));
		} else {
			log("WS_MEDIA 未设置，跳过媒体下载探测");
		}
		ws.close();
		process.exit(0);
	} else if (m.type === "snapshot") {
		if (m.state?.cwd) log("snapshot cwd:", m.state.cwd);
	}
});

ws.on("error", (e) => {
	log("ws error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	log("TIMEOUT");
	process.exit(2);
}, 10000);
