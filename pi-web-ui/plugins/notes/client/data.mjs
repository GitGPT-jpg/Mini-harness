/**
 * notes 插件的数据客户端 —— 视图与浮窗**共用同一个实例**（见 entry.mjs）。
 *
 * 通道选择：全部走插件的 HTTP 路由 `/plugins-api/notes/*`（host.route），不用
 * plugin_message/plugin_data。原因：浮窗要在「用户从没打开过插件视图」的情况下也能
 * 收提醒，而插件只有 mount(el, ctx) 里才拿得到 ctx（send/onData）—— 视图挂不挂载
 * 取决于用户点不点那个 tab，不能拿它当命脉。HTTP 两边都能用，且多标签页天然一致。
 *
 * 推送靠**长轮询**：`GET /wait?rev=N` 由服务端挂住（最多 25s），库一变（rev+1）立刻
 * 返回新快照 —— 提醒到点、另一个标签页改了东西都会秒回；没有变化就 25s 后空返，客户端
 * 再发一次。断线/服务重启时按 2s→15s 指数退避重试，期间界面显示「离线」。
 *
 * 服务端返回的快照带 `next: { [reminderId]: iso }`（服务端本地时区算的下次触发时间，
 * 权威值；浏览器时区不同也不会显示错），我们单独存，不混进 store（免得回传污染）。
 */
import * as S from "./store.mjs";

/** 从 bundle 自己的 URL 推 API 前缀：<base>/plugins/notes/client/data.mjs → <base>/plugins-api/notes
 *  这样 nginx 子路径反代（页面在 /pi/ 下）不用任何额外配置。 */
