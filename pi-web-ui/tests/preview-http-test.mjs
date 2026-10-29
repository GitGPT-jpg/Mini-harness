/**
 * /api/preview/*splat HTTP 路由回归测试（issue #225，零 token、自包含）。
 *
 * 前端媒体/HTML 预览按段 encode 后拼多段路径（sub/deep/a.md、__abs__/C:/…）——
 * Express 5 的命名通配多段给数组，直接 String() 会拼成逗号导致嵌套文件全 404。
 * 验证（server CWD 即工作区，无需 WS 会话）：
 * - 相对嵌套路径 200 + 内容正确
 * - __abs__ 绝对路径 200（跨平台：win32 用 C:/…，posix 用 /…）
 * - 工作区外文件不泄露字节（400/404，或 SPA 回退的 index.html）
 *
 * 运行：先 npm run build:server，再 node tests/preview-http-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const PORT = 8920;
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = realpathSync(process.execPath);
const workspace = mkdtempSync(join(tmpdir(), "pi-web-preview-http-"));
let proc = null;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

mkdirSync(join(workspace, "sub", "deep"), { recursive: true });
writeFileSync(join(workspace, "note.txt"), "root-note-225\n");
writeFileSync(join(workspace, "sub", "n.txt"), "nested-225-ok\n");
writeFileSync(join(workspace, "sub", "deep", "a.md"), "# deep-225-ok\n");
// 工作区外的秘密（断言绝不泄露字节）
const outsideDir = mkdtempSync(join(tmpdir(), "pi-web-preview-outside-"));
writeFileSync(join(outsideDir, "secret.txt"), "SECRET-225-MUST-NOT-LEAK\n");

proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: join(workspace, ".data"), PI_WEB_CWD: workspace },
	stdio: ["ignore", "pipe", "pipe"],
});
proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

async function waitServer() {
	for (let i = 0; i < 80; i++) {
		try {
			const r = await fetch(`${BASE}/api/health`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("server did not start");
}

try {
	await waitServer();

	// -- 相对嵌套路径 ------------------------------------------------------
	let r = await fetch(`${BASE}/api/preview/sub/n.txt`);
	if (r.status !== 200 || !(await r.text()).includes("nested-225-ok")) {
		fail(`嵌套相对路径异常：${r.status}`);
	} else console.log("✓ /api/preview/sub/n.txt → 200 内容正确");
	r = await fetch(`${BASE}/api/preview/sub/deep/a.md`);
	if (r.status !== 200 || !(await r.text()).includes("deep-225-ok")) {
		fail(`深层嵌套路径异常：${r.status}`);
	} else console.log("✓ /api/preview/sub/deep/a.md → 200 内容正确");

	// -- __abs__ 绝对路径（前端拼法：逐段 encode） -----------------------------
	const wire = workspace.split(sep).join("/");
	const segs = wire
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
	r = await fetch(`${BASE}/api/preview/__abs__/${segs}/sub/n.txt`);
	if (r.status !== 200 || !(await r.text()).includes("nested-225-ok")) {
		fail(`__abs__ 绝对路径异常：${r.status}`);
	} else console.log("✓ /api/preview/__abs__/<cwd>/sub/n.txt → 200 内容正确");

	// -- 相对路径穿越被挡（workspacePath containment） --------------------------
	// 注：__abs__ 绝对路径分支与 /api/file 同口径（有意不做 containment，
	// 靠 loopback 绑定 + PI_WEB_TOKEN 鉴权），此处只断言相对分支不逃逸。
	r = await fetch(
		`${BASE}/api/preview/sub/%2E%2E/%2E%2E/${encodeURIComponent(outsideDir.split(sep).join("/").split("/").pop() ?? "")}/secret.txt`,
	);
	const travBody = await r.text();
	if (travBody.includes("SECRET-225-MUST-NOT-LEAK")) {
		fail(`相对路径穿越泄露：${r.status} ${travBody.slice(0, 60)}`);
	} else console.log(`✓ 相对路径穿越不泄露（${r.status}）`);

	if (process.exitCode) console.error("PREVIEW HTTP TESTS FAILED");
	else console.log("ALL PREVIEW HTTP TESTS PASSED");
} catch (err) {
	fail(String(err?.message ?? err));
} finally {
	if (proc) {
		proc.kill();
		await new Promise((r) => setTimeout(r, 500));
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
	rmSync(workspace, { recursive: true, force: true });
	rmSync(outsideDir, { recursive: true, force: true });
}
