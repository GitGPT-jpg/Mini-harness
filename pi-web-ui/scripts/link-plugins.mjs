#!/usr/bin/env node
/**
 * scripts/link-plugins.mjs
 *
 * 将当前仓库中的内置插件 (plugins/<id>) 通过符号链接 / Junction 软链接到用户数据目录 (<dataDir>/plugins/<id>)。
 * 解决「本地修改插件代码后必须手动复制到数据目录、AI/开发者容易遗漏」的痛点。
 *
 * 用法：
 *   node scripts/link-plugins.mjs                 # 链接全部内置插件
 *   node scripts/link-plugins.mjs legado-web      # 仅链接指定插件
 *   node scripts/link-plugins.mjs --unlink        # 恢复全部内置插件为独立目录
 *   node scripts/link-plugins.mjs legado-web -u   # 仅恢复指定插件
 */

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const repoPluginsDir = join(repoRoot, "plugins");
const catalogPath = join(repoPluginsDir, "catalog.json");

const dataDir = process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web");
const userPluginsDir = join(dataDir, "plugins");

const isWin = process.platform === "win32";

// 解析命令行参数
const args = process.argv.slice(2);
const isUnlink = args.includes("--unlink") || args.includes("-u");
const targetPluginId = args.find((a) => !a.startsWith("-"));

function getBuiltinPluginIds() {
	if (targetPluginId) return [targetPluginId];
	if (!existsSync(catalogPath)) return [];
	try {
		const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
		return Array.isArray(raw) ? raw.map((e) => e?.id).filter(Boolean) : [];
	} catch {
		return [];
	}
}

export function linkPlugin(id, { repoDir = repoPluginsDir, targetDir = userPluginsDir } = {}) {
	const src = join(repoDir, id);
	const dest = join(targetDir, id);
	const bak = join(targetDir, `${id}.bak`);

	if (!existsSync(src)) {
		console.warn(`[link-plugins] 源码目录不存在，跳过: ${src}`);
		return false;
	}

	mkdirSync(targetDir, { recursive: true });

	if (existsSync(dest)) {
		const stat = lstatSync(dest);
		if (stat.isSymbolicLink()) {
			console.log(`[link-plugins] ✓ ${id} 已经是软链接，无需操作`);
			return true;
		}
		// 普通目录：备份并替换
		if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
		renameSync(dest, bak);
		console.log(`[link-plugins] 旧目录已备份至 ${id}.bak`);
	}

	// Windows 使用 junction，无需管理员权限；POSIX 使用 dir symlink
	symlinkSync(src, dest, isWin ? "junction" : "dir");
	console.log(`[link-plugins] ✓ 成功链接: ${id} → ${src}`);
	return true;
}

export function unlinkPlugin(id, { repoDir = repoPluginsDir, targetDir = userPluginsDir } = {}) {
	const src = join(repoDir, id);
	const dest = join(targetDir, id);
	const bak = join(targetDir, `${id}.bak`);

	if (!existsSync(dest)) {
		console.log(`[link-plugins] 目录不存在，跳过: ${dest}`);
		return true;
	}

	const stat = lstatSync(dest);
	if (!stat.isSymbolicLink()) {
		console.log(`[link-plugins] ${id} 是普通目录，不是软链接，无需解除`);
		return true;
	}

	// 移除软链接
	rmSync(dest, { force: true });

	// 如果有备份，优先恢复备份
	if (existsSync(bak)) {
		renameSync(bak, dest);
		console.log(`[link-plugins] ✓ 已恢复备份目录: ${id}`);
	} else if (existsSync(src)) {
		// 没有备份但有源码，复制源码副本
		cpSync(src, dest, { recursive: true });
		console.log(`[link-plugins] ✓ 已从源码复制独立副本: ${id}`);
	} else {
		console.log(`[link-plugins] ✓ 已移除软链接: ${id}`);
	}
	return true;
}

export function cleanBrokenSymlinks({ targetDir = userPluginsDir } = {}) {
	if (!existsSync(targetDir)) return [];
	const removed = [];
	try {
		for (const name of readdirSync(targetDir)) {
			const p = join(targetDir, name);
			try {
				const st = lstatSync(p);
				if (st.isSymbolicLink() && !existsSync(p)) {
					rmSync(p, { force: true });
					console.log(`[link-plugins] 自动清理失效软链接: ${name}`);
					removed.push(name);
				}
			} catch {}
		}
	} catch {}
	return removed;
}

// 主流程执行（CLI 模式）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	cleanBrokenSymlinks();
	const ids = getBuiltinPluginIds();
	if (ids.length === 0) {
		console.log("[link-plugins] 未找到内置插件，退出。");
		process.exit(0);
	}

	console.log(`[link-plugins] ${isUnlink ? "解除链接" : "建立软链接"}目标目录: ${userPluginsDir}`);
	for (const id of ids) {
		if (isUnlink) {
			unlinkPlugin(id);
		} else {
			linkPlugin(id);
		}
	}
	console.log(
		`[link-plugins] 完成！${isUnlink ? "已恢复为独立副本" : "现在修改 plugins/ 源码将实时生效，无需手动复制"}`,
	);
}
