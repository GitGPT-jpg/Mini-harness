/**
 * ensure-build.mjs —— 冒烟用例共用的「dist 就绪」闸门（零依赖，纯 node）。
 *
 * 背景：多个 `*-test.mjs` 原先各自在用例里跑 `npm run build`。冒烟默认 4 worker 并行，
 * 于是出现两类问题：
 *   1. 一个用例正在重写 `dist/`，另一个用例同时 `spawn dist/server/index.js` →
 *      与被测逻辑无关的假红（例：「测试插件没被激活」，其实插件已经激活了）；
 *   2. 同一次套件里把整棵 vite + tsc + vendor 构建重复跑 6 遍，并发写同一份产物。
 *
 * 约定：`tests/run-smoke.mjs` 在**开始跑用例之前**串行构建一次，并给子进程带上
 * `PI_WEB_SMOKE_PREBUILT=1`（`--no-build` 时跳过构建，但仍会校验产物在）。用例侧一律走
 * `ensureBuild()`：
 *   - 套件内（见到标记）：只校验产物存在，不再构建；
 *   - 单跑（`node tests/xxx-test.mjs`）：保持原行为，自己 `npm run build`。
 *
 * 新增自建 server 的用例：需要 dist 时请调用它，不要自己 `execSync("npm run build")`
 * （否则并行套件里又会互相踩）。
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 套件内部约定产物：服务端入口（其它构建产物都由同一次 `npm run build` 生成）。 */
export function distEntry(repoRoot) {
	return join(repoRoot, "dist", "server", "index.js");
}

/** 套件内标记：值为 "1" 时表示 `run-smoke.mjs` 已经构建过 dist。 */
export const PREBUILT_ENV = "PI_WEB_SMOKE_PREBUILT";

/**
 * 保证 `dist/` 可用。套件内直接返回（runner 已构建），单跑时自己构建一次。
 * @param {string} repoRoot 仓库根
 * @param {string} [label] 出错信息里的用例名
 */
export function ensureBuild(repoRoot, label = "smoke") {
	const entry = distEntry(repoRoot);
	if (process.env[PREBUILT_ENV] === "1") {
		if (!existsSync(entry)) {
			throw new Error(`[${label}] 套件声明 dist 已就绪，但找不到 ${entry}（检查 run-smoke.mjs 的构建步骤）`);
		}
		return;
	}
	try {
		execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
	} catch {
		throw new Error(`[${label}] npm run build 失败 —— 先手动跑一次看完整输出`);
	}
}