export function resolveApiBase(importMetaUrl) {
	const base = String(importMetaUrl);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/notes`;
}

async function readJson(res) {
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`bad response (${res.status})`);
	}
}

/**
 * 建一个数据客户端。`apiBase` 缺省由 import.meta.url 推出；`onFired` 用于「有新提醒到达」
 * 的副作用（提示音/桌面通知/自动展开浮窗），由 entry.mjs 注入。
 */
export function createDataClient(opts = {}) {
	const apiBase = opts.apiBase ?? resolveApiBase(opts.importMetaUrl ?? import.meta.url);
	const onFired = typeof opts.onFired === "function" ? opts.onFired : () => {};
	let store = S.emptyStore();
	let nextMap = {};
	let status = "connecting"; // connecting | online | offline
	let lastError = "";
	const listeners = new Set();
	const ackQueue = new Set();

	function snapshot() {
		return { store, next: nextMap, status, error: lastError, now: Date.now() };
	}

	function emit() {
		for (const fn of [...listeners]) {
			try {
				fn(snapshot());
			} catch (err) {
				console.error("[notes] listener failed:", err);
			}
		}
	}

	function apply(payload, { quiet = false } = {}) {
		if (payload?.store) store = S.normalizeStore(payload.store);
		// `next` 缺席时**不要**清空：长轮询的空转超时与卸载放行都不带它，清掉会让界面
		// 退回「浏览器时区本地重算」，和服务端权威值来回跳
		if (payload?.next && typeof payload.next === "object") nextMap = payload.next;
		if (status !== "online") status = "online";
		lastError = "";
		if (!quiet) emit();
	}

	/** 提醒送达回执：见过的提醒从待送达队列里摘掉（本地立刻反映，再异步落盘）。 */
	function ackLocal(ids) {
		const n = S.ackPending(store, ids);
		if (n > 0) emit();
		for (const id of ids) ackQueue.add(id);
	}

	async function call(path, init) {
		const res = await fetch(`${apiBase}${path}`, {
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			...init,
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`);
			err.status = res.status; // 有状态码 = 服务端活着但拒绝（不是断线）
			throw err;
		}
		return readJson(res);
	}

	/** 认领本次快照里所有还没确认过的提醒（返回被认领的条目，交给调用方做提示）。 */
	function takeUnseen() {
		const seenKey = "notes:seen";
		let seen = [];
		try {
			seen = JSON.parse(localStorage.getItem(seenKey) ?? "[]");
		} catch {
			seen = [];
		}
		const seenSet = new Set(Array.isArray(seen) ? seen : []);
		const fresh = store.meta.pending.filter((p) => !seenSet.has(p.id));
		if (!fresh.length) return [];
		for (const p of fresh) seenSet.add(p.id);
		// 只留最近 500 条，防 localStorage 无限增长
		const keep = [...seenSet].slice(-500);
		try {
			localStorage.setItem(seenKey, JSON.stringify(keep));
		} catch {
			/* 隐私模式等写不进去：退化成每次重连都可能重复提示一次，不影响主流程 */
		}
		return fresh;
	}

	async function flushAcks() {
		if (!ackQueue.size) return;
		const ids = [...ackQueue];
		ackQueue.clear();
		try {
			const data = await call("/op", { method: "POST", body: JSON.stringify({ op: "reminder.ack", ids }) });
			if (data?.store) {
				store = S.normalizeStore(data.store);
				nextMap = data.next ?? nextMap;
				emit();
			}
		} catch {
			// 失败就放回去，下一轮再试（下次快照还会带上它们，最坏是再提示一次）
			for (const id of ids) ackQueue.add(id);
		}
	}

	let disposed = false;

	/** 长轮询主循环：rev 一变就回来，永远不发同一个 rev 的两份请求。 */
	async function pollLoop() {
		let delay = 2000;
		for (;;) {
			if (disposed) return;
			const rev = store.meta.rev;
			try {
				const data = await call(`/wait?rev=${rev}&client=${encodeURIComponent(clientKey())}`, { method: "GET" });
				if (data?.store) apply(data);
				delay = 2000;
				// 服务端长轮询挂满（多标签页/多设备）时会让我们稍后再来 —— 别原地自旋
				if (typeof data?.retryAfterMs === "number" && data.retryAfterMs > 0) {
					await sleep(Math.min(data.retryAfterMs, 10_000));
				}
				// 先把「见过的提醒」收下、提示出去，再**立即**把回执发回去 ——
				// flushAcks 会把服务端 rev 推高，那是唤醒自己下一轮等待的途径；
				// 放到循环末尾（waiter 前面）会卡到 25s 超时，提示会晚半分钟。
				const fresh = takeUnseen();
				if (fresh.length) {
					ackLocal(fresh.map((p) => p.id));
					onFired(fresh, snapshot());
				}
				await flushAcks();
			} catch (err) {
				if (disposed) return;
				// 有 HTTP 状态码 = 服务端还在，只是这一次请求被拒（插件没激活/参数错）——
				// 不要报「连不上服务端」，那是另一回事
				if (typeof err?.status === "number") {
					lastError = err.message;
					emit();
					await sleep(Math.max(delay, 3000));
					continue;
				}
				status = "offline";
				lastError = err instanceof Error ? err.message : String(err);
				emit();
				await sleep(delay);
				delay = Math.min(15000, Math.round(delay * 1.7));
			}
		}
	}

	function sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	}

	// 每个标签页一个随机 key：只为日志/面板计数用（服务端不依赖它做去重）
	const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	function clientKey() {
		return key;
	}

	return {
		subscribe(fn) {
			listeners.add(fn);
			fn(snapshot());
			return () => listeners.delete(fn);
		},
		getState: snapshot,
		/** 提醒的下次触发时间（毫秒）；服务端给了权威值就用它，否则本地算。 */
		nextAt(rem) {
			const iso = nextMap?.[rem?.id];
			if (iso) {
				const t = new Date(iso).getTime();
				if (!Number.isNaN(t)) return t;
			}
			return rem?.enabled ? (nextScheduleSafe(rem.schedule) ?? null) : null;
		},
		async op(payload) {
			try {
				const data = await call("/op", { method: "POST", body: JSON.stringify(payload) });
				if (data?.store) apply(data, { quiet: true });
				emit();
				return data?.result ?? { ok: data?.ok !== false, error: data?.error };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				status = "offline";
				lastError = msg;
				emit();
				return { ok: false, error: msg };
			}
		},
		/** 下载导出（走服务端渲染，避免两边格式不一致）。 */
		async download(format) {
			try {
				const res = await fetch(`${apiBase}/export?format=${format}`, { credentials: "same-origin" });
				if (!res.ok) {
					const err = new Error(`HTTP ${res.status}`);
					err.status = res.status; // 有状态码 = 服务端活着但拒绝（不是断线）
					throw err;
				}
				const text = await res.text();
				const stamp = S.nowStamp().replace(/[:T]/g, "-");
				download(`${format === "md" ? "notes" : "notes-backup"}-${stamp}.${format}`, text);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
		/** 主动拉一次（浮窗打开时用，缩短「打开即见旧数据」的窗口）。 */
		async refresh() {
			try {
				const data = await call("/store", { method: "GET" });
				apply(data);
			} catch {
				/* 长轮询会自己恢复 */
			}
		},
		start() {
			void pollLoop();
		},
		stop() {
			disposed = true;
		},
	};
}

function nextScheduleSafe(schedule) {
	try {
		return S.reminderFireAt({ enabled: true, schedule }, Date.now());
	} catch {
		return null;
	}
}

/** 触发浏览器下载（Blob + a[download]，不依赖主应用的 download.ts）。 */
export function download(filename, text) {
	const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
