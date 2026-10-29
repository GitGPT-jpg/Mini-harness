/**
 * 插件市场列表（server/plugin-catalog.ts）单测：builtin+custom 两层合并、
 * 同 id 覆盖、source 校验、默认 id 推导、添加/移除持久化。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readCatalog,
	addCustomEntry,
	removeCustomEntry,
	deriveCatalogId,
	writeCommunityCatalog,
} from "../../server/plugin-catalog.js";

let dir: string;
let builtin: string;
let custom: string;
let community: string;

const BUILTIN = [
	{
		id: "webmail",
		name: "webmail",
		icon: "📬",
		description: "网页邮箱",
		source: "xing-shuyin/pi-web-ui/plugins/webmail",
	},
	{
		id: "mermaid",
		name: "mermaid",
		source: "xing-shuyin/pi-web-ui/plugins/mermaid",
	},
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-web-ui-catalog-"));
	builtin = join(dir, "catalog.json");
	custom = join(dir, "custom.json");
	community = join(dir, "community.json");
	writeFileSync(builtin, JSON.stringify(BUILTIN));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readCatalog", () => {
	it("合并 builtin + custom，custom 同 id 覆盖 builtin", () => {
		writeFileSync(
			custom,
			JSON.stringify({ entries: [{ id: "webmail", name: "我的邮箱", source: "other/repo/webmail" }] }),
		);
		const list = readCatalog(builtin, custom);
		expect(list).toHaveLength(2);
		const webmail = list.find((e) => e.id === "webmail")!;
		expect(webmail.name).toBe("我的邮箱");
		expect(webmail.builtin).toBe(false);
		expect(webmail.source).toBe("other/repo/webmail");
		const mermaid = list.find((e) => e.id === "mermaid")!;
		expect(mermaid.builtin).toBe(true);
		expect(mermaid.description).toBeUndefined();
	});

	it("支持 nameEn 字段透传", () => {
		writeFileSync(
			custom,
			JSON.stringify({ entries: [{ id: "custom-p", name: "自定义", nameEn: "Custom", source: "user/custom" }] }),
		);
		const list = readCatalog(builtin, custom);
		const customPlugin = list.find((e) => e.id === "custom-p")!;
		expect(customPlugin.name).toBe("自定义");
		expect(customPlugin.nameEn).toBe("Custom");
	});

	it("builtin 文件缺失时只看 custom", () => {
		writeFileSync(custom, JSON.stringify({ entries: [{ id: "x", source: "a/b" }] }));
		const list = readCatalog(join(dir, "missing.json"), custom);
		expect(list).toHaveLength(1);
		expect(list[0]!.builtin).toBe(false);
	});

	it("三层合并：builtin + community + custom 标记 origin 并分级优先级", () => {
		// 社区列表包含一个第三方插件和一个试图重名覆盖 webmail 的条目
		writeCommunityCatalog(community, [
			{ id: "pi-web-multigit", name: "Multi Git", source: "EinErste/pi-web-multigit", builtin: false },
			{ id: "webmail", name: "社区邮箱（应被内置阻挡）", source: "other/webmail", builtin: false },
		]);
		// 自定义列表包含一个全新的自定义插件和一个显式覆盖 mermaid 的条目
		writeFileSync(
			custom,
			JSON.stringify({
				entries: [
					{ id: "my-custom", name: "私有插件", source: "me/my-custom" },
					{ id: "mermaid", name: "我的 Mermaid", source: "me/mermaid" },
				],
			}),
		);

		const list = readCatalog(builtin, custom, community);
		expect(list).toHaveLength(4);

		// 1. webmail：属于内置，不被社区列表覆盖
		const webmail = list.find((e) => e.id === "webmail")!;
		expect(webmail.origin).toBe("builtin");
		expect(webmail.builtin).toBe(true);
		expect(webmail.name).toBe("webmail");

		// 2. pi-web-multigit：来自社区生态
		const multigit = list.find((e) => e.id === "pi-web-multigit")!;
		expect(multigit.origin).toBe("community");
		expect(multigit.builtin).toBe(false);
		expect(multigit.name).toBe("Multi Git");

		// 3. mermaid：被自定义列表覆盖
		const mermaid = list.find((e) => e.id === "mermaid")!;
		expect(mermaid.origin).toBe("custom");
		expect(mermaid.builtin).toBe(false);
		expect(mermaid.overridesBuiltin).toBe(true);
		expect(mermaid.name).toBe("我的 Mermaid");

		// 4. my-custom：独立自定义插件
		const myCustom = list.find((e) => e.id === "my-custom")!;
		expect(myCustom.origin).toBe("custom");
		expect(myCustom.builtin).toBe(false);
	});
});

describe("addCustomEntry / removeCustomEntry", () => {
	it("添加后读回，id 默认按来源推导", () => {
		const e = addCustomEntry(custom, { source: "other/repo/awesome-plugin" });
		expect(e.id).toBe("awesome-plugin");
		expect(e.name).toBe("awesome-plugin");
		expect(e.builtin).toBe(false);
		const list = readCatalog(builtin, custom);
		expect(list.find((x) => x.id === "awesome-plugin")).toBeDefined();
	});

	it("同 id 覆盖旧条目（不重复）", () => {
		addCustomEntry(custom, { source: "a/b", id: "dup" });
		addCustomEntry(custom, { source: "c/d", id: "dup", name: "second" });
		const list = readCatalog(builtin, custom);
		const hits = list.filter((x) => x.id === "dup");
		expect(hits).toHaveLength(1);
		expect(hits[0]!.name).toBe("second");
		expect(hits[0]!.source).toBe("c/d");
	});

	it("移除用户条目；builtin 条目不可移除", () => {
		addCustomEntry(custom, { source: "a/b", id: "temp" });
		expect(removeCustomEntry(custom, "temp")).toBe(true);
		expect(removeCustomEntry(custom, "temp")).toBe(false);
		// 内置条目（不在 custom 文件里）移除返回 false
		expect(removeCustomEntry(custom, "webmail")).toBe(false);
		const list = readCatalog(builtin, custom);
		expect(list.find((x) => x.id === "webmail")).toBeDefined();
	});

	it("非法来源抛错（本地路径 / 单段）", () => {
		expect(() => addCustomEntry(custom, { source: "/tmp/x" })).toThrow();
		expect(() => addCustomEntry(custom, { source: "justone" })).toThrow();
	});
});

describe("deriveCatalogId", () => {
	it("对齐 CLI 默认 id 规则：子路径末段 > 仓库名；#ref 剥离", () => {
		expect(deriveCatalogId(undefined, "a/b/sub/dir")).toBe("dir");
		expect(deriveCatalogId(undefined, "owner/repo")).toBe("repo");
		expect(deriveCatalogId(undefined, "owner/repo#v1.2")).toBe("repo");
		expect(deriveCatalogId(undefined, "owner/repo/sub#dev")).toBe("sub");
		expect(deriveCatalogId(undefined, "owner/repo/weird name")).toBe("weird-name");
		expect(deriveCatalogId("my-id", "owner/repo")).toBe("my-id");
	});
});
