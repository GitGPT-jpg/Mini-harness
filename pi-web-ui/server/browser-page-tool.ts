/**
 * 浏览器页面工具（标准 pi 引擎的 browser_page customTool）
 *
 * 模型调 browser_page → 服务端发 page_request 给浏览器 → 前端转 page-picker
 * 扩展 → 扩展操作目标页面 → 前端回 page_response → 工具结果回到模型。
 *
 * op 的语义（read/click/type/…）属于**扩展侧**，服务端只透传，不解读也不校验
 * ——所以参数说明写在 tool description 里让模型知道怎么用，不在这里分支处理。
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";
import { BROWSER_PAGE_TOOL_NAME } from "./tool-manager.js";

/** timeoutMs 默认值。对面是扩展不是人，超时必须自己兜住。 */
const PAGE_CALL_DEFAULT_TIMEOUT_MS = 30_000;
/** 夹取区间：太小会误杀慢页面（拿不到结果还白跑一趟），太大就把模型拖到
 *  工具看门狗（20 分钟）附近了。 */
const PAGE_CALL_MIN_TIMEOUT_MS = 1_000;
const PAGE_CALL_MAX_TIMEOUT_MS = 120_000;

/** 客户端/扩展回来的页面调用结果（pageCall 的返回值）。失败一律带人话原因，
 *  由工具转成 Error 抛给模型（模型看到 error 才会改变策略）。 */
export type PageCallResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** pageCall 的入参 = 协议 page_request 去掉 id/type（id 由 ClientSession 生成，
 *  type 由 emit 补上）。从 protocol.ts 派生而非手写：契约单源，协议改字段这里
 *  跟着报错。 */
export type PageCallRequest = Omit<Extract<ServerMessage, { type: "page_request" }>, "id" | "type">;

/** timeoutMs 归一：非有限数字/缺省 → 默认；其余夹在 [1000, 120000]。
 *  工具入口与页桥（pageCall）共用，防手写脏值绕过 schema。 */
export function normalizePageCallTimeoutMs(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : PAGE_CALL_DEFAULT_TIMEOUT_MS;
	return Math.min(PAGE_CALL_MAX_TIMEOUT_MS, Math.max(PAGE_CALL_MIN_TIMEOUT_MS, n));
}

/** 除 op/target/timeoutMs 外的扁平参数名（保持扩展侧原名：what/selector/…）。
 *  列表即 schema 里的可选字段——改 schema 忘改这里，单测会炸（见
 *  tests/unit/browser-page-tool.test.ts）。 */
const BROWSER_PAGE_ARG_KEYS = ["what", "selector", "text", "url", "code", "all", "index", "maxEdge"] as const;

/** 只收模型**确实传了**的参数：undefined 不入包，否则扩展拿到一堆
 *  `"selector": undefined` 会覆盖自己的默认值。 */
export function collectBrowserPageArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const k of BROWSER_PAGE_ARG_KEYS) {
		if (params[k] !== undefined) args[k] = params[k];
	}
	return args;
}

/** 页面调用结果 → 给模型的文本：字符串原样（read 的正文就是这样，别再加引号），
 *  其余 JSON 缩进；空结果给一句说明，免得模型以为工具没输出。 */
export function formatPageCallResult(result: unknown): string {
	if (typeof result === "string") return result.length > 0 ? result : "(empty)";
	if (result === undefined || result === null) return "(no result)";
	try {
		return JSON.stringify(result, null, 2) ?? String(result);
	} catch {
		// 循环引用/含大整数等不可序列化结果：别让格式化把工具调用炸掉。
		return String(result);
	}
}

/** 失败文本：带上 op 与原因，再补一句**可执行的**下一步（模型只有知道该让
 *  用户干什么，才不会再盲目重试同一个调用）。 */
export function formatBrowserPageError(op: string, error: string): string {
	return [
		`browser_page "${op}" failed: ${error}`,
		`browser_page "${op}" 失败：${error}`,
		'Next: make sure a pi-web-ui page is open with the page-picker extension enabled and paired, then try op:"pages" to see which pages are available. If the target page is not allowed yet, ask the user to allow it in the extension.',
		'下一步：确认 pi-web-ui 页面已打开、page-picker 扩展已启用并与该页面配对，再用 op:"pages" 看有哪些可操作页面；若目标页面尚未授权，请让用户先在扩展里授权。',
	].join("\n");
}

