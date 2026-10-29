/**
 * image-toolkit 视图 ↔ 生图服务端通道。
 */

function apiBase() {
	try {
		let p = location.pathname.replace(/index\.html$/i, "");
		if (!p.endsWith("/")) p += "/";
		return `${p}plugins-api/image-toolkit`;
	} catch {
		return "/plugins-api/image-toolkit";
	}
}

function url(path, params) {
	const u = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
	if (!params) return u;
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
	}
	const s = q.toString();
	return s ? `${u}?${s}` : u;
}

async function request(path, init, query) {
	const res = await fetch(url(path, query), init);
	const text = await res.text();
	let data = {};
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		/* 非 JSON */
	}
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status} ${text.slice(0, 160)}`);
	return data;
}

const postJson = (path, body) =>
	request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** 获取生图配置 + 预设模板 + 任务。 */
export const getConfig = () => request("/gen/config").catch(() => request("/config"));

/** 保存生图配置。 */
export const saveConfig = (config, apiKeys) =>
	postJson("/gen/config", { config, apiKeys }).catch(() => postJson("/config", { config, apiKeys }));

/** 按模板添加生图服务。 */
export const addPreset = (preset) =>
	postJson("/gen/service/preset", { preset }).catch(() => postJson("/service/preset", { preset }));

/** 探测生图服务。 */
export const probe = (id, opts = {}) =>
	postJson("/gen/probe", { id, ...opts }).catch(() => postJson("/probe", { id, ...opts }));

/** 获取支持模型。 */
export async function fetchModels(id, opts = {}) {
	try {
		return await postJson("/gen/models", { id, ...opts });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/\b404\b|not found/i.test(msg)) {
			return await postJson("/probe", { id, ...opts });
		}
		throw err;
	}
}

/** 发起生成。 */
export const generate = (input) => postJson("/gen/generate", input).catch(() => postJson("/generate", input));

/** 任务簿。 */
export const getJobs = () =>
	request("/gen/jobs")
		.catch(() => request("/jobs"))
		.then((d) => d.jobs ?? []);
export const removeJob = (id) => postJson("/gen/jobs/remove", { id }).catch(() => postJson("/jobs/remove", { id }));
export const clearJobs = () => postJson("/gen/jobs/clear", {}).catch(() => postJson("/jobs/clear", {}));

/** 图片直链。 */
export const imageUrl = (path) => url("/gen/image", { path });

/** 列工作区。 */
export const listDir = (dir = "") => request("/ws/list", undefined, { dir });

/** 读工作区文本。 */
export const readText = (path) => request("/ws/text", undefined, { path }).then((d) => d.text ?? "");

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
