/**
 * universal-attachments.ts — 通用底座附件构建、@ 提及扫描与技能提示注入。
 *
 * 职责：
 *   1. 扫描用户提问中的 `@path`（文件引用）与 `@skill:name`（技能引用）；
 *   2. 生成符合 Web UI 标准的 custom "file" 卡片（UiMessage），供渲染折叠文件卡片、
 *      图片预览并支持编辑重问（question-attachments.ts）；
 *   3. 格式化最终投递给各底层驱动（Claude Code、DSH 等）的 Prompt 上下文与附件列表。
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { PromptAttachment, UiMessage } from "../protocol.js";
import { readSkillInstruction, type DiscoveredSkill } from "../skill-discovery.js";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";

export interface ScanResult {
	detectedAttachments: PromptAttachment[];
	detectedSkills: DiscoveredSkill[];
}

/**
 * 扫描用户提问文本中的 `@` 词元：
 *   - `@skill:foo` 或匹配已知技能名的 `@foo`
 *   - `@path/to/file` 在当前工作区存在的相对路径
 */
export function scanAtMentions(
	text: string,
	cwd: string,
	availableSkills: readonly DiscoveredSkill[] = [],
	existingAttachments: readonly PromptAttachment[] = [],
): ScanResult {
	const detectedAttachments: PromptAttachment[] = [];
	const detectedSkills: DiscoveredSkill[] = [];
	const existingPaths = new Set(existingAttachments.map((a) => a.path).filter(Boolean));

	// 1. 扫描 @skill:xxx 引用
	const skillRegex = /@skill:([A-Za-z0-9_-]+)/g;
	let sm: RegExpExecArray | null;
	const matchedSkillNames = new Set<string>();
	while ((sm = skillRegex.exec(text)) !== null) {
		matchedSkillNames.add(sm[1].toLowerCase());
	}

	for (const sk of availableSkills) {
		const bareName = sk.name.startsWith("skill:") ? sk.name.slice(6) : sk.name;
		if (matchedSkillNames.has(bareName.toLowerCase()) || matchedSkillNames.has(sk.name.toLowerCase())) {
			detectedSkills.push(sk);
		}
	}

	// 远程 SSH 项目的工作区不在本地文件系统中，跳过本地相对路径与 existsSync 检查
	if (isRemoteWorkspaceUri(cwd)) {
		return { detectedAttachments, detectedSkills };
	}

	// 2. 扫描 @path/to/file 引用（避开邮箱格式，例如 a@b.com）
	const pathRegex = /(?:^|\s)@([^\s@:"'<>|?*]+)/g;
	let pm: RegExpExecArray | null;
	const root = resolve(cwd);

	while ((pm = pathRegex.exec(text)) !== null) {
		const rawCandidate = pm[1].trim();
		if (!rawCandidate || rawCandidate.startsWith("skill:")) continue;

		// 规范化相对路径
		const candidate = rawCandidate.replace(/^[/\\]+/, "");
		const absPath = isAbsolute(rawCandidate) ? rawCandidate : resolve(root, candidate);

		// 防止跳出项目根目录或不存在的文件
		if (existsSync(absPath)) {
			try {
				const rel = relative(root, absPath).replace(/\\/g, "/");
				if (!existingPaths.has(rel) && !existingPaths.has(rawCandidate)) {
					existingPaths.add(rel);
					detectedAttachments.push({
						path: rel,
						name: basename(absPath),
						mode: "reference",
					});
				}
			} catch {
				/* ignore fs error */
			}
		}
	}

	return { detectedAttachments, detectedSkills };
}

/**
 * 将用户携带的附件列表转为 UiMessage 卡片消息（以便持久化及前端渲染与复原）。
 */
export function createAttachmentUiMessages(attachments: PromptAttachment[], timestamp = Date.now()): UiMessage[] {
	const out: UiMessage[] = [];

	for (const att of attachments) {
		const cardId = `u-att-${timestamp}-${randomUUID().slice(0, 6)}`;

		// 1. 图片附件
		if (att.imageData) {
			const dataUrl = att.imageData.startsWith("data:")
				? att.imageData
				: `data:${att.mimeType || "image/png"};base64,${att.imageData}`;
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "image", dataUrl }],
				details: {
					name: att.name || "image.png",
					mode: "reference",
				},
			});
			continue;
		}

		// 2. 引述文本
		if (att.mode === "quote" && att.quote) {
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text: att.quote.text }],
				details: {
					mode: "quote",
					quote: att.quote,
				},
			});
			continue;
		}

		// 3. 授权网页
		if (att.mode === "page") {
			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text: `<browser-page url="${att.path}" title="${att.name || att.path}" />` }],
				details: {
					name: att.name || att.path,
					path: att.path,
					mode: "page",
				},
			});
			continue;
		}

		// 4. 工作区文件/目录/行范围
		if (att.path) {
			const isLines = att.mode === "lines" && att.lines;
			let isDir = false;
			try {
				if (existsSync(att.path)) {
					isDir = statSync(att.path).isDirectory();
				}
			} catch {
				/* ignore */
			}
			const text = isLines
				? `<file path="${att.path}" lines="${att.lines!.start}-${att.lines!.end}" />`
				: isDir
					? `<folder path="${att.path}" />`
					: `<file path="${att.path}" />`;

			out.push({
				id: cardId,
				role: "custom",
				customType: "file",
				timestamp,
				content: [{ type: "text", text }],
				details: {
					name: att.name || basename(att.path),
					path: att.path,
					mode: isLines ? "lines" : "reference",
					isDir,
					...(isLines ? { startLine: att.lines!.start, endLine: att.lines!.end } : {}),
				},
			});
		}
	}

	return out;
}

/**
 * 组装最终送入底座驱动的 Prompt 上下文与综合附件。
 */
export function formatPromptWithSkills(rawPrompt: string, skills: readonly DiscoveredSkill[]): string {
	if (!skills || skills.length === 0) return rawPrompt;

	const skillSnippets: string[] = [];
	for (const sk of skills) {
		const body = readSkillInstruction(sk.filePath);
		if (body) {
			const title = sk.name.startsWith("skill:") ? sk.name.slice(6) : sk.name;
			skillSnippets.push(`[Skill: ${title}]\n${body}`);
		}
	}

	if (skillSnippets.length === 0) return rawPrompt;

	return `${skillSnippets.join("\n\n")}\n\n[User Prompt]\n${rawPrompt}`;
}
