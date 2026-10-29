/**
 * 全局 prompt 历史（供输入框 Up/Down 循环使用）。
 *
 * - 全局：所有对话共享同一份 localStorage 队列（issue #68 要求 not tied to session）。
 * - 持久化：localStorage key `pi-web-ui:prompt-history`，JSON 数组。
 * - 去重：连续重复的提交不重复入队。
 * - 上限：最多保留 100 条（超出按 FIFO 截断）。
 * - 纯函数核心（normalizeHistory / appendHistory）可单测；存储层薄封装并做
 *   异常兜底（隐私模式 / 配额满时忽略，不抛错）。
 */

const PROMPT_HISTORY_KEY = "pi-web-ui:prompt-history";
export const PROMPT_HISTORY_MAX = 100;
const PROMPT_HISTORY_SETTINGS_KEY = "pi-web-ui:prompt-history-settings";

interface PromptHistorySettings {
	/** 最大保留条数（1–500） */
	maxEntries: number;
	/** 是否限制单条字数 */
	charLimitEnabled: boolean;
	/** 单条最大字数（启用时生效） */
	charLimit: number;
}

const DEFAULT_PROMPT_HISTORY_SETTINGS: PromptHistorySettings = {
	maxEntries: 100,
	charLimitEnabled: false,
	charLimit: 2000,
};

/** 规整设置值，超出范围回退默认值。 */
export function normalizePromptHistorySettings(raw: unknown): PromptHistorySettings {
	const def = DEFAULT_PROMPT_HISTORY_SETTINGS;
	if (!raw || typeof raw !== "object") return { ...def };
	const o = raw as Record<string, unknown>;
	let maxEntries = typeof o.maxEntries === "number" ? Math.floor(o.maxEntries) : def.maxEntries;
	if (!Number.isFinite(maxEntries) || maxEntries < 1) maxEntries = 1;
	if (maxEntries > 500) maxEntries = 500;
	let charLimit = typeof o.charLimit === "number" ? Math.floor(o.charLimit) : def.charLimit;
	if (!Number.isFinite(charLimit) || charLimit < 100) charLimit = 100;
	if (charLimit > 20000) charLimit = 20000;
	const charLimitEnabled = typeof o.charLimitEnabled === "boolean" ? o.charLimitEnabled : def.charLimitEnabled;
	return { maxEntries, charLimitEnabled, charLimit };
}

export function loadPromptHistorySettings(): PromptHistorySettings {
	try {
		const raw = localStorage.getItem(PROMPT_HISTORY_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_PROMPT_HISTORY_SETTINGS };
		return normalizePromptHistorySettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_PROMPT_HISTORY_SETTINGS };
	}
}

export function savePromptHistorySettings(s: PromptHistorySettings): void {
	const norm = normalizePromptHistorySettings(s);
	try {
		localStorage.setItem(PROMPT_HISTORY_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	// 同步裁剪已有历史以符合新设置（条数 / 字数限制）
	try {
		let history = loadPromptHistory();
		if (norm.charLimitEnabled) {
			history = history.map((v) => (v.length > norm.charLimit ? v.slice(0, norm.charLimit) : v));
		}
		if (history.length > norm.maxEntries) history = history.slice(history.length - norm.maxEntries);
		persist(history);
	} catch {
		/* ignore */
	}
}

/** 规整持久化的历史数组：非数组 / 非字符串 / 空白项一律丢弃；保留 trim 后的完整文本（不截断）。 */
export function normalizeHistory(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string") continue;
		const t = v.trim();
		if (!t) continue;
		out.push(t);
	}
	return out;
}

/** 纯函数：把一条 prompt 追加入队（去重连续相同 + 截断上限），返回新数组，不改入参。 */
export function appendHistory(history: string[], text: string, max: number = PROMPT_HISTORY_MAX): string[] {
	const t = text.trim();
	if (!t) return history;
	if (history.length > 0 && history[history.length - 1] === t) return history;
	const next = [...history, t];
	if (next.length > max) return next.slice(next.length - max);
	return next;
}

/** 读取持久化的全局 prompt 历史（localStorage 不可用或数据损坏时回退空数组）。 */
export function loadPromptHistory(): string[] {
	try {
		const raw = localStorage.getItem(PROMPT_HISTORY_KEY);
		if (!raw) return [];
		return normalizeHistory(JSON.parse(raw));
	} catch {
		return [];
	}
}

function persist(history: string[]): void {
	// 配额满时逐半丢弃最旧条目重试，避免直接丢掉整份历史。
	let cur: string[] | null = history;
	while (cur) {
		try {
			localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(cur));
			return;
		} catch (e) {
			const quota = e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22);
			if (!quota || cur.length <= 1) {
				// 非配额错误或已无法再缩（隐私模式 / 完全不可写）——忽略。
				return;
			}
			// 丢弃最旧的一半后重试
			cur = cur.slice(Math.ceil(cur.length / 2));
		}
	}
}

/** 追加一条提交过的 prompt 到全局历史并持久化（尊重设置里的条数/字数限制）。 */
export function pushPromptHistory(text: string): void {
	let t = text.trim();
	if (!t) return;
	const settings = loadPromptHistorySettings();
	if (settings.charLimitEnabled && t.length > settings.charLimit) t = t.slice(0, settings.charLimit);
	const cur = loadPromptHistory();
	const next = appendHistory(cur, t, settings.maxEntries);
	if (next === cur) return;
	persist(next);
}

/** 清空全局 prompt 历史（主要供测试/设置入口使用）。 */
export function clearPromptHistory(): void {
	try {
		localStorage.removeItem(PROMPT_HISTORY_KEY);
	} catch {
		/* ignore */
	}
}
