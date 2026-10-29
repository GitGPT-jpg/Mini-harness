/**
 * 退格键原子化整块删除 @提及 并联动摘掉对应附件 chip 的纯函数逻辑。
 *
 * 两段式：
 * ① chip 精确匹配 —— 优先按精确相对路径（@path）、页面标题（@name）及短名匹配；
 *    覆盖带空格路径、带中文文件名等通用正则无法识别的名字；
 *    多个候选时以尾部最长匹配优先，彻底杜绝同名条目（如 报告 vs 方案/报告）错位误删。
 * ② 通用有边界 @词元 —— 覆盖手打的 @引用；查找待联动附件时遵循
 *    「精确 path > 精确 name > 短名 fallback」顺序。
 */

interface BackspaceAttachmentLike {
	path?: string;
	name?: string;
	mode?: string;
	key?: string;
	conversationId?: string;
	sessionPath?: string;
}

interface BackspaceMentionResult<T extends BackspaceAttachmentLike = BackspaceAttachmentLike> {
	tokenStart: number;
	attachment?: T;
}

export function resolveBackspaceMention<T extends BackspaceAttachmentLike>(
	before: string,
	pos: number,
	attachments: readonly T[],
): BackspaceMentionResult<T> | null {
	if (pos <= 0 || !before) return null;

	// ① chip 精确匹配：收集所有附件可能的提及形式
	let bestHit: { attachment: T; tokenLen: number; withSpace: boolean } | null = null;

	for (const a of attachments) {
		const isPageOrConv = a.mode === "page" || a.mode === "conversation";
		const primary = isPageOrConv ? a.name : a.path;
		const fallback = a.name;

		const candidates = [primary, fallback].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

		for (const cand of candidates) {
			const tok = "@" + cand;
			const withSpace = before.endsWith(tok + " ");
			if (withSpace || before.endsWith(tok)) {
				const tokenLen = tok.length;
				if (!bestHit || tokenLen > bestHit.tokenLen) {
					bestHit = { attachment: a, tokenLen, withSpace };
				}
			}
		}
	}

	let tokenStart = -1;
	let hitAttachment = bestHit?.attachment;

	if (bestHit) {
		const cand = pos - (bestHit.withSpace ? bestHit.tokenLen + 1 : bestHit.tokenLen);
		// token 紧贴词类字符（如 path 中段 /@file）→ 不整块删，落回普通退格
		if (cand > 0 && /[\w.\-/]/.test(before[cand - 1])) {
			tokenStart = -1;
			hitAttachment = undefined;
		} else {
			tokenStart = cand;
		}
	}

	// ② 通用有边界 @词元（手打引用或未精确匹配到 chip 的情况）
	if (tokenStart < 0) {
		const gm = /(^|[\s(（"'"“‘[【])(@[^\s@,.;:!?，。！？)\]】」]+)(\s?)$/.exec(before);
		if (gm) {
			tokenStart = pos - gm[2].length - gm[3].length;
			const rawToken = before.slice(tokenStart, pos).trim().replace(/^@/, "");
			const baseName = rawToken.split("/").pop() ?? rawToken;

			// 查找对应附件：精确路径 > 精确名称 > 短名 fallback
			hitAttachment =
				attachments.find((a) => a.path && a.path === rawToken) ??
				attachments.find((a) => a.name && a.name === rawToken) ??
				attachments.find((a) => a.mode !== "page" && a.mode !== "conversation" && a.name === baseName);
		}
	}

	if (tokenStart >= 0 && tokenStart < pos) {
		return { tokenStart, ...(hitAttachment ? { attachment: hitAttachment } : {}) };
	}

	return null;
}
