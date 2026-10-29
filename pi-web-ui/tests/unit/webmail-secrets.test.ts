/**
 * webmail 插件密码持久化回归（见 plugins/webmail/index.mjs）。
 *
 * 修复前：applyConfig 无条件把密码写进 host.secrets 后从内存里抹掉；宿主机密写盘
 * 失败（目录只读/磁盘满，PluginSecrets.set 只 console.error 不抛错）时密码既没进
 * 机密也没留在配置里 —— 表现为「保存后设置里密码没了 + IMAP 报 No password
 * configured」。本测试锁定三条不变式：
 *   1. 机密可用：密码存机密，config.json 不落明文；
 *   2. 机密写入失败：回退明文落盘，绝不丢密码；
 *   3. 二次保存留空 = 沿用已存密码。
 *
 * 插件在缺依赖时会自动 npm install：这里把 npm 指向不可用 registry + offline，
 * 让子进程立刻失败（无网络访问），并在断言后 deactivate 一并回收。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PLUGIN = pathToFileURL(join(process.cwd(), "plugins/webmail/index.mjs")).href;

// 让插件的自动依赖安装立刻失败：不联网、不污染 CI。
process.env.npm_config_offline = "true";
process.env.npm_config_registry = "http://127.0.0.1:9/";
process.env.npm_config_audit = "false";
process.env.npm_config_fund = "false";

/** 插件回传的脱敏配置分节（只断言用得到的字段）。 */
interface PublicSection {
	user: string;
	hasPass: boolean;
}
interface PublicState {
	configured: boolean;
	config: { imap: PublicSection; smtp: PublicSection };
}
interface PluginMessage {
	kind?: string;
	state?: PublicState;
}
/** config.json 落盘形态（只关心密码字段）。 */
interface StoredConfig {
	imap?: { pass?: string };
	smtp?: { pass?: string };
}
/** 视图 → 插件的消息。 */
interface ViewMessage {
	action: string;
	config?: unknown;
}
type PluginModule = { default: { activate: (host: unknown) => () => void } };

interface Harness {
	send: (msg: ViewMessage) => void;
	state: () => PublicState | null;
	configFile: () => StoredConfig | null;
	stop: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起一个插件实例：dir/secrets 由调用方提供，可跨实例复用以模拟重启。 */
async function activate(dir: string, secrets: Map<string, string>, failSecretWrites = false): Promise<Harness> {
	const mod = (await import(PLUGIN)) as PluginModule;
	const sent: PluginMessage[] = [];
	let handler: ((msg: ViewMessage, from?: string) => void) | null = null;
	const host = {
		dir,
		log: () => {},
		notify: () => {},
		broadcast: (p: PluginMessage) => sent.push(p),
		sendTo: (_clientId: string, p: PluginMessage) => sent.push(p),
		onMessage: (h: (msg: ViewMessage, from?: string) => void) => {
			handler = h;
			return () => {};
		},
		onToolEvent: () => () => {},
		onAttach: () => () => {},
		onCwdChange: () => () => {},
		registerAgentTool: () => () => {},
		registerBackgroundTask: () => ({ unregister() {} }),
		storage: { get: () => undefined, set() {}, delete() {}, all: () => ({}) },
		secrets: {
			set: (n: string, v: string) => {
				if (failSecretWrites) return; // 静默失败：与宿主写盘失败同形
				secrets.set(n, String(v));
			},
			get: (n: string) => secrets.get(n),
			has: (n: string) => secrets.has(n),
			delete: (n: string) => secrets.delete(n),
			list: () => [...secrets.keys()],
		},
	};
	const dispose = mod.default.activate(host);
	await sleep(120);
	return {
		send: (msg) => handler?.(msg, "c1"),
		state: () => {
			for (let i = sent.length - 1; i >= 0; i--) {
				const m = sent[i];
				if (m?.kind === "state" && m.state) return m.state;
			}
			return null;
		},
		configFile: () => {
			const f = join(dir, "config.json");
			return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as StoredConfig) : null;
		},
		stop: () => dispose(),
	};
}

function fullConfig(pass?: string): unknown {
	const imap = { host: "imap.example.com", port: 993, tls: true, user: "u@example.com", ...(pass ? { pass } : {}) };
	const smtp = {
		host: "smtp.example.com",
		port: 465,
		tls: true,
		user: "u@example.com",
		from: "u@example.com",
		...(pass ? { pass } : {}),
	};
	return { imap, smtp, pollSec: 60, notifyEnabled: true, aiEnabled: false };
}

const dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "webmail-test-"));
	dirs.push(d);
	return d;
}

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("webmail 密码持久化", () => {
	it("机密可用：密码入机密、config.json 不落明文、重启后仍在", async () => {
		const dir = tempDir();
		const secrets = new Map<string, string>();
		let h = await activate(dir, secrets);
		h.send({ action: "save_config", config: fullConfig("SECRET123") });
		await sleep(200);
		h.send({ action: "get_state" });
		await sleep(50);

		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		expect(h.configFile()?.imap?.pass).toBe(""); // 明文不落盘
		expect(secrets.get("imap_pass")).toBe("SECRET123");
		h.stop();

		// 重启：机密回填内存副本
		h = await activate(dir, secrets);
		h.send({ action: "get_state" });
		await sleep(50);
		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		h.stop();
	});

	it("机密写入失败：回退明文落盘，密码不丢（修复前会丢）", async () => {
		const dir = tempDir();
		const secrets = new Map<string, string>();
		let h = await activate(dir, secrets, true);
		h.send({ action: "save_config", config: fullConfig("SECRET123") });
		await sleep(200);
		h.send({ action: "get_state" });
		await sleep(50);

		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		expect(h.configFile()?.imap?.pass).toBe("SECRET123"); // 宁可明文，不能丢
		expect(h.configFile()?.smtp?.pass).toBe("SECRET123");
		h.stop();

		// 重启后依然可用（否则 IMAP 会报 No password configured）
		h = await activate(dir, secrets, true);
		h.send({ action: "get_state" });
		await sleep(50);
		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		h.stop();
	});

	it("二次保存留空 = 沿用已存密码", async () => {
		const dir = tempDir();
		const secrets = new Map<string, string>();
		const h = await activate(dir, secrets);
		h.send({ action: "save_config", config: fullConfig("SECRET123") });
		await sleep(200);
		h.send({ action: "save_config", config: fullConfig() }); // 密码框留空
		await sleep(200);
		h.send({ action: "get_state" });
		await sleep(50);

		expect(h.state()?.config?.imap?.hasPass).toBe(true);
		expect(secrets.get("imap_pass")).toBe("SECRET123");
		h.stop();
	});
});
