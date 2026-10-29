/* 终端活力检测（liveness watchdog）单元级回归：直接实例化 TerminalManager
 * （真实 PTY，但不起 server、不耗 token），用小阈值验证：
 *   1. 用户手开的终端（未 noteAgentActivity）永不触发静默提醒；
 *   2. agent 触碰过的终端静默 ≥ 阈值触发一次 onAgentIdle；
 *   3. 一次性语义：触发后保持沉默不再重复触发，agent 再次触碰重新武装；
 *   4. 纪元内的输出/输入重置倒计时；
 *   5. 终端退出后看门狗拆除（不触发）。
 * Run:  npm run build:server && node tests/terminal-idle-test.mjs */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 小阈值加快测试；armIdleWatch 每次调用时读取 env，注入即生效。
process.env.PI_WEB_TERMINAL_IDLE_MS = "700";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const { TerminalManager } = await import(pathToFileURL(join(REPO, "dist", "server", "terminals.js")).href);

const workdir = mkdtempSync(join(tmpdir(), "piweb-term-idle-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

function makeManager(events) {
	const mgr = new TerminalManager(() => {}, workdir);
	mgr.onAgentIdle = (terminalId, idleMs, title) => {
		events.push({ terminalId, idleMs, title, at: Date.now() });
	};
	return mgr;
}

try {
	// ---- 1. 用户手开的终端：无 agent 触碰 → 不触发 ----
	{
		const events = [];
		const mgr = makeManager(events);
		check("用户终端创建成功", mgr.create("user-term", workdir, 80, 24, workdir) !== null);
		await sleep(1200);
		check("用户终端静默 1.2s 不触发提醒", events.length === 0);
		mgr.killAll();
	}

	// ---- 2+3. agent 触碰：触发一次；持续沉默不重复；再触碰重新武装 ----
	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("agent-term", workdir, 80, 24, workdir);
		mgr.noteAgentActivity("agent-term");
		const t0 = Date.now();
		// 等到首次触发（阈值 700ms + 余量）
		for (let i = 0; i < 40 && events.length === 0; i++) await sleep(50);
		check("agent 终端静默后触发提醒", events.length === 1);
		if (events.length === 1) {
			check("提醒来自正确终端", events[0].terminalId === "agent-term");
			check("idleMs ≥ 阈值", events[0].idleMs >= 650);
			check("idleMs 合理（<3s）", events[0].idleMs < 3000);
			check("触发时机 ≈ 阈值之后", events[0].at - t0 >= 650);
		}
		// 再沉默一个阈值以上：一次性语义，不得重复触发
		await sleep(1100);
		check("一次性：持续沉默不重复提醒", events.length === 1);
		// agent 再次触碰（如又发了输入）→ 新纪元，再次触发一次
		mgr.noteAgentActivity("agent-term");
		for (let i = 0; i < 40 && events.length < 2; i++) await sleep(50);
		check("agent 再次触碰后重新武装并触发第二次", events.length === 2);
		mgr.killAll();
	}

	// ---- 4. 纪元内输出重置倒计时 ----
	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("reset-term", workdir, 80, 24, workdir);
		mgr.noteAgentActivity("reset-term");
		// 每 300ms 产生一段输出，共 3 次（累计 900ms > 阈值 700ms）
		for (let i = 0; i < 3; i++) {
			await sleep(300);
			// 直接走内部输出路径：模拟 shell 吐字（appendOutput 为私有，借 inputChecked+
			// echo 太慢——这里通过 read/waitForOutput 同款公开行为不可行，改用 noteAgent
			// 不动、手动喂输出的等价入口：inputChecked 会重置倒计时，语义相同）。
			mgr.inputChecked("reset-term", "");
		}
		await sleep(500); // 距最后一次活动仅 500ms < 700ms
		check("活动不断重置倒计时 → 阈值时间内不触发", events.length === 0);
		await sleep(600); // 现在距最后活动 > 阈值
		check("停止活动后仍会正常触发", events.length === 1);
		mgr.killAll();
	}

	// ---- 5. 退出后拆钟 ----
	{
		const events = [];
		const mgr = makeManager(events);
		mgr.create("exit-term", workdir, 80, 24, workdir);
		mgr.inputChecked("exit-term", "exit\r");
		// 等 shell 真正退出（onExit 拆钟），再触碰一次已退出的终端应为 no-op
		for (let i = 0; i < 60; i++) {
			await sleep(50);
			if (!mgr.list().find((t) => t.id === "exit-term")?.running) break;
		}
		mgr.noteAgentActivity("exit-term"); // 已退出 → no-op，不武装
		await sleep(1100);
		check("终端退出后不触发静默提醒", events.length === 0);
		mgr.killAll();
	}

	console.log(`\n${passed} checks passed${process.exitCode ? "（有失败）" : ""}`);
} finally {
	try {
		rmSync(workdir, { recursive: true, force: true });
	} catch {
		// Windows 上 node-pty ConPTY 子进程可能持有句柄——忽略，避免挂起
	}
}
process.exit(process.exitCode || 0);
