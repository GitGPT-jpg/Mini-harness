/**
 * durable-storage.ts — Pi Durable 存储后端管理与目录初始化。
 *
 * 职责：
 * 1. 自动为每个工作区或全局建立 SQLite 持久化存储（WAL 模式）；
 * 2. 动态加载 @earendil-works/pi-durable 的持久化仓储驱动；
 * 3. 当未安装原生包或缺少编译依赖时，优雅回退到内存存储或报错。
 */

import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadDurableModule } from "./durable-loader.js";

export interface DurableStorageHandle {
	storage: any;
	path?: string;
	isMemory: boolean;
}

/**
 * 为指定工作区 cwd 解析或创建 SQLite 存储实例。
 */
export async function openDurableStorage(dataDir: string, cwd: string): Promise<DurableStorageHandle> {
	const durableDir = join(dataDir, "durable");
	if (!existsSync(durableDir)) {
		mkdirSync(durableDir, { recursive: true });
	}

	// 按 cwd 的 hash 区分项目存储，避免多项目写入同一库发生锁争用
	const slug = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
	const dbPath = join(durableDir, `session-${slug}.sqlite`);

	try {
		// 动态通过全局/本地加载器加载 SQLite 持久层
		const sqliteModule = await loadDurableModule("storage/sqlite/node").catch(() => null);

		if (sqliteModule && typeof sqliteModule.openNodeSqliteStorage === "function") {
			const storage = await sqliteModule.openNodeSqliteStorage(dbPath);
			return { storage, path: dbPath, isMemory: false };
		}
	} catch {
		/* sqlite native driver not available, fall back to memory */
	}

	// 动态尝试加载 MemoryStorage
	const coreModule = await loadDurableModule().catch(() => null);

	if (coreModule && coreModule.MemoryStorage) {
		const storage = new coreModule.MemoryStorage();
		return { storage, isMemory: true };
	}

	throw new Error("Pi Durable 依赖未安装。请运行 npm i -g @earendil-works/pi-durable 启用该引擎。");
}
