/**
 * skill-content-filler — 技能全文注入（{{skills}} 全文模式）内容填充器。
 *
 * 负责读取名单里技能的文件正文。
 * 单文件 8KB、总量 32KB 封顶，失败/超限/不在名单回落名录（无 content）。
 * 名单为空时零开销：原样返回，不碰磁盘。
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { readFileSync, statSync } from "node:fs";
import { decodeText } from "./text-sniff.js";
import { normalizeSkillList } from "./client-state.js";

export function fillSkillContents(
	skills: { name: string; description: string; filePath: string }[],
	skillsFullTextConfig: string[] | undefined,
): { name: string; description: string; filePath: string; content?: string }[] {
	const wanted = new Set(normalizeSkillList(skillsFullTextConfig));
	if (wanted.size === 0) return skills;
	let budget = 32 * 1024;
	return skills.map((s) => {
		if (!wanted.has(s.name) || !s.filePath || budget <= 0) return s;
		try {
			const st = statSync(s.filePath);
			if (!st.isFile() || st.size <= 0 || st.size > 8192) return s;
			const raw = decodeText(readFileSync(s.filePath).subarray(0, Math.min(st.size, budget))).trim();
			budget -= raw.length;
			return raw ? { ...s, content: raw } : s;
		} catch {
			return s;
		}
	});
}
