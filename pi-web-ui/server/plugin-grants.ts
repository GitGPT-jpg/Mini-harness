/**
 * plugin-grants —— 插件目录授权表（issue #146）。
 *
 * 插件服务端跑的是全权 Node 代码，宿主只能在「自己提供的 API」上做闸门
 * （见 server/plugins.ts 的 registerAgentTool / route / host.fs）。当插件要碰
 * **工作区之外**的目录时，宿主弹确认框问用户；用户同意后可以选「记住」——
 * 记住的东西就落在这个文件里：`<dataDir>/plugin-grants.json`
 * （`{ grants: { <pluginId>: [绝对目录…] } }`），设置面板可随时撤销。
 *
 * 为什么单独一个文件而不是塞进 client-state.json：授权是**安全语义**的持久化
 * 状态，与 UI 偏好/最近项目是两回事 —— 用户清 UI 状态、迁移设置预设时不该
 * 连带丢（或带上）一份授权；文件独立后也能被运维一眼看懂、手改、审计。
 *
 * 三条设计取舍（都有意为之，改动前请先读）：
 *
 * 1. **父目录授权覆盖子目录**：`has()` 命中目录本身或其任一祖先。
 *    理由：目录授权天然是「子树授权」—— 用户批准 `/proj` 时的心理模型就是
 *    「这个项目目录随你用」，若还要求逐个 `/proj/src`、`/proj/docs` 再弹十次
 *    确认，用户只会一路盲点「同意」，闸门形同虚设（安全上反而更糟）。反之
 *    **不成立**：只授权了 `/proj/a` 时访问 `/proj` 必须再问 —— 祖先目录里
 *    还躺着用户没打算交出去的东西。判定按路径分段边界做（`/proj` 不覆盖
 *    `/project`），不做字符串前缀匹配。
 *
 * 2. **坏文件不覆盖**：读失败 / JSON 坏 / 形状不对一律当作空表（绝不抛给调用方，
 *    也绝不在读路径上回写）。因为「读不出来」与「确实是空的」在故障态下无法
 *    区分，若读失败就写一份空表回去，等于用一次磁盘抖动**静默清空用户全部授权**
 *    （或更糟：把手工修了一半的文件冲掉）。只有真正发生变更的写操作
 *    （grant / revoke 命中）才重写文件，此时以内存里的净化为准。
 *
 * 3. **文件 I/O 全部 best-effort**：磁盘错误不能让 server 崩（与
 *    server/client-state.ts 同风格）。写失败 = 这次授权没落盘，下次再问用户；
 *    内存态仍然生效，本次会话可用。
 *
 * 路径归一：一律 `resolve()` 成绝对路径再存；相对路径直接拒绝（相对谁是个隐藏
 * 上下文，落盘后换个 cwd 就读出另一个目录，等于埋雷）。win32 上比较时忽略大小写
 * 与尾部分隔符（Windows 文件系统不区分大小写），但**存储保持用户写入时的形式**
 * （不 lowerCase），否则设置面板里 `C:\Users\Foo` 会显示成 `c:\users\foo`。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

/** 合法插件 id（与 server/plugins.ts 的 ID_RE 一致，防路径穿越）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 磁盘格式：`{ grants: { pluginId: [绝对目录…] } }`。 */
export interface PluginGrantsFile {
	grants: Record<string, string[]>;
}

/** 去掉尾部分隔符（保留根：「C:\」/「/」不能退化）。 */
function stripTrailingSep(p: string): string {
	let out = p;
	for (;;) {
		if (out.length <= 1) return out;
		const last = out[out.length - 1];
		if (last !== "/" && last !== "\\") return out;
		const trimmed = out.slice(0, -1);
		// 「C:\」→「C:」在 win32 上语义完全不同（后者是「C 盘当前目录」），不能削。
		if (/^[A-Za-z]:$/.test(trimmed)) return out;
		out = trimmed;
	}
}

/** 比较用键：win32 折大小写（文件系统不区分大小写）；尾部分隔符统一去掉
 *  （`C:\a\` 与 `C:\a` 是同一目录，手改文件很容易多写一个斜杠）。 */
