/**
 * mini-harness Loop 扩展 —— 受控任务运行时（源码版，正式接入 pi-web-ui）
 *
 * 移植自 pi-web-cockpit/vendor/mini-harness-runtime（DOM 注入时代的运行时），
 * 本版为源码级正式实现，包含四项正确性修复：
 *
 *  1) 任务绑定只认显式 sessionId（去掉「同 cwd 最新活跃 run」兜底，杜绝串任务）；
 *  2) epoch 代际守卫：停止即递增代次，所有 await 之后的续写先核对代次与活跃态，
 *     迟到回调不得把 stopped 翻转成 done，也不得继续调度下一轮；
 *  3) LLM loop 关闭 reviewer 时按「模型自述完成」收尾（self-declared），
 *     不再以 reviewer-error 停止；
 *  4) loop_start 支持 taskId（外部批量/编排显式关联用），落进运行状态。
 *
 * 状态落盘在仓库之外（默认 ~/.mini-harness/runs/<id>/state.json + journal.jsonl），
 * 进程重启后可识别孤立运行（alive 判定在服务层）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_ROUNDS = 5;
const CUSTOM_TYPE = "mini-harness-loop";
const ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), ".mini-harness", "runs");
const ACTIVE_STAGES = new Set(["intake", "plan", "run", "validate"]);

/** 工具执行的 ctx（模型注册表/会话 id 等）；SDK 类型面较宽，这里按实际使用收窄。 */
type LoopCtx = {
	model?: { provider?: string; id: string } | null;
	modelRegistry?: {
		find: (provider: string, id: string) => { provider: string; id: string } | undefined;
		getAll?: () => Array<{ provider?: string; id: string }>;
		getAvailable?: () => Array<{ provider?: string; id: string }>;
		complete: (model: unknown, context: unknown) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
	} | null;
	sessionManager?: { getSessionId?: () => string } | null;
	cwd?: string;
	ui?: { notify?: (message: string, type?: string) => void } | null;
};

/** 运行状态（state.json 的结构；字段与旧运行时保持兼容）。 */
interface LoopState {
	runId: string;
	taskId: string | null;
	goal: string;
	workspace: string;
	baseWorkspace: string;
	worktreeDir: string | null;
	worktreeBranch: string | null;
	worktreeCommitted: boolean;
	harnessRoot: string | null;
	artifactRoots: string[];
	validateCmd: string | null;
	maxRounds: number;
	auto: boolean;
	mode: "code" | "llm";
	round: number;
	stage: string;
	status: "active" | "done" | "stopped";
	stopReason?: string;
	epoch: number;
	sessionId: string;
	mainModel: { provider?: string; id: string; family: string } | null;
	plannerModel: { provider?: string; id: string; family: string } | null;
	reviewerModel: { provider?: string; id: string; family: string } | null;
	plannerOutput: string;
	lastReview: { verdict: string; reasons?: string[]; diff?: string } | null;
	lastDiff?: string;
	plan: string;
	summary: string;
	lastVerdict: string | null;
	lastCode: number | null;
	lastEvidence: string;
	validatedRound: number;
	createdAt: string;
	updatedAt?: string;
	history: Array<{ round: number; verdict: string; code: number | null; at: string; evidence: string | null }>;
}

// ---------- 事件上报（服务层接线用：run 状态变化 / 启动请求失败） ----------

/**
 * Loop 事件，进程内单上报器（服务层经 setLoopEventReporter 注册一次，
 * 按 st.sessionId 路由到对应会话——扩展本身是每会话一份，上报器是全局的）。
 *  - run-state：每次状态落盘后上报（事件驱动，替代轮询 state.json）；
 *  - request-failed：挂起的启动请求在该回合结束时仍未变成 run（模型没调
 *    loop_start，或调用被拒）——修复「启动后无可见记录/无明确失败态」。
 */
export type LoopEvent =
	| { type: "run-state"; st: LoopState }
	| { type: "request-failed"; sessionId: string; taskId: string; goal: string; reason: string };

let eventReporter: ((e: LoopEvent) => void) | null = null;

/** 服务层注册全局事件上报器（传 null 注销）。上报器异常不影响运行时。 */
export function setLoopEventReporter(fn: ((e: LoopEvent) => void) | null) {
	eventReporter = fn;
}

function reportEvent(e: LoopEvent) {
	try {
		eventReporter?.(e);
	} catch {}
}

// 挂起的启动请求：服务层在把启动提示词发进会话**之前**登记（先有记录再有执行），
// loop_start 成功即消费；回合结束仍是挂起 → 上报 request-failed。
const pendingRequests = new Map<string, { taskId: string; goal: string; at: string }>();

/** 服务层登记挂起启动请求（按 sessionId；重复登记覆盖旧的）。 */
export function markLoopRequestPending(sessionId: string, taskId: string, goal: string) {
	pendingRequests.set(sessionId, { taskId, goal, at: now() });
}

/** 消费挂起请求（loop_start 成功时用；不存在返回 null）。 */
export function takePendingLoopRequest(sessionId: string): { taskId: string; goal: string; at: string } | null {
	const p = pendingRequests.get(sessionId);
	pendingRequests.delete(sessionId);
	return p ?? null;
}

// ---------- 基础工具 ----------

function now() {
	return new Date().toISOString();
}

function runDir(runId: string) {
	return path.join(ROOT, runId);
}

function statePath(runId: string) {
	return path.join(runDir(runId), "state.json");
}

function newRunId() {
	const t = new Date()
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14);
	return `${t}-${crypto.randomBytes(3).toString("hex")}`;
}

function loadState(runId: string): LoopState | null {
	try {
		return JSON.parse(fs.readFileSync(statePath(runId), "utf8")) as LoopState;
	} catch {
		return null;
	}
}

function saveState(st: LoopState) {
	st.updatedAt = now();
	fs.mkdirSync(runDir(st.runId), { recursive: true });
	fs.writeFileSync(statePath(st.runId), JSON.stringify(st, null, 2));
	reportEvent({ type: "run-state", st });
}

function journal(st: LoopState, event: string, extra: Record<string, unknown> = {}) {
	try {
		fs.mkdirSync(runDir(st.runId), { recursive: true });
		fs.appendFileSync(
			path.join(runDir(st.runId), "journal.jsonl"),
			JSON.stringify({ at: now(), runId: st.runId, round: st.round, event, ...extra }) + "\n",
		);
	} catch {}
}

