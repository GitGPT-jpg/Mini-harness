/**
 * 运行中任务的集群绑定（cluster-config.ts 的 bindTask / envForTask / releaseTask）与命令入口：
 * Agent Bash（bash-tool spawnHook）、validator（operation.ts runner 环境）、任务终端（TerminalManager.envFor）。
 * 两集群回归：任务 A 绑定配置 A 后导入配置 B，A 新起的进程仍连 A，新任务 B 连 B。
 * 替身 kubectl 只记录目标 server（不记凭据）；所有 token 都是假值，断言日志与绑定记录里没有它们。
 */
import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cluster-binding-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = join(ROOT, "runs");
const BIN = join(ROOT, "bin");
mkdirSync(BIN, { recursive: true });
const LOG = join(BIN, "calls.log");
// 替身 kubectl：config view 原样吐出生效的配置；其余命令记下目标 server（取自生效配置）。
writeFileSync(
	join(BIN, "kubectl"),
	`#!/bin/sh
cfg=""
prev=""
for a in "$@"; do [ "$prev" = "--kubeconfig" ] && cfg="$a"; prev="$a"; done
[ -z "$cfg" ] && cfg="\${KUBECONFIG:-$HOME/.kube/config}"
case "$*" in
  *"config view"*) cat "$cfg"; exit $?;;
esac
echo "TARGET=$(grep -m1 'server:' "$cfg" 2>/dev/null | sed 's/.*server: *//')" >> "${join(BIN, "calls.log")}"
echo '{"gitVersion":"v1.28.3"}'
`,
);
chmodSync(join(BIN, "kubectl"), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

const { ClusterConfig, setActiveClusterConfig } = await import("../../server/loop/cluster-config.js");
const { makeKillableBashTool } = await import("../../server/bash-tool.js");
const { runCommandPersistent } = await import("../../server/loop/operation.js");
const { TerminalManager } = await import("../../server/terminals.js");

afterAll(() => {
	setActiveClusterConfig(null);
	rmSync(ROOT, { recursive: true, force: true });
});

const TOKEN_A = "FAKE-TOKEN-AAA111";
const TOKEN_B = "FAKE-TOKEN-BBB222";
const kubeconfig = (server: string, ctx: string, token: string) =>
	`apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: ${server}\ncontexts:\n- name: ${ctx}\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    token: ${token}\ncurrent-context: ${ctx}\n`;
const targets = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
const lastTarget = () => targets().trim().split("\n").at(-1) ?? "";
const RUN_A = "20261104000000-aaaa";
const RUN_B = "20261104000000-bbbb";

function setup(name: string) {
	const dir = join(ROOT, name);
	const home = join(dir, "home");
	const dataDir = join(dir, "data");
	mkdirSync(home, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const extFile = join(dir, "a.yaml");
	writeFileSync(extFile, kubeconfig("https://a.example", "ctx-a", TOKEN_A));
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, KUBECONFIG: extFile };
	const make = () => new ClusterConfig({ dataDir, env, home, kubectl: join(BIN, "kubectl"), probeTimeoutMs: 300 });
	return { dir, home, dataDir, extFile, env, make };
}

async function bashTarget(envFor: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv): Promise<string> {
	const tool = makeKillableBashTool(ROOT, new Set(), () => "en", envFor);
	await tool.execute(
		"t1",
		{ command: "kubectl get --raw=/version" } as never,
		undefined,
		undefined,
		undefined as never,
	);
	return lastTarget();
}

describe("两集群回归：运行中任务保持绑定的目标", () => {
	it("A 启动后导入 B：A 的 Bash / validator / 任务终端仍连 A，新任务 B 连 B；外部改写与清除不影响已绑定任务", async () => {
		const s = setup("two");
		const cc = s.make();
		setActiveClusterConfig(cc);
		const a = await cc.bindTask(`run:${RUN_A}`);
		expect(a).toMatchObject({ source: "env", status: "pinned", context: "ctx-a" });
		expect(cc.save(kubeconfig("https://b.example", "ctx-b", TOKEN_B))).toEqual({ ok: true });
		const b = await cc.bindTask(`run:${RUN_B}`);
		expect(b).toMatchObject({ source: "app", status: "pinned" });

		// Agent Bash（spawnHook）
		expect(await bashTarget((env) => cc.envForTask(`run:${RUN_A}`, env))).toBe("TARGET=https://a.example");
		expect(await bashTarget((env) => cc.envForTask(`run:${RUN_B}`, env))).toBe("TARGET=https://b.example");
		// validator / precheck（operation runner 继承绑定环境）
		for (const [runId, server] of [
			[RUN_A, "https://a.example"],
			[RUN_B, "https://b.example"],
		] as const) {
			const res = await runCommandPersistent("kubectl", ["get", "--raw=/version"], {
				cwd: ROOT,
				runId,
				stage: "validate",
				round: 1,
			});
			expect(res.code).toBe(0);
			expect(lastTarget()).toBe(`TARGET=${server}`);
		}
		// 外部改写继承的配置文件：已绑定的 A 用的是快照，不受影响；没绑定的新任务按当前配置
		writeFileSync(s.extFile, kubeconfig("https://evil.example", "ctx-evil", TOKEN_A));
		expect(await bashTarget((env) => cc.envForTask(`run:${RUN_A}`, env))).toBe("TARGET=https://a.example");
		cc.clear();
		expect(await bashTarget((env) => cc.envForTask("run:new-task", env))).toBe("TARGET=https://evil.example");
		// 清除 Web 导入后，仍在运行的 B 继续用它的导入版本
		expect(await bashTarget((env) => cc.envForTask(`run:${RUN_B}`, env))).toBe("TARGET=https://b.example");

		// 任务终端：PTY 也走绑定环境
		const mgr = new TerminalManager(() => {}, ROOT);
		mgr.envFor = (env) => cc.envForTask(`run:${RUN_A}`, env) as Record<string, string>;
		const before = targets().length;
		mgr.create("bind-term", ROOT, 80, 24, ROOT, "bind", { forceBash: true });
		mgr.input("bind-term", "kubectl get --raw=/version; exit\r");
		const t0 = Date.now();
		while (targets().length === before && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
		mgr.killAll();
		expect(lastTarget()).toBe("TARGET=https://a.example");

		// 释放：快照与导入版本都被回收；日志与绑定记录不含凭据
		const store = readFileSync(join(s.dataDir, "kubeconfig.d", "bindings.json"), "utf8");
		expect(statSync(join(s.dataDir, "kubeconfig.d", "bindings.json")).mode & 0o777).toBe(0o600);
		expect(store).not.toContain(TOKEN_A);
		expect(store).not.toContain(TOKEN_B);
		expect(targets()).not.toContain("FAKE-TOKEN");
		const files = () => readFileSync(join(s.dataDir, "kubeconfig.d", "bindings.json"), "utf8");
		cc.releaseTask(`run:${RUN_B}`);
		cc.releaseTask(`run:${RUN_A}`);
		expect(JSON.parse(files())).toEqual({});
		const left = (await import("node:fs"))
			.readdirSync(join(s.dataDir, "kubeconfig.d"))
			.filter((n) => n.endsWith(".yaml"));
		expect(left.filter((n) => n.startsWith("bound-") || n.startsWith("kc-"))).toEqual([]);
	}, 30_000);

	it("并发任务各用各的绑定；释放一个不影响另一个", async () => {
		const s = setup("concurrent");
		const cc = s.make();
		await cc.bindTask("goal:conv-1");
		cc.save(kubeconfig("https://b.example", "ctx-b", TOKEN_B));
		await cc.bindTask("goal:conv-2");
		cc.save(kubeconfig("https://c.example", "ctx-c", TOKEN_B));
		expect(await bashTarget((env) => cc.envForTask("goal:conv-1", env))).toBe("TARGET=https://a.example");
		expect(await bashTarget((env) => cc.envForTask("goal:conv-2", env))).toBe("TARGET=https://b.example");
		cc.releaseTask("goal:conv-2");
		expect(await bashTarget((env) => cc.envForTask("goal:conv-1", env))).toBe("TARGET=https://a.example");
		expect(await bashTarget((env) => cc.envForTask("goal:conv-3", env))).toBe("TARGET=https://c.example");
	});
});

describe("核实不了就受阻，不落到当前全局配置", () => {
	it("快照被改动或缺 kubectl：任务里的 kubectl 指向必然失败的占位配置", async () => {
		const s = setup("blocked");
		const cc = s.make();
		await cc.bindTask(`run:${RUN_A}`);
		const store = JSON.parse(readFileSync(join(s.dataDir, "kubeconfig.d", "bindings.json"), "utf8"));
		const snap = store[`run:${RUN_A}`].file as string;
		writeFileSync(snap, kubeconfig("https://evil.example", "ctx-evil", TOKEN_A));
		expect(await bashTarget((env) => cc.envForTask(`run:${RUN_A}`, env))).toBe(
			"TARGET=https://harness-cluster-binding-blocked.invalid",
		);
		expect(cc.taskBinding(`run:${RUN_A}`)).toMatchObject({ status: "blocked", reason: "snapshot-changed" });

		const missing = new ClusterConfig({
			dataDir: join(s.dir, "data2"),
			env: { ...s.env },
			home: s.home,
			kubectl: join(s.dir, "no-kubectl"),
		});
		expect(await missing.bindTask(`run:${RUN_B}`)).toMatchObject({ status: "blocked", reason: "no-kubectl" });
		expect(missing.envForTask(`run:${RUN_B}`, {}).KUBECONFIG).toMatch(/blocked\.yaml$/);
	});

	it("绑定时没有任何配置：之后导入的配置不会被已运行任务捡到", async () => {
		const s = setup("none");
		const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: s.home };
		const cc = new ClusterConfig({ dataDir: s.dataDir, env, home: s.home, kubectl: join(BIN, "kubectl") });
		expect(await cc.bindTask("goal:conv-x")).toMatchObject({ source: "none", status: "none" });
		cc.save(kubeconfig("https://b.example", "ctx-b", TOKEN_B));
		expect(await bashTarget((e) => cc.envForTask("goal:conv-x", e))).toBe(
			"TARGET=https://harness-cluster-binding-blocked.invalid",
		);
	});

	it("跨重启：run 绑定按持久记录核实后继续用；目标绑定不跨重启，快照被删除", async () => {
		const s = setup("restart");
		const cc = s.make();
		await cc.bindTask(`run:${RUN_A}`);
		await cc.bindTask("goal:conv-1");
		const store = JSON.parse(readFileSync(join(s.dataDir, "kubeconfig.d", "bindings.json"), "utf8"));
		const goalSnap = store["goal:conv-1"].file as string;
		writeFileSync(s.extFile, kubeconfig("https://evil.example", "ctx-evil", TOKEN_A));
		const again = s.make();
		expect(again.taskBinding(`run:${RUN_A}`)).toMatchObject({ status: "pinned", context: "ctx-a" });
		expect(await bashTarget((env) => again.envForTask(`run:${RUN_A}`, env))).toBe("TARGET=https://a.example");
		expect(again.taskBinding("goal:conv-1")).toBeNull();
		expect(existsSync(goalSnap)).toBe(false);
		// 重启后 validator 经 operation.ts 取的同样是持久绑定（当前全局已被外部改写成 evil）
		setActiveClusterConfig(again);
		const res = await runCommandPersistent("kubectl", ["get", "--raw=/version"], {
			cwd: ROOT,
			runId: RUN_A,
			stage: "validate",
			round: 2,
		});
		expect(res.code).toBe(0);
		expect(lastTarget()).toBe("TARGET=https://a.example");
	});
});

describe("快照能否固定 kubeconfig 引用的文件", () => {
	it("残留相对路径引用（tokenFile 等）→ 受阻；绝对路径 / exec 插件 → 固定目标并标记外部凭据", async () => {
		const s = setup("refs");
		writeFileSync(
			s.extFile,
			kubeconfig("https://a.example", "ctx-a", TOKEN_A).replace(`token: ${TOKEN_A}`, "tokenFile: token.txt"),
		);
		const cc = s.make();
		expect(await cc.bindTask(`run:${RUN_A}`)).toMatchObject({ status: "blocked", reason: "snapshot-unpinnable" });
		expect(await bashTarget((env) => cc.envForTask(`run:${RUN_A}`, env))).toBe(
			"TARGET=https://harness-cluster-binding-blocked.invalid",
		);
		writeFileSync(
			s.extFile,
			kubeconfig("https://a.example", "ctx-a", TOKEN_A).replace(
				`token: ${TOKEN_A}`,
				`tokenFile: ${join(s.dir, "token.txt")}`,
			),
		);
		expect(await cc.bindTask(`run:${RUN_B}`)).toMatchObject({ status: "pinned", externalCredentials: true });
	});
});

describe("终端归属：Agent 发起的终端带 agent 标记，用户手开的不带", () => {
	it("terminal_create 工具与终端接管 bash 为 agent=true，界面创建为 agent=false", async () => {
		const seen: Array<{ id: string; agent: boolean }> = [];
		const mgr = new TerminalManager(() => {}, ROOT);
		let current = "";
		mgr.envFor = (env, ctx) => {
			seen.push({ id: current, agent: ctx.agent });
			return env;
		};
		current = "user-term";
		mgr.create("user-term", ROOT, 80, 24, ROOT, "user");
		current = "tool-term";
		mgr.create("tool-term", ROOT, 80, 24, ROOT, "tool", { agentTool: true });
		current = "bash-term";
		mgr.create("bash-term", ROOT, 80, 24, ROOT, "bash", { agentBash: true });
		mgr.killAll();
		expect(seen).toEqual([
			{ id: "user-term", agent: false },
			{ id: "tool-term", agent: true },
			{ id: "bash-term", agent: true },
		]);
	});
});
