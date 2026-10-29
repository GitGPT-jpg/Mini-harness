/**
 * 监听端口解析单测：`snapshotListeningPorts` 的跨平台文本解析。
 *
 * 为什么单独测：命令输出格式随平台/发行版变化，而这两种解析是「后台任务」面板
 * 唯一的发现通道 —— 解析错一列，功能静默失效（无报错、无输出、只是列表一直空）。
 * 真实命令行（带表头、IPv4/IPv6、`(LISTEN)` 在 NAME 里 / 自成最后一列）都覆盖。
 */
import { describe, expect, it } from "vitest";
import { parseLsofListening, parseNetstatListening } from "../../server/process-utils.js";

describe("parseNetstatListening", () => {
	it("解析 IPv4 / IPv6 监听行（netstat -ano -p tcp）", () => {
		const out = [
			"活动连接",
			"",
			"  协议  本地地址          外部地址        状态           PID",
			"  TCP    0.0.0.0:5173     0.0.0.0:0       LISTENING       12345",
			"  TCP    127.0.0.1:8787   0.0.0.0:0       LISTENING       6789",
			"  TCP    [::1]:9000       [::]:0          LISTENING       4321",
			// 非 LISTENING 的连接不进表
			"  TCP    127.0.0.1:54321  127.0.0.1:5173  ESTABLISHED     12345",
			"  UDP    0.0.0.0:5353     *:*                             9999",
		].join("\r\n");
		const ports = parseNetstatListening(out);
		expect([...ports.entries()].sort((a, b) => a[0] - b[0])).toEqual([
			[5173, 12345],
			[8787, 6789],
			[9000, 4321],
		]);
	});

	it("空输出 / 表头 / 脏行不抛错", () => {
		expect(parseNetstatListening("").size).toBe(0);
		expect(parseNetstatListening("协议 本地地址 外部地址 状态 PID").size).toBe(0);
		expect(parseNetstatListening("TCP ??? LISTENING nan").size).toBe(0);
	});
});

describe("parseLsofListening", () => {
	const header = "COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME";

	it("`(LISTEN)` 自成最后一列时也能取到 NAME 里的端口（旧实现取最后一列 → 整段失效）", () => {
		const out = [
			header,
			"node    12345  user   23u  IPv4  123456      0t0  TCP  *:5173 (LISTEN)",
			"node     6789  user   24u  IPv6  234567      0t0  TCP  [::1]:9000 (LISTEN)",
		].join("\n");
		expect([...parseLsofListening(out).entries()].sort((a, b) => a[0] - b[0])).toEqual([
			[5173, 12345],
			[9000, 6789],
		]);
	});

	it("`(LISTEN)` 贴在 NAME 列里同样能解析（BSD/macOS 风格）", () => {
		const out = [
			header,
			"node    12345  user   23u  IPv4  123456      0t0  TCP  127.0.0.1:8787",
			"python   3210  user    5u  IPv6  987654      0t0  TCP  *:8080",
		].join("\n");
		expect([...parseLsofListening(out).entries()].sort((a, b) => a[0] - b[0])).toEqual([
			[8080, 3210],
			[8787, 12345],
		]);
	});

	it("空输出 / 只有表头 / 端口越界不抛错", () => {
		expect(parseLsofListening("").size).toBe(0);
		expect(parseLsofListening(header).size).toBe(0);
		// 端口 99999 越界 → 丢弃
		expect(parseLsofListening(`${header}\nnode 1 u 3u IPv4 1 0t0 TCP *:99999`).size).toBe(0);
	});
});
