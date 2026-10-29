#!/usr/bin/env node
/**
 * check-protocol-sync.mjs — 校验 wire 协议单源机制仍然成立。
 *
 * web/src/types.ts 已不再手工镜像 server/protocol.ts，而是
 * `export type * from "../../server/protocol"` 全量再导出（唯一事实源），
 * 协议改动只改 protocol.ts 一处，双端永远同步。
 *
 * 本脚本守护的不变量：
 *   1. types.ts 确实是 shim（有人退回手工镜像时立刻发现）；
 *   2. protocol.ts 保持纯类型导出（出现 export const/function/class 等
 *      运行时代码会破坏「类型擦除、不共享运行时」的前提）；
 *   3. 双端 PROTOCOL_VERSION 一致；
 *   4. 改了 protocol.ts 必须 bump 版本（相对上一 tag 的 git 启发式，#479）。
 *
 * 用法：node scripts/check-protocol-sync.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesSrc = readFileSync(join(root, "web/src/types.ts"), "utf8");
const protocolSrc = readFileSync(join(root, "server/protocol.ts"), "utf8");

let failed = false;

// 1. shim 存在
if (!/export\s+type\s+\*\s+from\s+"\.\.\/\.\.\/server\/protocol"/.test(typesSrc)) {
	console.error(
		"✗ web/src/types.ts 不再是 re-export shim —— 协议必须以 server/protocol.ts 为唯一事实源，不要退回手工镜像。",
	);
	failed = true;
} else {
	console.log("✓ types.ts 是 protocol.ts 的 type-only re-export shim");
}

// 2. protocol.ts 无运行时代码导出
const runtimeExports = [
	...protocolSrc.matchAll(/^export\s+(?!type\b|interface\b)(?:declare\s+)?(const|let|var|function|class|enum)\b/gm),
].map((m) => m[1]);
if (runtimeExports.length > 0) {
	console.error(
		`✗ server/protocol.ts 出现运行时代码导出（${[...new Set(runtimeExports)].join(", ")}）——该文件必须保持纯类型，前端要经 type-only re-export 引用它。`,
	);
	failed = true;
} else {
	console.log("✓ protocol.ts 保持纯类型导出（无运行时代码）");
}

// 3. 双端协议版本号一致
const serverVerSrc = readFileSync(join(root, "server/protocol-version.ts"), "utf8");
const webVerSrc = readFileSync(join(root, "web/src/protocol-version.ts"), "utf8");
const mServer = serverVerSrc.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
const mWeb = webVerSrc.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
if (!mServer || !mWeb || mServer[1] !== mWeb[1]) {
	console.error(
		`✗ 协议版本号不一致：server=${mServer?.[1] ?? "?"} web=${mWeb?.[1] ?? "?"} —— 改协议时必须同步 bump 两份 PROTOCOL_VERSION。`,
	);
	failed = true;
} else {
	console.log(`✓ 双端 PROTOCOL_VERSION 一致 (v${mServer[1]})`);
}

// 4. git 启发式（#479/D-12）：protocol.ts 相对上一 tag 有 diff 而 PROTOCOL_VERSION
//    两份都无 diff → 报错。不变量 3 只能查「两份常数不相等」，查不出「改了协议
//    没 bump」（#430 加上行字段未 bump 而 #428 同性质追加 bump 了）。无法判定
//    （浅克隆/打包环境/无 tag）时跳过，不误报。
{
	let usable = true;
	const diffQuiet = (range, file) => {
		try {
			execFileSync("git", ["diff", "--quiet", range, "--", file], { cwd: root, stdio: "pipe" });
			return false;
		} catch (err) {
			if (err?.status === 1) return true; // 有差异
			usable = false; // git 不可用 / 浅克隆缺对象 → 放弃判定
			return false;
		}
	};
	let tag = null;
	try {
		tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		usable = false;
	}
	if (!usable || !tag) {
		console.log("· 跳过协议版本 git 启发式（无可用 tag 或浅检出环境）");
	} else {
		const protocolChanged = diffQuiet(tag, "server/protocol.ts");
		const versionChanged =
			diffQuiet(tag, "server/protocol-version.ts") || diffQuiet(tag, "web/src/protocol-version.ts");
		if (!usable) {
			console.log("· 跳过协议版本 git 启发式（git 判定不可用）");
		} else if (protocolChanged && !versionChanged) {
			console.error(
				`✗ protocol.ts 自 ${tag} 起有改动但 PROTOCOL_VERSION 未 bump——新增/变更 wire 字段必须同步 bump server/web 两份 PROTOCOL_VERSION。`,
			);
			failed = true;
		} else {
			console.log(
				`✓ 协议版本纪律（相对 ${tag}）：${protocolChanged ? "协议有改动且已 bump" : "协议相对上一 tag 无改动"}`,
			);
		}
	}
}

if (failed) process.exit(1);
