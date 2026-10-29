/// <reference lib="dom" />
import { getMessage } from "./i18n.js";
/**
 * 「这一页能不能让 AI 操作」的状态查询契约 + 浮条文案（纯逻辑，可单测）。
 *
 * 为什么需要它：AI 授权的两个入口原来**只挂在拾取确认条上** —— 也就是必须先点一个元素才能
 * 看见「让 AI 操作本页…」。现在拾取态底部就常驻一条细条，于是它得知道「本页授权了没」：
 * 已授权就别再催着去设置页，总开关关着也得当场说清（否则用户点了按钮、模型还是不动，
 * 只会怀疑整个功能坏了）。
 *
 * 纪律：**不装**。查询没回来（undefined）与查询失败（null）是两种状态，前者说「正在查」、
 * 后者说「查不到」，绝不糊成一句「未授权」—— 那会把「worker 挂了」误导成「你得去授权」。
 */

/** background 回给内容脚本的本页授权状态。 */
export interface PageState {
	/** 本页归一后的 origin；拿不到就是空串（不是 http/https 页面）。 */
	origin: string;
	/** 本页在「AI 操作页面」授权表里吗。 */
	authorized: boolean;
	/** 授权表里记的标题（有就用它）。 */
	title?: string;
	/** 「允许 AI 操作页面」总开关 —— 关着时即使授权了也调不动。 */
	aiControl: boolean;
}

/** 底部细条上那块状态 + 主按钮文案（UI 只负责画）。 */
export interface GrantView {
	/** 状态行短文案（细条很短，别写长句）。 */
	status: string;
	/** 状态颜色档。 */
	kind: "ok" | "warn" | "err" | "info";
	/** 主按钮文案。 */
	label: string;
	/** 已经办妥了（授权成功）：按钮不再是「催你去点」的样子。 */
	done: boolean;
	/** 长解释（挂 title/aria 上，鼠标停一下能看到前因后果）。 */
	hint: string;
}

export function grantView(state: PageState | null | undefined): GrantView {
	if (state === undefined) {
		return {
			status: getMessage("grant_checking_status", undefined, "检查授权状态…"),
			kind: "info",
			label: getMessage("grant_checking_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage("grant_checking_hint", undefined, "正在问扩展后台：本页有没有被授权给模型操作"),
		};
	}
	if (state === null) {
		return {
			status: getMessage("grant_null_status", undefined, "查不到授权状态"),
			kind: "info",
			label: getMessage("grant_null_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage("grant_null_hint", undefined, "扩展后台没响应（它可能刚被回收）—— 仍然可以点，授权在扩展设置页完成"),
		};
	}
	if (!state.origin) {
		return {
			status: getMessage("grant_notHttp_status", undefined, "本页不是 http/https"),
			kind: "warn",
			label: getMessage("grant_notHttp_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage("grant_notHttp_hint", undefined, "模型只能操作普通网页（http/https）—— 浏览器内部页、扩展页、本地文件都不行"),
		};
	}
	if (!state.authorized) {
		return {
			status: getMessage("grant_unauthorized_status", undefined, "未授权"),
			kind: "warn",
			label: getMessage("grant_unauthorized_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage(
				"grant_unauthorized_hint",
				[state.origin],
				`让模型在对话里读写 ${state.origin}（可随时在扩展设置页收回）—— 授权要在扩展自己的页面里点一下`,
			),
		};
	}
	const named = state.title && state.title !== state.origin ? `「${state.title}」` : state.origin;
	if (!state.aiControl) {
		return {
			status: getMessage("grant_authorizedSwitchOff_status", undefined, "已授权 · 总开关关着"),
			kind: "warn",
			label: getMessage("grant_authorizedSwitchOff_label", undefined, "已授权 · 打开设置页"),
			done: true,
			hint: getMessage(
				"grant_authorizedSwitchOff_hint",
				[named],
				`${named} 已授权，但扩展设置页里的「允许 AI 操作页面」总开关是关着的 —— 打开它模型才能动手`,
			),
		};
	}
	return {
		status: getMessage("grant_authorizedOn_status", undefined, "已授权 · 模型可操作本页"),
		kind: "ok",
		label: getMessage("grant_authorizedOn_label", undefined, "已授权 · 打开设置页"),
		done: true,
		hint: getMessage(
			"grant_authorizedOn_hint",
			[named],
			`${named} 已授权：在对话里让模型操作这个页面即可（工具 browser_page）；收回授权在扩展设置页`,
		),
	};
}
