import { describe, expect, it } from "vitest";
import {
	cleanBashOutput,
	detectTrailingLimiter,
	makeTerminalBashTool,
	newSentinelNonce,
	sentinelUnsafeReason,
	type TerminalManager,
} from "../../server/terminals.js";

/** 终端接管 bash 的输出清洗与退出码判定（#572 / #571）。
 *
 * 旧实现的缺陷：清洗假定「哨兵回显一定在真实输出之前」，按它截断。
 *  - Linux 上哨兵回显确实在输出之前，但readline 命令结束后又重绘一次，第二次把真实输出整段吃掉（#572 ①）；
 *  - Windows ConPTY（MINGW64 bash）实测：shell 读到哨兵行才回显它，哨兵回显排在真实输出之后，
 *    同样整段吃掉、只剩 [exit:0]（Windows 实测复现，tests/terminal-bash-test.mjs 也因此失败）；
 *  - 哨兵没有 nonce，真实输出里的 `[pi-exit:42]` 被当成真哨兵，提前返回假退出码（#572 ②）。
 * 修复：哨兵带每次调用随机 nonce；清洗只依赖与时序无关的两个锚点——含 nonce 的哨兵回显行整行删除，
 * 命令回显（首行）及其之前的提示符删除。 */

const NONCE = "0123456789ab";

/** 哨兵行的 shell 回显（与 buildTerminalBashLine 的 sentinel 同形）。字符串拼接，避免转义歧义。 */
const sentinelEcho = (nonce: string): string =>
	"__pi_rc=${PIPESTATUS:-$?}; printf '" + String.raw`\n[pi-exit-${nonce}:%s]\n` + `' "$__pi_rc"`;

/** 哨兵输出（数字版）。 */
const sentinelExit = (nonce: string, code = 0): string => `\r\n[pi-exit-${nonce}:${code}]\r\n`;

const toCRLF = (s: string): string => s.replace(/\n/g, "\r\n");

/** 假 PTY：按两种真实时序之一写入缓冲区。
 *  - linux：命令回显 → 哨兵回显 → 真实输出 → 哨兵重绘 → 哨兵输出；
 *  - conpty：提示符 + 命令回显 → 真实输出 → 提示符 + 哨兵回显（读到才回显）→ 哨兵输出。 */
function fakePty(realOutput: string, timing: "linux" | "conpty"): TerminalManager {
	let buf = "";
	return {
		create: () => "ai-bash-1",
		suspendIdleWatch: () => {},
		endCursor: () => 0,
		setSentinelPending: () => {},
		watchOutput: () => () => {},
		read: (_id: string, cursor: number) => {
			if (cursor >= buf.length) return null;
			return { data: buf.slice(cursor), cursor: buf.length };
		},
		inputChecked: (_id: string, data: string): string | null => {
			if (data === "exit\r" || data === "\x03") return null;
			const body = data.replace(/\r$/, "");
			const nonce = /\[pi-exit-([0-9a-f]{12}):%s\]/.exec(body)?.[1];
			if (!nonce) return "fake pty: no sentinel in input";
			const cmdFirstLine = body.split("\n")[0] ?? "";
			const sentLine = body.split("\n").pop() ?? "";
			const prompt = "c@HOST MINGW64 /tmp/x\r\n$ ";
			if (timing === "linux") {
				buf += toCRLF(body) + "\r\n" + toCRLF(realOutput) + "\r" + sentLine + "\r\n" + sentinelExit(nonce);
			} else {
				buf += prompt + cmdFirstLine + "\r\n" + toCRLF(realOutput) + prompt + sentLine + "\r\n" + sentinelExit(nonce);
			}
			return null;
		},
	} as unknown as TerminalManager;
}

