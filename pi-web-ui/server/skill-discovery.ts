/**
 * skill-discovery.ts — 跨引擎技能（Skill）磁盘发现与内容加载。
 *
 * 规范参考：docs/skills.md
 * 支持路径：
 *   - 全局 Pi 技能：~/.pi/agent/skills/ 或 agentDir/skills/
 *   - 项目 Pi 技能：<cwd>/.pi/skills/
 *   - Claude Code 技能：~/.claude/skills/ 与 <cwd>/.claude/skills/
 *
 * 技能结构：
 *   1. 目录形式（标准）：<skill-name>/SKILL.md
 *   2. 独立文件形式：<skill-name>.md
 *
 * SKILL.md 规范包含 YAML frontmatter：
 *   ---
 *   name: skill-name
 *   description: 技能说明
 *   ---
 *   正文指令...
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { decodeText } from "./text-sniff.js";

export interface DiscoveredSkill {
	name: string;
	description: string;
	descriptionEn?: string;
	filePath: string;
	dirPath: string;
}

/** 解析 SKILL.md 的 YAML frontmatter 提取 name 与 description */
export function parseSkillFrontmatter(content: string, fallbackName: string): { name: string; description: string } {
	const trimmed = content.trim();
	let name = fallbackName;
	let description = "";

	if (trimmed.startsWith("---")) {
		const secondDash = trimmed.indexOf("\n---", 3);
		if (secondDash !== -1) {
			const header = trimmed.slice(3, secondDash);
			for (const line of header.split("\n")) {
				const colon = line.indexOf(":");
				if (colon <= 0) continue;
				const key = line.slice(0, colon).trim().toLowerCase();
				let val = line.slice(colon + 1).trim();
				if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
					val = val.slice(1, -1);
				}
				if (key === "name" && val) {
					name = val;
				} else if (key === "description" && val) {
					description = val;
				}
			}
			// 若 frontmatter 缺 description，取正文第一行段落
			if (!description) {
				const rest = trimmed.slice(secondDash + 4).trim();
				const firstLine = rest.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
				if (firstLine) description = firstLine.trim();
			}
		}
	}

	if (!description) {
		const firstHeader = trimmed.split("\n").find((l) => l.trim().startsWith("#"));
		if (firstHeader) {
			description = firstHeader.replace(/^#+\s*/, "").trim();
		} else {
			description = `Skill ${name}`;
		}
	}

	return { name, description };
}

/**
 * 递归/顺序扫描各候选目录发现技能。
 */
export function discoverDiskSkills(opts: { cwd: string; agentDir?: string; includeHome?: boolean }): DiscoveredSkill[] {
	const results: DiscoveredSkill[] = [];
	const seen = new Set<string>();

	const searchDirs: string[] = [];
	const home = homedir();

	// 1. 项目本地技能优先（.pi/skills, .claude/skills）
	if (opts.cwd) {
		searchDirs.push(join(opts.cwd, ".pi", "skills"));
		searchDirs.push(join(opts.cwd, ".claude", "skills"));
	}

	// 2. 全局技能目录（agentDir/skills, ~/.pi/agent/skills, ~/.claude/skills）
	if (opts.agentDir) {
		searchDirs.push(join(opts.agentDir, "skills"));
	}
	if (opts.includeHome !== false) {
		searchDirs.push(join(home, ".pi", "agent", "skills"));
		searchDirs.push(join(home, ".claude", "skills"));
	}

	for (const baseDir of searchDirs) {
		if (!existsSync(baseDir)) continue;
		try {
			const entries = readdirSync(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;

				if (entry.isDirectory()) {
					// 目录型：<baseDir>/<entry>/SKILL.md
					const skillMd = join(baseDir, entry.name, "SKILL.md");
					if (existsSync(skillMd)) {
						try {
							const text = decodeText(readFileSync(skillMd));
							const { name, description } = parseSkillFrontmatter(text, entry.name);
							if (!seen.has(name)) {
								seen.add(name);
								results.push({
									name,
									description,
									filePath: skillMd,
									dirPath: join(baseDir, entry.name),
								});
							}
						} catch {
							/* 忽略单文件损坏 */
						}
					}
				} else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
					// 单文件型：<baseDir>/<name>.md
					const filePath = join(baseDir, entry.name);
					const base = basename(entry.name, ".md");
					try {
						const text = decodeText(readFileSync(filePath));
						const { name, description } = parseSkillFrontmatter(text, base);
						if (!seen.has(name)) {
							seen.add(name);
							results.push({
								name,
								description,
								filePath,
								dirPath: baseDir,
							});
						}
					} catch {
						/* 忽略单文件损坏 */
					}
				}
			}
		} catch {
			/* 目录读取权限异常静默跳过 */
		}
	}

	return results;
}

/** 读取技能完整指令正文（若含 frontmatter，保留或剥离后返回有效指令） */
export function readSkillInstruction(filePath: string): string {
	if (!existsSync(filePath)) return "";
	try {
		const raw = decodeText(readFileSync(filePath)).trim();
		return raw;
	} catch {
		return "";
	}
}
