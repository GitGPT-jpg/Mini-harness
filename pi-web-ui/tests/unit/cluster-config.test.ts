/**
 * 集群配置与探测（server/loop/cluster-config.ts + /api/mini-harness/cluster）。
 * 全部用替身 kubectl（shell 脚本，按 mode 文件决定输出）和临时 HOME / 数据目录，
 * 不碰真实 ~/.kube、~/.pi-web 与 process.env.KUBECONFIG；token 一律是假值。
 */
import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClusterConfig, classifyKubectlFailure } from "../../server/loop/cluster-config.js";

const ROOT = mkdtempSync(join(tmpdir(), "cluster-config-"));
const previousRunsRoot = process.env.MINI_HARNESS_RUNTIME_ROOT;
process.env.MINI_HARNESS_RUNTIME_ROOT = join(ROOT, "runs");
const { registerLoopRoutes } = await import("../../server/loop/routes.js");
if (previousRunsRoot === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
else process.env.MINI_HARNESS_RUNTIME_ROOT = previousRunsRoot;

const TOKEN = "FAKE-TOKEN-7f3a9c";

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let seq = 0;
/** 一套隔离环境：替身 kubectl + 临时 HOME + 数据目录 + 独立环境对象。 */
function sandbox(opts: { kubeconfigEnv?: string; defaultConfig?: boolean; noKubectl?: boolean } = {}) {
	const dir = join(ROOT, `s${++seq}`);
	const bin = join(dir, "bin");
	const home = join(dir, "home");
	const dataDir = join(dir, "data");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const kubectl = join(bin, "kubectl");
	writeFileSync(
		kubectl,
		`#!/bin/sh
d="$(dirname "$0")"
echo "ARGS=$* KUBECONFIG=\${KUBECONFIG-<unset>}" >> "$d/calls.log"
case "$*" in
  *"config current-context"*) echo "ctx-test"; exit 0;;
  *cluster-info*) echo 'Error from server (Forbidden): services is forbidden: cannot list resource "services" in the namespace "kube-system"' >&2; exit 1;;
esac
[ -f "$d/delay" ] && sleep "$(cat "$d/delay")"
case "$(cat "$d/mode" 2>/dev/null)" in
  ok) echo '{"gitVersion":"v1.28.3","note":"${TOKEN}"}'; echo "Bearer ${TOKEN}" >&2; exit 0;;
  unauthorized) echo "error: You must be logged in to the server (Unauthorized) Bearer ${TOKEN}" >&2; exit 1;;
  forbidden) echo 'Error from server (Forbidden): User "u" cannot get path "/version" token=${TOKEN}' >&2; exit 1;;
  tls) echo "Unable to connect to the server: x509: certificate signed by unknown authority ${TOKEN}" >&2; exit 1;;
  network) echo "Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused ${TOKEN}" >&2; exit 1;;
  hang) sleep 30;;
  *) echo "odd failure ${TOKEN}" >&2; exit 1;;
esac
`,
	);
	chmodSync(kubectl, 0o755);
	const setMode = (m: string) => writeFileSync(join(bin, "mode"), m);
	setMode("ok");
	if (opts.defaultConfig) {
		mkdirSync(join(home, ".kube"));
		writeFileSync(join(home, ".kube", "config"), "apiVersion: v1\nkind: Config\n");
	}
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
	if (opts.kubeconfigEnv !== undefined) env.KUBECONFIG = opts.kubeconfigEnv;
	const calls = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : "");
	const make = () =>
		new ClusterConfig({
			dataDir,
			env,
			home,
			kubectl: opts.noKubectl ? join(bin, "missing-kubectl") : kubectl,
			probeTimeoutMs: 300,
		});
	return { dir, bin, home, dataDir, env, setMode, calls, make };
}