function listRuns(): LoopState[] {
	try {
		return fs
			.readdirSync(ROOT)
			.map((n) => loadState(n))
			.filter((s): s is LoopState => !!s);
	} catch {
		return [];
	}
}

function sessionIdOf(ctx: LoopCtx): string {
	try {
		return ctx?.sessionManager?.getSessionId?.() || "";
	} catch {
		return "";
	}
}

/** 解析真实路径（macOS /tmp -> /private/tmp），保证 workspace 比较一致。 */
function real(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * 找到当前会话的活跃 run —— 【修复①】只认显式 sessionId 精确匹配。
 * 不做「同 cwd 最新活跃 run」兜底：那条路会把别的会话/别的 worktree 的任务接过来。
 * 恢复必须显式绑定（服务层按 runId 重开会话，sessionId 天然一致）。
 */
function findActiveRun(ctx: LoopCtx): LoopState | null {
	const sid = sessionIdOf(ctx);
	if (!sid) return null;
	const runs = listRuns().filter((r) => r.status === "active" && ACTIVE_STAGES.has(r.stage));
	return runs.find((r) => r.sessionId === sid) || null;
}

function tail(s: unknown, n: number) {
	const str = String(s || "");
	return str.length > n ? "…" + str.slice(-n) : str;
}

function notify(ctx: LoopCtx, message: string, type = "info") {
	try {
		ctx?.ui?.notify?.(message, type);
	} catch {}
}

// ---------- 模型家族与选择 ----------

/** 按模型 id 归类家族。planner / reviewer 必须与主模型、彼此都不同家族。 */
function familyOf(id: string): string {
	const s = String(id || "").toLowerCase();
	const rules: Array<[RegExp, string]> = [
		[/^(gpt|o[1-9])/, "openai"],
		[/claude|opus|sonnet|haiku/, "anthropic"],
		[/gemini/, "google"],
		[/glm/, "zhipu"],
		[/kimi|moonshot/, "moonshot"],
		[/deepseek/, "deepseek"],
		[/grok/, "xai"],
		[/minimax|abab/, "minimax"],
		[/qwen|tongyi/, "alibaba"],
		[/llama/, "meta"],
		[/mistral|mixtral/, "mistral"],
		[/ernie/, "baidu"],
		[/doubao/, "bytedance"],
	];
	for (const [re, fam] of rules) if (re.test(s)) return fam;
	return "other";
}

function resolveModel(ctx: LoopCtx, spec: string) {
	if (!spec) return null;
	const reg = ctx?.modelRegistry;
	if (!reg) return null;
	const s = String(spec).trim();
	if (s.includes("/")) {
		const i = s.indexOf("/");
		return reg.find(s.slice(0, i), s.slice(i + 1)) || null;
	}
	const all = reg.getAll ? reg.getAll() : [];
	return all.find((m) => m.id === s) || all.find((m) => String(m.id).toLowerCase() === s.toLowerCase()) || null;
}

const PREFER_FAMILIES = ["openai", "anthropic", "zhipu", "deepseek", "moonshot", "google", "xai", "minimax", "alibaba"];

function pickModelByFamily(ctx: LoopCtx, exclude: Set<string>) {
	const reg = ctx?.modelRegistry;
	if (!reg) return null;
	const models = (reg.getAvailable ? reg.getAvailable() : null) || (reg.getAll ? reg.getAll() : []);
	for (const fam of PREFER_FAMILIES) {
		if (exclude.has(fam)) continue;
		const m = models.find((x) => familyOf(x.id) === fam);
		if (m) return m;
	}
	return models.find((m) => !exclude.has(familyOf(m.id))) || null;
}

function modelBrief(m: { provider?: string; id: string } | null) {
	return m ? { provider: m.provider, id: m.id, family: familyOf(m.id) } : null;
}

async function callModel(ctx: LoopCtx, model: unknown, systemPrompt: string, userText: string, timeoutMs = 120000) {
	if (!model) throw new Error("model not resolved");
	let timer: NodeJS.Timeout | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`model call timeout after ${timeoutMs}ms`)), timeoutMs);
		});
		const msg = await Promise.race([
			ctx.modelRegistry!.complete(model, {
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
			}),
			timeout,
		]);
		const text = (msg?.content || [])
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n")
			.trim();
		return text;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function mainModel(ctx: LoopCtx) {
	try {
		return ctx?.model || null;
	} catch {
		return null;
	}
}

// ---------- validator ----------

function resolveValidator(st: LoopState) {
	if (st.validateCmd) {
		return { cmd: "bash", args: ["-lc", st.validateCmd], label: st.validateCmd };
	}
	const candidates: string[] = [];
	if (st.workspace) candidates.push(path.join(st.workspace, "validate.py"));
	if (st.harnessRoot) candidates.push(path.join(st.harnessRoot, "validate.py"));
	if (process.env.HARNESS_ROOT) candidates.push(path.join(process.env.HARNESS_ROOT, "validate.py"));
	for (const p of candidates) {
		if (fs.existsSync(p)) return { cmd: "python3", args: [p], label: p };
	}
	return null;
}

async function runValidation(pi: ExtensionAPI, st: LoopState) {
	const r = resolveValidator(st);
	if (!r) {
		return {
			pass: false,
			noValidator: true,
			code: null as number | null,
			evidence: null as string | null,
			output:
				"未找到 validator。请提供 validateCmd（例如 validate.py 的路径），或在 workspace 放置 validate.py，或设置 HARNESS_ROOT。",
		};
	}
	let res: { stdout?: string; stderr?: string; code?: number | null; killed?: boolean };
	try {
		res = await pi.exec(r.cmd, r.args, { cwd: st.workspace || process.cwd(), timeout: 30 * 60 * 1000 });
	} catch (e) {
		res = { stdout: "", stderr: String((e as Error)?.message || e), code: -1, killed: false };
	}
	const output =
		`$ ${r.label}\n` +
		`exit=${res.code}${res.killed ? " (killed/timeout)" : ""}\n` +
		`--- stdout (tail) ---\n${tail(res.stdout, 6000)}\n` +
		`--- stderr (tail) ---\n${tail(res.stderr, 4000)}\n`;
	let evidence = "";
	try {
		const dir = path.join(runDir(st.runId), "evidence");
		fs.mkdirSync(dir, { recursive: true });
		evidence = path.join(dir, `round-${st.round}-${Date.now()}.log`);
		fs.writeFileSync(evidence, output);
	} catch {}
	return { pass: res.code === 0, noValidator: false, code: res.code ?? null, evidence, output };
}

