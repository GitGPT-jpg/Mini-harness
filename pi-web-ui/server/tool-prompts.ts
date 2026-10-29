/**
 * bash 工具「模型可见」部分的唯一事实源。
 *
 * 同一个 bash 工具存在三条执行路径（原生 SDK bash / 终端接管 bash / 由
 * `makeAdaptiveBashTool` 在两者间动态分流），但模型只看到**一份**工具定义：
 * 分流器用 `{...killable}` 覆盖 name/label/parameters/execute，提示词从本模块取。
 * 历史上三条路径各写一份 description/snippet（且终端那份经分流器覆盖后**永不发送**），
 * 结果是文案漂移——"prefer head/tail over piping" 只写在死的那份里。集中到此处后
 * 新增分支只需复用，不再各自维护。
 */
import { Type } from "typebox";

/** 主描述：做什么 + 副作用/边界（不写「什么时候用」，那是 guidelines 的活）。 */
export const BASH_DESCRIPTION =
	"Run a shell command and return its full output plus exit code. " +
	"When the terminal-backed bash is active (setting: default bash override) it runs in a visible terminal: " +
	"persist=true keeps the 'ai-bash' terminal alive (cd/venv/ssh retained across calls), persist=false is one-shot; " +
	"otherwise it runs natively (process spawn, no terminal) and persist has no effect. " +
	"Never pipe through head/tail/more/less — use the head/tail params (pipes hide live progress).";

/** 触发条件（进系统提示词 Available tools 列表，渲染为 `- bash: <snippet>`）。 */
export const BASH_PROMPT_SNIPPET = "run shell commands";

/** 行为要点：只在「何时用/顺序/禁止」上说 description 没说的事。 */
export const BASH_PROMPT_GUIDELINES = [
	"For interactive commands (REPLs, y/n prompts) set persist=true and drive them with terminal_input / terminal_key",
	"Use the dedicated worktree tool instead of running 'git worktree' in bash to prevent unsynchronized workspace state",
];

/** 参数 schema（含参数说明）：三条执行路径共用，避免「分流后 schema 变陌生」。 */
export const BASH_PARAMETERS = Type.Object({
	command: Type.String({ description: "The shell command to run" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
	persist: Type.Optional(
		Type.Boolean({
			description:
				"Ignored in native mode. With the terminal-backed bash: true = persistent 'ai-bash' terminal " +
				"(shell state retained across calls), false = one-shot terminal.",
		}),
	),
	head: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Only return the FIRST N lines of output (like `| head -N`).",
		}),
	),
	tail: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Only return the LAST N lines of output (like `| tail -N`).",
		}),
	),
});