async function run(
	command: string,
	realOutput: string,
	timing: "linux" | "conpty",
): Promise<{ output: string; exitCode: number }> {
	const tool = makeTerminalBashTool(fakePty(realOutput, timing), {
		cwd: process.cwd(),
		defaultPersist: () => false,
		idleMs: () => 0,
		kills: new Set(),
		notifyBackgroundDone: () => {},
	});
	const res = await tool.execute("t1", { command }, undefined, undefined, undefined as never);
	const details = res.details as { output: string; exitCode: number };
	return { output: details.output, exitCode: details.exitCode };
}

describe("cleanBashOutput：与时序无关的清洗（#572 ①、Windows ConPTY 实测）", () => {
	it("Linux 时序：命令回显 / 哨兵回显 / 真实输出 / 哨兵重绘：正文完整保留", () => {
		const raw =
			"echo hello; whoami\r\n" +
			sentinelEcho(NONCE) +
			"\r\nhello\r\nuser\r\n" +
			"\r" +
			sentinelEcho(NONCE) +
			"\r\n" +
			sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "echo hello; whoami")).toBe("hello\nuser");
	});

	it("ConPTY 时序：哨兵回显在真实输出之后，正文完整保留（旧实现在此返回空串）", () => {
		const raw =
			"c@HOST MINGW64 /tmp/x\r\n$ echo hello-dbg\r\nhello-dbg       \r\n" +
			"c@HOST MINGW64 /tmp/x\r\n$ " +
			sentinelEcho(NONCE) +
			"\r\n" +
			sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "echo hello-dbg")).toBe("hello-dbg");
	});

	it("ConPTY 时序：行尾填充空格被去掉，多行输出顺序不变", () => {
		const raw =
			"c@HOST MINGW64 /tmp/x\r\n$ ls\r\na.txt       \r\nb.txt       \r\n" +
			"c@HOST MINGW64 /tmp/x\r\n$ " +
			sentinelEcho(NONCE) +
			"\r\n" +
			sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "ls")).toBe("a.txt\nb.txt");
	});
});

describe("cleanBashOutput / 退出码：nonce 隔离真实输出里的哨兵字面量（#572 ②）", () => {
	it("真实输出含 [pi-exit:%s] 与 [pi-exit:42]：不被清掉、不被当成真哨兵", () => {
		const raw =
			"grep out\r\n" + sentinelEcho(NONCE) + "\r\nhello\r\n[pi-exit:42]\r\n[pi-exit:%s]\r\n" + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "grep out")).toBe("hello\n[pi-exit:42]\n[pi-exit:%s]");
	});
});

describe("终端接管 bash 工具端到端（假 PTY，两种时序）", () => {
	it.each(["linux", "conpty"] as const)("%s：正常命令正文非空、退出码真实", async (timing) => {
		const r = await run("echo hello-dbg", "hello-dbg       \n", timing);
		expect(r.output).toBe("hello-dbg");
		expect(r.exitCode).toBe(0);
	});

	it.each(["linux", "conpty"] as const)("%s：多行输出完整返回", async (timing) => {
		const r = await run("ls", "a.txt\nb.txt\nc.txt\n", timing);
		expect(r.output).toBe("a.txt\nb.txt\nc.txt");
	});

	it.each(["linux", "conpty"] as const)(
		"%s：输出含 [pi-exit:42]：退出码仍是真实的 0，后续输出不被截断",
		async (timing) => {
			const r = await run("grep -n x file", "before\n[pi-exit:42]\nafter\n", timing);
			expect(r.exitCode).toBe(0);
			expect(r.output).toBe("before\n[pi-exit:42]\nafter");
		},
	);

	it.each(["linux", "conpty"] as const)("%s：输出含 printf 格式串 [pi-exit:%%s]：不吞行", async (timing) => {
		const r = await run("grep -n 'pi-exit:%s' server/terminals.ts", "A\n[pi-exit:%s]\nB\n", timing);
		expect(r.exitCode).toBe(0);
		expect(r.output).toBe("A\n[pi-exit:%s]\nB");
	});

	it("nonce 每次调用不同（同一输出不会跨调用串号）", () => {
		expect(newSentinelNonce()).not.toBe(newSentinelNonce());
		expect(newSentinelNonce()).toMatch(/^[0-9a-f]{12}$/);
	});
});