// ---------- 提示词 ----------

function stateBlock(st: LoopState) {
	const lines = [
		"<mini_harness_loop>",
		`runId: ${st.runId}`,
		`mode: ${st.mode} | stage: ${st.stage} | round: ${st.round}/${st.maxRounds}`,
		`goal: ${st.goal}`,
		st.plannerModel ? `planner: ${st.plannerModel.family}/${st.plannerModel.id}` : "",
		st.reviewerModel ? `reviewer: ${st.reviewerModel.family}/${st.reviewerModel.id}` : "",
		st.plan ? `plan: ${tail(st.plan, 600)}` : "",
		st.plannerOutput ? `planner_acceptance:\n${tail(st.plannerOutput, 1600)}` : "",
		st.lastVerdict ? `last_verdict: ${st.lastVerdict} (exit ${st.lastCode})` : "last_verdict: (none yet)",
		st.lastReview
			? `last_review: ${st.lastReview.verdict} — ${tail((st.lastReview.reasons || []).join("; "), 600)}`
			: "",
		st.lastEvidence ? `last_evidence_tail:\n${tail(st.lastEvidence, 1600)}` : "",
		"规则：",
		"- 完成本轮工作后调用 loop_done(summary) 声明完成；运行时会在本轮结束时自动执行 validator。",
		"- 不要自行宣布完成；只有 validator 通过（且 reviewer 不否决）才算完成。",
		"- 若验证失败：按证据修复，不要重复已完成的步骤，也不要向用户提问。",
		"</mini_harness_loop>",
	];
	return lines.filter(Boolean).join("\n");
}

function nextRoundPrompt(st: LoopState, v: { code?: number | null; output?: string } | null, feedback: string) {
	return [
		`【mini-harness · 第 ${st.round} 轮】上一轮未通过。`,
		v ? `validator 退出码：${v.code}` : "",
		v ? "validator 证据（尾部）：\n```\n" + tail(v.output, 3000) + "\n```" : "",
		feedback ? `额外反馈：\n${tail(feedback, 2000)}` : "",
		`请修复后再次调用 loop_done(summary)。目标：${st.goal}`,
		"要求：直接修改工作区，不要只在回复里描述；不要向用户提问。",
	]
		.filter(Boolean)
		.join("\n");
}

// ---------- 证据采集与评审 ----------

async function collectDiff(pi: ExtensionAPI, st: LoopState) {
	try {
		// git diff 不包含未跟踪的新文件；非 git 目录还要回退成目录快照，reviewer 才能核验真实状态。
		const script = [
			"echo '=== cwd ==='; pwd",
			"if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then",
			"  echo '=== git status ==='; git status --porcelain 2>/dev/null | head -100",
			"  echo '=== git diff --stat ==='; git diff --stat 2>/dev/null | tail -50",
			"  echo '=== git diff ==='; git diff 2>/dev/null | head -c 6000",
			"  echo '=== untracked files (first 5, 2KB each) ==='; " +
				"for f in $(git ls-files --others --exclude-standard 2>/dev/null | head -5); " +
				'do echo "--- $f ---"; head -c 2000 "$f" 2>/dev/null; echo; done',
			"else",
			"  echo '=== not a git repo: directory snapshot ==='; ls -la 2>/dev/null | head -50",
			"  echo '=== files (first 8, 2KB each) ==='; " +
				"for f in $(find . -maxdepth 2 -type f -not -path './.git/*' 2>/dev/null | head -8); " +
				'do echo "--- $f ---"; head -c 2000 "$f" 2>/dev/null; echo; done',
			"fi",
		].join("\n");
		const res = await pi.exec("bash", ["-lc", script], { cwd: st.workspace, timeout: 30000 });
		let out = `${res.stdout || ""}${res.stderr ? "\n" + res.stderr : ""}`;
		// 外部产物根（artifact roots）：workspace 之外的真实产出，reviewer 也必须能看到
		for (const root of st.artifactRoots || []) {
			const r = await pi.exec(
				"bash",
				[
					"-lc",
					[
						`echo '=== artifact root: ${root} ==='`,
						`ls -la ${JSON.stringify(root)} 2>/dev/null | head -40`,
						"echo '--- files (maxdepth 5, first 20) ---'",
						`find ${JSON.stringify(root)} -maxdepth 5 -type f 2>/dev/null | head -20`,
						"echo '--- recent json/status contents (first 5, 2KB each) ---'",
						`for f in $(find ${JSON.stringify(root)} -maxdepth 6 -type f ` +
							"\\( -name '*.json' -o -name '*.log' -o -name '*.md' \\) 2>/dev/null | head -5); " +
							'do echo "--- $f ---"; head -c 2000 "$f" 2>/dev/null; echo; done',
					].join("\n"),
				],
				{ cwd: st.workspace, timeout: 30000 },
			);
			out += `\n${r.stdout || ""}${r.stderr ? "\n" + r.stderr : ""}`;
		}
		return tail(out, 20000);
	} catch {
		return "";
	}
}

/** 从模型输出里提取第一个合法的 JSON 对象（处理前后夹杂文字/多个对象）。 */
function extractJson(text: unknown): Record<string, unknown> | null {
	const s = String(text || "");
	for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < s.length; i++) {
			const ch = s[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
					} catch {
						break;
					}
				}
			}
		}
	}
	return null;
}

