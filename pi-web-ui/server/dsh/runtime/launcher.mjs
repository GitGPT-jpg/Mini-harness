#!/usr/bin/env node
/**
 * pi-web-ui DSH runtime launcher (DshEngine的运行时子进程).
 *
 * 组合 = 全局/本地 dsh 运行时树里的 dsh-base bundle patch + 本文件同目录的
 * override patch（挂 stdio JSON-RPC 服务插件 + pin 会话持久化/人设/沙箱）。
 * 与官方 dsh CLI 的 profile 机制无关 —— 直接以 boot() 组合静态入口，绕开
 * $DSH_HOME/profiles 初始化。
 *
 * 运行时树解析顺序（实现见 runtime-root.mjs，支持 flat / dsh 嵌套两种布局）：
 *   1. $PI_WEB_DSH_RUNTIME — 显式指定 node_modules 根（含 @deepseek-ai/dsh-base）
 *   2. 本包 node_modules — 若 pi-web-ui 完整安装了 dsh 依赖树
 *   3. execPath 邻近 node_modules — fnm / 独立 node 的稳定布局
 *   4. `npm root -g` — 全局 dsh 安装（`npm i -g @deepseek-ai/dsh`）
 *
 * JSON-RPC 服务插件（dsh-sdk-jsonrpc-server）按项目依赖解析：override patch
 * 里的 name 由 $PI_WEB_DSH_JSONRPC_ENTRY 用 !!js 求值成绝对路径（指向项目
 * node_modules），其 peer 依赖从项目树自洽解析 —— cordis loader 的裸包解析
 * 只有单一 base，所以混树只能走绝对路径挂载。
 *
 * 协议：newline-delimited JSON-RPC 2.0 于 stdio（stdout 只承载协议帧）。
 */
import { dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntimeBaseWithDetails, getExpectedDshVersion, getDshFamily } from "./runtime-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN_NAME = "pi-web-ui-dsh";

const expectedVersion = getExpectedDshVersion();
const expectedFamily = getDshFamily(expectedVersion);

const { base: runtimeBase, scannedPaths, compatibility } = await resolveRuntimeBaseWithDetails();
if (!runtimeBase) {
	const pathList = scannedPaths
		.slice(0, 15)
		.map((s) => `  - ${s.path} (${s.exists ? s.reason || "已存在但非有效运行时树" : "不存在"})`)
		.join("\n");
	const more = scannedPaths.length > 15 ? `\n  ... 另有 ${scannedPaths.length - 15} 处候选` : "";
	process.stderr.write(
		`[${BIN_NAME}] 找不到 DSH 运行时树（含 @deepseek-ai/dsh-base 的 node_modules）。\n` +
			`请先执行 npm i -g @deepseek-ai/dsh@${expectedVersion}（或设置 PI_WEB_DSH_RUNTIME 指向其 node_modules 目录）。\n\n` +
			`已探测的候选路径：\n${pathList}${more}\n\n` +
			`详见文档 docs/dsh-engine.md。\n`,
	);
	process.exit(1);
}

process.env.PI_WEB_DSH_RUNTIME_BASE = runtimeBase;

