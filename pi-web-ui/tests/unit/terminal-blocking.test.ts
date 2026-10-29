import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../server/terminals.js";

/** issue #181：残留的 AI bash 终端（agentBash）不得阻断会话移出。
 *  countBlockingLive 保持老口径（含 AI bash，供切对话保留用——切走不杀后台活）；
 *  dismiss 口径改用 countUserBlockingLive（只看用户亲手开且用过的终端）。 */
function makeManager(): TerminalManager {
	return new TerminalManager(() => {}, "/tmp");
}

function putEntry(
	mgr: TerminalManager,
	id: string,
	partial: { exited: boolean; used: boolean; agentBash: boolean },
): void {
	(mgr as unknown as { terms: Map<string, unknown> }).terms.set(id, { id, ...partial });
}

describe("countUserBlockingLive（issue #181）", () => {
	it("空管理器：两口径都为 0", () => {
		const mgr = makeManager();
		expect(mgr.countBlockingLive()).toBe(0);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("残留 ai-bash 不阻断移出：老口径 >0，新口径 =0", () => {
		const mgr = makeManager();
		putEntry(mgr, "ai-bash-98", { exited: false, used: true, agentBash: true });
		putEntry(mgr, "ai-bash-99", { exited: false, used: true, agentBash: true });
		expect(mgr.countBlockingLive()).toBe(2);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("用户用过的存活终端：两口径都计数", () => {
		const mgr = makeManager();
		putEntry(mgr, "term-1", { exited: false, used: true, agentBash: false });
		expect(mgr.countBlockingLive()).toBe(1);
		expect(mgr.countUserBlockingLive()).toBe(1);
	});

	it("没动过的空 shell：两口径都不计数", () => {
		const mgr = makeManager();
		putEntry(mgr, "term-pristine", { exited: false, used: false, agentBash: false });
		expect(mgr.countBlockingLive()).toBe(0);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("已退出的终端：两口径都不计数", () => {
		const mgr = makeManager();
		putEntry(mgr, "ai-bash-100", { exited: true, used: true, agentBash: true });
		putEntry(mgr, "term-old", { exited: true, used: true, agentBash: false });
		expect(mgr.countBlockingLive()).toBe(0);
		expect(mgr.countUserBlockingLive()).toBe(0);
	});

	it("混合：1 个用户终端 + N 个残留 ai-bash → 用户口径只算 1", () => {
		const mgr = makeManager();
		putEntry(mgr, "term-1", { exited: false, used: true, agentBash: false });
		putEntry(mgr, "ai-bash", { exited: false, used: true, agentBash: true });
		putEntry(mgr, "ai-bash-101", { exited: false, used: true, agentBash: true });
		expect(mgr.countBlockingLive()).toBe(3);
		expect(mgr.countUserBlockingLive()).toBe(1);
	});
});
