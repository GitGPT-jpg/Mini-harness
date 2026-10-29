/**
 * server/net-guard.ts —— 服务端外发 HTTP(S) 请求的统一 SSRF 防护与安全抓取工具 (#602)。
 *
 * 防护分层：
 *   1. URL 语法与协议白名单：仅允许 http: / https:；
 *   2. 主机名与字面量 IP 校验（isBlockedHost）：
 *      - 拦截 localhost / *.localhost / *.local / *.internal；
 *      - 将 IPv6 完整展开为 8×16-bit 组，统一还原 IPv4-mapped (::ffff:0:0/96)、
 *        IPv4-translated (::ffff:0:0:0/96)、IPv4-compatible (::/96)、NAT64 (64:ff9b::/96)
 *        内嵌的 32-bit IPv4，彻底杜绝 ::ffff:7f00:1 / ::ffff:0:7f00:1 / 0:0:0:0:0:ffff:... 绕过；
 *      - 拦截回环、未指定、RFC1918 私网、CGNAT (100.64/10)、链路本地与云元数据 (169.254/16, fe80::/10)、
 *        ULA (fc00::/7)、组播与保留段；
 *   3. DNS 解析后 IP 校验（resolveAndValidateUrl）：
 *      - 对域名调用 dns.promises.lookup(host, { all: true })，任一 A/AAAA 记录命中内网/元数据 IP 即拒绝，
 *        防御域名解析到 127.0.0.1 / 169.254.169.254 的 DNS rebinding；
 *   4. 重定向逐跳校验（safeFetch）：
 *      - 强制 redirect: "manual"，对每一跳 Location 重新执行 URL + DNS 校验（最多 5 跳），
 *        防止公网 URL 302 跳转到内网/云元数据端点。
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type LookupAddress = { address: string; family?: number };
export type LookupAllFn = (hostname: string) => Promise<LookupAddress[]>;

const initialGlobalFetch = globalThis.fetch;

/** 判断全局 fetch 是否仍为进程启动时的原生 fetch（未被 vi.stubGlobal 替换）。 */
export function isNativeGlobalFetch(): boolean {
	return globalThis.fetch === initialGlobalFetch;
}

const defaultLookupAll: LookupAllFn = async (hostname: string) => {
	return await dnsLookup(hostname, { all: true, verbatim: true });
};

/** 解析点分十进制 IPv4 为 4 个 0..255 字节；非法返回 null。 */
function parseIpv4Octets(input: string): [number, number, number, number] | null {
	const m = input.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const a = Number(m[1]);
	const b = Number(m[2]);
	const c = Number(m[3]);
	const d = Number(m[4]);
	if (a > 255 || b > 255 || c > 255 || d > 255) return null;
	return [a, b, c, d];
}