function pathKey(p: string): string {
	const s = stripTrailingSep(p);
	return process.platform === "win32" ? s.toLowerCase() : s;
}

/** 路径归一：绝对化 + 去尾分隔符；非法（空 / 非字符串 / 含 NUL / 相对 / 盘符怪）→ null。
 *  存储的也是这个形式（用户写入形式的绝对化版本）。 */
export function normalizeGrantPath(p: string): string | null {
	if (typeof p !== "string") return null;
	const raw = p.trim();
	if (!raw || raw.includes("\0")) return null;
	// 相对路径一律拒绝：授权必须是「明确的绝对目录」，不做 cwd 相对解析。
	// 顺带干掉 win32 上的怪盘符形式（"C:relative"、"1:\x" 都是 isAbsolute=false）。
	if (!isAbsolute(raw)) return null;
	let abs: string;
	try {
		abs = resolve(raw);
	} catch {
		return null;
	}
	if (!isAbsolute(abs)) return null;
	return stripTrailingSep(abs);
}

/** target 是否落在 ancestor 自身或它的子树上（按分段边界，不做裸前缀匹配：
 *  `/proj` 不能覆盖 `/project`）。两边都须是 pathKey() 归一后的形式。 */
function isSameOrInside(targetKey: string, ancestorKey: string): boolean {
	if (targetKey === ancestorKey) return true;
	const prefix = ancestorKey.endsWith(sep) ? ancestorKey : ancestorKey + sep;
	return targetKey.startsWith(prefix);
}

/** 原子写：临时文件 + rename。 */
function atomicWriteJson(filePath: string, data: unknown): void {
	writeJsonAtomicSync(filePath, data);
}

/** 读文件并净化为内存表：任何异常（不存在 / 权限 / JSON 坏 / 形状不对）→ 空表。
 *  条目逐个过 normalizeGrantPath（顺手兼容手工写入的相对路径、重复项、坏 id）。 */
function readGrantsFile(filePath: string): Record<string, string[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return {};
	}
	const grants = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PluginGrantsFile).grants : undefined;
	if (!grants || typeof grants !== "object" || Array.isArray(grants)) return {};
	const out: Record<string, string[]> = {};
	for (const [id, paths] of Object.entries(grants as Record<string, unknown>)) {
		if (!ID_RE.test(id) || !Array.isArray(paths)) continue;
		const seen = new Set<string>();
		const list: string[] = [];
		for (const p of paths) {
			if (typeof p !== "string") continue;
			const norm = normalizeGrantPath(p);
			if (!norm) continue;
			const key = pathKey(norm);
			if (seen.has(key)) continue;
			seen.add(key);
			list.push(norm);
		}
		if (list.length > 0) out[id] = list;
	}
	return out;
}

/**
 * 插件目录授权表。全局共享（不是 per-client）：授权是「这台机器上的这套插件
 * 配置允许它访问哪些目录」，任何浏览器/标签页看到的都该是同一份。
 */
export class PluginGrantsStore {
	/** 内存缓存 = 上次读盘结果（含净化）。null = 尚未读 / 已被 invalidate。 */
	private cache: Record<string, string[]> | null = null;

	/** @param dataDir 数据目录；授权文件固定为 `<dataDir>/plugin-grants.json`。 */
	constructor(private dataDir: string) {}

	/** 授权文件路径（测试 / 排障 / 审计用）。 */
	get filePath(): string {
		return resolve(this.dataDir, "plugin-grants.json");
	}

	private load(): Record<string, string[]> {
		if (!this.cache) this.cache = readGrantsFile(this.filePath);
		return this.cache;
	}

	/** 落盘（best-effort）：失败只丢持久化，不影响本次会话的内存态。 */
	private save(): void {
		try {
			atomicWriteJson(this.filePath, { grants: this.load() } satisfies PluginGrantsFile);
		} catch {
			// best effort —— 磁盘故障不能弄崩 server
		}
	}

