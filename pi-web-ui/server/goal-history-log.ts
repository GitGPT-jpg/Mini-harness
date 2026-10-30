/**
 * LLM loop（目标模式）的永久目录：<dataDir>/goal-history.jsonl。
 *
 * 设目标时追加一条 kind="created"；收尾时追加一条复用同 id 的 "finished:<kind>"。
 * 只有用户在任务台里删除才会消失（GoalStatus.history 是内存态 cap 20，重启即丢，
 * 两者互补）。写盘失败一律吞掉：目录是观测数据，不能影响目标循环本身。
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GoalLogRecord {
	id: string;
	at: string;
	convId: string | null;
	convTitle: string;
	goal: string;
	/** "created" | "finished:pass" | "finished:blocked" | "finished:exhausted" */
	kind: string;
	phase: string;
	round: number;
	verdict: string;
	status: string;
}

export type GoalLogEntry = Omit<GoalLogRecord, "id" | "at">;

const FILE = "goal-history.jsonl";

/** index.ts 解析出的 DATA_DIR（含 --data-dir 命令行参数）。未配置 = 不落盘
 *  （单测里直接 new GoalService 时不会写到用户真实的 ~/.pi-web）。 */
let configuredDataDir: string | null = null;

export function configureGoalLog(dataDir: string | null): void {
	configuredDataDir = dataDir;
}

function logFile(dataDir?: string): string | null {
	const dir = dataDir ?? configuredDataDir;
	return dir ? join(dir, FILE) : null;
}

function readRecords(file: string | null): GoalLogRecord[] {
	if (!file) return [];
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: GoalLogRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as GoalLogRecord);
		} catch {
			// 半行（崩溃时写了一半）跳过即可
		}
	}
	return out;
}

/** 追加一条目录记录；finished 记录复用同一目标 created 记录的 id（目录里一个目标只占一行）。 */
export function recordGoalEvent(entry: GoalLogEntry, dataDir?: string): void {
	try {
		const file = logFile(dataDir);
		if (!file) return;
		mkdirSync(dirname(file), { recursive: true });
		let id = `${Date.now()}-${randomBytes(3).toString("hex")}`;
		if (entry.kind.startsWith("finished")) {
			const created = readRecords(file)
				.reverse()
				.find((r) => r.kind === "created" && r.convId === entry.convId && r.goal === entry.goal);
			if (created?.id) id = created.id;
		}
		const rec: GoalLogRecord = { id, at: new Date().toISOString(), ...entry };
		appendFileSync(file, JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
	} catch {
		// 观测数据，写失败不影响目标循环
	}
}

/** 目录视图：同 id 只留最新一条（结束记录覆盖创建记录），新的在前。 */
export function listGoalLog(limit = 300, dataDir?: string): GoalLogRecord[] {
	const seen = new Set<string>();
	const out: GoalLogRecord[] = [];
	for (const r of readRecords(logFile(dataDir)).reverse()) {
		if (!r?.id || seen.has(r.id)) continue;
		seen.add(r.id);
		out.push(r);
		if (out.length >= limit) break;
	}
	return out;
}

/** 删除某个目标的全部记录，返回删掉的行数。 */
export function deleteGoalLog(id: string, dataDir?: string): number {
	const file = logFile(dataDir);
	if (!file) return 0;
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return 0;
	}
	const lines = raw.split("\n").filter((l) => l.trim());
	const kept = lines.filter((l) => {
		try {
			return (JSON.parse(l) as GoalLogRecord).id !== id;
		} catch {
			return true;
		}
	});
	if (kept.length !== lines.length) {
		writeFileSync(file, kept.join("\n") + (kept.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
	}
	return lines.length - kept.length;
}
