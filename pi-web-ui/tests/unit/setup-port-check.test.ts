/**
 * 受管启动器回归：
 * - health 只是就绪信号，不能独立证明端口归属；
 * - token URL 只在同一安装目录的受管进程上打开；
 * - setup / DMG 不得各自实现一份弱校验。
 */
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcherPath = fileURLToPath(new URL("../../../pi-web-cockpit/launch-harness.sh", import.meta.url));
const setupPath = fileURLToPath(new URL("../../../setup.sh", import.meta.url));
const packagePath = fileURLToPath(new URL("../../../build/package.sh", import.meta.url));
const launcher = readFileSync(launcherPath, "utf8");
const setup = readFileSync(setupPath, "utf8");
const packageScript = readFileSync(packagePath, "utf8");

function healthScript(): string {
	const match = launcher.match(/HARNESS_HEALTH_PORT="\$PORT" node -e '\n([\s\S]*?)\n' >\/dev\/null 2>&1/);
	if (!match?.[1]) throw new Error("launch-harness.sh 未找到真实 health 谓词");
	return match[1];
}

function runHealthCheck(script: string, port: number): Promise<number> {
	return new Promise((resolve) => {
		execFile("node", ["-e", script], { env: { ...process.env, HARNESS_HEALTH_PORT: String(port) } }, (err) => {
			resolve(err ? (typeof err.code === "number" ? err.code : 1) : 0);
		});
	});
}

async function freePort(): Promise<number> {
	for (let port = 8900; port < 9000; port += 1) {
		const free = await new Promise<boolean>((resolve) => {
			const server = createNetServer();
			server.once("error", () => resolve(false));
			server.once("listening", () => server.close(() => resolve(true)));
			server.listen(port, "127.0.0.1");
		});
		if (free) return port;
	}
	throw new Error("8900-8999 没有空闲端口");
}

async function listen(port: number, body: string, statusCode = 200): Promise<() => Promise<void>> {
	const server = createHttpServer((_req, res) => {
		res.statusCode = statusCode;
		res.setHeader("content-type", "application/json");
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return () => new Promise((resolve) => server.close(() => resolve()));
}

describe("受管 Harness 启动器", () => {
	it("health 谓词只接受明确的成功 Harness 响应", async () => {
		const script = healthScript();
		const cases: Array<{ body: string; expected: number }> = [
			{ body: '{"ok":true}', expected: 1 },
			{ body: '{"app":"mini-harness"}', expected: 1 },
			{ body: '{"ok":false,"app":"mini-harness"}', expected: 1 },
			{ body: '{"ok":true,"app":"mini-harness"}', expected: 0 },
			{ body: 'not-json', expected: 1 },
		];
		for (const testCase of cases) {
			const port = await freePort();
			const close = await listen(port, testCase.body);
			try {
				expect(await runHealthCheck(script, port)).toBe(testCase.expected);
			} finally {
				await close();
			}
		}
	});

	it("所有 token 交接前都要求受管进程归属，且固定使用 IPv4 loopback", () => {
		expect(launcher).toContain("is_owned_listener");
		expect(launcher).toContain("all_listeners_owned && harness_healthy");
		expect(launcher).toContain('OPEN_URL="http://127.0.0.1:$PORT/"');
		expect(launcher).not.toContain("http://localhost:");
		expect(launcher).toContain('fail "端口 :$PORT 被未知进程占用');
	});

	it("setup 与 DMG 启动器只委托共享启动器，不再各自拼 token URL", () => {
		expect(setup).toContain('"$COCKPIT/launch-harness.sh" --upgrade');
		expect(setup).not.toContain("open \"http://localhost:");
		expect(packageScript).toContain('"$DEST/pi-web-cockpit/launch-harness.sh"');
		expect(packageScript).not.toContain("open \"http://localhost:");
	});
});
