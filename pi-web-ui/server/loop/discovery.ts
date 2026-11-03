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
}

const KNOWN_MARKERS = [
	"validate.py", "run.py", "task.yaml", "pyproject.toml", "Cargo.toml", "Makefile",
	"package.json", "bench_ascache.py", "benchmark", "Script", "references", "workflows", "tasks",
];

const CONFIG_FILES = ["pyproject.toml", "task.yaml", "package.json"];

export interface ResolvedInput extends CapabilityPackInput {
	source: "user" | "discovery" | "project-config" | "pack-default" | "history";
	value: string | null;
	sourceOf: string;
}

export interface TaskContext {
	packId: string;
	workspace: string;
	probe: WorkspaceProbe;
	inputs: ResolvedInput[];
	missing: ResolvedInput[];
	conflicts: Array<{ inputId: string; defaultValue: string; resolvedValue: string; source: string }>;
	packVersion: string | null;
	provenance: Array<{ repo: string; path: string; version: string }>;
}

/** 只读扫描工作区，发现已有入口与关键文件；不执行任何工作区命令。 */
export function probeWorkspace(workspace: string): WorkspaceProbe {
	const ws = path.resolve(workspace || process.cwd());
	const probe: WorkspaceProbe = { workspace: ws, exists: false, gitBranch: null, gitHead: null, kubeconfigReady: false, markers: [], dirs: [] };
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
	}
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
	const conflicts: TaskContext["conflicts"] = [];
	if (!pack) {
		return { packId, workspace: probe.workspace, probe, inputs, missing, conflicts, packVersion: null, provenance: [] };
	}
	const configHints: Record<string, string | null> = {};
	for (const f of CONFIG_FILES) { const h = readConfigHint(probe.workspace, f); if (h) configHints[f] = h; }
	for (const decl of pack.inputs) {
		const userValue = (userInputs[decl.id] || "").trim() || null;
		if (userValue) { inputs.push({ ...decl, source: "user", value: userValue, sourceOf: "用户输入" }); continue; }
		const discovered = discoverInputValue(decl.id, probe, configHints);
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
	return { packId, workspace: probe.workspace, probe, inputs, missing, conflicts, packVersion: pack.version, provenance: pack.provenance.map((p) => ({ repo: p.repo, path: p.path, version: p.version })) };
}

function discoverInputValue(inputId: string, probe: WorkspaceProbe, configHints: Record<string, string | null>): ResolvedInput | null {
	const has = (m: string) => probe.markers.includes(m) || probe.dirs.includes(m);
	switch (inputId) {
		case "validateCmd":
			if (has("validate.py")) return { id: "validateCmd", label: "验收命令", required: true, source: "discovery", value: "validate.py", sourceOf: "发现 validate.py，验收命令可指向它（发起者确认）" };
			if (has("run.py")) return { id: "validateCmd", label: "验收命令", source: "discovery", value: "run.py", sourceOf: "发现 run.py（执行入口）；验收命令仍需真实 --validate 入口" };
			return null;
		case "deploy_yaml":
			for (const m of ["decode.yaml", "deploy.yaml", "deployment.yaml"]) {
				if (probe.markers.includes(m) || probe.dirs.includes(m)) return { id: "deploy_yaml", label: "部署 YAML", required: true, source: "project-config", value: m, sourceOf: "发现部署 manifest：" + m };
			}
			return null;
		case "kubeconfig":
			if (probe.kubeconfigReady) return { id: "kubeconfig", label: "kubeconfig", required: true, source: "discovery", value: process.env.KUBECONFIG!, sourceOf: "KUBECONFIG 环境变量" };
			return null;
		case "namespace":
			if ((configHints["task.yaml"] || "").includes("namespace")) return { id: "namespace", label: "namespace", source: "project-config", value: "取自 manifest", sourceOf: "manifest/task.yaml 声明 namespace" };
			return null;
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
	if (ctx.missing.length) {
		lines.push("missing(只问这些): " + ctx.missing.map((m) => m.id + ": " + (m.hint ?? m.label)).join("; "));
	} else {
		lines.push("missing: (none)");
	}
	lines.push("provenance: " + ctx.provenance.map((p) => p.repo + "@" + p.path + "#" + p.version).join(" | "));
	return lines.join("\n");
}
