/**
 * 会话缓存上限与转录全文拆分的单元测试（issue #440，零 server、零 token）。
 *
 * 覆盖四类行为：
 * 1. sessionFileCache LRU：条目超上限淘汰最旧；命中续期后不被淘汰；
 * 2. invalidateSessionInfos：仍能清理指定文件的元信息缓存与全文缓存；
 * 3. 全文拆分：列表路径（loadSessionInfos）的缓存条目与返回值都不带转录全文，
 *    mtime/size 未变时仍复用同一 info 对象（原行为保持）；
 * 4. 全文按需加载：loadSessionSearchText 走 TTL 缓存 + 256K 字符封顶，
 *    filterSessionsForSearch 元信息命中不读全文、全文命中走按需加载。
 *
 * 磁盘用例经 PI_CODING_AGENT_SESSION_DIR 指向临时目录（扁平布局），fake-this
 * 模式与 soft-cap-apply.test.ts 一致：Object.create(ClientSession.prototype) +
 * 原型/静态方法 .call；私有静态经 Record cast 访问。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClientSession } from "../../server/agent-service.js";

// 私有静态字段/方法：运行时都挂在 class 上，经 cast 访问（同 fake-this 思路）
const CS = ClientSession as unknown as Record<string, any>;

/** fake this：loadSessionInfos / invalidateSessionInfos 只触静态缓存与 this.cwd。 */
function svcWith(cwd: string) {
	const svc = Object.create(ClientSession.prototype) as { cwd: string };
	svc.cwd = cwd;
	return svc;
}

function dummyInfo(path: string) {
	return {
		path,
		id: "x",
		cwd: "",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

function transcript(id: string, messages: { role: "user" | "assistant"; text: string }[]) {
	const lines = [JSON.stringify({ type: "session", id, cwd: tmp, timestamp: "2026-01-01T00:00:00.000Z" })];
	for (const m of messages) {
		lines.push(
			JSON.stringify({ type: "message", message: { role: m.role, timestamp: 1700000000000, content: m.text } }),
		);
	}
	return lines.join("\n");
}

let tmp = "";
const originalEnv = process.env.PI_CODING_AGENT_SESSION_DIR;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "piwui-session-cache-"));
	// 小转录：全文远小于 256K 封顶
	writeFileSync(
		join(tmp, "a.jsonl"),
		transcript("sess-a", [
			{ role: "user", text: "hello world" },
			{ role: "assistant", text: "hi there" },
		]),
	);
	// 大转录：全文 > 256K 字符。首条消息（进 firstMessage 元信息）只含 head_marker，
	// tail_marker 在第二条消息的封顶之外 —— 确保截断判定不被元信息命中短路。
	writeFileSync(
		join(tmp, "big.jsonl"),
		transcript("sess-big", [
			{ role: "user", text: "head_marker" },
			{ role: "assistant", text: `${"y".repeat(300 * 1024)} tail_marker` },
		]),
	);
	process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
});

afterAll(() => {
	if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = originalEnv;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	CS.sessionFileCache.clear();
	CS.sessionTextCache.clear();
	CS.sessionInfosCache.clear();
	CS.sessionInfosInFlight.clear();
});

afterEach(() => {
	// 防止用例内对上限常量的临时改写泄漏
	CS.SESSION_FILE_CACHE_MAX = 512;
	CS.SESSION_TEXT_CACHE_MAX = 256;
});

