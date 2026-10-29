import { describe, expect, it } from "vitest";
import { buildTerminalBashLine, detectTrailingLimiter, sentinelUnsafeReason } from "../../server/terminals.js";

/** 哨兵 printf 格式串（回显里出现的那一份）：nonce 每次随机，只校验形状。 */
const SENTINEL_FMT = /\[pi-exit-[0-9a-f]{12}:%s\]/;

/** 终端接管 bash 的哨兵注入（audit fix #2/#6）：
 *  - 旧实现把 `; printf '\n[pi-exit:%s]\n' "$__pi_rc"` 与命令拼在同一物理行，
 *    尾注释/尾管道/续行符/未闭合引号都会吞掉哨兵或造成语法错误；
 *  - 新实现单行命令的哨兵独占一行，多行命令保持 $'...' 转义单行 + 行内拼接。 */

describe("buildTerminalBashLine：哨兵独占一行（audit fix #2）", () => {
	it("单行命令：哨兵独占一行追加（命令 + 换行 + 退出码捕获行）", () => {
		const line = buildTerminalBashLine("ls -la");
		const lines = line.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("ls -la");
		expect(lines[1]).toMatch(SENTINEL_FMT);
		expect(lines[1]).toContain("PIPESTATUS");
		// 命令行本身不再拼哨兵序列
		expect(lines[0]).not.toContain("printf");
	});

	it("尾注释不再吞哨兵：哨兵行独立于注释所在行", () => {
		const line = buildTerminalBashLine("echo done # note");
		const lines = line.split("\n");
		expect(lines[0]).toBe("echo done # note");
		expect(lines[1]).toMatch(/^__pi_rc=/);
		expect(lines[1]).toMatch(SENTINEL_FMT);
	});

	it("尾管道不再吞哨兵：哨兵行仍是独立的一行", () => {
		const line = buildTerminalBashLine("echo hi |");
		const lines = line.split("\n");
		expect(lines[0]).toBe("echo hi |");
		expect(lines[1]).toMatch(SENTINEL_FMT);
	});

	it("尾随续行符：无法安全注入，原样返回（无哨兵）", () => {
		const line = buildTerminalBashLine("echo hi \\");
		expect(line).toBe("echo hi \\");
		expect(line).not.toContain("pi-exit");
	});

	it("未闭合引号：无法安全注入，原样返回（无哨兵）", () => {
		const line = buildTerminalBashLine('echo "hi');
		expect(line).toBe('echo "hi');
		expect(line).not.toContain("pi-exit");
	});

	it("多行命令保持 $'...' 转义单行 + 行内拼接（行为不变）", () => {
		const line = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
		expect(line.startsWith("eval $'")).toBe(true);
		expect(line.includes("\n")).toBe(false);
		expect(line).toContain("; __pi_rc=");
		expect(line).toMatch(SENTINEL_FMT);
	});

	it("tailFile：tail 补看段落在哨兵行内，退出码仍是底层命令的", () => {
		const line = buildTerminalBashLine("make", { file: "build.log", lines: 20 });
		const lines = line.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("tail -n 20 -- 'build.log'");
		expect(lines[1]).toMatch(SENTINEL_FMT);
	});
});

describe("sentinelUnsafeReason：续行/引号扫描（audit fix #2）", () => {
	it("普通单行命令 → null（可注入）", () => {
		expect(sentinelUnsafeReason("echo 'a b' | grep a")).toBeNull();
		expect(sentinelUnsafeReason('echo "x=$(date)"')).toBeNull();
	});

	it("尾随续行符 → trailing_backslash（含尾随空白）", () => {
		expect(sentinelUnsafeReason("echo hi \\")).toBe("trailing_backslash");
		expect(sentinelUnsafeReason("echo hi \\   ")).toBe("trailing_backslash");
	});

	it("未闭合引号 → unclosed_quote（三种引号）", () => {
		expect(sentinelUnsafeReason('echo "hi')).toBe("unclosed_quote");
		expect(sentinelUnsafeReason("echo 'hi")).toBe("unclosed_quote");
		expect(sentinelUnsafeReason("echo `hi")).toBe("unclosed_quote");
	});

	it("ANSI-C 引号内的转义单引号不误判", () => {
		expect(sentinelUnsafeReason("echo $'it\\'s fine'")).toBeNull();
	});

	it("多行命令恒判安全（走 eval 转义路径，必然可注入）", () => {
		expect(sentinelUnsafeReason("echo 'x\ndo\ny'")).toBeNull();
	});
});

describe("detectTrailingLimiter：命令替换保守跳过拆管（audit fix #6）", () => {
	it("含 $( 的命令直接跳过：替换内的嵌套管道不被误拆", () => {
		expect(detectTrailingLimiter("echo $(ls | tail -5)")).toBeNull();
		expect(detectTrailingLimiter("diff $(sort a.txt | tail -1) b.txt | tail -3")).toBeNull();
	});

	it("含反引号的命令直接跳过", () => {
		expect(detectTrailingLimiter("echo `ls | tail -5`")).toBeNull();
	});

	it("不含命令替换的尾部限输出管道照常识别", () => {
		const hit = detectTrailingLimiter("seq 1 30 | tail -3");
		expect(hit).not.toBeNull();
		expect(hit?.base).toBe("seq 1 30");
		expect(hit?.lines).toBe(3);
	});
});

