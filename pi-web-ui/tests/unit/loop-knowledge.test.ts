/**
 * 三层任务默认知识回归：
 * - 第一层目录不下发第二/三层知识（knowledge/references 被剥离）；
 * - 第二层 getPackKnowledge 携带 provenance 与指标契约，但无可执行命令；
 * - 第三层 references 按需取用，cache-loss 的「来源缺口」显式记录；
 * - discovery 只读扫描 + 输入来源合并（用户 > 探测/项目配置 > 能力包默认）+ 只问缺口。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseNamespaceFromManifest, probeWorkspace, renderDiscoverySummary, resolveTaskContext } from "../../server/loop/discovery.js";
import { getPackKnowledge, getPackReference, listCapabilityPacks, listPackReferences, resolvePack } from "../../server/loop/packs.js";

const TMP = mkdtempSync(join(tmpdir(), "mh-knowledge-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("三层任务默认知识", () => {
	it("第一层目录剥离第二/三层知识，只暴露任务语义与来源", () => {
		const packs = listCapabilityPacks();
		expect(packs.length).toBe(3);
		for (const p of packs) {
			expect(p).not.toHaveProperty("knowledge");
			expect(p).not.toHaveProperty("references");
			expect(p.provenance.length).toBeGreaterThan(0);
			expect(p.provenance[0].version).toBeTruthy();
		}
	});

	it("第二层知识携带指标契约与 provenance，且不含可执行命令字段", () => {
		const perf = getPackKnowledge("inference-perf")!;
		expect(perf).not.toBeNull();
		expect(perf.metric.direction).toBe("maximize");
		expect(perf.metric.name).toBe("input_throughput");
		expect(perf.requiredInputs.some((i) => i.id === "pod" && i.required)).toBe(true);
		expect(perf.entries.length).toBeGreaterThan(0);
		expect(perf.executionOrder.length).toBeGreaterThan(0);
		expect(perf.evidence.required.length).toBeGreaterThan(0);
		expect(perf.commonFailures.length).toBeGreaterThan(0);
		expect(perf.impact.confirmBefore.length).toBeGreaterThan(0);
		// 知识里没有可执行命令（path 只是角色/契约定位，不是 shell 命令）。
		for (const e of perf.entries) {
			expect(e.path).not.toMatch(/\||&|;/);
		}

		const verify = getPackKnowledge("service-config-verify")!;
		expect(verify.metric.direction).toBeNull();
	});

	it("cache-loss 指标口径修正 + 来源缺口显式记录", () => {
		const loss = resolvePack("cache-loss")!;
		expect(loss.primaryMetric).toBe("loss_pct");
		expect(loss.metricDirection).toBe("minimize");
		expect(loss.metricThreshold).toEqual({ op: "lt", value: 20 });
		expect(loss.metricScenario).toBe("ascache-on-vs-radix-off");
		const refs = listPackReferences("cache-loss");
		const gap = refs.find((r) => r.id === "gap");
		expect(gap).toBeTruthy();
		expect(gap!.kind).toBe("troubleshooting");
		expect(getPackReference("cache-loss", "gap")?.title).toContain("来源缺口");
	});

	it("discovery 只读扫描识别工作区标记", () => {
		const ws = join(TMP, "ws-a");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "validate.py"), "print(1)");
		const probe = probeWorkspace(ws);
		expect(probe.exists).toBe(true);
		expect(probe.markers).toContain("validate.py");
	});

	it("输入来源合并：用户 > 探测 > 能力包默认，只问真正缺失的必要项", () => {
		const ws = join(TMP, "ws-b");
		mkdirSync(ws, { recursive: true });
		// 空工作区：无 validate.py → cache-loss 的 validateCmd 缺失；cache_hit/input_len 落 pack-default。
		const ctx = resolveTaskContext("cache-loss", ws, {});
		const byId = new Map(ctx.inputs.map((i) => [i.id, i]));
		expect(byId.get("cache_hit")?.source).toBe("pack-default");
		expect(byId.get("cache_hit")?.value).toBe("0.96");
		expect(byId.get("input_len")?.value).toBe("81920");
		expect(ctx.missing.map((m) => m.id)).toContain("validateCmd");
		// 用户显式给 validateCmd 时，来源是 user 且不再缺失。
		const ctx2 = resolveTaskContext("cache-loss", ws, { validateCmd: "python3 bench.py --validate" });
		const v2 = ctx2.inputs.find((i) => i.id === "validateCmd");
		expect(v2?.source).toBe("user");
		expect(ctx2.missing).toHaveLength(0);
	});

	it("renderDiscoverySummary 只追问缺口，并带 provenance", () => {
		const ws = join(TMP, "ws-c");
		mkdirSync(ws, { recursive: true });
		const ctx = resolveTaskContext("cache-loss", ws, {});
		const summary = renderDiscoverySummary(ctx);
		expect(summary).toContain("missing(只问这些)");
		expect(summary).toContain("validateCmd");
		expect(summary).toContain("provenance:");
		expect(summary).toContain("mini-harness");
	});

	it("发现部署 manifest 并从 metadata.namespace 解析真实 namespace（不是占位符）", () => {
		const ws = join(TMP, "ws-deploy");
		mkdirSync(join(ws, "deploy"), { recursive: true });
		writeFileSync(join(ws, "deploy", "deployment.yaml"), "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: infer\n  namespace: prod-infer\nspec:\n  replicas: 1\n");
		writeFileSync(join(ws, "validate.py"), "print(1)");
		const probe = probeWorkspace(ws);
		expect(probe.deployManifests).toContain("deploy/deployment.yaml");
		// 直接解析 manifest
		expect(parseNamespaceFromManifest("metadata:\n  namespace: prod-infer\n")).toBe("prod-infer");
		// 通过 service-config-verify 的 namespace 输入走真实解析
		const ctx = resolveTaskContext("service-config-verify", ws, {});
		const ns = ctx.inputs.find((i) => i.id === "namespace");
		expect(ns?.value).toBe("prod-infer");
		expect(ns?.sourceOf).toContain("prod-infer");
		// deploy_yaml 输入用 probe.deployManifests 解析
		const dy = ctx.inputs.find((i) => i.id === "deploy_yaml");
		expect(dy?.value).toContain("deployment.yaml");
	});

	it("顶层 deploy.yaml 也能被发现并解析 namespace（顶层 namespace: 行）", () => {
		const ws = join(TMP, "ws-deploy2");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "decode.yaml"), "namespace: radix-cache\nfoo: bar\n");
		const probe = probeWorkspace(ws);
		expect(probe.deployManifests).toContain("decode.yaml");
		const ctx = resolveTaskContext("service-config-verify", ws, {});
		const ns = ctx.inputs.find((i) => i.id === "namespace");
		expect(ns?.value).toBe("radix-cache");
	});

	it("未知能力包 / 缺失工作区：resolveTaskContext 明确返回 error（不再空成功）", () => {
		expect(resolveTaskContext("no-such-pack", join(TMP, "x"), {}).error).toContain("未知能力包");
		expect(resolveTaskContext("cache-loss", join(TMP, "missing-dir"), {}).error).toContain("工作区不存在");
		expect(renderDiscoverySummary(resolveTaskContext("no-such-pack", join(TMP, "x"), {})).startsWith("error:")).toBe(true);
	});
});