describe("sessionFileCache LRU（issue #440）", () => {
	it("条目超上限：从最旧端淘汰", () => {
		CS.SESSION_FILE_CACHE_MAX = 3;
		CS.sessionFileCacheStore("k1", { mtime: 1, size: 1, info: dummyInfo("k1") });
		CS.sessionFileCacheStore("k2", { mtime: 1, size: 1, info: dummyInfo("k2") });
		CS.sessionFileCacheStore("k3", { mtime: 1, size: 1, info: dummyInfo("k3") });
		expect(CS.sessionFileCache.size).toBe(3);
		CS.sessionFileCacheStore("k4", { mtime: 1, size: 1, info: dummyInfo("k4") });
		expect(CS.sessionFileCache.size).toBe(3);
		expect(CS.sessionFileCache.has("k1")).toBe(false); // 最旧被淘汰
		expect(CS.sessionFileCache.has("k4")).toBe(true);
	});

	it("LRU 命中续期：最近命中的条目不会被淘汰", () => {
		CS.SESSION_FILE_CACHE_MAX = 3;
		CS.sessionFileCacheStore("k1", { mtime: 1, size: 1, info: dummyInfo("k1") });
		CS.sessionFileCacheStore("k2", { mtime: 1, size: 1, info: dummyInfo("k2") });
		CS.sessionFileCacheStore("k3", { mtime: 1, size: 1, info: dummyInfo("k3") });
		// k1 命中 → 续期到最新端；再写入 k4 时被淘汰的是未命中的 k2
		const hit = CS.sessionFileCacheLookup("k1");
		expect(hit?.info.path).toBe("k1");
		CS.sessionFileCacheStore("k4", { mtime: 1, size: 1, info: dummyInfo("k4") });
		expect(CS.sessionFileCache.size).toBe(3);
		expect(CS.sessionFileCache.has("k1")).toBe(true);
		expect(CS.sessionFileCache.has("k2")).toBe(false);
		expect(CS.sessionFileCache.has("k3")).toBe(true);
	});
});

describe("invalidateSessionInfos 清理语义（issue #440 后保持）", () => {
	const p1 = resolve("/x/a.jsonl");
	const p2 = resolve("/x/b.jsonl");
	// private 方法：同 fake-this 模式经 cast 取原型实现
	const invalidate = (ClientSession.prototype as unknown as Record<string, (this: unknown, filePath?: string) => void>)
		.invalidateSessionInfos;

	it("带 filePath：清该文件的元信息缓存 + 全文缓存，并清列表缓存", () => {
		CS.sessionFileCache.set(p1, { mtime: 1, size: 1, info: dummyInfo(p1) });
		CS.sessionFileCache.set(p2, { mtime: 1, size: 1, info: dummyInfo(p2) });
		CS.sessionTextCache.set(p1, { text: "全文", at: Date.now() });
		CS.sessionInfosCache.set("somecwd", { infos: [], at: Date.now() });
		invalidate.call(svcWith("/x"), p1);
		expect(CS.sessionFileCache.has(p1)).toBe(false);
		expect(CS.sessionTextCache.has(p1)).toBe(false);
		expect(CS.sessionFileCache.has(p2)).toBe(true); // 其他文件不受影响
		expect(CS.sessionInfosCache.size).toBe(0);
	});

	it("不带 filePath：只清列表缓存，文件与全文缓存保留（原语义）", () => {
		CS.sessionFileCache.set(p1, { mtime: 1, size: 1, info: dummyInfo(p1) });
		CS.sessionTextCache.set(p1, { text: "全文", at: Date.now() });
		CS.sessionInfosCache.set("somecwd", { infos: [], at: Date.now() });
		invalidate.call(svcWith("/x"));
		expect(CS.sessionFileCache.has(p1)).toBe(true);
		expect(CS.sessionTextCache.has(p1)).toBe(true);
		expect(CS.sessionInfosCache.size).toBe(0);
	});
});

