/**
 * 上下文发现与「只追问缺口」编排（三层任务默认知识的第一层 → 第二层衔接）。
 *
 * 目标体验：用户只给「代码/项目位置 + 任务目标」，系统先发现并整理现有信息，
 * 再只询问真正缺失的必要项。发现只做只读扫描（列目录 + 读少量项目配置文件），
 * 绝不执行工作目录文档里的任意指令。
 *
 * 输入来源标签（与 packs.ts 的 CapabilityPackInput.source 对齐）：
 *  - user           用户显式输入；
 *  - discovery      当前环境实际探测结果（工作区文件 / KUBECONFIG / git）；
 *  - project-config 项目配置（pyproject.toml / task.yaml / manifest 等）；
 *  - pack-default   能力包默认值（如目标命中率 0.96、输入长度 81920）；
 *  - history        历史经验（可参考，不覆盖当前事实）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveGitHeadSha } from "./metrics.js";
import { resolvePack, type CapabilityPackInput } from "./packs.js";

export interface WorkspaceProbe {
	workspace: string;
	exists: boolean;
	gitBranch: string | null;
	gitHead: string | null;
	kubeconfigReady: boolean;
	markers: string[];
	dirs: string[];
	/** 发现的部署 manifest 候选（相对路径，如 "deploy/decode.yaml"）。 */
	deployManifests: string[];
}

const KNOWN_MARKERS = [
	"validate.py", "run.py", "task.yaml", "pyproject.toml", "Cargo.toml", "Makefile",
	"package.json", "bench_ascache.py", "benchmark", "Script", "references", "workflows", "tasks",
];

/** 部署 manifest 候选名（必须在扫描清单里，否则 service-config-verify 的 deploy_yaml 永远发现不到）。 */
const DEPLOY_MANIFEST_NAMES = ["decode.yaml", "deploy.yaml", "deployment.yaml", "decode.yml", "deploy.yml", "deployment.yml"];

const CONFIG_FILES = ["pyproject.toml", "task.yaml", "package.json"];

export interface ResolvedInput extends CapabilityPackInput {
	source: "user" | "discovery" | "project-config" | "pack-default" | "history";
	value: string | null;
	sourceOf: string;
	/** 探测候选（如裸 validate.py/run.py）：value 只是建议，须发起者确认后才算有效输入，不得自动当作已确认。 */
	confirmed?: boolean;
}

export interface InputCandidate {
	inputId: string;
	value: string;
	sourceOf: string;
}

export interface TaskContext {
	packId: string;
	workspace: string;
	probe: WorkspaceProbe;
	inputs: ResolvedInput[];
	missing: ResolvedInput[];
	/** 探测得到的候选值（只建议、不确认），供发起者选择；未选择时对应输入仍算缺失。 */
	candidates: InputCandidate[];
	conflicts: Array<{ inputId: string; defaultValue: string; resolvedValue: string; source: string }>;
	packVersion: string | null;
	provenance: Array<{ repo: string; path: string; version: string }>;
	/** 发现错误（未知能力包 / 工作区不存在 / 配置解析失败等）；非 null 时不得当作成功结果。 */
	error?: string | null;
}