/** 判定 4 字节 IPv4 是否属于内网/回环/链路本地/云元数据/保留段。 */
function isBlockedIpv4Octets([a, b]: [number, number, number, number]): boolean {
	// 注意：不拦截 198.18.0.0/15，因 Clash / Surge / sing-box 等 TUN Fake-IP 模式会将公网域名解析至该段。
	return (
		a === 0 || // 0.0.0.0/8 (this network)
		a === 10 || // 10.0.0.0/8 (RFC1918)
		(a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT RFC6598)
		a === 127 || // 127.0.0.0/8 (loopback)
		(a === 169 && b === 254) || // 169.254.0.0/16 (link-local / cloud metadata)
		(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (RFC1918)
		(a === 192 && b === 168) || // 192.168.0.0/16 (RFC1918)
		a >= 224 // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved/broadcast)
	);
}

/**
 * 将任意合法 IPv6 字符串（含 :: 压缩及末尾 점分 IPv4）展开为 8 个 16-bit 整数（0..0xffff）。
 * 解析失败返回 null。
 */
function expandIpv6Words(rawInput: string): number[] | null {
	// 去掉 zone index（如 fe80::1%eth0 或 %25eth0）
	const input = rawInput.split("%")[0].toLowerCase();
	if (!input.includes(":")) return null;

	let working = input;
	// 若末尾带点分 IPv4（如 ::ffff:127.0.0.1 或 ::ffff:0:127.0.0.1），先转成两个 16-bit hex 段
	const lastColon = working.lastIndexOf(":");
	const tail = working.slice(lastColon + 1);
	if (tail.includes(".")) {
		const octets = parseIpv4Octets(tail);
		if (!octets) return null;
		const hi = ((octets[0] << 8) | octets[1]).toString(16);
		const lo = ((octets[2] << 8) | octets[3]).toString(16);
		working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const doubleColonParts = working.split("::");
	if (doubleColonParts.length > 2) return null;

	const parseSide = (side: string): number[] | null => {
		if (!side) return [];
		const parts = side.split(":");
		const words: number[] = [];
		for (const p of parts) {
			if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
			words.push(parseInt(p, 16));
		}
		return words;
	};

	if (doubleColonParts.length === 2) {
		const left = parseSide(doubleColonParts[0]);
		const right = parseSide(doubleColonParts[1]);
		if (!left || !right) return null;
		const missing = 8 - (left.length + right.length);
		if (missing < 1) return null;
		return [...left, ...new Array(missing).fill(0), ...right];
	}

	const full = parseSide(working);
	if (!full || full.length !== 8) return null;
	return full;
}

/**
 * 判断 8×16-bit IPv6 地址是否内嵌了 IPv4：
 * - IPv4-mapped:     0:0:0:0:0:ffff:w6:w7
 * - IPv4-translated: 0:0:0:0:ffff:0:w6:w7 (RFC 2765 SIIT)
 * - IPv4-compatible: 0:0:0:0:0:0:w6:w7 (排除 ::0 与 ::1)
 * - NAT64 well-known prefix: 64:ff9b:0:0:0:0:w6:w7 或 64:ff9b:1::/48
 */
function extractEmbeddedIpv4(w: number[]): [number, number, number, number] | null {
	const isMapped = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff;
	const isTranslated = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0;
	const isCompatible =
		w[0] === 0 &&
		w[1] === 0 &&
		w[2] === 0 &&
		w[3] === 0 &&
		w[4] === 0 &&
		w[5] === 0 &&
		!(w[6] === 0 && (w[7] === 0 || w[7] === 1));
	const isNat64 = w[0] === 0x0064 && w[1] === 0xff9b && w[3] === 0 && w[4] === 0 && w[5] === 0;

	if (isMapped || isTranslated || isCompatible || isNat64) {
		return [(w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff];
	}
	return null;
}

/** SSRF 收口：内网/回环/链路本地/云元数据地址一律拒绝。 */
export function isBlockedHost(hostname: string): boolean {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "");
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}

	// 1. IPv6 字面量（含 ::ffff:7f00:1 / ::ffff:0:7f00:1 / 0:0:0:0:0:ffff:... 等所有展开或压缩变体）
	if (host.includes(":")) {
		const words = expandIpv6Words(host);
		if (!words) return true; // 非法 IPv6 字面量一律拒绝
		const embeddedV4 = extractEmbeddedIpv4(words);
		if (embeddedV4) {
			return isBlockedIpv4Octets(embeddedV4);
		}
		const allZeroPrefix =
			words[0] === 0 &&
			words[1] === 0 &&
			words[2] === 0 &&
			words[3] === 0 &&
			words[4] === 0 &&
			words[5] === 0 &&
			words[6] === 0;
		// :: (unspecified) 或 ::1 (loopback)
		if (allZeroPrefix && (words[7] === 0 || words[7] === 1)) return true;
		// fe80::/10 (link-local)
		if ((words[0] & 0xffc0) === 0xfe80) return true;
		// fc00::/7 (ULA unique local fc00::..fdff::)
		if ((words[0] & 0xfe00) === 0xfc00) return true;
		// ff00::/8 (multicast)
		if ((words[0] & 0xff00) === 0xff00) return true;
		// 2001:db8::/32 (documentation)
		if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
		return false;
	}

	// 2. 标准点分 IPv4
	const v4 = parseIpv4Octets(host);
	if (v4) {
		return isBlockedIpv4Octets(v4);
	}

	// 3. 非常规纯数字/十六进制/八进制单段或多段 IPv4 变形（如 2130706433、0x7f000001、127.1）
	// URL 构造器通常会规范化，若仍有纯数字结尾段则拒绝
	if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(host)) {
		return true;
	}

	return false;
}