async function runReview(ctx: LoopCtx, st: LoopState, v: { code?: number | null; output?: string }, pi: ExtensionAPI) {
	if (!st.reviewerModel) {
		return { verdict: "skip", reasons: [] as string[], diff: "" };
	}
	const model = st.reviewerModel.provider
		? ctx.modelRegistry?.find(st.reviewerModel.provider, st.reviewerModel.id) || null
		: null;
	if (!model) {
		return { verdict: "error", reasons: ["reviewer model unavailable"], diff: "" };
	}
	const diff = await collectDiff(pi, st);
	const system =
		"你是独立审查者。下面给出的是「运行时自动采集的真实证据」：工作区快照" +
		"（git 状态/diff/未跟踪文件内容；非 git 目录为目录快照）、artifact 产物目录快照、以及 validator 输出。" +
		'只依据这些证据判断目标是否达成，不要臆测，也不要因为"没有终端日志"而否决。' +
		'只输出一个 JSON 对象，不要输出任何其它文字：{"verdict":"pass"|"block","reasons":["..."]}。' +
		"证据不足、或与目标/验收条件不符时，必须输出 block。";
	const user = [
		`目标：${st.goal}`,
		st.plannerOutput ? `规划与验收条件：\n${tail(st.plannerOutput, 2000)}` : "",
		st.plan ? `执行计划：\n${tail(st.plan, 1200)}` : "",
		st.summary ? `执行者自述：\n${tail(st.summary, 1200)}` : "",
		`validator：exit=${v.code}\n${tail(v.output, 3000)}`,
		diff ? `工作区/产物快照（运行时采集，真实）：\n${tail(diff, 12000)}` : "工作区/产物快照：（空）",
	]
		.filter(Boolean)
		.join("\n\n");
	const parse = (text: string) => {
		const obj = extractJson(text);
		if (!obj) return null;
		const verdict = obj.verdict === "block" ? "block" : obj.verdict === "pass" ? "pass" : null;
		if (!verdict) return null;
		const reasons = Array.isArray(obj.reasons)
			? (obj.reasons as unknown[]).map(String)
			: obj.reasons
				? [String(obj.reasons)]
				: [];
		return { verdict, reasons };
	};
	try {
		let text = await callModel(ctx, model, system, user);
		let parsed = parse(text);
		if (!parsed) {
			// 一次重试：明确要求只输出 JSON
			text = await callModel(
				ctx,
				model,
				system,
				`${user}\n\n上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要任何其它文字。`,
				120000,
			);
			parsed = parse(text);
		}
		if (!parsed) {
			return { verdict: "error", reasons: ["reviewer output is not valid JSON after retry"], diff };
		}
		return { ...parsed, diff };
	} catch (e) {
		return { verdict: "error", reasons: [String((e as Error)?.message || e)], diff };
	}
}

// ---------- 判定处理 ----------

/**
 * 【修复②】await 前记录代次，await 后核对：停止过的 run 不再被迟到回调推进。
 * 必须重读磁盘：stop 走的是另一次 loadState（不同对象引用），内存里的 st
 * 不会随之更新——只比内存对象会误判「仍然有效」，把 stopped 覆盖成 done。
 */
function stillCurrent(runId: string, epoch: number) {
	const fresh = loadState(runId);
	return !!fresh && fresh.status === "active" && fresh.epoch === epoch;
}

function advanceOrStop(
	pi: ExtensionAPI,
	st: LoopState,
	v: { code?: number | null; output?: string } | null,
	feedback: string,
	event: string,
) {
	writeRoundReview(st, v, null, "");
	if (st.round < st.maxRounds) {
		const failedRound = st.round;
		st.round += 1;
		st.stage = "run";
		st.validatedRound = 0;
		saveState(st);
		journal(st, event, { code: v?.code ?? null, failedRound, nextRound: st.round });
		pi.sendUserMessage(nextRoundPrompt(st, v, feedback), { deliverAs: "followUp" });
	} else {
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = event;
		st.epoch += 1;
		saveState(st);
		journal(st, event, { code: v?.code ?? null, maxRounds: st.maxRounds });
		pi.sendUserMessage(
			`【mini-harness】已达最大轮数 ${st.maxRounds}，停止。` +
				`${v ? `最后 validator 退出码 ${v.code}。` : ""}\n` +
				(feedback ? `反馈：${tail(feedback, 1500)}\n` : "") +
				(v ? `证据：\n\`\`\`\n${tail(v.output, 2000)}\n\`\`\`` : ""),
			{ deliverAs: "followUp" },
		);
	}
}

/** 代码 loop 判定：validator 是硬门禁，reviewer 是否决层。 */
async function handleVerdict(
	pi: ExtensionAPI,
	ctx: LoopCtx,
	st: LoopState,
	v: { pass: boolean; noValidator?: boolean; code: number | null; output: string },
) {
	if (v.pass) {
		const epoch = st.epoch;
		const review = await runReview(ctx, st, v, pi);
		if (!stillCurrent(st.runId, epoch)) {
			journal(st, "late-callback-dropped", { at: "handleVerdict/review", epoch });
			return;
		}
		st.lastReview = review;
		st.lastDiff = review.diff || "";
		saveState(st);
		journal(st, "review", { verdict: review.verdict, reasons: review.reasons });
		writeRoundReview(st, v, review, review.diff);
		if (review.verdict === "block") {
			notify(ctx, `⚠️ mini-harness：validator 通过，但 reviewer 否决（第 ${st.round} 轮）。`, "warning");
			advanceOrStop(pi, st, v, `reviewer 否决：\n${review.reasons.join("\n")}`, "reviewer-block");
			return;
		}
		if (review.verdict === "error") {
			// reviewer 模型不可用（404/过载/输出非法）——这是评审层故障，不是实质性否决。
			// validator 才是硬门禁：validator 已通过即视为达成，降级为 validator-only，但要显式告警。
			st.stage = "done";
			st.status = "done";
			saveState(st);
			journal(st, "reviewer-degraded", { code: v.code, reasons: review.reasons });
			notify(
				ctx,
				`⚠️ mini-harness：validator 通过，但 reviewer 不可用（第 ${st.round} 轮），` +
					`按 validator-only 判定完成。${(review.reasons || []).join("; ")}`,
				"warning",
			);
			return;
		}
		st.stage = "done";
		st.status = "done";
		saveState(st);
		journal(st, "validate-pass", { code: v.code, review: review.verdict });
		if (st.worktreeDir && st.worktreeBranch && !st.worktreeCommitted) {
			try {
				await pi.exec("git", ["-C", st.worktreeDir, "add", "-A"], { cwd: st.worktreeDir, timeout: 60000 });
				const d = await pi.exec("git", ["-C", st.worktreeDir, "diff", "--cached", "--quiet"], {
					cwd: st.worktreeDir,
					timeout: 60000,
				});
				if (d.code !== 0) {
					await pi.exec("git", ["-C", st.worktreeDir, "commit", "-m", `mini-harness run ${st.runId}`], {
						cwd: st.worktreeDir,
						timeout: 60000,
					});
				}
				if (!stillCurrent(st.runId, epoch)) {
					journal(st, "late-callback-dropped", { at: "handleVerdict/worktree", epoch });
					return;
				}
				st.worktreeCommitted = true;
				saveState(st);
				journal(st, "worktree-commit", { branch: st.worktreeBranch, dir: st.worktreeDir });
			} catch (e) {
				journal(st, "worktree-commit-error", { error: String((e as Error)?.message || e) });
			}
		}
		notify(
			ctx,
			`✅ mini-harness：第 ${st.round} 轮验证通过` +
				`${review.verdict === "skip" ? "" : `（reviewer ${review.verdict}）`}，目标达成。`,
			"info",
		);
		return;
	}
	if (v.noValidator) {
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = "no-validator";
		st.epoch += 1;
		saveState(st);
		journal(st, "no-validator");
		notify(ctx, "⚠️ mini-harness：未找到 validator，运行已停止。请提供 validateCmd 或 validate.py。", "warning");
		return;
	}
	advanceOrStop(pi, st, v, "", "validate-fail");
}

