import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * pi 扩展加载器的硬要求（issue #553）：**宿主提供的包必须只声明在 peerDependencies（`"*"`）**，
 * 不能出现在 `dependencies` 里 —— 否则 `pi update --extensions` 会在扩展目录里再装一份嵌套副本，
 * 绕开加载器注入（`Host-provided extension packages` 警告），typebox 之类出现两份运行时模块，
 * instanceof / 状态判断分裂。
 *
 * 本包同时是「pi 扩展」（extensions/webui.ts）和「独立服务端 / CLI」（dist/server/index.js 由扩展
 * spawn 出的独立 Node 进程）：服务端真的要 import 这两包（server/*.ts 里 typebox 20+ 处引用、
 * SDK 遍布全仓），`PI_WEB_SDK=bundled` 也承诺自带副本随时可用（可复现 / 报 bug 用）。所以它们
 * 落在 **optionalDependencies**：npm 默认照装（自带副本还在），而 pi 的检查只读 `dependencies`
 * （pi 的 dist/core/resource-loader.js 里 collectExtensionPackageWarnings 只遍历 manifest.dependencies），
 * 警告随之消失。谁把这两包搬回 dependencies，这里就红。
 */
const HOST_PROVIDED = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
];

/** 本包真用到的两个（服务端运行时依赖 + 宿主提供）。 */
const USED = ["@earendil-works/pi-coding-agent", "typebox"];

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
	packages: Record<
		string,
		{
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			optional?: boolean;
		}
	>;
};

describe("扩展宿主提供包（issue #553）", () => {
	it("dependencies 里不许出现宿主提供的包（pi 扩展加载器只看这个字段）", () => {
		const offenders = Object.keys(manifest.dependencies ?? {}).filter((name) => HOST_PROVIDED.includes(name));
		expect(offenders).toEqual([]);
	});

	it("用到的两个包声明成 peer（`*`）+ optional peer（宿主没装也不报警）", () => {
		for (const name of USED) {
			expect(manifest.peerDependencies?.[name]).toBe("*");
			expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
		}
	});

	it("同时挂在 optionalDependencies 上：npm 默认照装，自带副本（PI_WEB_SDK=bundled）不丢", () => {
		for (const name of USED) {
			expect(manifest.optionalDependencies?.[name]).toBeTruthy();
		}
	});

	it("package-lock 与 package.json 同口径（锁文件不残留旧归属）", () => {
		const root = lock.packages[""];
		expect(root).toBeTruthy();
		for (const name of USED) {
			expect(root.dependencies?.[name]).toBeUndefined();
			expect(root.optionalDependencies?.[name]).toBeTruthy();
		}
		// 已安装的那两份必须是 optional 身份：可选依赖装失败只跳过这一条，不连累整棵树安装。
		expect(lock.packages["node_modules/typebox"]?.optional).toBe(true);
		expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"]?.optional).toBe(true);
	});
});
