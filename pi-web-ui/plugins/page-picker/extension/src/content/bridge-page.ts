/// <reference lib="dom" />
/**
 * 页面桥的**页面侧**（注入到被配对页面的 MAIN world）。
 *
 * 为什么是 MAIN world：页面自己的脚本只能看见自己世界的全局对象 —— 隔离世界的
 * `window.__piBridge` 它根本摸不到。现有代码里 `composeInPage`（往 pi-web-ui 输入框塞草稿）
 * 走同一套路数。
 *
 * **这个文件里的函数必须自包含**：`chrome.scripting.executeScript({ func })` 是把函数
 * `toString()` 之后丢进页面里跑的，任何对模块作用域的引用（哪怕是 esbuild 打包后的常量）
 * 都会在页面里变成 `ReferenceError`。所以：
 * - 数字/字符串一律写字面量（`1`、`"data-pi-bridge"`、`"__piBridge"`），
 *   与 `shared/bridge.ts` 的常量一致性由单测钉住；
 * - 只用 `globalThis`（浏览器里就是 `window`）与参数、以及 `setTimeout` 这类真全局；
 * - 不 import 任何运行时值（`import type` 会被编译掉，是允许的）。
 *
 * 页面 API（给页面开发者用）：
 *
 * ```js
 * // 接收方：注册能力
 * window.__piBridge.on("orders", () => [...document.querySelectorAll(".order")].map(el => el.textContent));
 *
 * // 发起方：调用对端
 * const orders = await window.__piBridge.call({ op: "orders" });
 * window.__piBridge.call({ to: "https://other.example", op: "highlight", args: { id: 3 } });
 * window.__piBridge.peers;   // 我能跟谁说话（数组）
 * ```
 */

/** `window.__piBridge` 的公开面（页面侧没有强类型，这里供扩展自己与测试使用）。 */
export interface BridgePageApi {
	/** 协议版本（与 `shared/bridge.ts` 的 BRIDGE_VERSION 一致）。 */
	version: number;
	/** 本页 origin。 */
	self: string;
	/** 当前允许对话的对端 origin 列表（**仅供参考**：真正放行与否由扩展后台按配对表判定）。 */
	peers: string[];
	/** 注册一个操作；返回注销函数。对端调 `op` 时执行 handler。 */
	on(op: string, handler: (args: unknown, ctx: { from: string }) => unknown): () => void;
	/** 注销一个操作。 */
	off(op: string): void;
	/** 调对端：`{ op, args?, to?, timeoutMs? }` → Promise<对端 handler 的返回值>。 */
	call(req: { op: string; args?: unknown; to?: string; timeoutMs?: number }): Promise<unknown>;
}

/** 内部面（`token` 是消息通道的凭据，不在公开文档里出现）。 */
interface BridgePageInternal extends BridgePageApi {
	token: string;
	/** 内置动作表（AI 操作页面用）。只有 `control: true` 装的桥才有 —— worker 靠它判断
	 *  该页能不能接受模型的动作。 */
	__builtin?: Record<string, (args: Record<string, unknown>) => unknown>;
	__invoke(op: unknown, args: unknown, from: unknown, builtin?: unknown): Promise<Record<string, unknown>>;
	__destroy(): void;
}

/** 注入结果（要过 executeScript 的 IPC，只能放可克隆的普通值）。 */
export interface BridgePageInstallResult {
	ok: boolean;
	reason?: "no-token" | "no-window";
	version?: number;
}

/**
 * 装上页面桥。**幂等**：已装上就只刷新 token / peers / self（页面上注册的 handler 不动 ——
 * 重新注入最常见的原因是「配对表变了」，把用户的 handler 冲掉是灾难）。
 *
 * token 从 DOM 属性读（content script 写的）：两个世界共享同一个 document，这是最省事
 * 且不依赖注入次序之外的通道。它**不是安全边界**（同文档的任何脚本都能读它），
 * 只用来挡「偶发/无意的伪造 postMessage」——真正的边界是扩展后台按 `sender.tab.url` 判定
 * 出「你是谁」，再查配对表决定「你能跟谁说话」。
 */
