/**
 * builtins/notify.ts — 纯提醒标记。
 */

import type { ApplyResult, MarkerTool, ParsedToken, MarkerContext } from "../marker.js";
import { getServerBlock, pick, type ServerLang } from "../../i18n.js";

const NOTIFY_GUIDANCE_ZH: string[] = [
	// #499：guidance 只能承诺协议真实支持的级别——success 从未存在于 notice 协议
	// （protocol.ts 仅 info|warning|error），按指引用 success 会被静默降级成 info。
	"- 浮动通知：[[notify:<级别>:<内容>]]（级别：info|warning|error，不进入正文）。",
];

const NOTIFY_GUIDANCE_EN: string[] = [
	"- Non-interruptive toast: [[notify:<level>:<message>]] (level: info|warning|error; omitted from reply).",
];

/** 语言感知的 notify guidance（issue #91）：en 用英译、zh 用中文，默认英文。 */
export function getNotifyGuidance(lang: ServerLang = "en"): string[] {
	return getServerBlock(lang, "markers.notify.guidance", NOTIFY_GUIDANCE_ZH, NOTIFY_GUIDANCE_EN);
}
export const notifyMarker: MarkerTool<never> = {
	name: "notify",
	guidance: NOTIFY_GUIDANCE_ZH,
	getGuidance: getNotifyGuidance,
	async apply(token: ParsedToken, ctx: MarkerContext, _state: never, lang: ServerLang = "en"): Promise<ApplyResult> {
		const level = token.op || token.kwargs["level"] || "info";
		const text = token.kwargs["text"] || token.args.join(" ") || "";
		if (!text)
			return {
				applied: false,
				error: pick(lang, "notify 需要内容", "notify requires a message", "markers.notify.requires.message"),
			};
		const safe = (level === "warning" || level === "error" ? level : "info") as "info" | "warning" | "error";
		ctx.notify(text, safe);
		return { applied: true, feedback: pick(lang, "已发送提醒", "notified", "markers.notify.notified") };
	},
	overlay: undefined,
	init: () => undefined as never,
};