// 检查版本族兼容性（默认宽松尝试运行；若需严格匹配可设置 PI_WEB_DSH_STRICT_VERSION=1）
if (!compatibility?.compatible) {
	const strictVer = process.env.PI_WEB_DSH_STRICT_VERSION === "1" || process.env.PI_WEB_DSH_STRICT_VERSION === "true";
	const verMsg =
		`[${BIN_NAME}] 注意：检测到 DSH 运行时版本（${compatibility?.runtimeVersion ?? "未知"}）与期望版本（${expectedVersion}，版本族 ${expectedFamily}）不同。\n` +
		`  - 运行时树位置：${runtimeBase}\n` +
		`  - 默认以可用运行时树为准并尝试向前兼容启动。如需强制版本一致，可设置 PI_WEB_DSH_STRICT_VERSION=1。\n`;

	if (strictVer) {
		process.stderr.write(
			`[${BIN_NAME}] DSH 运行时版本族不匹配（已开启 PI_WEB_DSH_STRICT_VERSION 严格模式）：\n` +
				`  - 检测到运行时版本：${compatibility?.runtimeVersion ?? "未知"}（位于 ${runtimeBase}）\n` +
				`  - pi-web-ui 期望版本族：${expectedFamily}（当前依赖 @deepseek-ai/dsh@${expectedVersion}）\n\n` +
				`推荐解决方案：\n` +
				`  1. 全局安装匹配版本的运行时：\n` +
				`     npm i -g @deepseek-ai/dsh@${expectedVersion}\n` +
				`  2. 或通过独立前缀安装并配置环境变量（推荐，不影响全局 CLI）：\n` +
				`     npm i -g @deepseek-ai/dsh@${expectedVersion} --prefix ~/.pi-web/dsh-runtime-${expectedFamily}\n` +
				`     并在启动 pi-web-ui 时设置环境变量：\n` +
				`     PI_WEB_DSH_RUNTIME=~/.pi-web/dsh-runtime-${expectedFamily}/lib/node_modules\n\n` +
				`详见文档 docs/dsh-engine.md。\n`,
		);
		process.exit(1);
	} else {
		process.stderr.write(verMsg);
	}
}

const runConfig = process.env.DSH_CORDIS_CONFIG ?? join(HERE, "cordis.yml");
const baseBundlePatch = join(runtimeBase, "@deepseek-ai", "dsh-base", "cordis.patch.yml");
const overridePatch = join(HERE, "override.patch.yml");

// 用户 patch 层：<dataDir>/dsh-patches/*.yml（按文件名序，在 override 之后）。
// 引擎（DshClientSession）负责在重启运行时前创建目录；launcher 只负责加载。
const userPatchDir = process.env.PI_WEB_DSH_DATA_DIR
	? join(process.env.PI_WEB_DSH_DATA_DIR, "dsh-patches")
	: (process.env.PI_WEB_DSH_PATCH_DIR ?? null);
const userPatchFiles = [];
if (userPatchDir) {
	try {
		for (const name of readdirSync(userPatchDir)) {
			if (/^[^.]/u.test(name) && /\.ya?ml$/iu.test(name)) {
				userPatchFiles.push(join(userPatchDir, name));
			}
		}
	} catch {
		// 目录不存在/不可读 = 无用户 patch，静默跳过。
	}
}
userPatchFiles.sort((a, b) => a.localeCompare(b));

// preset-plane patch 路径（服务端生成的 agent-plane 下沉层，见
// server/dsh/preset-clones.ts）。实际加载在 boot import 之后；缺失/不可读 =
// 回落 legacy 单组合（roster 不挂，会话走 host 直连），静默跳过。
const presetPlanePatch = process.env.PI_WEB_DSH_PRESET_PATCH ?? null;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

const { boot, installFailLoud, loadOverlayPatches } = await import(
	pathToFileURL(join(runtimeBase, "@deepseek-ai", "dsh-app-boot", "lib", "index.js")).href
);

// cordis loader 只对 entry 的 config 做 !!js 插值，name 字段不支持。
// sdk-jsonrpc 走本地扩展插件 goal-rpc.mjs（官方 server 类 + goal RPC 方法）；
// 官方入口（base 类）通过 env PI_WEB_DSH_JSONRPC_ENTRY 传给 wrapper。
const jsonrpcWrapper = join(HERE, "goal-rpc.mjs");
const _jsonrpcEntry = process.env.PI_WEB_DSH_JSONRPC_ENTRY
	? resolve(process.env.PI_WEB_DSH_JSONRPC_ENTRY)
	: join(
			resolve(HERE, "..", "..", "..", ".."),
			"node_modules",
			"@deepseek-ai",
			"dsh-sdk-jsonrpc-server",
			"lib",
			"index.js",
		);

