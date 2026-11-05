/**
 * 任务存储：DSH storage domain 的文件直存等价物。
 *
 * 任务记录落 <dataDir>/tasks/<id>.json（per-record 布局），证据落 <dataDir>/runs/<id>/。
 * 与 DSH 版语义一致：宿主（这里是 Comate 会话）重启后状态可恢复，靠磁盘而不是内存。
 */
import fs from "node:fs";
import path from "node:path";

export class TaskStore {
	constructor(dir) {
		this.dir = dir;
		fs.mkdirSync(dir, { recursive: true });
	}

	file(id) {
		return path.join(this.dir, `${id}.json`);
	}

	get(id) {
		try {
			return JSON.parse(fs.readFileSync(this.file(id), "utf8"));
		} catch {
			return undefined;
		}
	}

	list() {
		const out = [];
		if (!fs.existsSync(this.dir)) return out;
		for (const name of fs.readdirSync(this.dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				out.push(JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")));
			} catch {
				// 跳过坏记录，不让单条脏数据挡住列表
			}
		}
		return out;
	}

	async put(record) {
		fs.writeFileSync(this.file(record.id), JSON.stringify(record, null, 2) + "\n");
	}

	async remove(id) {
		fs.rmSync(this.file(id), { force: true });
	}
}

/** 证据目录（round-N.stdout.txt / round-N.stderr.txt / round-N.meta.json）。 */
export function evidenceDirOf(dataDir, taskId) {
	return path.join(dataDir, "runs", taskId);
}
