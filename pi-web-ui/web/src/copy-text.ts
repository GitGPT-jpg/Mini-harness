/**
 * 整条消息的复制文本（issue #228）。
 * SDK 消息里的 text 块存的是原始 Markdown，这里提供两份导出：
 * 复制 Markdown（原文聚合）与复制纯文本（去标记，供粘贴到微信/飞书等非
 * Markdown 场景）。
 */

/** 消息里的全部文本块（保持原顺序）。 */
export function textBlocks(content: Array<{ type: string; text?: unknown }>): string[] {
	const out: string[] = [];
	for (const b of content) {
		if (b?.type === "text" && typeof b.text === "string" && b.text.length > 0) out.push(b.text);
	}
	return out;
}

/** 整条消息的原始 Markdown（文本块按空行拼接）。 */
export function messageMarkdown(content: Array<{ type: string; text?: unknown }>): string {
	return textBlocks(content).join("\n\n");
}

/** 整条消息的纯文本（Markdown 标记剥掉，代码内容保留）。 */
export function messagePlainText(content: Array<{ type: string; text?: unknown }>): string {
	return stripMarkdown(messageMarkdown(content));
}

/**
 * 轻量 Markdown → 纯文本（无依赖，零 DOM）：
 * 代码围栏/行内代码保留内容只去反引号；链接取文本；图片取 alt；
 * 标题/引用/列表/加粗斜体/删除线/表格线/HTML 标签只去标记。
 */
export function stripMarkdown(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (let line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		line = line
			// 标题前缀（# 至 ######）
			.replace(/^\s{0,3}#{1,6}\s+/, "")
			// 引用前缀（可多层）
			.replace(/^\s*(>\s*)+/, "")
			// 列表前缀（- * + / 1.）
			.replace(/^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+)/, "")
			// 任务列表勾选
			.replace(/^\s*\[[ xX]\]\s+/, "");
		// 表格对齐行（|---|---|）整行丢掉，不留空行
		if (/^\s*\|?\s*[:-]+\s*(\|\s*[:-]+\s*)*\|?\s*$/.test(line) && /[-:]/.test(line)) continue;
		out.push(line);
	}
	return (
		out
			.join("\n")
			// 图片 → alt（无 alt 则整段去掉）
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			// 链接 → 文本
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// 行内代码保留内容
			.replace(/`([^`]*)`/g, "$1")
			// 加粗/斜体/删除线（** __ * _ ~~，成对出现才去）
			.replace(/(\*\*|__)(.+?)\1/g, "$2")
			.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1$2")
			.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1$2")
			.replace(/~~(.+?)~~/g, "$1")
			// 表格竖线 → 空格（首尾线先去掉）
			.replace(/^\s*\|/gm, "")
			.replace(/\|\s*$/gm, "")
			.replace(/\|/g, " ")
			// HTML 标签
			.replace(/<[^>]+>/g, "")
			// 行尾残留的 #（ATX 闭合式标题）
			.replace(/\s+#+\s*$/gm, "")
			.split("\n")
			.map((l) => l.replace(/[ \t]+/g, " ").replace(/^\s+|\s+$/g, ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}
