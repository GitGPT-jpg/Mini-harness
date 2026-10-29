/**
 * durable-loader.ts — Pi Durable 运行环境加载门面（基于 server/global-loader.ts）。
 *
 * 统一委托给通用全局加载器，消除代码冗余。
 */

import {
	dynamicImportGlobalPackage,
	probeGlobalPackage,
	resolvePackageRoot,
	resolvePackageEntryFile,
} from "../global-loader.js";

const DURABLE_PKG = "@earendil-works/pi-durable";

/**
 * 解析并定位 @earendil-works/pi-durable 包的物理安装根目录。
 */
export function findDurablePackageRoot(forceRefresh = false): string | null {
	return resolvePackageRoot(DURABLE_PKG, { refresh: forceRefresh });
}

/**
 * 探测 Pi Durable 引擎的安装元数据（包版本号与物理路径）。
 */
export function probeDurableInstallation(forceRefresh = false): {
	installed: boolean;
	version?: string;
	packagePath?: string;
} {
	return probeGlobalPackage(DURABLE_PKG, { refresh: forceRefresh });
}

/**
 * 动态加载 @earendil-works/pi-durable 核心模块或其子路径模块。
 * @param subpath 子路径标识，如 ""（主包）、"tools"、"storage/sqlite/node"、"storage/memory"
 */
export async function loadDurableModule<T = any>(subpath = ""): Promise<T> {
	return dynamicImportGlobalPackage<T>(DURABLE_PKG, subpath);
}

/**
 * 动态加载关联的 @earendil-works/* 兄弟包（如 chord/context、pi-ai/models）。
 */
export async function loadDurablePeerModule<T = any>(packageName: string, subpath = ""): Promise<T | null> {
	try {
		return await dynamicImportGlobalPackage<T>(packageName, subpath);
	} catch {
		return null;
	}
}

export { resolvePackageEntryFile };