/**
 * 标准 pi 引擎的 browser_page 工具：模型调用时把请求桥到用户浏览器里的
 * pi-web-ui 页面（page_request/page_response 协议），由 page-picker 扩展真正
 * 操作用户授权的页面。
 *
 * 与 ask_user_question 同样以 customTool 注册（标准 SDK 没有这个工具；DSH 引擎
 * 走自己的运行时，也不经此）。写法严格比照 makeAskUserQuestionTool。
 *
 * pageCall 签名同样带 {aborted} 快照而非完整 AbortSignal（customTool 的 execute
 * 信号服务于整个 agent 生命周期，这里只要「已中止即失败」的最小语义）。
 */
export function makeBrowserPageTool(
	clientSession: {
		pageCall: (req: PageCallRequest, sig: { aborted?: boolean }, conversationId?: string) => Promise<PageCallResult>;
		/** 主模型能不能直接看图 —— 决定 `op:"shot"` 是「给图」还是「走视觉桥转写」。
		 *  两者都可选：老测试替身不实现时，截图退化成「看不到图 + 说明原因」。 */
		canSeeImages?: () => boolean;
		transcribeToolImage?: (
			image: { data: string; mimeType: string },
			signal?: AbortSignal,
		) => Promise<{ text?: string; reason?: string }>;
	},
	/** 本 runtime 所属会话（语义与 ask_user_question 的 ownerId 一致）。 */
	ownerId?: string,
): ToolDefinition {
	return {
		name: BROWSER_PAGE_TOOL_NAME,
		label: "Browser page",
		description: [
			"Read or act on a page in the USER'S OWN browser via the pi-web-ui page-picker extension (the server only forwards).",
			"Only the parameters below exist — an op option that is not a field here (e.g. type's submit) is unavailable.",
			"ops: pages | read (what? selector? all?) | click (selector? index?) | type (selector text) | scroll (selector?) | goto (url) | wait (selector? text? timeoutMs?) | eval (code) | shot (maxEdge?)",
		].join("\n"),
		promptSnippet: "operate a page in the user's browser (page-picker extension)",
		promptGuidelines: [
			"Only use browser_page when the user asked you to read or act on a page in their browser; " +
				"never click or type on their pages on your own initiative",
			'Start with op:"pages"; the target page must already be allowed in the page-picker extension — ' +
				"if it fails, tell the user what to enable instead of retrying.",
		],
		parameters: Type.Object({
			op: Type.String({
				description: "Action to perform (extension-side).",
			}),
			target: Type.Optional(
				Type.String({
					description: "Target page origin (e.g. https://example.com). Only needed when several pages are allowed.",
				}),
			),
			what: Type.Optional(
				Type.String({ description: 'For op:read — "text" | "html" | "title" | "url" | "query" (default: text).' }),
			),
			selector: Type.Optional(
				Type.String({ description: "CSS selector, for op:read / click / type / scroll / wait." }),
			),
			text: Type.Optional(
				Type.String({ description: "For op:type — the text to enter; for op:wait — the text to wait for." }),
			),
			url: Type.Optional(Type.String({ description: "For op:goto — the absolute URL to navigate to." })),
			code: Type.Optional(
				Type.String({
					description: "For op:eval — JS to run in the page (extension-side switch, disabled by default).",
				}),
			),
			all: Type.Optional(
				Type.Boolean({ description: "For op:read — return every match instead of only the first one." }),
			),
			index: Type.Optional(Type.Number({ description: "For op:click — which match to click (default: 0)." })),
			maxEdge: Type.Optional(
				Type.Number({
					description: "For op:shot — max px of the longer side (320-1568, default 1280).",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description: "How long the server waits for the browser (1000-120000 ms, default 30000).",
				}),
			),
		}),
		execute: async (_id: string, params: unknown, signal: AbortSignal | undefined): Promise<unknown> => {
			const p = (params ?? {}) as Record<string, unknown>;
			const op = typeof p.op === "string" ? p.op.trim() : "";
			if (!op) {
				throw new Error(
					'browser_page requires a non-empty `op` (e.g. "pages", "read", "click").\nbrowser_page 需要非空的 op（如 pages/read/click）。',
				);
			}
			const resolved = await clientSession.pageCall(
				{
					op,
					args: collectBrowserPageArgs(p),
					target: typeof p.target === "string" && p.target.length > 0 ? p.target : undefined,
					timeoutMs: normalizePageCallTimeoutMs(p.timeoutMs),
				},
				{
					aborted: signal?.aborted,
				},
				ownerId,
			);
			if (!resolved.ok) {
				// 抛 Error 而不是回一段失败文本：模型需要看到「工具失败」才会改策略。
				throw new Error(formatBrowserPageError(op, resolved.error));
			}
			const shot = extractShotImage(resolved.result);
			if (!shot) {
				// 工具结果：read 的正文原样给模型，结构化结果 JSON 缩进；details 留 UI/轨迹。
				return {
					content: [{ type: "text", text: formatPageCallResult(resolved.result) }],
					details: { op, args: collectBrowserPageArgs(p), target: p.target, result: resolved.result },
				} as never;
			}
			// 截图：**主模型能看图就直接把图给回去**（当轮就能看到，不用等下一轮）；
			// 看不到图（纯文本模型）就交给视觉桥转写成文字证据 —— 与用户粘贴图片走同一套
			// 选择逻辑与提示词，设置里开着就自动生效，模型侧不需要任何额外配置。
			const where = `${p.target ?? "the page"}${shot.selector ? ` (element ${shot.selector})` : ""}`;
			const caption = [
				`Screenshot of ${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px.`,
				`页面截图：${where} — ${shot.width ?? "?"}×${shot.height ?? "?"} px。`,
			].join("\n");
			const details = {
				op,
				args: collectBrowserPageArgs(p),
				target: p.target,
				result: { ...(resolved.result as Record<string, unknown>), image: "[image]" },
			};
			if (clientSession.canSeeImages?.() === true) {
				return {
					content: [
						{ type: "text", text: caption },
						{ type: "image", data: shot.data, mimeType: shot.mimeType },
					],
					details,
				} as never;
			}
			const bridged = await clientSession.transcribeToolImage?.(shot, signal);
			const note = bridged?.text
				? `\n\n<vision-bridge>\n${bridged.text}\n</vision-bridge>`
				: [
						`\n\n（当前模型看不到图片：${bridged?.reason ?? "视觉桥不可用"} —— 可让用户改用支持识图的模型，或在模型配置里加一个支持图片的模型）`,
						`(The current model cannot see images: ${bridged?.reason ?? "vision bridge unavailable"})`,
					].join("\n");
			return {
				content: [{ type: "text", text: caption + note }],
				details,
			} as never;
		},
	} as unknown as ToolDefinition;
}

/**
 * 从扩展的截图结果里取出图片。
 *
 * 扩展回的是 `{ image: { dataUrl, mimeType, width, height }, selector?, rect?, viewport? }`；
 * dataUrl 带 `data:image/jpeg;base64,` 前缀，而模型 API 要的是**纯 base64** —— 剥前缀这一步
 * 很容易忘（忘了就是「图片解析失败」）。
 */
export function extractShotImage(
	result: unknown,
): { data: string; mimeType: string; width?: number; height?: number; selector?: string } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const image = (result as { image?: unknown }).image;
	if (!image || typeof image !== "object") return undefined;
	const src = image as { dataUrl?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
	if (typeof src.dataUrl !== "string") return undefined;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(src.dataUrl);
	if (!match) return undefined;
	const selector = (result as { selector?: unknown }).selector;
	return {
		data: match[2],
		mimeType: typeof src.mimeType === "string" && src.mimeType ? src.mimeType : match[1],
		...(typeof src.width === "number" ? { width: src.width } : {}),
		...(typeof src.height === "number" ? { height: src.height } : {}),
		...(typeof selector === "string" && selector ? { selector } : {}),
	};
}
