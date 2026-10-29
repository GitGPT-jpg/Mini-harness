/**
 * AI commit-message generation — pure prompt assembly + response cleanup.
 *
 * The git gathering lives in scm.ts (scmCommitContext); the one-off model
 * call lives in agent-service (ClientSession.scmGenCommitMessage, same
 * completeSimple path as the vision bridge). This module owns everything
 * deterministic so it stays unit-testable:
 *
 *   buildCommitMsgInput(ctx, fallbackLang) → user message (null = nothing
 *     to commit — the caller turns that into a friendly error)
 *   COMMITMSG_SYSTEM_PROMPT                   → system prompt
 *   sanitizeCommitMessage(raw)               → the single-line subject that
 *     ends up in the commit input (models are told to emit exactly that, but
 *     fences/labels/quotes/newlines are stripped defensively)
 *
 * Language policy: the generated message follows the repository's own commit
 * subjects (style AND language — a repo writing "feat(xxx): 描述" keeps
 * getting that). Only a repo with no commits yet falls back to the UI
 * language passed as fallbackLang.
 */

import { isNotRepoError, scmCommitContext, type ScmCommitContext } from "./scm.js";
import { pick, type ServerLang } from "./i18n.js";

/** SCM AI 提交信息生成超时时间（毫秒） */
export const SCM_COMMITMSG_TIMEOUT_MS = 60_000;

/** Hard cap for the generated subject — the commit input is single-line and
 *  this keeps a chatty model from filling the whole header row. */
export const MAX_COMMITMSG_LEN = 200;

/** File list cap inside the prompt (porcelain lines); the diffs carry the
 *  details, the list is orientation only. */
const MAX_FILE_LINES = 200;

export const COMMITMSG_SYSTEM_PROMPT = `You write git commit messages. You receive the pending changes of a repository and output exactly one commit message: a single subject line.

Rules:
1. Match the style, format and language of the repository's recent commit subjects when provided — conventional commits ("type(scope): summary"), prefixes, punctuation, language: copy what the repo actually does.
2. Describe what the change does at a glance (the user-facing effect), not a file-by-file listing.
3. The staged diff is the subject of the commit. Describe staged changes when any exist; otherwise describe the unstaged and untracked changes shown.
4. One line. No quotes, no markdown, no code fences, no "Commit message:" label, no explanation. Under 72 characters when the repository's language allows it (CJK text may naturally be shorter).
5. Never invent scope names, issue numbers or details not visible in the provided material.
6. If the repository has no commits yet, write the message in the language stated in the request.

Output ONLY the subject line.`;

/**
 * Assemble the effective system prompt from the settings-panel prefs (same
 * contract as the vision bridge's buildVisionBridgePrompt): mode "append"
 * puts custom text after the built-in default (empty custom = pure default);
 * mode "replace" swaps in the custom text, but an empty custom still falls
 * back to the default (never send an empty system prompt).
 */
export function buildCommitMsgPrompt(mode: "append" | "replace", custom: string): string {
	const text = custom?.trim() ?? "";
	if (mode === "replace" && text) return text;
	if (text) return `${COMMITMSG_SYSTEM_PROMPT}\n\n${text}`;
	return COMMITMSG_SYSTEM_PROMPT;
}

/** "path → [add,del]" map → compact "+12/-3 path" lines (sorted by path). */
function formatNumStat(stat: Record<string, [number, number]>): string[] {
	return Object.keys(stat)
		.sort()
		.map((p) => `+${stat[p][0]}/-${stat[p][1]} ${p}`);
}

/**
 * Assemble the user message from the gathered context. Returns null when
 * there is nothing to describe (no staged/unstaged diff and no untracked
 * files) — the caller replies "no changes" instead of calling the model.
 */
export function buildCommitMsgInput(ctx: ScmCommitContext, fallbackLang: "zh" | "en"): string | null {
	const parts: string[] = [];

	if (ctx.subjects.length > 0) {
		parts.push("Recent commit subjects (newest first — style reference):");
		parts.push(...ctx.subjects.map((s) => `- ${s}`));
	} else {
		parts.push(
			fallbackLang === "zh"
				? "（仓库还没有任何提交；请用中文写这条提交信息）"
				: "(The repository has no commits yet; write this commit message in English.)",
		);
	}

	if (ctx.files.length > 0) {
		const shown = ctx.files.slice(0, MAX_FILE_LINES);
		const more = ctx.files.length - shown.length;
		parts.push("Changed files (porcelain status):");
		parts.push(...shown.map((f) => `${f.x}${f.y} ${f.path}`));
		if (more > 0) parts.push(`… (+${more} more files)`);
	}

	if (ctx.stagedPatch.trim()) {
		parts.push("Staged diff (these changes are the commit's subject):");
		if (Object.keys(ctx.stagedStat).length > 0) {
			parts.push(...formatNumStat(ctx.stagedStat));
		}
		parts.push(ctx.stagedPatch);
	}

	if (ctx.worktreePatch.trim()) {
		parts.push("Unstaged diff (worktree only):");
		if (Object.keys(ctx.worktreeStat).length > 0) {
			parts.push(...formatNumStat(ctx.worktreeStat));
		}
		parts.push(ctx.worktreePatch);
	}

	const untracked = ctx.files.filter((f) => f.x === "?" && f.y === "?");
	if (untracked.length > 0 && !ctx.stagedPatch.trim()) {
		// Untracked content never appears in `git diff` — name the files so
		// the model knows they are part of the change set (commit-all flow).
		parts.push(
			`Untracked files (new, content not shown): ${untracked
				.map((f) => f.path)
				.join(", ")
				.slice(0, 2000)}`,
		);
	}

	if (!ctx.stagedPatch.trim() && !ctx.worktreePatch.trim() && untracked.length === 0) return null;
	return parts.join("\n");
}

