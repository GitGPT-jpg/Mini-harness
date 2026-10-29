import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../server/terminals.js";

/** safeCwd 是私有方法：经真实实例（emit 空实现）转发调用。
 *  远程工作区根是 ssh:// URI——本地边界（realpath/relative）无法解析它，
 *  修复前远程终端的每次创建/接管命令都会被「必须位于工作区内」拒掉。 */
const safeCwdOf = (workspaceRoot: string): ((raw: string) => string | null) => {
	const mgr = new TerminalManager(() => {}, workspaceRoot);
	return (mgr as unknown as { safeCwd(raw: string): string | null }).safeCwd.bind(mgr);
};

describe("safeCwd：远程 ssh:// 工作区（0.103 审计修复）", () => {
	it("远程 URI 与相对路径都挂到远程根下解析", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev:22/srv/app/logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("./logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("")).toBe("ssh://root@dev:22/srv/app");
	});

	it("无端口 URI 规范化补全 22（spawnShell 的 URI 正则要求带端口）", () => {
		const safeCwd = safeCwdOf("ssh://root@dev/srv/app");
		expect(safeCwd("")).toBe("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev/srv/app/sub")).toBe("ssh://root@dev:22/srv/app/sub");
	});

	it("跨主机/跨用户拒绝", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@other:22/srv")).toBeNull();
		expect(safeCwd("ssh://adm@dev:22/srv")).toBeNull();
		expect(safeCwd("ssh://root@dev:2222/srv")).toBeNull();
	});

	it("相对路径越出远程根拒绝", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("../../etc")).toBeNull();
		expect(safeCwd("..\\..\\etc")).toBeNull();
	});
});