export function installBridgePage(options?: { peers?: unknown; self?: unknown; control?: unknown }): BridgePageInstallResult {
	const g = globalThis as unknown as Record<string, unknown>;
	const doc = (g as { document?: { documentElement?: { getAttribute?(name: string): string | null } } }).document;
	const el = doc?.documentElement;
	if (!el || typeof el.getAttribute !== "function") return { ok: false, reason: "no-window" };
	const token = el.getAttribute("data-pi-bridge") ?? "";
	if (!token) return { ok: false, reason: "no-token" }; // content script 还没 arm —— 让它先跑

	const VERSION = 1; // ← 必须等于 shared/bridge.ts 的 BRIDGE_VERSION（单测钉住）
	const location = (g as { location?: { origin?: string } }).location;
	const self = typeof options?.self === "string" ? options.self : (location?.origin ?? "");
	const peers = Array.isArray(options?.peers)
		? (options?.peers as unknown[]).filter((x): x is string => typeof x === "string")
		: [];
	// control = 这个页面被授权「让 AI 操作」→ 装上内置动作（read/click/type/…）
	const control = options?.control === true;

	const existing = g.__piBridge as Partial<BridgePageInternal> | undefined;
	if (
		existing &&
		existing.version === VERSION &&
		typeof existing.__destroy === "function" &&
		// 内置动作的有无必须与 control 一致：相反时宁可重建（否则会出现「授权了但没动作」）
		(existing.__builtin !== undefined) === control
	) {
		// 更新分支：token 会被 content script 每次 arm 时刷新，listener 读的就是这个属性
		existing.token = token;
		existing.peers = peers.slice();
		existing.self = self;
		return { ok: true, version: VERSION };
	}
	// 旧版本/半残的桥先拆干净，否则会留下第二个 message 监听器（结果乱窜）
	if (existing && typeof existing.__destroy === "function") {
		try {
			existing.__destroy();
		} catch {
			/* 拆旧失败不该挡住装新 */
		}
	}

	const handlers = new Map<string, (args: unknown, ctx: { from: string }) => unknown>();

	// ---------------------------------------------------------------- 内置动作（AI 操作页面）
	//
	// 这些是**扩展自己提供的**能力（不是页面注册的 handler），只有被授权「让 AI 操作」的
	// 页面才装（`control: true`）。
	//
	// 纪律：全部写在函数体内（含嵌套函数）—— executeScript 只搬这一个函数的源码，引用任何
	// 模块作用域的东西都会在页面里变成 ReferenceError。同理只用页面真全局：
	// document / window / MouseEvent / HTMLInputElement 这些浏览器自带的构造器。
	//
	// 一个绕不开的限制：`eval` 受**目标页面的 CSP** 约束。页面写了 `script-src` 不含
	// `unsafe-eval` 时（很多生产站），eval 动作会直接报错——这是浏览器的规矩，不是我们的
	// bug，报错文案要说清楚。

	const docAny = (g as { document?: Document }).document;
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

	/** 整数参数归一（模型给的东西什么形状都可能有）。 */
	const num = (v: unknown, dflt: number, min: number, max: number): number => {
		const n = typeof v === "number" && isFinite(v) ? Math.round(v) : dflt;
		return Math.min(max, Math.max(min, n));
	};

	/** 字符串参数归一。 */
	const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

	const cut = (text: string, max: number): string =>
		text.length > max ? `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）` : text;

	/** 元素的可见文本（innerText 会算上 CSS 隐藏；拿不到时退回 textContent）。 */
	const textOf = (node: Element | null): string => {
		if (!node) return "";
		const raw = (node as HTMLElement).innerText ?? node.textContent ?? "";
		return String(raw).replace(/\r/g, "").trim();
	};

	/** 元素摘要（给模型看的一份“这是什么东西”）。 */
	const brief = (node: Element, index: number): Record<string, unknown> => {
		const rect = node.getBoundingClientRect();
		const classes = node.classList ? [...node.classList].slice(0, 6) : [];
		const tag = node.tagName.toLowerCase();
		return {
			index,
			tag,
			...(node.id ? { id: node.id } : {}),
			...(classes.length > 0 ? { classes } : {}),
			text: cut(textOf(node).replace(/\s+/g, " "), 160),
			...(tag === "a" ? { href: (node as HTMLAnchorElement).href } : {}),
			...(tag === "input" || tag === "textarea"
				? {
						...(node as HTMLInputElement).type ? { type: (node as HTMLInputElement).type } : {},
						value: (node as HTMLInputElement).value,
						...(node as HTMLInputElement).placeholder ? { placeholder: (node as HTMLInputElement).placeholder } : {},
					}
				: {}),
			rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
		};
	};

	/** 找元素；找不到就返回 null（调用方给一句「选择器没匹上」）。 */
	const find = (args: Record<string, unknown>): Element | null => {
		const selector = str(args.selector);
		if (!selector || !docAny) return null;
		const all = [...docAny.querySelectorAll(selector)];
		const index = num(args.index, 0, 0, Math.max(0, all.length - 1));
		return all[index] ?? null;
	};

	/**
	 * 输入框赋值。
	 *
	 * **必须走原型上的 native setter**：React/Vue 把 value 的 setter 换成了自己的，
	 * 直接 `input.value = x` 页面框架看不到（受控组件下一拍就被改回去）——这是自动化里
	 * 最常见的一个坑。赋值后补发 input/change 事件，页面才会当“用户真的输了字”。
	 */
	const setValue = (node: Element, text: string): void => {
		const tag = node.tagName.toLowerCase();
		if (tag === "input" || tag === "textarea") {
			const target = node as HTMLInputElement | HTMLTextAreaElement;
			const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (setter) setter.call(target, text);
			else target.value = text;
		} else {
			// contenteditable / 其它可编辑容器
			(node as HTMLElement).textContent = text;
		}
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const actions: Record<string, (args: Record<string, unknown>) => unknown> = {};

	actions["pages"] = () => ({ pages: peers.slice(), self });

	/** 视口与设备像素比：截图裁剪要靠它（rect 是 CSS 像素，截出来的是物理像素）。 */
	actions["metrics"] = () => {
		const win = g as unknown as {
			devicePixelRatio?: number;
			innerWidth?: number;
			innerHeight?: number;
			scrollX?: number;
			scrollY?: number;
		};
		return {
			dpr: win.devicePixelRatio ?? 1,
			vw: win.innerWidth ?? 0,
			vh: win.innerHeight ?? 0,
			sx: win.scrollX ?? 0,
			sy: win.scrollY ?? 0,
		};
	};

	actions["read"] = (args) => {
		const what = str(args.what) || "text";
		if (what === "title") return { title: docAny?.title ?? "" };
		if (what === "url") return { url: String((g as { location?: { href?: string } }).location?.href ?? "") };
		const selector = str(args.selector);
		if (what === "query") {
			if (!selector) return { error: "read what=query 需要 selector" };
			const all = [...(docAny?.querySelectorAll(selector) ?? [])];
			const limit = num(args.limit, 20, 1, 100);
			const picked = (args.all === false ? all.slice(0, 1) : all).slice(0, limit);
			return {
				selector,
				count: all.length,
				shown: picked.length,
				items: picked.map((node, i) => brief(node, i)),
			};
		}
		if (what === "html") {
			const node = selector ? (docAny?.querySelector(selector) ?? null) : (docAny?.documentElement ?? null);
			if (selector && !node) return { error: `选择器没匹上：${selector}` };
			return { html: cut(node?.outerHTML ?? "", 20000), selector: selector || null };
		}
		const node = selector ? (docAny?.querySelector(selector) ?? null) : (docAny?.body ?? null);
		if (selector && !node) return { error: `选择器没匹上：${selector}` };
		return { text: cut(textOf(node), 12000), selector: selector || null };
	};

	actions["click"] = (args) => {
		const selector = str(args.selector);
		if (!selector) return { error: "click 需要 selector" };
		const node = find(args);
		if (!node) return { error: `选择器没匹上：${selector}` };
		try {
			// 先滚进视口：不少页面靠 IntersectionObserver 才渲染/启用
			node.scrollIntoView({ block: "center", inline: "center" });
		} catch {
			/* 老环境不支持参数对象也无所谓 */
		}
		const asButton = node as HTMLElement;
		if (typeof asButton.click === "function") asButton.click();
		else node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: g as unknown as Window }));
		return { clicked: true, selector, ...brief(node, 0) };
	};

	actions["type"] = (args) => {
		const selector = str(args.selector);
		if (!selector) return { error: "type 需要 selector" };
		const node = find(args);
		if (!node) return { error: `选择器没匹上：${selector}` };
		const text = typeof args.text === "string" ? args.text : "";
		const asInput = node as HTMLElement;
		try {
			asInput.focus();
		} catch {
			/* 不可聚焦的容器跳过 */
		}
		setValue(node, args.clear === false ? `${(node as HTMLInputElement).value ?? ""}${text}` : text);
		if (args.submit === true) {
			for (const type of ["keydown", "keypress", "keyup"]) {
				node.dispatchEvent(
					new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }),
				);
			}
		}
		return { typed: true, selector, value: (node as HTMLInputElement).value ?? textOf(node), submitted: args.submit === true };
	};

	actions["scroll"] = (args) => {
		const selector = str(args.selector);
		const win = g as unknown as { scrollTo: (x: number, y: number) => void; scrollBy: (x: number, y: number) => void; scrollX: number; scrollY: number };
		if (selector) {
			const node = docAny?.querySelector(selector) ?? null;
			if (!node) return { error: `选择器没匹上：${selector}` };
			try {
				node.scrollIntoView({ block: "center", inline: "nearest" });
			} catch {
				/* 老环境 / 特殊元素没有 scrollIntoView：位置不动也比抛错好 */
			}
		} else if (args.to && typeof args.to === "object") {
			const to = args.to as { x?: unknown; y?: unknown };
			win.scrollTo(num(to.x, win.scrollX, -1e9, 1e9), num(to.y, win.scrollY, -1e9, 1e9));
		} else if (args.by && typeof args.by === "object") {
			const by = args.by as { x?: unknown; y?: unknown };
			win.scrollBy(num(by.x, 0, -1e9, 1e9), num(by.y, 0, -1e9, 1e9));
		} else {
			return { error: "scroll 需要 selector / to / by 之一" };
		}
		return { scrolled: true, x: Math.round(win.scrollX), y: Math.round(win.scrollY) };
	};

	actions["goto"] = (args) => {
		const url = str(args.url);
		if (!url) return { error: "goto 需要 url" };
		// 延后一拍再跳：直接把 location 改掉会让页面卸载，这次调用就变成「没有响应」——
		// 模型只会看到一个莫名其妙的失败，而页面已经跳走了。
		setTimeout(() => {
			try {
				(g as { location?: { href?: string } }).location!.href = url;
			} catch {
				/* 跳转失败页面自己会报错 */
			}
		}, 80);
		return { navigating: true, url };
	};

	actions["wait"] = async (args) => {
		const selector = str(args.selector);
		const text = typeof args.text === "string" ? args.text : "";
		if (!selector && !text) return { error: "wait 需要 selector 或 text" };
		const timeout = num(args.timeoutMs, 5000, 1, 30000);
		const started = Date.now();
		for (;;) {
			if (selector && docAny?.querySelector(selector)) {
				return { found: "selector", selector, waitedMs: Date.now() - started };
			}
			if (text && (docAny?.body ? textOf(docAny.body) : "").includes(text)) {
				return { found: "text", text, waitedMs: Date.now() - started };
			}
			if (Date.now() - started >= timeout) {
				return {
					found: null,
					waitedMs: Date.now() - started,
					note: `等了 ${timeout}ms 还是没出现（selector/text 可能不对，或者这一步需要先点/先输入）`,
				};
			}
			await sleep(100);
		}
	};

	actions["eval"] = async (args) => {
		const code = typeof args.code === "string" ? args.code : "";
		if (!code.trim()) return { error: "eval 需要 code" };
		try {
			// 间接 eval：在页面全局作用域里跑（不是本函数的局部作用域）
			const value = await (0, eval)(code);
			return { value: plain(value) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				error: `${message}${
					/eval|unsafe-eval|Content Security Policy/i.test(message)
						? "（这个页面通过 CSP 禁了 eval —— 换用 read/click/type 这些动作）"
						: ""
				}`,
			};
		}
	};

	/** 把任意返回值变成能跨进程传输的普通数据（DOM 节点/函数这类东西回不去）。 */
	const plain = (value: unknown): unknown => {
		if (value === undefined) return undefined;
		try {
			return JSON.parse(JSON.stringify(value));
		} catch {
			return String(value);
		}
	};

	/**
	 * 在页面上闪一条「AI 正在操作本页」的轻提示。
	 *
	 * 为什么必须有：模型在背后点页面时，如果页面上一点痕迹都没有，用户会觉得页面自己在动
	 * （甚至以为是 bug 或劫持）。提示条是**只报信、不拦截**：pointer-events:none，2.2s 后淡出，
	 * 不抢焦点、不改布局。挂 shadow DOM 是为了不被页面 CSS 弄坏。
	 */
	let badgeHost: HTMLElement | null = null;
	let badgeTimer: ReturnType<typeof setTimeout> | undefined;
	const flashAction = (label: string): void => {
		const root0 = docAny?.documentElement;
		if (!root0) return;
		try {
			if (!badgeHost || !badgeHost.isConnected) {
				// 同一个页面可能被重装过桥（授权变更 / 导航后重注入）——先把上一任留下的提示条清掉，
				// 否则页面上会挂着两条（旧那条再也不会被更新，看着像卡住的提示）。
				docAny?.getElementById("pi-ai-control-badge")?.remove();
				badgeHost = docAny!.createElement("div");
				badgeHost.id = "pi-ai-control-badge";
				badgeHost.style.cssText =
					"position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;" +
					"opacity:0;transition:opacity .25s ease";
				const shadow = badgeHost.attachShadow({ mode: "open" });
				const style = docAny!.createElement("style");
				style.textContent =
					".box{font:12px/1.5 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;" +
					"background:rgba(17,24,39,.94);color:#e5e7eb;padding:7px 11px;border-radius:8px;" +
					"border-left:3px solid #6366f1;box-shadow:0 6px 20px rgba(0,0,0,.35);" +
					"max-width:min(360px,80vw);word-break:break-all}" +
					".t{color:#a5b4fc;font-weight:600;margin-right:6px}" +
					".d{color:#cbd5e1}";
				const box = docAny!.createElement("div");
				box.className = "box";
				const who = docAny!.createElement("span");
				who.className = "t";
				who.textContent = "AI 正在操作本页";
				const detail = docAny!.createElement("span");
				detail.className = "d";
				box.append(who, detail);
				shadow.append(style, box);
				root0.append(badgeHost);
			}
			const detail = badgeHost.shadowRoot?.querySelector<HTMLElement>(".d");
			if (detail) detail.textContent = label;
			badgeHost.style.opacity = "1";
			if (badgeTimer) clearTimeout(badgeTimer);
			badgeTimer = setTimeout(() => {
				if (badgeHost) badgeHost.style.opacity = "0";
			}, 2200);
		} catch {
			/* 画不出来不影响动作本身 */
		}
	};

	const builtinOps: Record<string, (args: Record<string, unknown>) => unknown> | undefined = control ? actions : undefined;
	let pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	let seq = 0;

	let api: BridgePageInternal;
	const onMessage = (e: { data?: unknown }): void => {
		const data = e?.data;
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (!api || msg.__piBridge !== api.token) return; // 不是我们这条通道的（token 每次都刷新）
		if (msg.kind !== "result") return;
		const id = String(msg.id);
		const entry = pending.get(id);
		if (!entry) return; // 超时后迟到 / 重复的结果：丢掉，绝不 reject 一个已经结束的 Promise
		pending.delete(id);
		clearTimeout(entry.timer);
		if (msg.ok === true) entry.resolve(msg.value);
		else entry.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "对端调用失败"));
	};

	const listeners = g as {
		addEventListener?(type: string, cb: unknown): void;
		removeEventListener?(type: string, cb: unknown): void;
	};
	listeners.addEventListener?.call(g, "message", onMessage);

	const call = (req: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const r = (req && typeof req === "object" ? req : {}) as Record<string, unknown>;
			const op = typeof r.op === "string" ? r.op.trim() : "";
			if (!op) {
				reject(new Error("call({ op }) 要带一个操作名"));
				return;
			}
			const rawTimeout = typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) ? r.timeoutMs : 5000;
			const timeout = Math.min(30000, Math.max(1, Math.round(rawTimeout)));
			const id = `c${++seq}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`对端在 ${timeout}ms 内没回（op: ${op}）`));
			}, timeout);
			pending.set(id, { resolve, reject, timer });
			try {
				const to = typeof r.to === "string" && r.to.trim() ? r.to.trim() : undefined;
				(g.postMessage as (message: unknown, targetOrigin: string) => void).call(
					g,
					{
						__piBridge: api.token,
						kind: "call",
						id,
						op,
						...(r.args === undefined ? {} : { args: r.args }),
						...(to ? { to } : {}),
						timeoutMs: timeout,
					},
					"*",
				);
			} catch (err) {
				// 结构化克隆失败（带了个 DOM 节点/函数）——在本地就报清楚，别让它落到「没反应」
				pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`参数发不出去：${err instanceof Error ? err.message : String(err)}（只能传普通数据）`));
			}
		});

	/** worker 注入调用的入口（`invokeBridgeHandler` 转发到这里）。
	 *  `code` 是给 worker 用的机器可读分类（只有 no-bridge 会让 worker 自动补装一次桥）。
	 *  `builtin === true` = 走内置动作（AI 操作页面），否则走页面自己注册的 handler。 */
	const invoke = async (
		op: unknown,
		args: unknown,
		from: unknown,
		builtin?: unknown,
	): Promise<Record<string, unknown>> => {
		const name = typeof op === "string" ? op.trim() : "";
		if (!name) return { ok: false, error: "缺少操作名（op）", code: "bad-op" };
		if (builtin === true) {
			const fn = builtinOps?.[name];
			if (!fn) {
				return {
					ok: false,
					code: "no-handler",
					error: `不支持的动作 "${name}"（支持：${Object.keys(actions).join("、")}）`,
				};
			}
			// 先在页面上留一个“谁在动”的痕迹（只报信、不拦截）
			const a = (args ?? {}) as Record<string, unknown>;
			const hint = str(a.selector) || str(a.what) || str(a.url) || str(a.text);
			flashAction(hint ? `${name} · ${cut(hint, 60)}` : name);
			try {
				const out = await fn((args ?? {}) as Record<string, unknown>);
				if (out && typeof out === "object" && "error" in (out as Record<string, unknown>)) {
					const err = (out as Record<string, unknown>).error;
					return { ok: false, code: "op-failed", error: typeof err === "string" ? err : "动作失败" };
				}
				return out === undefined ? { ok: true } : { ok: true, value: plain(out) };
			} catch (err) {
				return { ok: false, code: "op-failed", error: `动作 ${name} 抛错：${err instanceof Error ? err.message : String(err)}` };
			}
		}
		const handler = handlers.get(name);
		if (!handler) {
			const known = [...handlers.keys()];
			return {
				ok: false,
				code: "no-handler",
				error: `对端页面没注册 "${name}"${known.length > 0 ? ` —— 它注册了：${known.join("、")}` : " —— 它一个操作都还没注册"}`,
			};
		}
		let value: unknown;
		try {
			value = await handler(args, { from: typeof from === "string" ? from : "" });
		} catch (err) {
			return { ok: false, error: `对端的 "${name}" 抛错：${err instanceof Error ? err.message : String(err)}` };
		}
		if (value !== undefined) {
			// 提前探一次：DOM 节点 / 函数这类东西会让 executeScript 回程抛 DataCloneError，
			// 那时候留给页面开发者的只有一句看不懂的浏览器内部消息
			try {
				JSON.stringify(value);
			} catch (err) {
				return {
					ok: false,
					error: `"${name}" 的返回值传不回来：${err instanceof Error ? err.message : String(err)}（只能返回普通数据）`,
				};
			}
		}
		return value === undefined ? { ok: true } : { ok: true, value };
	};

	const destroy = (): void => {
		listeners.removeEventListener?.call(g, "message", onMessage);
		// 提示条也不留：桥都卸了，页面上还挂着「AI 正在操作本页」只会吓人
		try {
			badgeHost?.remove();
			badgeHost = null;
		} catch {
			/* 删不掉不影响卸载 */
		}
		const held = pending;
		pending = new Map();
		for (const entry of held.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("页面桥已被卸载"));
		}
		handlers.clear();
		if (g.__piBridge === api) delete g.__piBridge;
	};

	api = {
		version: VERSION,
		self,
		peers: peers.slice(),
		token,
		...(builtinOps ? { __builtin: builtinOps } : {}),
		on(op, handler) {
			if (typeof op !== "string" || !op.trim() || typeof handler !== "function") {
				throw new Error("on(op, handler)：op 要是非空字符串、handler 要是函数");
			}
			const name = op.trim();
			handlers.set(name, handler);
			return () => {
				handlers.delete(name);
			};
		},
		off(op) {
			handlers.delete(String(op).trim());
		},
		call,
		__invoke: invoke,
		__destroy: destroy,
	};
	g.__piBridge = api;
	return { ok: true, version: VERSION };
}

/**
 * worker 注入：把一个调用转给页面的 handler。
 *
 * 单独一个函数（而不是让 worker 自己去找 `__piBridge`）是为了让「没装上桥」这个失败
 * 返回一个**可读的原因**，而不是一句 `Cannot read properties of undefined`。
 */
export async function invokeBridgeHandler(req?: {
	op?: unknown;
	args?: unknown;
	from?: unknown;
	/** true = 走内置动作（AI 操作页面）；缺省 = 走页面注册的 handler。 */
	builtin?: unknown;
}): Promise<{ ok: boolean; value?: unknown; error?: string; code?: string }> {
	const g = globalThis as unknown as Record<string, unknown>;
	const api = g.__piBridge as Partial<BridgePageInternal> | undefined;
	if (!api || typeof api.__invoke !== "function") {
		return { ok: false, code: "no-bridge", error: "对端页面还没装上页面桥（它可能刚导航过）—— 刷新那个页面再试" };
	}
	if (req?.builtin === true && !api.__builtin) {
		return {
			ok: false,
			code: "no-control",
			error: "这个页面没被授权给 AI 操作 —— 在扩展选项页「AI 操作页面」里授权它",
		};
	}
	try {
		const res = (await api.__invoke(req?.op, req?.args, req?.from, req?.builtin)) as Record<string, unknown> | undefined;
		if (!res || typeof res !== "object") return { ok: false, error: "对端页面桥返回了意外结果" };
		if (res.ok === true) return res.value === undefined ? { ok: true } : { ok: true, value: res.value };
		return {
			ok: false,
			error: typeof res.error === "string" && res.error ? res.error : "对端调用失败",
			...(typeof res.code === "string" ? { code: res.code } : {}),
		};
	} catch (err) {
		return { ok: false, error: `对端页面桥异常：${err instanceof Error ? err.message : String(err)}` };
	}
}

/** 卸下页面桥（取消配对、或页面已经不该再能发起调用了）。 */
export function uninstallBridgePage(): { ok: boolean } {
	const g = globalThis as unknown as Record<string, unknown>;
	const api = g.__piBridge as { __destroy?: () => void } | undefined;
	if (api && typeof api.__destroy === "function") {
		try {
			api.__destroy();
		} catch {
			/* 卸载失败就只是留下一个不会再被放行的桥 */
		}
	}
	const doc = (g as { document?: { documentElement?: { removeAttribute?(name: string): void } } }).document;
	try {
		doc?.documentElement?.removeAttribute?.call(doc.documentElement, "data-pi-bridge");
	} catch {
		/* 属性删不掉无妨：token 已经不是当前的那个，监听器也拆了 */
	}
	return { ok: true };
}