describe("classifyKubectlFailure", () => {
	it("401/403/TLS/网络/超时/配置错误各自归类，未知错误不冒充网络断开", () => {
		const e = { code: 1 };
		expect(classifyKubectlFailure(null, "")).toBe("ok");
		expect(classifyKubectlFailure({ code: "ENOENT" }, "")).toBe("no-kubectl");
		expect(classifyKubectlFailure({ killed: true, signal: "SIGKILL" }, "")).toBe("timeout");
		expect(classifyKubectlFailure(e, "error: You must be logged in to the server (Unauthorized)")).toBe("unauthorized");
		expect(classifyKubectlFailure(e, "Error from server (Forbidden): forbidden")).toBe("forbidden");
		expect(classifyKubectlFailure(e, "Unable to connect to the server: x509: certificate has expired")).toBe("tls");
		expect(classifyKubectlFailure(e, "Unable to connect to the server: net/http: TLS handshake timeout")).toBe(
			"timeout",
		);
		expect(classifyKubectlFailure(e, "Unable to connect to the server: dial tcp: i/o timeout")).toBe("timeout");
		expect(classifyKubectlFailure(e, "Unable to connect to the server: dial tcp: connect: connection refused")).toBe(
			"network",
		);
		expect(classifyKubectlFailure(e, "error: no configuration has been provided")).toBe("config-invalid");
		expect(classifyKubectlFailure(e, "something else")).toBe("error");
	});
});

