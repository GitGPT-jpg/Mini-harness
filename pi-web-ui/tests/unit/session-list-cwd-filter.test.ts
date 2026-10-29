/**
 * issue #438：历史会话列表在扁平布局（PI_CODING_AGENT_SESSION_DIR）下混入其他项目会话。
 *
 * 扁平布局语义：根目录顶层直接是**所有项目**共享的 .jsonl，所属 cwd 是文件内字段。
 * loadSessionInfos 的快速路径从 readdir 到返回全程没有 cwd 过滤，导致项目 A 的
 * 「历史会话」出现项目 B/C 的对话（点开即切走工作区）；且各项目文件共同竞争
 * validStats.slice(0, 200) 的名额，大库下本项目会话可能被别的项目挤出列表。
 *
 * 测试策略：真实临时目录 + 真 .jsonl 文件（parseSessionInfoFast 是模块私有函数，
 * mock 不到），fake-this 直接调 ClientSession 原型上的 private loadSessionInfos
 * （同 soft-cap-apply.test.ts 的 Object.create(prototype) 模式）。
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { normalizePathKey } from "../../server/client-state.js";

// private static 缓存：测试间必须隔离（30s TTL 缓存 + 文件缓存 + in-flight 去重）。
const caches = ClientSession as unknown as {
	sessionInfosCache: Map<string, { infos: SessionInfo[]; at: number }>;
	sessionInfosInFlight: Map<string, Promise<SessionInfo[]>>;
	sessionFileCache: Map<string, unknown>;
};

// private 方法：绕过可见性（同 soft-cap-apply.test.ts 的做法）。
const loadSessionInfos = (
	ClientSession.prototype as unknown as Record<string, (this: unknown) => Promise<SessionInfo[]>>
).loadSessionInfos;

const fakeThis = (cwd: string) => Object.assign(Object.create(ClientSession.prototype), { cwd });

const envOriginal = {
	PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

let idSeq = 0;
let tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `pi-438-${prefix}-`));
	tmpDirs.push(dir);
	return dir;
}

/** 写一个最小会话 transcript（header 一行；cwd=null 模拟缺 cwd 字段的损坏文件），
 *  并用 utimes 固定 mtime（排序断言不依赖文件系统 mtime 粒度）。 */
async function writeSession(
	dir: string,
	opts: { cwd: string | null; atMs: number; id?: string },
): Promise<{ path: string; id: string }> {
	const id = opts.id ?? `s${idSeq++}`;
	const header: Record<string, unknown> = { type: "session", id, timestamp: new Date(opts.atMs).toISOString() };
	if (opts.cwd !== null) header.cwd = opts.cwd;
	const fp = join(dir, `2026-01-01T00-00-${String(idSeq % 60).padStart(2, "0")}_${id}.jsonl`);
	await writeFile(fp, `${JSON.stringify(header)}\n`);
	await utimes(fp, new Date(opts.atMs), new Date(opts.atMs));
	return { path: fp, id };
}

async function setFlatRoot(root: string | null): Promise<void> {
	if (root === null) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = root;
}

beforeEach(() => {
	caches.sessionInfosCache.clear();
	caches.sessionInfosInFlight.clear();
	caches.sessionFileCache.clear();
});