/** 只读扫描工作区，发现已有入口与关键文件；不执行任何工作区命令。 */
export function probeWorkspace(workspace: string): WorkspaceProbe {
	const ws = path.resolve(workspace || process.cwd());
	const probe: WorkspaceProbe = { workspace: ws, exists: false, gitBranch: null, gitHead: null, kubeconfigReady: false, markers: [], dirs: [], deployManifests: [] };
	try { probe.exists = fs.existsSync(ws); } catch { return probe; }
	if (!probe.exists) return probe;
	let entries: string[] = [];
	try { entries = fs.readdirSync(ws); } catch { return probe; }
	for (const e of entries) {
		const full = path.join(ws, e);
		let stat: fs.Stats | null = null;
		try { stat = fs.statSync(full); } catch { continue; }
		if (stat.isDirectory()) { if (KNOWN_MARKERS.includes(e)) probe.dirs.push(e); }
		else if (KNOWN_MARKERS.includes(e)) probe.markers.push(e);
		else if (DEPLOY_MANIFEST_NAMES.includes(e)) probe.deployManifests.push(e);
	}
	// 部署 manifest 常放在 deploy/ 子目录：浅扫一层，仍是有界扫描。
	try {
		const deployDir = path.join(ws, "deploy");
		if (fs.statSync(deployDir).isDirectory()) {
			for (const f of fs.readdirSync(deployDir)) {
				if (DEPLOY_MANIFEST_NAMES.includes(f)) probe.deployManifests.push("deploy/" + f);
				else if (/\.ya?ml$/.test(f)) {
					// 其它 yaml：只登记名字，不递归；namespace 解析只对登记到的 manifest 做。
					probe.deployManifests.push("deploy/" + f);
				}
			}
		}
	} catch {}
	probe.gitHead = resolveGitHeadSha(ws);
	try {
		probe.gitBranch = execFileSync("git", ["-C", ws, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch { probe.gitBranch = null; }
	probe.kubeconfigReady = !!process.env.KUBECONFIG && (() => { try { return fs.existsSync(process.env.KUBECONFIG!); } catch { return false; } })();
	return probe;
}

function readConfigHint(ws: string, file: string): string | null {
	try { return fs.readFileSync(path.join(ws, file), "utf8").slice(0, 2000); } catch { return null; }
}

/**
 * 解析某能力包在指定工作区的任务上下文：按「用户 → 探测/项目配置 → 能力包默认」合并，
 * 输出每个必要输入的来源与值、缺失项、以及默认值与当前事实的冲突（不静默选择）。
 */
export function resolveTaskContext(packId: string, workspace: string, userInputs: Record<string, string> = {}): TaskContext {
	const pack = resolvePack(packId);
	const probe = probeWorkspace(workspace);
	const inputs: ResolvedInput[] = [];
	const missing: ResolvedInput[] = [];
	const candidates: InputCandidate[] = [];
	const conflicts: TaskContext["conflicts"] = [];
	if (!pack) {
		// 未知能力包：明确错误，不返回「没有缺口」的空成功结果。
		return { packId, workspace: probe.workspace, probe, inputs, missing, candidates, conflicts, packVersion: null, provenance: [], error: "未知能力包：" + packId };
	}
	if (!probe.exists) {
		return { packId, workspace: probe.workspace, probe, inputs, missing, candidates, conflicts, packVersion: pack.version, provenance: [], error: "工作区不存在：" + probe.workspace };
	}
	const configHints: Record<string, string | null> = {};
	for (const f of CONFIG_FILES) { const h = readConfigHint(probe.workspace, f); if (h) configHints[f] = h; }
	for (const decl of pack.inputs) {
		const userValue = (userInputs[decl.id] || "").trim() || null;
		if (userValue) { inputs.push({ ...decl, source: "user", value: userValue, sourceOf: "用户输入" }); continue; }
		const discovered = discoverInputValue(decl.id, probe, configHints);
		if (discovered && discovered.confirmed === false) {
			// 探测候选：只建议、不确认。归入 candidates，输入仍算缺失（发起者确认后才算有效）。
			candidates.push({ inputId: decl.id, value: discovered.value!, sourceOf: discovered.sourceOf });
			const resolved: ResolvedInput = { ...decl, source: "discovery", value: null, sourceOf: discovered.sourceOf };
			inputs.push(resolved);
			if (decl.required) missing.push(resolved);
			continue;
		}
		if (discovered) {
			inputs.push(discovered);
			if (decl.source === "pack-default" && decl.defaultValue && discovered.value !== decl.defaultValue) {
				conflicts.push({ inputId: decl.id, defaultValue: decl.defaultValue, resolvedValue: discovered.value!, source: discovered.sourceOf });
			}
			continue;
		}
		if (decl.source === "pack-default") { inputs.push({ ...decl, source: "pack-default", value: decl.defaultValue ?? null, sourceOf: decl.sourceOf ?? "能力包默认" }); continue; }
		const resolved: ResolvedInput = { ...decl, source: decl.source ?? "user", value: null, sourceOf: "尚未确定" };
		inputs.push(resolved);
		if (decl.required) missing.push(resolved);
	}
	return { packId, workspace: probe.workspace, probe, inputs, missing, candidates, conflicts, packVersion: pack.version, provenance: pack.provenance.map((p) => ({ repo: p.repo, path: p.path, version: p.version })) };
}

/** 从部署 manifest 内容解析 namespace（只读，支持 metadata.namespace / 顶层 namespace:）。 */
export function parseNamespaceFromManifest(text: string): string | null {
	if (!text) return null;
	const m = /^\s*namespace\s*:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*(?:#.*)?$/m.exec(text);
	return m ? m[1]! : null;
}

function discoverInputValue(inputId: string, probe: WorkspaceProbe, configHints: Record<string, string | null>): ResolvedInput | null {
	const has = (m: string) => probe.markers.includes(m) || probe.dirs.includes(m);
	switch (inputId) {
		case "validateCmd":
			// 裸文件名只是探测候选，不是已确认的验收命令：validate.py 可能不是唯一入口，run.py 更只是执行入口。
			// 标记 confirmed=false，交给 resolveTaskContext 归入 candidates，发起者确认前该输入仍算缺失。
			if (has("validate.py")) return { id: "validateCmd", label: "验收命令", required: true, source: "discovery", value: "validate.py", sourceOf: "发现 validate.py（候选，须发起者确认）", confirmed: false };
			if (has("run.py")) return { id: "validateCmd", label: "验收命令", source: "discovery", value: "run.py", sourceOf: "发现 run.py（执行入口，验收命令仍需真实 --validate 入口；候选）", confirmed: false };
			return null;
		case "deploy_yaml":
			for (const m of probe.deployManifests) {
				return { id: "deploy_yaml", label: "部署 YAML", required: true, source: "project-config", value: m, sourceOf: "发现部署 manifest（候选，须发起者确认）：" + m };
			}
			return null;
		case "kubeconfig":
			if (probe.kubeconfigReady) return { id: "kubeconfig", label: "kubeconfig", required: true, source: "discovery", value: process.env.KUBECONFIG!, sourceOf: "KUBECONFIG 环境变量" };
			return null;
		case "namespace": {
			// 真实解析：优先从发现的部署 manifest 取 metadata.namespace；退回 task.yaml 的 namespace 声明。
			for (const m of probe.deployManifests) {
				const full = path.join(probe.workspace, m);
				try {
					const ns = parseNamespaceFromManifest(fs.readFileSync(full, "utf8"));
					if (ns) return { id: "namespace", label: "namespace", source: "project-config", value: ns, sourceOf: "从 manifest 解析：" + m + " → " + ns };
				} catch {}
			}
			const taskNs = parseNamespaceFromManifest(configHints["task.yaml"] || "");
			if (taskNs) return { id: "namespace", label: "namespace", source: "project-config", value: taskNs, sourceOf: "从 task.yaml 解析：" + taskNs };
			return null;
		}
		default:
			return null;
	}
}

/**
 * 生成「只追问缺口」的注入摘要：只列已确认信息与真正缺失的必要项，不把整包知识塞进提示词。
 * 冲突项显式呈现（默认 vs 当前事实），由用户/模型决定，不静默选择。
 */
export function renderDiscoverySummary(ctx: TaskContext): string {
	const lines: string[] = [];
	if (ctx.error) {
		lines.push("error: " + ctx.error);
		return lines.join("\n");
	}
	lines.push("pack: " + ctx.packId + (ctx.packVersion ? "@" + ctx.packVersion : "") + " | workspace: " + ctx.workspace);
	if (ctx.probe.gitBranch || ctx.probe.gitHead) {
		lines.push("git: " + (ctx.probe.gitBranch || "") + (ctx.probe.gitHead ? "@" + ctx.probe.gitHead : ""));
	}
	if (ctx.probe.markers.length || ctx.probe.dirs.length) {
		lines.push("found: " + ([...ctx.probe.markers, ...ctx.probe.dirs].join(", ") || "(none)"));
	}
	const confirmed = ctx.inputs.filter((i) => i.value != null);
	if (confirmed.length) {
		lines.push("confirmed: " + confirmed.map((i) => i.id + "(" + i.source + ":" + i.value + ")").join(" "));
	}
	if (ctx.conflicts.length) {
		lines.push("conflicts: " + ctx.conflicts.map((c) => c.inputId + " 默认=" + c.defaultValue + " 实际=" + c.resolvedValue + "(" + c.source + ")").join("; "));
	}
	if (ctx.candidates.length) {
		lines.push("candidates(需发起者确认，未确认前视为缺失): " + ctx.candidates.map((c) => c.inputId + "=" + c.value + "（" + c.sourceOf + "）").join("; "));
	}
	if (ctx.missing.length) {
		lines.push("missing(只问这些): " + ctx.missing.map((m) => m.id + ": " + (m.hint ?? m.label)).join("; "));
	} else {
		lines.push("missing: (none)");
	}
	lines.push("provenance: " + ctx.provenance.map((p) => p.repo + "@" + p.path + "#" + p.version).join(" | "));
	return lines.join("\n");
}