/**
 * Normalize whatever the model emitted into the single-line subject that goes
 * into the commit input: drop fences, labels and wrapping quotes, keep only
 * the first non-empty line, collapse whitespace, cap the length.
 */
export function sanitizeCommitMessage(raw: string): string {
	let text = raw.trim();
	// ```…``` fences wrapping the whole answer.
	const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
	if (fence) text = fence[1].trim();
	// Leading labels some models add despite the instructions.
	text = text.replace(/^(commit(\s+message)?|subject|提交信息|提交消息|提交说明)\s*[:：]\s*/i, "");
	// First non-empty line only — the input field is single-line by design.
	const firstLine =
		text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	let out = firstLine.replace(/\s+/g, " ").trim();
	// Matching wrapping quotes.
	if (out.length >= 2) {
		const a = out[0];
		const b = out[out.length - 1];
		if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === "`" && b === "`")) {
			out = out.slice(1, -1).trim();
		}
	}
	if (out.length > MAX_COMMITMSG_LEN) out = `${out.slice(0, MAX_COMMITMSG_LEN - 1).trimEnd()}…`;
	return out;
}

/**
 * 完整的 SCM AI 提交信息生成逻辑封装：
 * 提取 git 差异上下文 -> 组装 prompt -> 调用模型 completeSimple -> 结果清洗校验
 */
export async function generateScmCommitMessage(opts: {
	cwd: string;
	model: any;
	runtime: {
		completeSimple: (
			model: any,
			context: any,
			options?: any,
		) => Promise<{
			stopReason: string;
			errorMessage?: string;
			content: Array<{ type: string; text?: string }>;
		}>;
	};
	lang: ServerLang;
	promptMode?: "append" | "replace";
	customPrompt?: string;
	timeoutMs?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const {
		cwd,
		model,
		runtime,
		lang,
		promptMode = "append",
		customPrompt = "",
		timeoutMs = SCM_COMMITMSG_TIMEOUT_MS,
	} = opts;

	try {
		const ctx = await scmCommitContext(cwd, () => lang);
		const input = buildCommitMsgInput(ctx, lang === "zh" ? "zh" : "en");
		if (!input) {
			return {
				ok: false,
				error: pick(
					lang,
					"没有可描述的更改（工作区干净）",
					"Nothing to describe (working tree clean)",
					"scm.commitmsg.no.changes",
				),
			};
		}

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		const systemPrompt = buildCommitMsgPrompt(promptMode, customPrompt);

		let msg: Awaited<ReturnType<typeof runtime.completeSimple>>;
		try {
			msg = await runtime.completeSimple(
				model,
				{
					systemPrompt,
					messages: [
						{
							role: "user",
							timestamp: Date.now(),
							content: [{ type: "text", text: input }],
						},
					],
				},
				{ signal: ac.signal, maxTokens: 400 },
			);
		} finally {
			clearTimeout(timer);
		}

		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			return {
				ok: false,
				error:
					msg.errorMessage ||
					pick(
						lang,
						`模型异常终止（${msg.stopReason}）`,
						`Model terminated abnormally (${msg.stopReason})`,
						"scm.commitmsg.model.terminated",
						{ stopReason: msg.stopReason },
					),
			};
		}

		const raw = msg.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text?: string }).text ?? "")
			.join("\n");
		const text = sanitizeCommitMessage(raw);
		if (!text) {
			return {
				ok: false,
				error: pick(
					lang,
					"模型返回了空的提交信息",
					"The model returned an empty commit message",
					"scm.commitmsg.empty",
				),
			};
		}

		return { ok: true, text };
	} catch (err) {
		if (isNotRepoError(err)) {
			return {
				ok: false,
				error: pick(
					lang,
					"当前目录不是 Git 仓库",
					"Current directory is not a Git repository",
					"scm.commitmsg.not.repo",
				),
			};
		}
		if (err instanceof Error && /abort/i.test(`${err.name} ${err.message}`)) {
			const secs = Math.round(timeoutMs / 1000);
			return {
				ok: false,
				error: pick(
					lang,
					`生成提交信息超时（${secs} 秒）`,
					`Commit-message generation timed out (${secs}s)`,
					"scm.commitmsg.timeout",
					{ secs },
				),
			};
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
