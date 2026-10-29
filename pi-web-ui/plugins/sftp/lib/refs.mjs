/**
 * 凭据引用解析 —— 让 `.pi/sftp.json`（可能进版本库、可能被 AI 读写）里
 * **永不出现明文密码**。
 *
 * 支持四种写法：
 *   ${env:VAR_NAME}       环境变量（CI / shell 里注入）
 *   ${secret:name}        宿主加密机密（host.secrets，AES-256-GCM 存 <dataDir>，
 *                         跨机器拷走也解不开；`sftp_secret` 工具写的就是它）
 *   ${file:~/path/to/key} 从文件读（读到的首尾空白会被去掉，方便 `echo xxx > pass`）
 *   其它字符串             明文（可用，但会被告警；见 manifest 的 plaintextWarn）
 *
 * 写错前缀（比如 `${env}` 少了冒号、`${token:x}` 这种不认的 scheme）一律**报错**，
 * 不做静默回落 —— 否则一个拼错的环境变量会退化成「密码为空」的怪异失败。
 */

/** 严格匹配一个完整引用。 */
const REF = /^\$\{(env|secret|file):([^{}]*)\}$/;

/** 是否写成了「看起来像引用」的样子（用于区分明文与拼错的引用）。 */
export function looksLikeRef(v) {
	return typeof v === "string" && v.trim().startsWith("${");
}

/**
 * 解析引用为 `{ scheme, arg }`；不是引用返回 null；像引用但写错则抛错。
 * @param {string} raw
 * @param {string} label 报错里用的字段名（如 `prod.auth.password`）
 */
export function parseRef(raw, label = "value") {
	if (!looksLikeRef(raw)) return null;
	const m = REF.exec(String(raw).trim());
	if (!m) {
		throw new Error(
			`${label} 的引用写法不合法：${String(raw).slice(0, 60)}。` +
				`可用 ${"${env:VAR}"} / ${"${secret:name}"} / ${"${file:~/path}"}，或直接写明文。`,
		);
	}
	const arg = m[2].trim();
	if (!arg) throw new Error(`${label} 的引用缺少名字：${String(raw).slice(0, 60)}`);
	return { scheme: m[1], arg };
}

/** 给界面/模型看的**安全描述**（永不含明文）。 */
export function describeRef(raw) {
	if (!raw) return "";
	const m = REF.exec(String(raw).trim());
	if (!m) return looksLikeRef(raw) ? "invalid" : "plain";
	return `${m[1]}:${m[2]}`;
}

/**
 * 解析成真实值。
 * @param {string} raw
 * @param {{ secrets?: { get(name: string): string | undefined }, label?: string }} ctx
 * @returns {Promise<{ value: string, source: "plain"|"env"|"secret"|"file" }>}
 */
export async function resolveRef(raw, ctx = {}) {
	const label = ctx.label ?? "value";
	if (raw === undefined || raw === null || raw === "") return { value: "", source: "plain" };
	if (typeof raw !== "string") return { value: String(raw), source: "plain" };
	const ref = parseRef(raw, label);
	if (!ref) return { value: raw, source: "plain" };

	if (ref.scheme === "env") {
		const v = process.env[ref.arg];
		if (v === undefined) throw new Error(`${label} 引用的环境变量 ${ref.arg} 未设置`);
		return { value: String(v), source: "env" };
	}
	if (ref.scheme === "secret") {
		const v = ctx.secrets?.get?.(ref.arg);
		if (v === undefined) {
			throw new Error(`${label} 引用的机密 ${ref.arg} 不存在——用 sftp_secret 工具写入，或在设置里重新保存`);
		}
		return { value: String(v), source: "secret" };
	}
	// file
	const { readFile } = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const p = ref.arg.startsWith("~/")
		? path.join(os.homedir(), ref.arg.slice(2))
		: path.isAbsolute(ref.arg)
			? ref.arg
			: path.resolve(ref.arg);
	try {
		const text = await readFile(p, "utf8");
		return { value: text.replace(/\r?\n+$/, ""), source: "file" };
	} catch (err) {
		throw new Error(`${label} 引用的文件读不到（${p}）：${err?.code ?? err?.message ?? err}`);
	}
}
