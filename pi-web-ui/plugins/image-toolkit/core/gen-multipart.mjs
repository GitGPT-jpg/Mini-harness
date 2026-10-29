/**
 * 极小 multipart/form-data 编码器 —— 零依赖、二进制安全、可单测。
 *
 * 为什么不用全局 FormData/Blob：形状适配器要能在单测里断言「到底发了哪些
 * 字段、字段名对不对」（OpenAI 要 image/image[]，反代要 image1/image2…），
 * 自己拼字节既能断言又能一次发给任意服务。
 */
import { randomHex } from "./gen-util.mjs";

/** 合法字段名（防注入畸形 header）。 */
const NAME_RE = /^[A-Za-z0-9_.\-[\]]+$/;

/**
 * 编码 multipart body。
 * parts: [{ name, value } | { name, filename, data, contentType }]
 *   字符串/数字 → 普通表单字段；带 filename+data → 文件字段（Buffer/Uint8Array）。
 * 返回 { body: Buffer, contentType, boundary }。
 */
export function buildMultipart(parts, boundary = `----piwebui-${randomHex(12)}`) {
	const chunks = [];
	const crlf = "\r\n";
	for (const p of parts) {
		const name = String(p?.name ?? "");
		if (!NAME_RE.test(name)) throw new Error(`multipart: 非法字段名 ${JSON.stringify(name)}`);
		const header = [];
		if (p && (p.filename || Buffer.isBuffer(p.data) || p.data instanceof Uint8Array)) {
			const filename = String(p.filename ?? "file");
			const type = String(p.contentType ?? "application/octet-stream");
			header.push(`--${boundary}${crlf}`);
			header.push(
				`Content-Disposition: form-data; name="${name}"; filename="${filename.replace(/["\r\n]/g, "_")}"${crlf}`,
			);
			header.push(`Content-Type: ${type}${crlf}${crlf}`);
			chunks.push(Buffer.from(header.join(""), "utf8"));
			chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data ?? []));
			chunks.push(Buffer.from(crlf, "utf8"));
		} else {
			header.push(`--${boundary}${crlf}`);
			header.push(`Content-Disposition: form-data; name="${name}"${crlf}${crlf}`);
			chunks.push(Buffer.from(header.join(""), "utf8"));
			chunks.push(Buffer.from(String(p?.value ?? ""), "utf8"));
			chunks.push(Buffer.from(crlf, "utf8"));
		}
	}
	chunks.push(Buffer.from(`--${boundary}--${crlf}`, "utf8"));
	return {
		body: Buffer.concat(chunks),
		contentType: `multipart/form-data; boundary=${boundary}`,
		boundary,
	};
}

/** 表单字段归一：对象 → 字段数组（跳过空值；对象/数组值 JSON 化）。 */
export function formFields(obj, allowed) {
	const out = [];
	for (const [k, v] of Object.entries(obj ?? {})) {
		if (allowed && !allowed.includes(k)) continue;
		if (v === undefined || v === null || v === "") continue;
		out.push({ name: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
	}
	return out;
}