describe("转录全文拆分与按需加载（issue #440）", () => {
	it("列表路径：返回值与缓存条目都不带全文，元信息完整", async () => {
		const infos = await (
			ClientSession.prototype as unknown as {
				loadSessionInfos: () => Promise<
					{ id: string; firstMessage: string; messageCount: number; allMessagesText: string }[]
				>;
			}
		).loadSessionInfos.call(svcWith(tmp));
		expect(infos).toHaveLength(2);
		const a = infos.find((i) => i.id === "sess-a")!;
		expect(a.firstMessage).toBe("hello world");
		expect(a.messageCount).toBe(2);
		expect(a.allMessagesText).toBe(""); // 拆分：列表不携带全文
		const cached = CS.sessionFileCache.get(resolve(join(tmp, "a.jsonl")));
		expect(cached?.info.allMessagesText).toBe("");
		expect(cached?.mtime).toBeGreaterThan(0);
	});

	it("mtime/size 未变：重扫时复用缓存里的同一 info 对象（不重读盘）", async () => {
		const proto = ClientSession.prototype as unknown as { loadSessionInfos: () => Promise<{ id: string }[]> };
		const first = await proto.loadSessionInfos.call(svcWith(tmp));
		// 只清列表 fridge，保留单文件缓存 → 第二次扫描应从 sessionFileCache 命中
		CS.sessionInfosCache.clear();
		const second = await proto.loadSessionInfos.call(svcWith(tmp));
		expect(second.find((i) => i.id === "sess-a")).toBe(first.find((i) => i.id === "sess-a"));
	});

	it("loadSessionSearchText：按需提取全文进 TTL 缓存；单条 256K 字符封顶", async () => {
		const pathA = resolve(join(tmp, "a.jsonl"));
		const pathBig = resolve(join(tmp, "big.jsonl"));
		const textA: string = await CS.loadSessionSearchText(pathA);
		expect(textA).toContain("hello world");
		expect(textA).toContain("hi there");
		expect(CS.sessionTextCache.has(pathA)).toBe(true);
		const textBig: string = await CS.loadSessionSearchText(pathBig);
		expect(textBig.length).toBe(256 * 1024);
		expect(textBig).toContain("head_marker");
		expect(textBig).not.toContain("tail_marker"); // 封顶影响面：截断点之后不参与命中
	});

	it("sessionTextCache：TTL 过期按未命中处理，未过期命中续期", () => {
		CS.sessionTextCacheStore("t1", "过期内容", 1); // at=1 → 必然过期
		expect(CS.sessionTextCacheLookup("t1", Date.now())).toBeUndefined();
		expect(CS.sessionTextCache.has("t1")).toBe(false);
		CS.sessionTextCacheStore("t2", "新鲜内容", Date.now());
		expect(CS.sessionTextCacheLookup("t2", Date.now())).toBe("新鲜内容");
		expect(CS.sessionTextCache.has("t2")).toBe(true);
	});

	it("sessionTextCache：条目超上限从最旧端淘汰", () => {
		CS.SESSION_TEXT_CACHE_MAX = 2;
		CS.sessionTextCacheStore("t1", "1", Date.now());
		CS.sessionTextCacheStore("t2", "2", Date.now());
		CS.sessionTextCacheStore("t3", "3", Date.now());
		expect(CS.sessionTextCache.size).toBe(2);
		expect(CS.sessionTextCache.has("t1")).toBe(false);
		expect(CS.sessionTextCache.has("t3")).toBe(true);
	});

	it("filterSessionsForSearch：元信息命中不读全文；全文命中走按需加载；保序返回", async () => {
		const infos = await (
			ClientSession.prototype as unknown as {
				loadSessionInfos: () => Promise<{ id: string; path: string }[]>;
			}
		).loadSessionInfos.call(svcWith(tmp));
		// 元信息命中（首条消息）——命中的会话不读全文（未命中的 big.jsonl 会按需加载）
		const byFirst: { id: string }[] = await CS.filterSessionsForSearch.call(ClientSession, "hello world", infos);
		expect(byFirst.map((s) => s.id)).toEqual(["sess-a"]);
		expect(CS.sessionTextCache.has(resolve(join(tmp, "a.jsonl")))).toBe(false);
		// 全文命中（assistant 回复只在全文里）——按需加载后进缓存
		const byText: { id: string }[] = await CS.filterSessionsForSearch.call(ClientSession, "hi there", infos);
		expect(byText.map((s) => s.id)).toEqual(["sess-a"]);
		expect(CS.sessionTextCache.size).toBeGreaterThan(0);
		// 封顶外尾段不命中（记录在案的影响面）
		const byTail: { id: string }[] = await CS.filterSessionsForSearch.call(ClientSession, "tail_marker", infos);
		expect(byTail).toHaveLength(0);
		// 无命中
		const none: { id: string }[] = await CS.filterSessionsForSearch.call(ClientSession, "zzz-no-such", infos);
		expect(none).toHaveLength(0);
	});
});