describe("ClusterConfig：来源优先级与新任务配置", () => {
	it("先连接后启动：继承的 KUBECONFIG（多路径）被识别为 env，按 kubectl 正常解析而不是塞进 --kubeconfig", async () => {
		const sb = sandbox();
		const a = join(sb.dir, "a.yaml");
		const b = join(sb.dir, "b.yaml");
		writeFileSync(a, "x");
		writeFileSync(b, "y");
		sb.env.KUBECONFIG = `${a}${delimiter}${b}`;
		const c = sb.make();
		expect(c.target()).toMatchObject({ source: "env", kubeconfig: `${a}${delimiter}${b}` });
		const st = await c.status(true);
		expect(st).toMatchObject({ configured: true, connected: true, code: "ok", source: "env", envPathCount: 2 });
		expect(st.context).toBe("ctx-test");
		expect(st.serverVersion).toBe("v1.28.3");
		expect(sb.calls()).toContain(`ARGS=get --raw=/version --request-timeout=1s KUBECONFIG=${a}${delimiter}${b}`);
		expect(sb.calls()).not.toContain("--kubeconfig");
		expect(sb.env.KUBECONFIG).toBe(`${a}${delimiter}${b}`);
	});

	it("只有 ~/.kube/config：source=default，探测与新任务都不设 KUBECONFIG", async () => {
		const sb = sandbox({ defaultConfig: true });
		const c = sb.make();
		expect(c.target()).toMatchObject({ source: "default", kubeconfig: null });
		expect(sb.env.KUBECONFIG).toBeUndefined();
		expect(await c.status(true)).toMatchObject({ code: "ok", source: "default" });
		expect(sb.calls()).toContain("KUBECONFIG=<unset>");
		expect(c.envFor(c.target(), { KUBECONFIG: "/stale", A: "1" })).toEqual({ A: "1" });
	});

	it("Web 导入优先于 env/default；清除后回退到启动时的 KUBECONFIG（不再丢失），新任务配置随之切换", async () => {
		const sb = sandbox({ defaultConfig: true });
		const ext = join(sb.dir, "ext.yaml");
		writeFileSync(ext, "x");
		sb.env.KUBECONFIG = ext;
		const c = sb.make();
		expect(c.save(`apiVersion: v1\nusers:\n- user:\n    token: ${TOKEN}\n`)).toEqual({ ok: true });
		const app = c.target();
		expect(app.source).toBe("app");
		expect(sb.env.KUBECONFIG).toBe(app.kubeconfig);
		expect(statSync(app.kubeconfig!).mode & 0o777).toBe(0o600);
		expect(statSync(join(sb.dataDir, "kubeconfig.d")).mode & 0o777).toBe(0o700);
		const st = await c.status(true);
		expect(st).toMatchObject({ source: "app", shadowed: ["env", "default"], code: "ok" });
		expect(sb.calls()).toContain(`--kubeconfig ${app.kubeconfig} get --raw=/version`);
		const cleared = c.clear();
		expect(cleared).toEqual({ ok: true, retainedForTasks: 0 });
		expect(existsSync(app.kubeconfig!)).toBe(false);
		expect(c.target()).toMatchObject({ source: "env", kubeconfig: ext });
		expect(sb.env.KUBECONFIG).toBe(ext);
		expect(c.target().generation).toBeGreaterThan(app.generation);
		// 重启后不复活已清除的配置
		expect(sb.make().target().source).toBe("env");
	});

	it("旧启动脚本把应用文件导出成 KUBECONFIG：识别为 app 来源，清除后不残留指向已删文件的变量", () => {
		const sb = sandbox();
		const legacy = join(sb.dataDir, "kubeconfig");
		writeFileSync(legacy, "x", { mode: 0o600 });
		sb.env.KUBECONFIG = legacy;
		const c = sb.make();
		expect(c.target()).toMatchObject({ source: "app", kubeconfig: legacy });
		c.clear();
		expect(existsSync(legacy)).toBe(false);
		expect(c.target().source).toBe("none");
		expect(sb.env.KUBECONFIG).toBeUndefined();
	});

	it("再次导入写新版本、不覆盖：已绑定旧版本的任务保持原目标，释放后才回收", () => {
		const sb = sandbox();
		const c = sb.make();
		c.save("first");
		const bound = c.bind("run-1");
		c.save("second");
		const next = c.target();
		expect(next.kubeconfig).not.toBe(bound.kubeconfig);
		expect(readFileSync(bound.kubeconfig!, "utf8")).toBe("first");
		expect(c.envFor(bound).KUBECONFIG).toBe(bound.kubeconfig);
		expect(c.clear()).toEqual({ ok: true, retainedForTasks: 1 });
		expect(readFileSync(bound.kubeconfig!, "utf8")).toBe("first");
		expect(existsSync(next.kubeconfig!)).toBe(false);
		c.release("run-1");
		expect(existsSync(bound.kubeconfig!)).toBe(false);
	});

	it("写入失败：返回 write-failed，原配置不变且不留半截文件", () => {
		const sb = sandbox();
		const legacy = join(sb.dataDir, "kubeconfig");
		writeFileSync(legacy, "good", { mode: 0o600 });
		const c = sb.make();
		const before = c.target();
		// kubeconfig.d 被一个普通文件占住：建目录 / 写版本文件都会失败
		writeFileSync(join(sb.dataDir, "kubeconfig.d"), "");
		expect(c.save(`token: ${TOKEN}`)).toEqual({ ok: false, code: "write-failed" });
		expect(c.target()).toEqual(before);
		expect(readFileSync(legacy, "utf8")).toBe("good");
		expect(readdirSync(sb.dataDir).sort()).toEqual(["kubeconfig", "kubeconfig.d"]);
	});
});

