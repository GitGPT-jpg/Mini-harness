/**
 * issue #223 回归测试：Express 5 的 send 默认 dotfiles=ignore，
 * 绝对路径中只要有一段以点号开头（如 ~/.pi-web、~/.local）就会被判 404。
 *
 * 数据目录刻意放在隐藏目录下（<tmp>/…/.pi-web），断言：
 *   - /api/themes 能列出用户主题；
 *   - /themes/<user>.css 返回 200（修复前是 404）且内容正确；
 *   - 内置主题仍返回 200；
 *   - 不存在的 id / 非白名单 id 仍返回 404（allow 没有打开遍历口）。
 *
 * 纯 HTTP 测试，无需浏览器、无需 token。独立端口 8936 + 临时目录，结束自清理。
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const PORT = 8936;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

// 数据目录本身就在隐藏目录段下（复现 ~/.pi-web 的线上布局）。
const BASE = mkdtempSync(join(tmpdir(), "piweb-themedot-"));
const DATA_DIR = join(BASE, ".pi-web");
mkdirSync(join(DATA_DIR, "themes"), { recursive: true });
const USER_CSS = "/* theme-name: DotDirTheme */\n:root{--bg:#123456;}\n";
writeFileSync(join(DATA_DIR, "themes", "dottheme.css"), USER_CSS);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(PROJ, "theme-dotfile-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(400);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: BASE,
		PI_WEB_DATA_DIR: DATA_DIR,
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关（置空=无鉴权）。
		PI_WEB_TOKEN: "",
	},
	stdio: "ignore",
});
try {
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const themes = await (await fetch(`${URL}/api/themes`)).json();
	const user = (themes.themes ?? []).find((t) => t.id === "dottheme");
	check("user theme listed", user?.builtin === false, JSON.stringify(user ?? null));

	const userRes = await fetch(`${URL}/themes/dottheme.css`);
	check("user theme css under dot-dir returns 200", userRes.status === 200, `status=${userRes.status}`);
	check(
		"user theme css content-type",
		(userRes.headers.get("content-type") ?? "").includes("text/css"),
		userRes.headers.get("content-type"),
	);
	const userBody = await userRes.text();
	// 主题 CSS 整体被服务端包进 `@layer theme { … }`（分层契约），原文必须原样在其中。
	check("user theme css body intact", userBody.includes(USER_CSS.trim()), userBody);
	check(
		"user theme css wrapped in @layer theme",
		/^@layer theme \{\n[\s\S]*\n\}\n$/.test(userBody),
		userBody.slice(0, 40),
	);

	const builtinRes = await fetch(`${URL}/themes/mist.css`);
	check("builtin theme still 200", builtinRes.status === 200, `status=${builtinRes.status}`);

	const missingRes = await fetch(`${URL}/themes/no-such-theme.css`);
	check("unknown theme still 404", missingRes.status === 404, `status=${missingRes.status}`);

	const badRes = await fetch(`${URL}/themes/..css`);
	check("non-whitelist id still 404", badRes.status === 404, `status=${badRes.status}`);
} catch (err) {
	check("test completed without exception", false, err instanceof Error ? err.message : String(err));
} finally {
	server.kill("SIGKILL");
	// Windows：给子进程收尾一点时间再退出，否则本机 libuv 在命名管道/句柄关闭时序
	// 上触发 win\async.c 断言（与 run-smoke 的 WIN32_KNOWN_ENV_FAIL 同类噪音）。
	await sleep(800);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