describe("括号组感知：组内 | 不是顶层管道，未闭合组不注入哨兵（#573）", () => {
	it("花括号组内的末段 | tail 不被拆（复现原形：cmd && { …; x | tail -3; } > log）", () => {
		expect(detectTrailingLimiter("cd /tmp && { echo HELLO; date | tail -3; } > /tmp/x.log 2>&1; echo done")).toBeNull();
	});

	it("子 shell 内的 | tail 不被拆", () => {
		expect(detectTrailingLimiter("cd /tmp && ( echo A; date | tail -3 )")).toBeNull();
	});

	it("组外的顶层尾部管道仍照常拆，base 是完整的组", () => {
		const hit = detectTrailingLimiter("{ echo a; echo b; } | tail -1");
		expect(hit?.base).toBe("{ echo a; echo b; }");
		expect(hit?.lines).toBe(1);
	});

	it("逻辑或 || 不是管道；转义的 \| 是字面竖线，都不拆", () => {
		expect(detectTrailingLimiter("false || tail -3")).toBeNull();
		expect(detectTrailingLimiter("echo a \\| tail -3")).toBeNull();
	});

	it("ANSI-C 引号内的 \' 不提前闭合引号，其后的顶层管道照常识别", () => {
		const hit = detectTrailingLimiter("echo $'it\\'s' | tail -1");
		expect(hit?.base).toBe("echo $'it\\'s'");
	});

	it("sentinelUnsafeReason：未闭合的 { / ( 组 → unclosed_group（残句不注入）", () => {
		expect(sentinelUnsafeReason("cd /tmp && { echo HELLO; date | tail -3")).toBe("unclosed_group");
		expect(sentinelUnsafeReason("cd /tmp && ( echo A; date")).toBe("unclosed_group");
	});

	it("sentinelUnsafeReason：括号已配平 / 参数展开 / 函数定义 / case 的 ) 不误判", () => {
		expect(sentinelUnsafeReason("cd /tmp && { echo HELLO; date | tail -3; } > /tmp/x.log 2>&1; echo done")).toBeNull();
		expect(sentinelUnsafeReason("echo ${HOME} && echo $((1+2))")).toBeNull();
		expect(sentinelUnsafeReason("f() { echo a; }; f")).toBeNull();
		expect(sentinelUnsafeReason("case x in a) echo a;; esac")).toBeNull();
		expect(sentinelUnsafeReason("echo '{' && echo done")).toBeNull();
	});
});

describe("sentinelUnsafeReason：heredoc 与关键字块（0.103 审计补漏）", () => {
	it("未闭合 heredoc → unclosed_heredoc：哨兵行会被当正文吞掉，shell 停在 PS2", () => {
		expect(sentinelUnsafeReason("cat <<EOF")).toBe("unclosed_heredoc");
		expect(sentinelUnsafeReason("cat <<- EOF")).toBe("unclosed_heredoc");
		expect(sentinelUnsafeReason("cat << 'EOF'")).toBe("unclosed_heredoc");
		expect(sentinelUnsafeReason("cat <<EOF | grep a")).toBe("unclosed_heredoc");
	});

	it("<<< here-string 与算术左移不是 heredoc，不误判", () => {
		expect(sentinelUnsafeReason("cat <<< 'text'")).toBeNull();
		expect(sentinelUnsafeReason("echo $((1 << 2))")).toBeNull();
		expect(sentinelUnsafeReason("(( x << 2 ))")).toBeNull();
		expect(sentinelUnsafeReason("echo a << b")).toBe("unclosed_heredoc"); // 重定向仍是 heredoc
	});

	it("未闭合 if/for/while/case 块 → unclosed_block", () => {
		expect(sentinelUnsafeReason("if [ -f x ]; then echo y")).toBe("unclosed_block");
		expect(sentinelUnsafeReason("for f in *; do echo $f")).toBe("unclosed_block");
		expect(sentinelUnsafeReason("while true; do sleep 1")).toBe("unclosed_block");
		expect(sentinelUnsafeReason("case $x in a) echo y;; ")).toBe("unclosed_block");
	});

	it("单行闭合的 if/for/while/case 不误判", () => {
		expect(sentinelUnsafeReason("if [ -f x ]; then echo y; fi")).toBeNull();
		expect(sentinelUnsafeReason("for f in *; do echo $f; done")).toBeNull();
		expect(sentinelUnsafeReason("while read l; do echo $l; done < f.txt")).toBeNull();
		expect(sentinelUnsafeReason("case $x in a) echo y;; esac")).toBeNull();
		expect(sentinelUnsafeReason("if true; then echo a; elif false; then echo b; else echo c; fi")).toBeNull();
	});

	it("作为参数/操作数/字符串的关键字不算块（命令位置识别）", () => {
		expect(sentinelUnsafeReason("echo if done fi esac while")).toBeNull();
		expect(sentinelUnsafeReason("[[ $x == if ]]")).toBeNull();
		expect(sentinelUnsafeReason("echo 'if; then'")).toBeNull();
		expect(sentinelUnsafeReason("grep if file # while done")).toBeNull();
	});
});
