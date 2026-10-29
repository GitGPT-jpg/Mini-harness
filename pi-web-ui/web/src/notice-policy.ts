/**
 * 通知降噪与队列策略（纯函数，单源供 use-chat.ts / App.tsx / 单测复用）：
 *
 * 1. 分级停留时长：info 2.4s / warning 4.2s / error 6.5s（原为 7s / 12s）；
 * 2. 静默过滤（shouldSuppressNotice）：遵循「有原位 UI 反馈或纯后台常规维护不弹 Toast」原则，
 *    仅在前端展示层静默冗余 info，WebSocket 协议帧保持原样以 100% 兼容服务端冒烟测试；
 * 3. 同文去重与同屏限流（enqueueNotice）：相同文案就地刷新计时不堆叠，同屏最多保留 2 条，
 *    超限时优先淘汰旧的普通提示以保护 error 不被冲掉。
 */

export interface NoticeLike {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
	textEn?: string;
}

export const MAX_VISIBLE_NOTICES = 2;

export function getNoticeDurationMs(level: NoticeLike["level"]): number {
	switch (level) {
		case "error":
			return 6500;
		case "warning":
			return 4200;
		case "info":
		default:
			return 2400;
	}
}

/**
 * 已有明确原位 UI 变化（文件树刷新、标题栏改名、顶部流光条、输入区模式药丸）
 * 或纯后台自动维护的普通 info 提示，不再重复弹出顶部 Toast 打断用户。
 * warning / error 永不静默。
 */
const SUPPRESSED_INFO_PATTERNS: readonly RegExp[] = [
	// 工作区切换（已有顶部流式进度条 + 左栏/底栏原位状态）
	/^(已在工作目录|正在切换到工作目录|已切换到工作目录)[：:]/,
	/^(Already in directory|Switching to directory|Switched to directory):/i,
	/该项目最近的对话.*(为你停在了空白新对话|为你停在了新对话)/,
	/The most recent conversation .* landed on a (blank|new) chat/i,

	// 后台自动维护与开机巡检（底栏 token 数值 / 顶栏红点已原位体现）
	/^分层上下文预算裁剪生效/,
	/^Tiered context budget pruning/i,
	/^发现 \d+ 个内置插件有更新可用/,
	/^\d+ built-in plugin\(s\) have updates available/i,

	// 文件树原位增删改移（右侧文件树已实时刷新；保留「已上传」回执）
	/^已(创建文件|创建文件夹|重命名|删除|移动|复制)[：:]/,
	/^(Created file|Created folder|Renamed|Deleted|Moved|Copied):/i,

	// 会话原位重命名与后台投递保留
	/^已重命名当前会话为/,
	/^Renamed current session to/i,
	/的消息正在投递，已为你保留该对话$/,
	/is still sending your message — kept in the running list$/i,

	// 模式/预设原位切换（输入区药丸、计划看板、预设选择器已有即时视觉反馈）
	/^(计划模式已开启|计划模式已关闭|已进入计划模式|已退出计划模式|审查者模式已开启|审查者模式已关闭)/,
	/^(Plan mode (enabled|disabled)|Entered plan mode|Exited plan mode|Delegate mode (enabled|disabled))/i,
	/^已切换(智能体预设|权限预设)/,
	/^Switched (agent|permission) preset/i,
];

export function shouldSuppressNotice(notice: Pick<NoticeLike, "level" | "text" | "textEn">): boolean {
	if (notice.level !== "info") return false;
	const zh = (notice.text ?? "").trim();
	const en = (notice.textEn ?? "").trim();
	return SUPPRESSED_INFO_PATTERNS.some((re) => (zh && re.test(zh)) || (en && re.test(en)));
}

export function enqueueNotice<T extends NoticeLike>(
	current: readonly T[],
	incoming: T,
	maxVisible: number = MAX_VISIBLE_NOTICES,
): T[] {
	if (shouldSuppressNotice(incoming)) {
		return current as T[];
	}
	const incomingKey = `${incoming.level}:${(incoming.text ?? "").trim()}`;
	const deduped = current.filter((n) => `${n.level}:${(n.text ?? "").trim()}` !== incomingKey);
	const next = [...deduped, incoming];
	while (next.length > maxVisible) {
		// 优先淘汰最早的非 error 提示，避免连续普通提示把还未读完的报错顶掉
		const nonErrorIdx = next.findIndex((n) => n.level !== "error");
		if (nonErrorIdx >= 0) {
			next.splice(nonErrorIdx, 1);
		} else {
			next.shift();
		}
	}
	return next;
}
