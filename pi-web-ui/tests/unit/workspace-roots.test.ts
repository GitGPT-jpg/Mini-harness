/**
 * 额外工作区根（宿主侧多根，issue #146）服务端单测：归一化 + 按项目持久化。
 * 不起 server、不碰网络，纯状态与纯函数。
 *
 * 语义回顾（contract）：AI 仍只在主 cwd 里干活（pi SDK 单 cwd 模型）；多根只影响
 * 「哪些路径算工作区内」—— 右栏文件树可跨根浏览。所以两个不变量必须成立：
 *   1. 只收绝对路径（相对路径在服务端没有可靠基准），去重、上限 8；
 *   2. 根**按项目（cwd）**存：切项目各带各自的多根，互不串味。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClientStateStore, MAX_WORKSPACE_ROOTS, normalizeWorkspaceRoots } from "../../server/client-state.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ws-roots-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** 造一个能当“目录”用的绝对路径（不要求真的存在：归一化不看磁盘）。 */
const abs = (...parts: string[]): string => join(dir, ...parts);

describe("normalizeWorkspaceRoots", () => {
	it("非数组 / 全垃圾 → []", () => {
		expect(normalizeWorkspaceRoots(undefined)).toEqual([]);
		expect(normalizeWorkspaceRoots("x")).toEqual([]);
		expect(normalizeWorkspaceRoots({})).toEqual([]);
		expect(normalizeWorkspaceRoots([1, null, {}, "", "   "])).toEqual([]);
	});

	it("相对路径一律丢弃（服务端没有可靠基准）", () => {
		expect(normalizeWorkspaceRoots(["relative/dir", "./x", "../up"])).toEqual([]);
	});

	it("绝对路径 resolve 成规范形式 + 去重 + 保持顺序", () => {
		const a = abs("a");
		const b = abs("b");
		expect(normalizeWorkspaceRoots([a, b, a])).toEqual([resolve(a), resolve(b)]);
	});

	it("win32 折大小写去重；posix 区分大小写", () => {
		const a = abs("Case");
		const upper = a.toUpperCase();
		const out = normalizeWorkspaceRoots([a, upper]);
		if (process.platform === "win32") expect(out).toHaveLength(1);
		else expect(out).toHaveLength(upper === a ? 1 : 2);
	});

	it(`上限 ${MAX_WORKSPACE_ROOTS} 个（多余的丢弃，不报错）`, () => {
		const many = Array.from({ length: MAX_WORKSPACE_ROOTS + 5 }, (_v, i) => abs(`r${i}`));
		expect(normalizeWorkspaceRoots(many)).toEqual(many.slice(0, MAX_WORKSPACE_ROOTS).map((p) => resolve(p)));
	});

	it("路径两端空白被裁掉（前端从 crumbs 复制来的常见形态）", () => {
		expect(normalizeWorkspaceRoots([`  ${abs("pad")}  `])).toEqual([resolve(abs("pad"))]);
	});
});

describe("ClientStateStore 的根持久化（按项目）", () => {
	it("save → get 往返；空数组 = 清掉该项目的键（不留空壳）", () => {
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const cwdA = abs("proj-a");
		store.saveWorkspaceRoots("c1", cwdA, [abs("extra-1"), abs("extra-2")]);
		expect(store.getWorkspaceRoots("c1", cwdA)).toEqual([resolve(abs("extra-1")), resolve(abs("extra-2"))]);

		store.saveWorkspaceRoots("c1", cwdA, []);
		expect(store.getWorkspaceRoots("c1", cwdA)).toEqual([]);
		// 落盘后不该留 "projects":{"…":[]} 这种空壳
		const raw = JSON.parse(readFileSync(join(dir, "client-state.json"), "utf8")) as Record<
			string,
			{ workspaceRoots?: Record<string, string[]> }
		>;
		expect(raw.c1?.workspaceRoots).toBeUndefined();
	});

	it("按项目隔离：两个 cwd 各带各自的多根，互不影响", () => {
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const cwdA = abs("pa");
		const cwdB = abs("pb");
		store.saveWorkspaceRoots("c1", cwdA, [abs("a-extra")]);
		store.saveWorkspaceRoots("c1", cwdB, [abs("b-extra-1"), abs("b-extra-2")]);
		expect(store.getWorkspaceRoots("c1", cwdA)).toEqual([resolve(abs("a-extra"))]);
		expect(store.getWorkspaceRoots("c1", cwdB)).toEqual([resolve(abs("b-extra-1")), resolve(abs("b-extra-2"))]);
		expect(store.getWorkspaceRoots("c1", abs("never"))).toEqual([]);
	});

	it("按客户端隔离；脏数据（相对路径/数字）逐个丢而不是整份回落", () => {
		const store = new ClientStateStore(join(dir, "client-state.json"));
		const cwd = abs("p");
		store.saveWorkspaceRoots("c1", cwd, [abs("good"), "relative", 42 as unknown as string]);
		expect(store.getWorkspaceRoots("c1", cwd)).toEqual([resolve(abs("good"))]);
		expect(store.getWorkspaceRoots("c2", cwd)).toEqual([]);
	});

	it("重开一个 store（进程重启）后仍然读得到", () => {
		const file = join(dir, "client-state.json");
		const cwd = abs("p");
		new ClientStateStore(file).saveWorkspaceRoots("c1", cwd, [abs("keep")]);
		expect(new ClientStateStore(file).getWorkspaceRoots("c1", cwd)).toEqual([resolve(abs("keep"))]);
	});
});