afterEach(async () => {
	if (envOriginal.PI_CODING_AGENT_SESSION_DIR === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = envOriginal.PI_CODING_AGENT_SESSION_DIR;
	if (envOriginal.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = envOriginal.PI_CODING_AGENT_DIR;
	for (const dir of tmpDirs.splice(0)) {
		if (existsSync(dir)) {
			// Windows 上带杀毒/索引时 rm 可能瞬时 EBUSY/ENOTEMPTY（尤其当上一个用例刚超时、
			// 文件还在陆续落盘）—— maxRetries 只在 force+recursive 时生效，这里正好用上。
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	}
});

describe("loadSessionInfos — 扁平布局 cwd 过滤（issue #438）", () => {
	it("只返回当前 cwd 的会话，其他项目的文件不混入", async () => {
		const root = await makeTmpDir("flat");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		await setFlatRoot(root);

		// cwdB 的会话 mtime 最新（真实场景：别的项目刚聊完），旧实现会把它排最前。
		const other = await writeSession(root, { cwd: cwdB, atMs: 3_000 });
		const ownOld = await writeSession(root, { cwd: cwdA, atMs: 1_000 });
		const ownNew = await writeSession(root, { cwd: cwdA, atMs: 2_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => normalizePathKey(i.cwd))).toEqual([normalizePathKey(cwdA), normalizePathKey(cwdA)]);
		expect(infos.map((i) => i.path).sort()).toEqual([ownOld.path, ownNew.path].sort());
		expect(infos.map((i) => i.id)).not.toContain(other.id);
		// 展示顺序仍是 modified 降序（新的在前）。
		expect(infos[0].path).toBe(ownNew.path);
	});

	it("Windows 大小写/斜杠差异不漏配（normalizePathKey 口径）", { skip: process.platform !== "win32" }, async () => {
		const root = await makeTmpDir("flat-win");
		const cwdA = await makeTmpDir("proj-a");
		await setFlatRoot(root);

		// 文件内 cwd 记成小写盘符 + 正斜杠（工具拷贝/手工编辑常见），仍须命中。
		const lowered = cwdA.toLowerCase().replaceAll("\\", "/");
		const own = await writeSession(root, { cwd: lowered, atMs: 1_000 });
		await writeSession(root, { cwd: "d:\\somewhere-else", atMs: 2_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => i.id)).toEqual([own.id]);
	});

	it("缺 cwd 字段的损坏文件不误收（normalizePathKey('') 会 resolve 到 process.cwd()）", async () => {
		const root = await makeTmpDir("flat-corrupt");
		const cwdA = await makeTmpDir("proj-a");
		await setFlatRoot(root);

		await writeSession(root, { cwd: null, atMs: 5_000 }); // mtime 最新，若误收会排最前
		const own = await writeSession(root, { cwd: cwdA, atMs: 1_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => i.path)).toEqual([own.path]);
	});

	// ⚠️ 这里真的有 211 个文件要落盘 + 211 个文件要被真实扫描：全量套件并行跑（4 个 worker，
	// 且 Windows 上有实时杀毒扫描）时 5s 默认超时不够 —— 那是超时，不是断言失败，会连带
	// 让 afterEach 在文件还在写时清理。给足超时，不要用缩小用例规模换速度：201 与 200 的
	// 边界正是这个用例要验的东西。
	it("200 截断发生在 cwd 过滤之后：名额只分给本项目（issue #438 附带问题）", { timeout: 60_000 }, async () => {
		const root = await makeTmpDir("flat-cap");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		await setFlatRoot(root);

		// 本项目 201 个 + 其他项目 10 个；其他项目的 mtime 全部更新（抢占名额）。
		// 修复前：mtime 前 200 = other×10 + own 最新的 190 → 本项目丢 10 个名额还混入异项目。
		// 修复后：先过滤（剩 201 个 own）再截 200 → 只丢 own 中 mtime 最旧的 1 个。
		const baseMs = 1_000_000;
		const ownFiles: { id: string }[] = [];
		for (let i = 0; i < 201; i++) {
			ownFiles.push(
				await writeSession(root, { cwd: cwdA, atMs: baseMs + i * 1000, id: `own-${String(i).padStart(3, "0")}` }),
			);
		}
		for (let i = 0; i < 10; i++) {
			await writeSession(root, { cwd: cwdB, atMs: baseMs + 500_000 + i * 1000, id: `other-${i}` });
		}

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos).toHaveLength(200);
		const ids = infos.map((i) => i.id);
		expect(ids.some((id) => id.startsWith("other-"))).toBe(false);
		expect(ids).not.toContain("own-000"); // mtime 最旧的被截掉
		expect(ids).toContain("own-200"); // mtime 最新的保留
		expect(infos.every((i) => normalizePathKey(i.cwd) === normalizePathKey(cwdA))).toBe(true);
	});
});

describe("loadSessionInfos — 默认分层布局行为不变", () => {
	it("每-cwd 子目录布局：只读本 cwd 子目录，其他 cwd 的子目录不混入", async () => {
		const agentDir = await makeTmpDir("agent");
		const cwdA = await makeTmpDir("proj-a");
		const cwdB = await makeTmpDir("proj-b");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await setFlatRoot(null); // 走 SDK 默认 <agentDir>/sessions/--<cwd>--/ 布局

		// SessionManager.create().getSessionDir() 会 mkdir -p，拿真实子目录路径（不猜编码规则）。
		const dirA = SessionManager.create(cwdA).getSessionDir();
		const own = await writeSession(dirA, { cwd: cwdA, atMs: 1_000 });
		const own2 = await writeSession(dirA, { cwd: cwdA, atMs: 2_000 });
		// cwdB 自己的子目录：旧实现 readdir(sessionDir) 只扫本 cwd 子目录，天然隔离——必须保持。
		const dirB = SessionManager.create(cwdB).getSessionDir();
		const foreign = await writeSession(dirB, { cwd: cwdB, atMs: 3_000 });

		const infos = await loadSessionInfos.call(fakeThis(cwdA));
		expect(infos.map((i) => i.id).sort()).toEqual([own.id, own2.id].sort());
		expect(infos.map((i) => i.id)).not.toContain(foreign.id);
		// 布局本身没被破坏：B 的子目录确实存在（getSessionDir 的 mkdir 副作用符合预期）。
		expect(existsSync(dirB)).toBe(true);
	});
});
