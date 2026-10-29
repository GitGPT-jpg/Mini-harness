/**
 * 特权 DOM 访问授权表（`<dataDir>/plugin-dom.json`）。
 *
 * 背景：插件 client bundle 与主应用同源，JS 层面拦不住它碰 `document`——真正的门禁
 * 只能放在 bundle 下发处（`/plugins/:id/client/*`）。manifest.permissions 含 "dom"
 * 族的插件，其 bundle 默认 403；用户在设置面板逐个授权后才放行（并 epoch+1 让
 * 浏览器重拉）。授权是整机全局的（与 plugin-grants.json 同口径），任何浏览器看到
 * 的都是同一份。
 *
 * 语义：
 * - 读不出来 / JSON 坏 / 形状不对 → 当空表，且**不在读路径回写**（一次磁盘抖动不
 *   能静默清空用户授权；与 PluginGrantsStore 同一条纪律）。
 * - 只有真正发生变更的写才落盘（临时文件 + rename 原子写）；写失败 best-effort
 *   （内存态仍生效，本次会话可用）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

const FILE = "plugin-dom.json";

/** manifest.permissions 条目 → 是否请求特权 DOM（只看 `:` 前的族名，与宿主 can() 同口径）。
 *  例外：`dom:anchor` 只是客户端锚点挂载点的范围 DOM（免用户授权），不触发 bundle 403；
 *  完整 document 访问仍需 `dom`（或除 anchor 外的其它 dom 子族）+ 用户授权。 */
export function declarationWantsDom(permissions: unknown): boolean {
	if (!Array.isArray(permissions)) return false;
	return permissions.some((p) => {
		if (typeof p !== "string") return false;
		const [fam, sub] = p.split(":").map((s) => s.trim().toLowerCase());
		if (fam !== "dom") return false;
		return sub === undefined || sub === "" || sub !== "anchor";
	});
}

/** 静态门禁判定：纯函数，单测覆盖。未知插件（wantsDom=false）一律放行——向后兼容。 */
export function isDomBundleBlocked(wantsDom: boolean, granted: boolean): boolean {
	return wantsDom && !granted;
}

function readGranted(dataDir: string): Set<string> {
	try {
		const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as { granted?: unknown };
		const list = Array.isArray(raw?.granted) ? raw.granted : [];
		return new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0));
	} catch {
		return new Set();
	}
}

export class PluginDomConsent {
	private granted: Set<string>;

	constructor(private readonly dataDir: string) {
		this.granted = readGranted(dataDir);
	}

	has(pluginId: string): boolean {
		return this.granted.has(pluginId);
	}

	list(): string[] {
		return [...this.granted].sort();
	}

	/** 授权/撤销。返回是否真的发生了变更（没变就不落盘、不推快照）。 */
	set(pluginId: string, granted: boolean): boolean {
		const id = String(pluginId ?? "").trim();
		if (!id) return false;
		const had = this.granted.has(id);
		if (granted === had) return false;
		if (granted) this.granted.add(id);
		else this.granted.delete(id);
		try {
			writeJsonAtomicSync(join(this.dataDir, FILE), { v: 1, granted: this.list() });
		} catch {
			/* 写失败 best-effort：内存态仍生效，本次会话可用 */
		}
		return true;
	}
}