describe("ClusterConfig：探测语义", () => {
	it("cluster-info 被 kube-system 拒绝不影响结果：/version 成功即 API 可达，且从不调用 cluster-info", async () => {
		const sb = sandbox();
		const c = sb.make();
		c.save("x");
		expect(await c.status(true)).toMatchObject({ connected: true, code: "ok" });
		expect(sb.calls()).not.toContain("cluster-info");
	});

	it("缺 kubectl / 401 / 403 / TLS / 网络 / 超时 / 未知错误可区分", async () => {
		const missing = sandbox({ noKubectl: true }).make();
		missing.save("x");
		expect((await missing.status(true)).code).toBe("no-kubectl");
		const sb = sandbox();
		const c = sb.make();
		c.save("x");
		for (const [mode, code] of [
			["unauthorized", "unauthorized"],
			["forbidden", "forbidden"],
			["tls", "tls"],
			["network", "network"],
			["weird", "error"],
			["hang", "timeout"],
		] as const) {
			sb.setMode(mode);
			const st = await c.status(true);
			expect(st.code, mode).toBe(code);
			expect(st.connected).toBe(false);
			expect(st.configured).toBe(true);
		}
	}, 20_000);

	it("A 探测晚返回、B 已导入：GET 拿到的是 B 的结果，A 不进缓存", async () => {
		const sb = sandbox({ defaultConfig: true });
		const c = sb.make();
		writeFileSync(join(sb.bin, "delay"), "0.4");
		const pending = c.status(true);
		await new Promise((r) => setTimeout(r, 100));
		c.save("B");
		const st = await pending;
		expect(st.source).toBe("app");
		expect(st.generation).toBe(c.target().generation);
		expect((await c.status()).generation).toBe(c.target().generation);
	});

	it("清除后旧探测才成功：结果按回退后的配置给出", async () => {
		const sb = sandbox();
		const c = sb.make();
		c.save("A");
		writeFileSync(join(sb.bin, "delay"), "0.4");
		const pending = c.status(true);
		await new Promise((r) => setTimeout(r, 100));
		c.clear();
		const st = await pending;
		expect(st).toMatchObject({ source: "none", code: "not-configured", configured: false });
	});
});

describe("/api/mini-harness/cluster：凭据不出接口", () => {
	it("stdout/stderr/输入里的 token 不出现在任何响应；JSON 解析错误也只回固定文案", async () => {
		const sb = sandbox();
		const app = express();
		app.use(express.json());
		registerLoopRoutes(app, {
			dataDir: sb.dataDir,
			agentDir: join(sb.dir, "agent"),
			cluster: { env: sb.env, home: sb.home, kubectl: join(sb.bin, "kubectl"), probeTimeoutMs: 300 },
		});
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((r) => server.once("listening", () => r()));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const post = (p: string, body: string) =>
			fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body });
		const bodies: string[] = [];
		try {
			const none = await (await fetch(`${base}/api/mini-harness/cluster`)).text();
			bodies.push(none);
			expect(JSON.parse(none)).toMatchObject({ configured: false, code: "not-configured", source: "none" });
			for (const mode of ["ok", "unauthorized", "forbidden", "tls", "network", "weird"]) {
				sb.setMode(mode);
				const r = await post("/api/mini-harness/cluster", JSON.stringify({ kubeconfig: `token: ${TOKEN}\n` }));
				expect(r.status).toBe(200);
				bodies.push(await r.text());
				bodies.push(await (await fetch(`${base}/api/mini-harness/cluster?refresh=1`)).text());
			}
			const bad = await post("/api/mini-harness/cluster", `{"kubeconfig": "token: ${TOKEN}`);
			expect(bad.status).toBe(400);
			bodies.push(await bad.text());
			expect((await post("/api/mini-harness/cluster", JSON.stringify({ kubeconfig: "  " }))).status).toBe(400);
			const cleared = await post("/api/mini-harness/cluster/clear", "{}");
			const cj = await cleared.json();
			expect(cj).toMatchObject({ ok: true, source: "none", code: "not-configured" });
			bodies.push(JSON.stringify(cj));
		} finally {
			server.close();
		}
		for (const b of bodies) expect(b).not.toContain(TOKEN);
		const keys = new Set(bodies.flatMap((b) => Object.keys(JSON.parse(b))));
		for (const k of keys)
			expect([
				"configured",
				"connected",
				"code",
				"message",
				"source",
				"envPathCount",
				"shadowed",
				"context",
				"serverVersion",
				"generation",
				"instance",
				"checkedAt",
				"ok",
				"retainedForTasks",
				"error",
			]).toContain(k);
	});
});