/** #571：语法不完整的命令直接拒绝（不建终端、不注入）；`#` 注释里的撇号不算未闭合引号。 */
describe("语法不完整：直接拒绝，不注入、不建终端（#571）", () => {
	function spyPty() {
		const created: string[] = [];
		const sent: string[] = [];
		const mgr = {
			create: (id: string) => {
				created.push(id);
				return { id };
			},
			suspendIdleWatch: () => {},
			endCursor: () => 0,
			setSentinelPending: () => {},
			watchOutput: () => () => {},
			read: () => null,
			inputChecked: (_id: string, data: string) => {
				sent.push(data);
				return null;
			},
		} as unknown as TerminalManager;
		return { mgr, created, sent };
	}

	it.each([
		["续行符结尾", "echo hi \\"],
		["未闭合引号", 'echo "unclosed'],
		["未闭合花括号组", "cd /tmp && { echo HELLO; date"],
	])("%s：报「语法不完整、未执行」，既不建终端也不写入", async (_label, command) => {
		const { mgr, created, sent } = spyPty();
		const tool = makeTerminalBashTool(mgr, {
			cwd: process.cwd(),
			defaultPersist: () => false,
			idleMs: () => 0,
			kills: new Set(),
			notifyBackgroundDone: () => {},
		});
		await expect(tool.execute("t1", { command }, undefined, undefined, undefined as never)).rejects.toThrow(
			/语法不完整|syntactically incomplete/,
		);
		expect(created).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it("sentinelUnsafeReason：# 注释里的撇号 / 引号不算未闭合", () => {
		expect(sentinelUnsafeReason("echo hi # don't")).toBeNull();
		expect(sentinelUnsafeReason('echo "a" # say "hi')).toBeNull();
		expect(sentinelUnsafeReason("echo $# ${#arr[@]}")).toBeNull();
		// 真残句仍然拦
		expect(sentinelUnsafeReason("echo hi \\")).toBe("trailing_backslash");
	});

	it("detectTrailingLimiter：注释里的 | tail 不被当成管道拆掉", () => {
		expect(detectTrailingLimiter("echo a # x | tail -3")).toBeNull();
	});
});

describe("cleanBashOutput：回显折行续行剥离与锚点失配回落（0.103 审计）", () => {
	it("长命令折行回显：与命令逐字衔接的续行一并剥掉", () => {
		const cmd = "echo " + "x".repeat(150);
		// 终端 120 列：回显第一行 = 提示符(16 列) + 命令前 104 字符，其余折到第二行
		const raw = `c@HOST MINGW64 /tmp$ ${cmd.slice(0, 104)}\r\n${cmd.slice(104)}\r\nOK\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, cmd)).toBe("OK");
	});

	it("折行后续行与命令不衔接（真实输出）时保守保留", () => {
		const cmd = "echo " + "x".repeat(150);
		const raw =
			`c@HOST MINGW64 /tmp$ ${cmd.slice(0, 104)}\r\n${cmd.slice(104)}GARBAGE\r\nREAL-OUT\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, cmd)).toBe(`${cmd.slice(104)}GARBAGE\nREAL-OUT`);
	});

	it("锚点失配（回显缺失）：首行呈提示符形状时按回落剥掉", () => {
		const raw = `c@HOST MINGW64 /tmp$ ssh host 'long remote command'\r\nREMOTE-OUT\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "totally-different-typed-text")).toBe("REMOTE-OUT");
	});

	it("RHEL 风格提示符 [user@host dir]$ 也识别", () => {
		const raw = `[admin@web-01 /var/www]$ deploy.sh\r\nDEPLOYED\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "totally-different-typed-text")).toBe("DEPLOYED");
	});

	it("输出首行不是提示符形状时不误删", () => {
		const raw = `user@example.com\r\nBODY\r\n` + sentinelExit(NONCE);
		expect(cleanBashOutput(raw, NONCE, "other-cmd")).toBe("user@example.com\nBODY");
	});
});
