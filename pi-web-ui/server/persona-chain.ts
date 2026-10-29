/**
 * persona-chain — 内联人设注入、扩展提示词包裹剥离与平台人设补丁。
 *
 * 负责：
 * - INLINE_PERSONA_EXT: 自家内联扩展名标识
 * - splitAgentStartPrompt: 剥离先前扩展对 SDK 原始系统提示词的首尾增补
 * - PI_DOC_PATHS: 本地 pi SDK 文档路径发现
 * - WINDOWS_PERSONA: Windows 平台特有人设补丁（超时/非交互 TTY/GBK 编码）
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { splitExtensionWrap } from "./prompt-composer.js";

/** 自家内联扩展名（组合模板渲染，见 prompt-composer.ts）。SDK 以其
 *  "<inline:<name>>" 作为 path；扩展白名单/禁用过滤必须放行它。 */
export const INLINE_PERSONA_EXT = "<inline:pi-webui-persona>";

/** 本次 run 的 SDK 原始提示词 + 早前扩展的首尾增补（见 splitExtensionWrap）。
 *  导出仅为单测（tests/unit/persona-prompt-chain.test.ts）可达。
 *  systemPromptOptions 就是 runner 里那个共享可变对象，forceSystemPrompt 有值即
 *  说明前面有扩展替换过提示词；临时清掉再读 event.systemPrompt 就拿到原始基线
 *  （公开字段，不碰 SDK 内部）。没人动过时零开销，直接返回当前文本。 */
export function splitAgentStartPrompt(event: {
	readonly systemPrompt: string;
	systemPromptOptions?: { forceSystemPrompt?: string };
}): { pre: string; core: string; post: string } {
	const current = event.systemPrompt;
	const opts = event.systemPromptOptions;
	const forced = opts?.forceSystemPrompt;
	if (!opts || typeof forced !== "string") return { pre: "", core: current, post: "" };
	try {
		opts.forceSystemPrompt = undefined;
		return splitExtensionWrap(event.systemPrompt, current);
	} finally {
		opts.forceSystemPrompt = forced;
	}
}

/** Pi 包文档路径（composer 的 {{pi_docs}} 自动内容用）。随安装位置解析一次。 */
export const PI_DOC_PATHS = (() => {
	try {
		const requireLocal = createRequire(import.meta.url);
		const root = dirname(requireLocal.resolve("@earendil-works/pi-coding-agent/package.json"));
		return { readme: join(root, "README.md"), docs: join(root, "docs"), examples: join(root, "examples") };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
})();

/** Windows persona appendix — appended to the SDK system prompt on win32 only.
 *  Two failure modes it guards against: (1) the SDK bash tool has NO default
 *  timeout, so a long-running command hangs the whole conversation forever;
 *  (2) the in-app terminal is an interactive TTY where heredocs / interactive
 *  programs wait for input that never comes. Legacy Chinese files are often
 *  GBK/GB2312 — read them with the right encoding, never paste mojibake into
 *  reasoning/answers. */
export const WINDOWS_PERSONA = `You are a coding agent running on Windows. The bash tool runs Git Bash (bash.exe), not PowerShell. Follow these rules to avoid hanging the session:



- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.
- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.
- In the interactive terminal (TTY) — which is Git Bash too, not PowerShell — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).

Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake (乱码) for them. If a file's content looks garbled, read it through the terminal instead: in Git Bash use \`cat file | iconv -f GBK -t UTF-8\` (or \`iconv -f GBK -t UTF-8 file\`); in cmd use \`chcp 65001 && type file\`; in PowerShell use \`Get-Content -Encoding Default file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`;