/** LLM loop 判定：无代码 validator，reviewer 是唯一判定。 */
async function handleLlmVerdict(pi: ExtensionAPI, ctx: LoopCtx, st: LoopState) {
	const syntheticV = {
		pass: true,
		code: null as number | null,
		output: "（LLM loop：无代码 validator，由 reviewer 判定）",
	};
	const epoch = st.epoch;
	const review = await runReview(ctx, st, syntheticV, pi);
	if (!stillCurrent(st.runId, epoch)) {
		journal(st, "late-callback-dropped", { at: "handleLlmVerdict/review", epoch });
		return;
	}
	st.lastReview = review;
	st.lastDiff = review.diff || "";
	st.lastVerdict = review.verdict === "pass" ? "pass" : review.verdict === "block" ? "fail" : review.verdict;
	st.lastCode = null;
	saveState(st);
	journal(st, "llm-review", { verdict: review.verdict, reasons: review.reasons });
	writeRoundReview(st, syntheticV, review, review.diff);
	if (review.verdict === "pass") {
		st.stage = "done";
		st.status = "done";
		saveState(st);
		journal(st, "validate-pass", { mode: "llm", review: review.verdict });
		notify(ctx, "✅ mini-harness（LLM loop）：reviewer 判定达成。", "info");
	} else if (review.verdict === "block") {
		if (st.round < st.maxRounds) {
			const failedRound = st.round;
			st.round += 1;
			st.stage = "run";
			st.validatedRound = 0;
			saveState(st);
			journal(st, "llm-block", { reasons: review.reasons, failedRound, nextRound: st.round });
			pi.sendUserMessage(
				`【mini-harness · LLM loop 第 ${st.round} 轮】reviewer 否决：\n${review.reasons.join("\n")}\n` +
					`请修复后再次调用 loop_done(summary)。目标：${st.goal}。不要向用户提问。`,
				{ deliverAs: "followUp" },
			);
		} else {
			st.stage = "stopped";
			st.status = "stopped";
			st.stopReason = "max-rounds";
			st.epoch += 1;
			saveState(st);
			journal(st, "llm-max-rounds");
			notify(ctx, `⚠️ mini-harness（LLM loop）：已达最大轮数 ${st.maxRounds}，停止。`, "warning");
		}
	} else if (review.verdict === "skip") {
		// 【修复③】reviewer 被关闭：LLM loop 按模型自述完成收尾（显式标记 self-declared），
		// 不再以 reviewer-error 停止。用户关闭 reviewer 即接受自述完成这一语义。
		st.lastVerdict = "self-declared";
		st.stage = "done";
		st.status = "done";
		saveState(st);
		journal(st, "llm-self-declared", {});
		notify(ctx, "✅ mini-harness（LLM loop）：reviewer 已关闭，按模型自述完成（self-declared）。", "info");
	} else {
		// reviewer 故障，且无 validator 可降级 → 停止（不做无判定完成）
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = "reviewer-error";
		st.epoch += 1;
		saveState(st);
		journal(st, "reviewer-error", { mode: "llm", reasons: review.reasons });
		notify(ctx, "⚠️ mini-harness（LLM loop）：reviewer 不可用且无 validator 可降级，已停止。", "warning");
	}
}

// ---------- 运行报告 ----------

function writeRoundReview(
	st: LoopState,
	v: { pass?: boolean; code?: number | null; output?: string } | null,
	review: { verdict: string; reasons?: string[] } | null,
	diff: string,
) {
	try {
		const dir = path.join(runDir(st.runId), "evidence");
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			`# mini-harness 运行报告 · ${st.runId}`,
			`- round: ${st.round} | stage: ${st.stage} | mode: ${st.mode}`,
			`- goal: ${st.goal}`,
			`- verdict: ${v?.pass ? "PASS" : "FAIL"}${v?.code != null ? `（exit ${v.code}）` : ""}`,
			review ? `- reviewer: ${review.verdict}` : "",
			...(review?.reasons?.length ? ["- reviewer reasons:", ...review.reasons.map((r) => `  - ${r}`)] : []),
			"",
			"## 执行者自述",
			st.summary || "(空)",
			"",
			"## 计划",
			st.plan || "(空)",
			"",
			"## validator 输出",
			"```",
			tail(v?.output || "", 4000),
			"```",
			"",
			"## 工作区/产物快照",
			"```",
			tail(diff, 4000),
			"```",
		];
		fs.writeFileSync(path.join(dir, `round-${st.round}-review.md`), lines.filter(Boolean).join("\n"));
	} catch {}
}

function buildTimelineText(st: LoopState) {
	try {
		const f = path.join(runDir(st.runId), "evidence", `round-${st.round}-review.md`);
		if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
	} catch {}
	return (
		`# mini-harness 运行报告 · ${st.runId}\n` +
		`stage=${st.stage} round=${st.round}\n` +
		`最近验证：${st.lastVerdict}（exit ${st.lastCode}）\n` +
		tail(st.lastEvidence || "", 2000)
	);
}

// ---------- 扩展入口 ----------