/** 同步校验一个可抓取地址：只允许 http/https 且 hostname 非内网/回环。 */
export function validateFetchUrl(raw: string): { ok: true; url: string } | { ok: false; reason: "scheme" | "host" } {
	let u: URL;
	try {
		u = new URL(String(raw ?? "").trim());
	} catch {
		return { ok: false, reason: "scheme" };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
	if (isBlockedHost(u.hostname)) return { ok: false, reason: "host" };
	return { ok: true, url: u.toString() };
}

/**
 * 异步校验 URL + 解析后 IP（防 DNS rebinding 指向 127.0.0.1 / 169.254.169.254 等内网地址）。
 *
 * - 先执行 validateFetchUrl；
 * - 若 hostname 是域名（非 IP 字面量），调用 lookup 解析全部 A/AAAA 记录；
 * - 任一解析出的 IP 命中 isBlockedHost，或解析无结果/报错，均判定为 reason: "host"。
 */
export async function resolveAndValidateUrl(
	raw: string,
	opts: { lookup?: LookupAllFn } = {},
): Promise<{ ok: true; url: string; addresses: string[] } | { ok: false; reason: "scheme" | "host" }> {
	const sync = validateFetchUrl(raw);
	if (!sync.ok) return sync;

	const u = new URL(sync.url);
	const bareHost = u.hostname.replace(/^\[|\]$/g, "");
	if (isIP(bareHost) !== 0) {
		return { ok: true, url: sync.url, addresses: [bareHost] };
	}

	const lookupFn = opts.lookup ?? defaultLookupAll;
	try {
		const records = await lookupFn(bareHost);
		if (!Array.isArray(records) || records.length === 0) {
			return { ok: false, reason: "host" };
		}
		const addresses: string[] = [];
		for (const rec of records) {
			const addr = typeof rec?.address === "string" ? rec.address.trim() : "";
			if (!addr || isBlockedHost(addr)) {
				return { ok: false, reason: "host" };
			}
			addresses.push(addr);
		}
		return { ok: true, url: sync.url, addresses };
	} catch {
		return { ok: false, reason: "host" };
	}
}

export interface SafeFetchOptions {
	fetcher?: (url: string, init: RequestInit) => Promise<Response>;
	lookup?: LookupAllFn;
	/** 是否跳过默认 DNS 解析校验（仅当注入了纯内存 mock fetcher 且未显式提供 lookup 时默认跳过）。 */
	skipDnsLookup?: boolean;
	maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 带 SSRF 收口（URL 校验 + DNS 解析后 IP 校验 + 重定向逐跳校验）的安全 fetch 封装。
 */
export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOptions = {}): Promise<Response> {
	const fetcher = opts.fetcher ?? ((u: string, i: RequestInit) => fetch(u, i));
	const useDns =
		opts.skipDnsLookup !== undefined ? !opts.skipDnsLookup : !!opts.lookup || (!opts.fetcher && isNativeGlobalFetch());
	const maxRedirects = opts.maxRedirects ?? 5;

	let currentUrl = url;
	let currentInit: RequestInit = { ...init, redirect: "manual" };

	for (let hop = 0; hop <= maxRedirects; hop++) {
		const check = useDns
			? await resolveAndValidateUrl(currentUrl, { lookup: opts.lookup })
			: validateFetchUrl(currentUrl);
		if (!check.ok) {
			throw new Error(
				check.reason === "scheme"
					? `Blocked URL scheme: ${currentUrl}`
					: `Blocked private or internal host: ${currentUrl}`,
			);
		}
		currentUrl = check.url;

		const res = await fetcher(currentUrl, currentInit);
		if (!REDIRECT_STATUSES.has(res.status)) {
			return res;
		}

		const location = res.headers?.get?.("location");
		if (!location) {
			return res;
		}
		if (hop === maxRedirects) {
			throw new Error(`Too many redirects (> ${maxRedirects})`);
		}

		const nextUrl = new URL(location, currentUrl).toString();
		// 303 或 301/302 POST 重定向按规范退化为 GET
		if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentInit.method === "POST")) {
			currentInit = { ...currentInit, method: "GET", body: undefined };
		}
		currentUrl = nextUrl;
	}

	throw new Error(`Too many redirects (> ${maxRedirects})`);
}