const overrideList = loadOverlayPatches(BIN_NAME, overridePatch);
// cordis loader 只对 entry 的 config 做 !!js 插值，name 字段不支持——
// 插件绝对路径在这里用 JS 写回（sdk-jsonrpc → 本地 goal-rpc wrapper；
// 用户 patch 若用 id 覆盖 sdk-jsonrpc 或 insert 同名 entry 也拿到 wrapper）。
const fixJsonrpcName = (patch) => {
	if (patch.id === "sdk-jsonrpc") {
		patch.name = jsonrpcWrapper;
	}
	for (const entry of patch.insert ?? []) {
		if (entry.id === "sdk-jsonrpc") entry.name = jsonrpcWrapper;
	}
};
for (const patch of overrideList) fixJsonrpcName(patch);
const userPatchLists = userPatchFiles.map((file) => {
	try {
		return loadOverlayPatches(BIN_NAME, file);
	} catch (err) {
		process.stderr.write(`[${BIN_NAME}] 跳过用户 patch ${file}: ${err?.message ?? String(err)}\n`);
		return [];
	}
});
for (const list of userPatchLists) for (const patch of list) fixJsonrpcName(patch);
// preset-plane patch（服务端生成；override 之后、用户 patch 之前）。
let presetPlaneLists = [];
if (presetPlanePatch) {
	try {
		presetPlaneLists = loadOverlayPatches(BIN_NAME, presetPlanePatch);
	} catch (err) {
		process.stderr.write(`[${BIN_NAME}] 跳过 preset-plane patch ${presetPlanePatch}: ${err?.message ?? String(err)}\n`);
		presetPlaneLists = [];
	}
}
for (const patch of presetPlaneLists) fixJsonrpcName(patch);
// patches 参数必须是扁平列表（boot → mountRootInclude → Include.applyPatches →
// applyEntryPatches 逐个消费；数组嵌套会被当无 id 的 patch 跳过）。
const patches = [
	...loadOverlayPatches(BIN_NAME, baseBundlePatch),
	...overrideList,
	...presetPlaneLists,
	// 用户 patch：同样按文件展开为扁平 patch entry 列表（一个文件可含多 entry）。
	...userPatchLists.flat(),
];

let ctx;
try {
	ctx = await boot(
		BIN_NAME,
		runConfig,
		patches,
		undefined,
		// 裸包名（dsh-base 组合行）锚定到运行时树；jsonrpc 行走绝对路径。
		pathToFileURL(runtimeBase + "/").href,
	);
} catch (err) {
	const seen = new Set();
	let isTypertFailure = false;
	const walk = (e, depth) => {
		if (!e || seen.has(e)) return;
		seen.add(e);
		const msg = e?.message ?? String(e);
		if (
			msg.includes("typert contributor") ||
			msg.includes("codec has no create() factory") ||
			msg.includes("typert-loader")
		) {
			isTypertFailure = true;
		}
		const indent = "    " + "  ".repeat(Math.min(depth, 6));
		process.stderr.write(`${indent}${msg}\n`);
		const kids = e?.aggregateErrors ?? e?.errors ?? (e?.cause ? [e.cause] : []);
		for (const k of kids) walk(k, depth + 1);
	};
	process.stderr.write(`[${BIN_NAME}] boot 失败: ${err?.message ?? String(err)}\n   runtime base: ${runtimeBase}\n`);
	walk(err, 0);
	if (isTypertFailure || !compatibility?.compatible) {
		process.stderr.write(
			`\n[${BIN_NAME}] 诊断：检测到启动失败。当前运行时版本为 ${compatibility?.runtimeVersion ?? "未知"}（期望版本族 ${expectedFamily}）。\n` +
				`若因跨版本破坏性变更引起，请执行 npm i -g @deepseek-ai/dsh@${expectedVersion} 重新安装匹配版本的运行时。\n\n`,
		);
	}
	process.exit(1);
}

let releasing = false;
const release = () => {
	if (releasing) return;
	releasing = true;
	void (async () => {
		try {
			await ctx.fiber.dispose();
		} catch (err) {
			console.error(`[${BIN_NAME}] teardown 错误: ${err?.message ?? String(err)}`);
		}
		process.exit(0);
	})();
	return true;
};
installFailLoud(BIN_NAME, process, release);

// stdin EOF = 客户端消失 → 有序释放后退出。
process.stdin.resume();
process.stdin.on("end", release);
process.stdin.on("close", release);
process.on("SIGTERM", release);
process.on("SIGINT", () => process.exit(130));