	/** 全部授权，按插件聚合（设置面板展示用；路径保持写入时的形式）。
	 *  按 pluginId 排序，保证界面顺序稳定（与本文件里的插入顺序无关）。 */
	list(): { pluginId: string; paths: string[] }[] {
		const all = this.load();
		return Object.keys(all)
			.sort()
			.map((pluginId) => ({ pluginId, paths: [...all[pluginId]!] }));
	}

	/** 单个插件的授权目录（副本；不存在或 id 非法 → 空数组）。 */
	get(pluginId: string): string[] {
		if (!ID_RE.test(pluginId)) return [];
		return [...(this.load()[pluginId] ?? [])];
	}

	/**
	 * 是否已授权：命中目录本身，**或它的任一祖先目录已被授权**（见文件头取舍 1）。
	 * 纯字符串判定，不碰磁盘（目录可能还不存在，也可能已被删 —— 授权表是
	 * 「用户批准过」，不是「磁盘现状」）。
	 */
	has(pluginId: string, dir: string): boolean {
		if (!ID_RE.test(pluginId)) return false;
		const target = normalizeGrantPath(dir);
		if (!target) return false;
		const list = this.load()[pluginId];
		if (!list || list.length === 0) return false;
		const targetKey = pathKey(target);
		for (const granted of list) {
			if (isSameOrInside(targetKey, pathKey(granted))) return true;
		}
		return false;
	}

	/**
	 * 记一条授权（幂等：同一目录不重复）。返回是否**新增**。
	 *
	 * 幂等按归一后的同一目录判（win32 大小写 / 尾部分隔符等价形式算同一个）。
	 * 注意：父目录已授权时再显式 grant 子目录仍然会记下（返回 true）——
	 * 授权表是「用户知情过什么」的记录，显式批准过的子目录值得留痕，之后撤销
	 * 父目录时它不会莫名其妙一起消失（has 侧照样被父目录短路，不产生额外询问）。
	 */
	grant(pluginId: string, dir: string): boolean {
		if (!ID_RE.test(pluginId)) return false;
		const norm = normalizeGrantPath(dir);
		if (!norm) return false;
		const all = this.load();
		const list = all[pluginId] ?? [];
		const key = pathKey(norm);
		if (list.some((p) => pathKey(p) === key)) return false;
		all[pluginId] = [...list, norm];
		this.save();
		return true;
	}

	/**
	 * 撤销授权，三种粒度，返回删除的条数：
	 *   - `revoke()`                    清空整张表
	 *   - `revoke(pluginId)`            清掉该插件全部
	 *   - `revoke(pluginId, dir)`       只清该目录（按归一后的同一目录精确匹配，
	 *                                   不连带删除它下面的授权条目）
	 * 只给 dir 不给 pluginId 是非法用法（不知道删谁的）→ 0，不动表。
	 * 无变化时**不写盘**：坏文件/空表不该被一次空撤销顺手覆盖（见取舍 2）。
	 */
	revoke(pluginId?: string, dir?: string): number {
		const all = this.load();
		if (pluginId === undefined) {
			if (dir !== undefined) return 0; // 非法用法：只给目录无法定位插件
			let total = 0;
			for (const list of Object.values(all)) total += list.length;
			if (total === 0) return 0;
			for (const id of Object.keys(all)) delete all[id];
			this.save();
			return total;
		}
		if (!ID_RE.test(pluginId)) return 0;
		const list = all[pluginId];
		if (!list || list.length === 0) return 0;
		if (dir === undefined) {
			delete all[pluginId];
			this.save();
			return list.length;
		}
		const norm = normalizeGrantPath(dir);
		if (!norm) return 0;
		const key = pathKey(norm);
		const next = list.filter((p) => pathKey(p) !== key);
		const removed = list.length - next.length;
		if (removed === 0) return 0;
		if (next.length > 0) all[pluginId] = next;
		else delete all[pluginId];
		this.save();
		return removed;
	}

	/** 磁盘文件变化（多进程 / 用户手改）后重读：丢缓存，下次访问重新读盘。 */
	reload(): void {
		this.cache = null;
	}
}
