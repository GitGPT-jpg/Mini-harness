/**
 * session-store.ts — 通用 Agent 会话的轻量级磁盘持久化。
 *
 * 会话存储在 <dataDir>/universal-sessions/<cwdHash>/<convId>.json 下。
 * 格式为纯 JSON，严格线性结构，便于直读、回放与恢复。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomicSync } from "../atomic-file.js";
import { normalizePathKey } from "../client-state.js";
import type { UniversalConversation } from "./universal-types.js";

export class UniversalSessionStore {
	private readonly baseDir: string;

	constructor(dataDir: string) {
		this.baseDir = join(dataDir, "universal-sessions");
		try {
			mkdirSync(this.baseDir, { recursive: true });
		} catch {
			/* best effort */
		}
	}

	private cwdDir(cwd: string): string {
		const normKey = normalizePathKey(cwd);
		const hash = createHash("sha256").update(normKey).digest("hex").slice(0, 16);
		const dir = join(this.baseDir, hash);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	private convPath(cwd: string, convId: string): string {
		const safeId = convId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.cwdDir(cwd), `${safeId}.json`);
	}

	listConversations(cwd: string): UniversalConversation[] {
		const dir = this.cwdDir(cwd);
		if (!existsSync(dir)) return [];
		const list: UniversalConversation[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const full = join(dir, file);
				const data = JSON.parse(readFileSync(full, "utf-8")) as UniversalConversation;
				if (data && data.id && Array.isArray(data.messages)) {
					list.push(data);
				}
			} catch {
				/* skip corrupted files */
			}
		}
		// 按更新时间降序排列
		return list.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	loadConversation(cwd: string, convId: string): UniversalConversation | null {
		const p = this.convPath(cwd, convId);
		if (!existsSync(p)) return null;
		try {
			return JSON.parse(readFileSync(p, "utf-8")) as UniversalConversation;
		} catch {
			return null;
		}
	}

	saveConversation(cwd: string, conv: UniversalConversation): void {
		const p = this.convPath(cwd, conv.id);
		writeJsonAtomicSync(p, conv);
	}

	deleteConversation(cwd: string, convId: string): void {
		const p = this.convPath(cwd, convId);
		if (existsSync(p)) {
			try {
				unlinkSync(p);
			} catch {
				/* best effort */
			}
		}
	}

	renameConversation(cwd: string, convId: string, title: string): void {
		const conv = this.loadConversation(cwd, convId);
		if (conv) {
			conv.title = title;
			conv.updatedAt = Date.now();
			this.saveConversation(cwd, conv);
		}
	}

	pinConversation(cwd: string, convId: string, pinned: boolean): void {
		const conv = this.loadConversation(cwd, convId);
		if (conv) {
			conv.pinned = pinned;
			conv.updatedAt = Date.now();
			this.saveConversation(cwd, conv);
		}
	}
}
