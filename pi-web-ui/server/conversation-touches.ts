// ---------------------------------------------------------------------------
// conversation-touches.ts — 会话「触碰文件集」提取（纯函数，零 node 依赖）
// ---------------------------------------------------------------------------
// 背景：同项目多对话并行时，服务端完全知道「谁碰过哪些文件」（实时消息与落盘
// 转录里都有工具调用记录），但既没算也没给 AI，导致 AI 只能靠猜冲突。本模块
// 只实现一次触碰集解析器，三处复用：并行提醒（agent-service.ts）、
// conversation_read 的 action:"files" 与 action:"status"。
//
// 输入形状（两条路都已核实，见下「数据来源」）：
//   - 实时路：session.agent.state.messages（SDK AgentMessage），assistant 消息
//     的 content 里是 {type:"toolCall", id, name, arguments} 块；
//   - 历史路：转录 jsonl 的 message.content，原样保留同一形状（parseTranscript
//     Lines 透传 content）。
// 注意：textOfContent 只在「渲染文本」里丢了参数（仍渲染 `[tool call: name]`），
// content 结构里的 arguments 一直都在。所以 toolCalls 字段是 additive 的便捷
// 访问点（一处解析、多处复用，并行 toolCall 也能表示），不是新数据源；取不到
// 时回落扫 content，再取不到就给空集 —— 绝不伪造。
//
// 提取规则（只算写，不算读 —— 这是准确性的关键）：
//   写工具白名单：edit / write / edit_soft（参数 path；兼容 file_path/filePath
//   别名）。白名单之外的一切工具调用一律忽略，所以 read/ls/glob/grep 等读操作
//   天然不算 —— 不需要也不维护「读工具黑名单」。
//   bash 高置信度写入迹象（拿不准就丢，宁可漏报不要假阳性）：
//     - 重定向 `>` / `>>` 的目标词（含 `2> file` 这类 fd 前缀；排除 `>&N`、
//       /dev/null、NUL、&N；heredoc `<<`/`<<<` 不算写入）；
//     - rm / rmdir / mkdir / touch 的非 flag 参数；
//     - cp / mv 只取最后一个非 flag 参数（目标端；源端是读/被删，不算写）。
//   解析是轻量分词器（引号/转义感知，`;`/`&&`/`||`/`|`/`&`/`(`/`)` 切分命令
//   段），不是完整 shell 解析器。
//
// 已知局限（如实记录，调用方展示时不要夸大）：
//   1. 压缩（compaction）后旧消息被摘要替代，压缩前的触碰会丢失 —— 触碰集是
//      「当前可见转录」的下界，不是全集。
//   2. 相对路径按字面记录（edit 常给绝对路径、bash 常给相对路径），跨会话交集
//      可能因此漏报；但绝不做后缀模糊匹配（同名不同目录会假阳性，比漏报更糟）。
//   3. 路径归一化只做：去首尾空白、反斜杠转斜杠、去 `./` 前缀。Windows 大小写
//      不敏感不做归一。
//   4. powershell/cmd 风格写入（Set-Content/Out-File/del/copy）、git apply、
//      tee 落盘、xargs/timeout/nice 等包装词之后的子命令 —— 一律不提取
//      （sudo/env/command/time/nohup/doas 这几个常见包装词能跳过）。
//   5. 引号内的 `>`（如 echo "a > b"）不提取；但 `eval`/`sh -c` 套娃串内的重定
//      向会被当成普通命令解析 —— 置信度下降，属已知噪声源。
// ---------------------------------------------------------------------------

/** 工具调用的参数键：SDK 用 arguments，兼容 input/args 两种历史写法。 */
function argsOfBlock(blk: { arguments?: unknown; input?: unknown; args?: unknown }): unknown {
	if (typeof blk.arguments !== "undefined") return blk.arguments;
	if (typeof blk.input !== "undefined") return blk.input;
	return blk.args;
}

