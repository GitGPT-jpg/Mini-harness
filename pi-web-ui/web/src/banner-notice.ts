import { useSyncExternalStore } from "react";

export type BannerType = "info" | "warning" | "success" | "error" | "question";

export interface BannerNotice {
	/** 唯一标识符。如果不提供则自动生成。 */
	id: string;
	/** 类型，决定图标与强调色（默认 info）。 */
	type?: BannerType;
	/** 标题（例如对话名字、操作通知等）。可选。 */
	title?: string;
	/** 正文内容（例如问卷题目、说明文本）。必填。 */
	message: string;
	/**
	 * 是否常驻：
	 * - true: 常驻，直到用户主动关闭或程序显式移除；
	 * - false: 短暂，显示 timeoutMs 毫秒后自动淡出消失（默认 5000ms）。
	 */
	persistent?: boolean;
	/** 短暂横幅的存活时间（毫秒，默认 5000）。 */
	timeoutMs?: number;
	/** 是否显示右上角关闭按钮（默认 true）。 */
	dismissible?: boolean;
	/** 点击横幅主体的回调（可选，例如切换会话）。 */
	onClick?: () => void;
	/** 关联的业务分类或数据，例如 { conversationId: "c2", questionId: "q-1" }。 */
	data?: Record<string, unknown>;
	/** 关闭时的回调。 */
	onClose?: () => void;
}

type BannerInput = Omit<BannerNotice, "id"> & { id?: string };

// 内部状态
let bannerSeq = 0;
let banners: readonly BannerNotice[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* listener errors should not break state notification */
		}
	}
}

function clearTimer(id: string): void {
	const timer = timers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		timers.delete(id);
	}
}

/**
 * 弹出或更新一个横幅通知。
 * - 若已存在同 id 的横幅，则就地更新内容；
 * - 若不是常驻（persistent !== true），则启动定时器在 timeoutMs（默认 5000ms）后自动关闭；
 * - 返回该横幅的唯一 id。
 */
export function showBanner(input: BannerInput): string {
	const id = input.id || `banner-${Date.now()}-${++bannerSeq}`;
	const banner: BannerNotice = {
		...input,
		id,
		type: input.type || "info",
		persistent: !!input.persistent,
		timeoutMs: input.timeoutMs ?? 5000,
		dismissible: input.dismissible !== false,
	};

	// 清理旧定时器（若有）
	clearTimer(id);

	// 如果是非常驻，则安排定时移除
	if (!banner.persistent && banner.timeoutMs && banner.timeoutMs > 0) {
		const timer = setTimeout(() => {
			dismissBanner(id);
		}, banner.timeoutMs);
		timers.set(id, timer);
	}

	const existingIndex = banners.findIndex((b) => b.id === id);
	if (existingIndex >= 0) {
		const next = [...banners];
		next[existingIndex] = banner;
		banners = next;
	} else {
		banners = [...banners, banner];
	}

	notifyListeners();
	return id;
}

interface DismissBannerOptions {
	/** 为 true 时静默关闭，不触发 onClose 回调（例如会话切换时由 UI 生命周期收起横幅）。 */
	silent?: boolean;
}

/**
 * 关闭并移除指定的横幅通知。
 * 会清除关联的定时器，并在非 silent 模式下触发该横幅的 onClose 回调。
 */
export function dismissBanner(id: string, opts?: DismissBannerOptions): void {
	clearTimer(id);
	const target = banners.find((b) => b.id === id);
	if (!target) return;

	banners = banners.filter((b) => b.id !== id);
	if (!opts?.silent) {
		try {
			target.onClose?.();
		} catch {
			/* ignore onClose errors */
		}
	}
	notifyListeners();
}

/**
 * 批量关闭满足条件的横幅通知。
 */
export function dismissBannersWhere(predicate: (b: BannerNotice) => boolean, opts?: DismissBannerOptions): void {
	const toDismiss = banners.filter(predicate);
	if (toDismiss.length === 0) return;

	for (const b of toDismiss) {
		clearTimer(b.id);
		if (!opts?.silent) {
			try {
				b.onClose?.();
			} catch {
				/* ignore onClose errors */
			}
		}
	}

	banners = banners.filter((b) => !predicate(b));
	notifyListeners();
}

/**
 * 清除所有横幅通知。
 */
export function clearAllBanners(): void {
	for (const timer of timers.values()) {
		clearTimeout(timer);
	}
	timers.clear();

	const oldBanners = banners;
	banners = [];
	for (const b of oldBanners) {
		try {
			b.onClose?.();
		} catch {
			/* ignore onClose errors */
		}
	}
	notifyListeners();
}

/**
 * 获取当前所有横幅通知。
 */
export function getBanners(): readonly BannerNotice[] {
	return banners;
}

/**
 * 订阅横幅列表变更。
 */
export function subscribeBanners(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * React Hook：订阅并获取当前的横幅通知列表。
 */
export function useBanners(): readonly BannerNotice[] {
	return useSyncExternalStore(subscribeBanners, getBanners, getBanners);
}