/**
 * mini-harness Loop 扩展工厂。
 * 经 agent-service 的 extensionFactories 注入（名字 mini-harness-loop，hidden），
 * 不再依赖 ~/.pi/agent 注册的包路径（那会加载到别的目录树的副本）。
 */
export function createLoopExtension() {
	return (pi: ExtensionAPI): void => {
		const busy = new Set<string>();

		// ---- 工具：loop_start ----
		pi.registerTool({
			name: "loop_start",
			label: "Loop Start",
			description:
				"启动一个受 validator 约束的任务运行（状态机 intake→plan→run→validate）。" +
				"validator 不通过会自动进入下一轮。状态落盘，可断点续跑。",
			parameters: Type.Object({
				goal: Type.String({ description: "要达成的目标（写清可验证的完成条件）" }),
				validateCmd: Type.Optional(
					Type.String({
						description: "validator 命令（shell）。缺省自动找 workspace/validate.py 或 HARNESS_ROOT/validate.py",
					}),
				),
				harnessRoot: Type.Optional(
					Type.String({ description: "infer-forge-harness 仓库根目录（用于定位 validate.py）" }),
				),
				artifactRoots: Type.Optional(
					Type.Array(Type.String(), { description: "产物根目录（可多个，workspace 之外）；reviewer 会核验这些目录" }),
				),
				maxRounds: Type.Optional(Type.Number({ description: `最大轮数，默认 ${DEFAULT_MAX_ROUNDS}` })),
				auto: Type.Optional(Type.Boolean({ description: "是否自动验证并自动下一轮，默认 true" })),
				plannerModel: Type.Optional(
					Type.String({ description: "规划模型（provider/id 或 id）。必须与主模型不同家族；缺省自动挑选" }),
				),
				reviewerModel: Type.Optional(
					Type.String({ description: "审查模型（provider/id 或 id）。必须与主模型、planner 都不同家族；缺省自动挑选" }),
				),
				useReviewer: Type.Optional(
					Type.Boolean({ description: "是否启用 reviewer 否决层，默认 true（有可用模型时）" }),
				),
				worktree: Type.Optional(
					Type.Boolean({
						description:
							"若 workspace 是 git 仓库，则在新 git worktree 中执行（隔离并行任务，验证通过后提交到独立分支）",
					}),
				),
				mode: Type.Optional(
					Type.String({
						description: "loop 类型：code（默认，validator 门禁）或 llm（无代码 validator，纯 reviewer 判定完成/迭代）",
					}),
				),
				taskId: Type.Optional(
					Type.String({
						description: "调用方任务 ID（批量队列/外部编排用）；记入运行状态用于显式关联，避免按 cwd+时间猜测",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const c = ctx as unknown as LoopCtx;
				// 家族约束：planner / reviewer 必须与主模型、彼此都不同家族
				const main = mainModel(c);
				const mainFam = main ? familyOf(main.id) : "unknown";
				const plannerSpec = params.plannerModel ? String(params.plannerModel) : "";
				const reviewerSpec = params.reviewerModel ? String(params.reviewerModel) : "";
				let planner = plannerSpec ? resolveModel(c, plannerSpec) : null;
				let reviewer = reviewerSpec ? resolveModel(c, reviewerSpec) : null;

				if (plannerSpec && !planner) {
					return { content: [{ type: "text", text: `无法解析 plannerModel「${plannerSpec}」。` }], details: {} };
				}
				const used = new Set([mainFam]);
				if (planner) {
					const f = familyOf(planner.id);
					if (used.has(f)) {
						return {
							content: [
								{
									type: "text",
									text: `planner 家族冲突：主模型 ${main?.id || "?"} 属于 ${mainFam}，planner ${planner.id} 也属于 ${f}。请选择不同家族的模型。`,
								},
							],
							details: {},
						};
					}
					used.add(f);
				} else {
					planner = pickModelByFamily(c, used);
					if (planner) used.add(familyOf(planner.id));
				}

				if (params.useReviewer !== false) {
					if (reviewerSpec && !reviewer) {
						return { content: [{ type: "text", text: `无法解析 reviewerModel「${reviewerSpec}」。` }], details: {} };
					}
					if (reviewer) {
						const f = familyOf(reviewer.id);
						if (used.has(f)) {
							return {
								content: [
									{
										type: "text",
										text:
											"reviewer 家族冲突：必须与主模型、planner 都不同家族。" +
											`当前已用 ${[...used].join("/")}，reviewer ${reviewer.id} 属于 ${f}。`,
									},
								],
								details: {},
							};
						}
					} else {
						reviewer = pickModelByFamily(c, used);
					}
				} else {
					reviewer = null;
				}

				const runId = newRunId();
				const maxRounds = Math.max(1, Math.min(20, Number(params.maxRounds) || DEFAULT_MAX_ROUNDS));

				// worktree 隔离：可选，在 git 仓库里开一个独立 worktree，避免并行任务互相污染
				let baseWorkspace = real(c?.cwd || process.cwd());
				let worktreeDir: string | null = null;
				let worktreeBranch: string | null = null;
				if (params.worktree) {
					try {
						const inside = await pi.exec("git", ["-C", baseWorkspace, "rev-parse", "--is-inside-work-tree"], {
							cwd: baseWorkspace,
							timeout: 15000,
						});
						if ((inside.stdout || "").trim() === "true") {
							worktreeDir = path.join(ROOT, runId, "worktree");
							worktreeBranch = `mini-harness/${runId}`;
							const add = await pi.exec(
								"git",
								["-C", baseWorkspace, "worktree", "add", "-b", worktreeBranch, worktreeDir],
								{ cwd: baseWorkspace, timeout: 60000 },
							);
							if (add.code === 0) baseWorkspace = real(worktreeDir);
							else {
								worktreeDir = null;
								worktreeBranch = null;
							}
						}
					} catch {}
				}

				const st: LoopState = {
					runId,
					taskId: params.taskId ? String(params.taskId) : null,
					goal: String(params.goal || "").trim(),
					workspace: baseWorkspace,
					baseWorkspace: real(c?.cwd || process.cwd()),
					worktreeDir,
					worktreeBranch,
					worktreeCommitted: false,
					harnessRoot: params.harnessRoot || null,
					artifactRoots: Array.isArray(params.artifactRoots) ? params.artifactRoots.map((x) => real(String(x))) : [],
					validateCmd: params.validateCmd || null,
					maxRounds,
					auto: params.auto !== false,
					mode: params.mode === "llm" ? "llm" : "code",
					round: 1,
					stage: "intake",
					status: "active",
					epoch: 0,
					sessionId: sessionIdOf(c),
					mainModel: modelBrief(main),
					plannerModel: modelBrief(planner),
					reviewerModel: modelBrief(reviewer),
					plannerOutput: "",
					lastReview: null,
					plan: "",
					summary: "",
					lastVerdict: null,
					lastCode: null,
					lastEvidence: "",
					validatedRound: 0,
					createdAt: now(),
					history: [],
				};
				saveState(st);
				journal(st, "start", {
					goal: st.goal,
					taskId: st.taskId,
					mode: st.mode,
					main: st.mainModel,
					planner: st.plannerModel,
					reviewer: st.reviewerModel,
				});
				// run 已创建：消费服务层登记的挂起启动请求（该回合结束不再上报 request-failed）
				takePendingLoopRequest(st.sessionId);

				// 规划：不同家族的 planner 产出可验证的验收条件（失败不阻塞运行，只记录）
				let plannerNote = "";
				if (planner) {
					try {
						const plan = await callModel(
							c,
							planner,
							"你是任务规划者。只输出可执行的计划与机器可验证的验收条件，不要调用工具、不要臆测环境。",
							[
								`目标：${st.goal}`,
								`工作区：${st.workspace}`,
								st.validateCmd ? `validator：${st.validateCmd}` : "",
								st.mode === "llm" ? "（LLM loop：无代码 validator，验收条件由 reviewer 判定）" : "",
								"请输出：1) 拆解步骤；2) 验收条件（明确文件/命令/指标，能被 validator 或人工直接核验）；3) 风险与需要人工确认的点。",
							]
								.filter(Boolean)
								.join("\n"),
						);
						st.plannerOutput = plan;
						saveState(st);
						journal(st, "planner", { family: st.plannerModel?.family, chars: plan.length });
						plannerNote = `\nplanner（${st.plannerModel?.family}/${st.plannerModel?.id}）已产出验收条件，见状态块。`;
					} catch (e) {
						plannerNote = `\n⚠️ planner 调用失败（不影响运行）：${String((e as Error)?.message || e)}`;
						journal(st, "planner-error", { error: String((e as Error)?.message || e) });
					}
				}

				return {
					content: [
						{
							type: "text",
							text:
								`已创建运行 ${runId}（mode=${st.mode}，stage=intake，最多 ${maxRounds} 轮）。\n` +
								`主模型家族：${mainFam}；` +
								`planner：${st.plannerModel ? `${st.plannerModel.family}/${st.plannerModel.id}` : "(无)"}；` +
								`reviewer：${st.reviewerModel ? `${st.reviewerModel.family}/${st.reviewerModel.id}` : "(无)"}。\n` +
								(st.worktreeBranch
									? `worktree 隔离：已在新分支 ${st.worktreeBranch} 的独立工作树中执行（验证通过后自动提交）。\n`
									: "") +
								"下一步：先调用 loop_plan 写出计划（会自动进入 run 阶段），然后直接修改工作区。\n" +
								"完成时调用 loop_done(summary)；运行时会自动执行 validator，" +
								"通过后 reviewer 可行使否决权，不通过则带证据进入下一轮。" +
								plannerNote,
						},
					],
					details: {
						runId,
						taskId: st.taskId,
						mode: st.mode,
						stage: st.stage,
						round: st.round,
						mainFamily: mainFam,
						planner: st.plannerModel,
						reviewer: st.reviewerModel,
					},
				};
			},
		});

		// ---- 工具：loop_plan ----
		pi.registerTool({
			name: "loop_plan",
			label: "Loop Plan",
			description: "记录本轮计划并进入 run 阶段。",
			parameters: Type.Object({ plan: Type.String({ description: "计划/步骤" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。请先调用 loop_start。" }], details: {} };
				}
				st.plan = String(params.plan || "").trim();
				st.stage = "run";
				saveState(st);
				journal(st, "plan", { plan: tail(st.plan, 400) });
				return {
					content: [
						{ type: "text", text: `计划已记录，进入 run（第 ${st.round} 轮）。完成后调用 loop_done(summary)。` },
					],
					details: { runId: st.runId, stage: st.stage },
				};
			},
		});

		// ---- 工具：loop_done ----
		pi.registerTool({
			name: "loop_done",
			label: "Loop Done",
			description: "声明本轮完成。运行时会自动执行 validator；只有 validator 通过才算真正完成。",
			parameters: Type.Object({ summary: Type.String({ description: "本轮改了什么、怎么验证的" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。请先调用 loop_start。" }], details: {} };
				}
				st.summary = String(params.summary || "").trim();
				st.stage = "validate";
				saveState(st);
				journal(st, "done-claimed", { summary: tail(st.summary, 400) });
				return {
					content: [{ type: "text", text: "已声明完成。运行时将在本轮结束时自动执行 validator 并给出判定。" }],
					details: { runId: st.runId, stage: st.stage },
				};
			},
		});

		// ---- 工具：loop_validate ----
		pi.registerTool({
			name: "loop_validate",
			label: "Loop Validate",
			description: "手动执行 validator 并记录证据（通常由运行时自动调用）。",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const c = ctx as unknown as LoopCtx;
				const st = findActiveRun(c);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。" }], details: {} };
				}
				if (st.mode === "llm") {
					await handleLlmVerdict(pi, c, st);
					return {
						content: [{ type: "text", text: `LLM loop 判定完成（reviewer ${st.lastReview?.verdict ?? "n/a"}）。` }],
						details: { runId: st.runId, mode: "llm", review: st.lastReview?.verdict },
					};
				}
				const v = await runValidation(pi, st);
				st.validatedRound = st.round;
				st.lastVerdict = v.pass ? "pass" : "fail";
				st.lastCode = v.code;
				st.lastEvidence = v.output;
				st.history.push({ round: st.round, verdict: st.lastVerdict, code: v.code, at: now(), evidence: v.evidence });
				journal(st, "manual-validate", { pass: v.pass, code: v.code });
				if (v.pass) {
					// 通过：同步跑 reviewer 并完结，避免 headless/print 模式下 agent_end 早退导致 reviewer 被跳过
					await handleVerdict(pi, c, st, v);
				} else {
					// 失败：交给 agent_end 统一推进下一轮（带证据 followUp）
					st.stage = "run";
					saveState(st);
				}
				return {
					content: [
						{
							type: "text",
							text:
								`${v.pass ? "PASS" : "FAIL"}（exit ${v.code}）\n${tail(v.output, 2000)}` +
								(v.pass ? `\nreviewer: ${st.lastReview?.verdict ?? "n/a"}` : ""),
						},
					],
					details: {
						runId: st.runId,
						pass: v.pass,
						code: v.code,
						evidence: v.evidence,
						review: st.lastReview?.verdict,
					},
				};
			},
		});

		// ---- 工具：loop_status ----
		pi.registerTool({
			name: "loop_status",
			label: "Loop Status",
			description: "查看当前会话的活跃运行状态（或指定 runId）。",
			parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = params.runId ? loadState(String(params.runId)) : findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
				}
				return {
					content: [{ type: "text", text: buildTimelineText(st) }],
					details: { runId: st.runId, stage: st.stage, status: st.status },
				};
			},
		});

		// ---- 工具：loop_stop ----
		pi.registerTool({
			name: "loop_stop",
			label: "Loop Stop",
			description: "停止当前会话的活跃运行（对在途操作与后续调度都生效）。",
			parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。" }], details: {} };
				}
				st.status = "stopped";
				st.stage = "stopped";
				st.stopReason = String(params.reason || "") || "user-stop";
				st.epoch += 1; // 【修复②】递增代次：在途/迟到的异步回调全部失效
				saveState(st);
				journal(st, "stop", { reason: st.stopReason, epoch: st.epoch });
				return {
					content: [{ type: "text", text: `已停止运行 ${st.runId}（epoch=${st.epoch}）。` }],
					details: { runId: st.runId, status: st.status, epoch: st.epoch },
				};
			},
		});

		// ---- 工具：loop_review ----
		pi.registerTool({
			name: "loop_review",
			label: "Loop Review",
			description: "读取运行报告（validator 证据 + reviewer 结论）。",
			parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = params.runId ? loadState(String(params.runId)) : findActiveRun(ctx as unknown as LoopCtx);
				if (!st) return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
				return {
					content: [{ type: "text", text: buildTimelineText(st) }],
					details: { runId: st.runId, stage: st.stage, status: st.status },
				};
			},
		});

		// ---- 工具：loop_timeline ----
		pi.registerTool({
			name: "loop_timeline",
			label: "Loop Timeline",
			description: "读取运行 journal（时间线）。",
			parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const c = ctx as unknown as LoopCtx;
				const st = params.runId
					? loadState(String(params.runId))
					: findActiveRun(c) || listRuns().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
				if (!st) return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
				return {
					content: [{ type: "text", text: buildTimelineText(st) }],
					details: { runId: st.runId, stage: st.stage, status: st.status },
				};
			},
		});

		// ---- 运行前注入状态（缓存友好：作为隐藏尾消息，不改系统提示词）----
		pi.on("before_agent_start", async (event, ctx) => {
			if ((event as { messageType?: string })?.messageType === "custom") {
				return;
			}
			const st = findActiveRun(ctx as unknown as LoopCtx);
			if (!st || st.status !== "active") {
				return;
			}
			return { message: { customType: CUSTOM_TYPE, content: stateBlock(st), display: false } };
		});

		// ---- 运行结束：自动 validator → 通过则完成；失败则自动下一轮 ----
		pi.on("agent_end", async (_event, ctx) => {
			const c = ctx as unknown as LoopCtx;
			const st = findActiveRun(c);
			if (!st) {
				// 修复「启动后无可见记录/无明确失败态」：服务层发启动提示词前会登记挂起请求；
				// 本回合结束仍没有活跃 run（模型没调 loop_start，或调用被拒）→ 上报明确失败。
				const sid = sessionIdOf(c);
				const pending = sid ? takePendingLoopRequest(sid) : null;
				if (pending) {
					reportEvent({
						type: "request-failed",
						sessionId: sid,
						taskId: pending.taskId,
						goal: pending.goal,
						reason: "模型未在本回合调用 loop_start（或调用被拒）",
					});
				}
				return;
			}
			if (!st.auto || st.status !== "active") {
				return;
			}
			if (!["run", "validate"].includes(st.stage)) {
				return;
			}
			if (busy.has(st.runId)) {
				return;
			}
			busy.add(st.runId);
			const epoch = st.epoch;
			try {
				if (st.mode === "llm") {
					await handleLlmVerdict(pi, c, st);
				} else {
					let v: { pass: boolean; noValidator: boolean; code: number | null; evidence: string | null; output: string };
					if (st.validatedRound === st.round && st.lastVerdict) {
						// 模型本轮已手动 loop_validate：复用结果，不再重复执行
						v = {
							pass: st.lastVerdict === "pass",
							noValidator: false,
							code: st.lastCode,
							output: st.lastEvidence || "",
							evidence: null,
						};
					} else {
						v = await runValidation(pi, st);
						if (!stillCurrent(st.runId, epoch)) {
							journal(st, "late-callback-dropped", { at: "agent_end/runValidation", epoch });
							return;
						}
						st.validatedRound = st.round;
						st.lastVerdict = v.pass ? "pass" : "fail";
						st.lastCode = v.code;
						st.lastEvidence = v.output;
						st.history.push({
							round: st.round,
							verdict: st.lastVerdict,
							code: v.code,
							at: now(),
							evidence: v.evidence,
						});
					}
					await handleVerdict(pi, c, st, v);
				}
			} catch (e) {
				journal(st, "runtime-error", { error: String((e as Error)?.message || e) });
				// 执行异常必须可见：不吞错，标记中断态（不伪装成完成）
				if (st.status === "active") {
					st.status = "stopped";
					st.stage = "stopped";
					st.stopReason = "runtime-error";
					st.epoch += 1;
					saveState(st);
					journal(st, "runtime-error-stop", { epoch: st.epoch });
					notify(c, `⚠️ mini-harness：运行时异常，已停止（${String((e as Error)?.message || e)}）。`, "warning");
				}
			} finally {
				busy.delete(st.runId);
			}
		});
	};
}