/** content 块数组里工具调用的 (name, args) 对（非 toolCall 块跳过）。 */
export function toolCallRefsOfContent(content: unknown): { name: string; args?: unknown }[] {
	if (!Array.isArray(content)) return [];
	const out: { name: string; args?: unknown }[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; name?: unknown; arguments?: unknown; input?: unknown; args?: unknown };
		if (blk.type !== "toolCall" || typeof blk.name !== "string" || !blk.name) continue;
		const args = argsOfBlock(blk);
		if (typeof args === "undefined") out.push({ name: blk.name });
		else out.push({ name: blk.name, args });
	}
	return out;
}

/** 触碰提取的最小输入面（TranscriptInputMessage 结构兼容，无需 import 避免循环）。 */
export interface TouchableMessage {
	role: string;
	content?: unknown;
	command?: string;
	output?: string;
	timestamp?: number;
	toolCalls?: { name: string; args?: unknown }[] | undefined | null;
}

/** 一条消息的全部工具调用：优先已解析的 toolCalls 字段，回落扫 content。 */
export function toolCallsOf(m: TouchableMessage | null | undefined): { name: string; args?: unknown }[] {
	if (!m || typeof m !== "object") return [];
	if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
		return m.toolCalls.filter(
			(t): t is { name: string; args?: unknown } =>
				!!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string",
		);
	}
	return toolCallRefsOfContent(m.content);
}

/** 写工具白名单：只有这些工具的目标路径才算「写」。 */
const WRITE_TOOL_NAMES = new Set(["edit", "write", "edit_soft"]);

function pathOfWriteArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as { path?: unknown; file_path?: unknown; filePath?: unknown };
	for (const k of ["path", "file_path", "filePath"] as const) {
		const v = a[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

/** 路径轻归一（见文件头局限 3）：只做无损、低风险的规范化。 */
export function normalizeTouchPath(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	while (s.startsWith("./")) s = s.slice(2);
	return s;
}

/** patch 补丁文本 → 目标路径集合（段头 [path#TAG]/[path] + MV 目标）。 */
export function patchWriteTargets(patchText: string): string[] {
	const out: string[] = [];
	for (const m of patchText.matchAll(/^\s*\[([^#\]\r\n]+)(?:#[0-9A-Fa-f]{4})?\]\s*$/gm)) {
		out.push(m[1].trim());
	}
	for (const m of patchText.matchAll(/^\s*MV\s+(\S+)/gim)) out.push(m[1]);
	return out;
}

export interface TouchedFile {
	path: string;
	count: number;
	/** 最后一次触碰的消息 timestamp（消息无 timestamp 时为 0）。 */
	lastTs: number;
}

// ---------------------------------------------------------------------------
// bash 命令解析（高置信度写入迹象，见文件头规则）
// ---------------------------------------------------------------------------

/** shell 分词：引号/反斜杠转义感知，引号剥掉（`echo "a > b"` 的 > 不会误报）。 */
function tokenizeShell(cmd: string): string[] {
	const toks: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let i = 0;
	const push = () => {
		if (cur !== "") {
			toks.push(cur);
			cur = "";
		}
	};
	while (i < cmd.length) {
		const ch = cmd[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
				cur += cmd[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			else cur += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < cmd.length) {
			cur += cmd[i + 1];
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			push();
			i++;
			continue;
		}
		// 多字符操作符先行：>>、<<、&&、||、2>、1>> 等。
		const three = cmd.slice(i, i + 3);
		const two = cmd.slice(i, i + 2);
		if (/^\d>>/.test(three) || three === "<<<") {
			push();
			toks.push(three);
			i += 3;
			continue;
		}
		if (two === ">>" || two === "<<" || two === "&&" || two === "||" || /^\d>$/.test(two) || /^\d</.test(two)) {
			push();
			toks.push(two);
			i += 2;
			continue;
		}
		if (ch === ">" || ch === "<" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
			push();
			toks.push(ch);
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	push();
	return toks;
}

const SEGMENT_SEPS = new Set([";", "&&", "||", "|", "&", "(", ")"]);
/** 命令段首可跳过的包装词（之后仍是命令位置）。 */
const WRAPPER_WORDS = new Set(["sudo", "env", "command", "time", "nohup", "doas"]);
const MULTI_TARGET_WRITES = new Set(["rm", "rmdir", "mkdir", "touch"]);
/** 只算目标端（最后一个非 flag 参数）的命令。 */
const DEST_ONLY_WRITES = new Set(["cp", "mv"]);
/** 重定向目标黑名单：不是文件。 */
function isNonFileTarget(t: string): boolean {
	if (t === "/dev/null" || t.toLowerCase() === "nul") return true;
	if (/^&\d*$/.test(t)) return true;
	if (t === "-") return true;
	return false;
}

/** bash 命令 → 高置信度写入路径（去重前，调用方计数）。 */
export function bashWriteTargets(command: string): string[] {
	if (typeof command !== "string" || !command.trim()) return [];
	const toks = tokenizeShell(command);
	const out: string[] = [];
	// 命令段内状态：cmd = 当前命令词（null = 还在找命令词），args = 该段非 flag 参数。
	let cmd: string | null = null;
	let pendingMulti: string[] = [];
	let pendingDest: string | null = null;
	let afterDoubleDash = false;
	let skipNext = false;
	const flush = () => {
		out.push(...pendingMulti);
		if (pendingDest !== null) out.push(pendingDest);
		pendingMulti = [];
		pendingDest = null;
	};
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (SEGMENT_SEPS.has(t)) {
			flush();
			cmd = null;
			afterDoubleDash = false;
			continue;
		}
		// 重定向：`[fd]>[>] 目标`；heredoc 一律跳过。分隔符不能当目标吃掉
		// （`echo a > ; rm x` 里 `;` 必须保留，否则后半段命令会错位）。
		if (/^(\d*)(>>?)$/.test(t) || t === "<<" || t === "<<<" || /^(\d*)<<<?$/.test(t)) {
			const next = toks[i + 1];
			if (typeof next !== "undefined" && !SEGMENT_SEPS.has(next)) {
				if (t.includes(">") && !isNonFileTarget(next)) out.push(next);
				skipNext = true;
			}
			continue;
		}
		if (t === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (cmd === null) {
			if (WRAPPER_WORDS.has(t)) continue;
			if (t.includes("=") && !t.startsWith("-")) continue; // VAR=val 前缀赋值
			cmd = t;
			if (cmd === "xargs") cmd = "\0xargs-opaque"; // xargs 后的是子命令+参数，别当文件（局限 4）
			continue;
		}
		if (cmd === "\0xargs-opaque") continue;
		if (!afterDoubleDash && t.startsWith("-") && t.length > 1) continue; // flag
		if (MULTI_TARGET_WRITES.has(cmd)) pendingMulti.push(t);
		else if (DEST_ONLY_WRITES.has(cmd)) pendingDest = t; // 只留最后一个
	}
	flush();
	return out.filter((p) => p !== "" && !isNonFileTarget(p));
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface ExtractTouchesOpts {
	/** 只看最近 N 条消息（提醒/摘要场景防长尾；默认 500）。 */
	maxMessages?: number;
}

/** 转录消息 → 触碰文件集（按次数降序，次数相同按最后时间降序）。 */
export function extractTouches(
	messages: readonly TouchableMessage[] | undefined | null,
	opts?: ExtractTouchesOpts,
): TouchedFile[] {
	if (!Array.isArray(messages) || messages.length === 0) return [];
	const max = Math.max(1, Math.floor(opts?.maxMessages ?? 500));
	const slice = messages.slice(Math.max(0, messages.length - max));
	const acc = new Map<string, { count: number; lastTs: number }>();
	const bump = (raw: string, ts: number) => {
		const path = normalizeTouchPath(raw);
		if (!path) return;
		const e = acc.get(path);
		if (e) {
			e.count++;
			if (ts > e.lastTs) e.lastTs = ts;
		} else {
			acc.set(path, { count: 1, lastTs: ts });
		}
	};
	for (const m of slice) {
		if (!m || typeof m !== "object") continue;
		const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : 0;
		for (const call of toolCallsOf(m)) {
			const name = call.name;
			if (name === "patch") {
				// patch 的目标路径在补丁文本里（无 args.path），按段头/MV 提取
				const args = call.args as { patch?: unknown } | undefined;
				if (args && typeof args.patch === "string") {
					for (const p of patchWriteTargets(args.patch)) bump(p, ts);
				}
				continue;
			}
			if (WRITE_TOOL_NAMES.has(name)) {
				const p = pathOfWriteArgs(call.args);
				if (p) bump(p, ts);
				continue;
			}
			if (name === "bash" && call.args && typeof call.args === "object") {
				const c = (call.args as { command?: unknown }).command;
				if (typeof c === "string") {
					for (const p of bashWriteTargets(c)) bump(p, ts);
				}
			}
		}
		// `!` 命令 / bashExecution 转录消息：命令在顶层 command 字段。
		if (m.role === "bashExecution" && typeof m.command === "string") {
			for (const p of bashWriteTargets(m.command)) bump(p, ts);
		}
	}
	return [...acc.entries()]
		.map(([path, e]) => ({ path, count: e.count, lastTs: e.lastTs }))
		.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

/** 两个触碰集求并（sidecar 合并用）：sidecar 是历史快照、live 是当前全量，
 *  两者消息集重叠，所以 count 取大不相加 —— 相加会把同一批触碰算两遍。
 *  压缩后次数只能保证是下界（presence 与 lastTs 精确，交集计算不受影响）。 */
export function unionTouchLists(a: TouchedFile[], b: TouchedFile[]): TouchedFile[] {
	const acc = new Map<string, { count: number; lastTs: number }>();
	for (const f of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
		if (!f || typeof f.path !== "string") continue;
		const e = acc.get(f.path);
		const count = typeof f.count === "number" && Number.isFinite(f.count) ? f.count : 0;
		const lastTs = typeof f.lastTs === "number" && Number.isFinite(f.lastTs) ? f.lastTs : 0;
		if (e) {
			if (count > e.count) e.count = count;
			if (lastTs > e.lastTs) e.lastTs = lastTs;
		} else {
			acc.set(f.path, { count, lastTs });
		}
	}
	return [...acc.entries()]
		.map(([path, e]) => ({ path, count: e.count, lastTs: e.lastTs }))
		.sort((x, y) => y.count - x.count || y.lastTs - x.lastTs);
}

/** 两个触碰集的交集：取 a 中同时出现在 b 里的条目（计数/时间沿用 a 的）。 */
export function intersectTouches(a: TouchedFile[], b: TouchedFile[]): TouchedFile[] {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return [];
	const inB = new Set(b.map((f) => f.path));
	return a.filter((f) => inB.has(f.path));
}

/** 单条触碰格式化（供提醒用）：条目超长时优先保路径完整 —— 路径永不截断
 *  （半截路径不可用，还可能误导 AI 去碰错文件），只丢 `×N` 后缀。 */
export function formatTouchEntry(f: TouchedFile, perItemCap = 60): string {
	const full = f.count > 1 ? `${f.path} ×${f.count}` : f.path;
	if (full.length <= perItemCap) return full;
	return f.path;
}

export interface FormatTouchesOpts {
	/** 最多展示几条（默认 3；超出给计数不断尾，见下）。 */
	maxItems?: number;
	/** 单条字符上限（默认 60；路径永不截断，见 formatTouchEntry）。 */
	perItemCap?: number;
}

/** 触碰集紧凑格式化：前 N 条完整路径 + `… (+K)` 计数（静默丢弃是大忌）。 */
export function formatTouchesCompact(files: TouchedFile[], opts?: FormatTouchesOpts): string {
	if (!Array.isArray(files) || files.length === 0) return "";
	const maxItems = Math.max(1, Math.floor(opts?.maxItems ?? 3));
	const cap = Math.max(10, Math.floor(opts?.perItemCap ?? 60));
	const shown = files.slice(0, maxItems).map((f) => formatTouchEntry(f, cap));
	if (files.length > maxItems) shown.push(`… (+${files.length - maxItems})`);
	return shown.join("、");
}
