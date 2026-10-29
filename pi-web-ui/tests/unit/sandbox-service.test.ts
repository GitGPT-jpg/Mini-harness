import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	SandboxManager,
	evaluateSandboxJail,
	extractPatchTargetPaths,
	isStrictlyInsideSandbox,
	withSandboxJailGate,
} from "../../server/sandbox-service.js";
import { makeSandboxTool } from "../../server/sandbox-tool.js";

describe("SandboxManager & Hard Jail Isolation", () => {
	let tempRoot: string;
	let dataDir: string;
	let sourceProjectDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-test-"));
		dataDir = join(tempRoot, "data");
		sourceProjectDir = join(tempRoot, "my-source-app");
		mkdirSync(sourceProjectDir, { recursive: true });
		mkdirSync(join(sourceProjectDir, "src"), { recursive: true });
		mkdirSync(join(sourceProjectDir, "node_modules", "pkg"), { recursive: true });
		mkdirSync(join(sourceProjectDir, ".git"), { recursive: true });
		writeFileSync(join(sourceProjectDir, "package.json"), '{"name":"my-source-app"}', "utf-8");
		writeFileSync(join(sourceProjectDir, "src", "index.ts"), "export const x = 1;\n", "utf-8");
		writeFileSync(join(sourceProjectDir, "node_modules", "pkg", "index.js"), "module.exports = {};\n", "utf-8");
		writeFileSync(join(sourceProjectDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("creates a blank ephemeral sandbox and persists or destroys it", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox, copiedFiles } = await mgr.create({
			name: "My Blank Lab",
			ephemeral: true,
		});
		expect(copiedFiles).toBe(0);
		expect(sandbox.name).toBe("My Blank Lab");
		expect(sandbox.ephemeral).toBe(true);
		expect(sandbox.sourcePath).toBeUndefined();
		expect(existsSync(sandbox.path)).toBe(true);
		expect(mgr.getByCwd(sandbox.path)?.id).toBe(sandbox.id);
		expect(mgr.getByCwd(join(sandbox.path, "nested", "dir"))?.id).toBe(sandbox.id);

		// Convert to permanent
		const persisted = mgr.persist(sandbox.id);
		expect(persisted.ephemeral).toBe(false);

		// Reload from disk registry
		const mgr2 = new SandboxManager(dataDir);
		expect(mgr2.get(sandbox.id)?.ephemeral).toBe(false);

		// Destroy removes directory and registry entry
		await mgr2.destroy(sandbox.id);
		expect(existsSync(sandbox.path)).toBe(false);
		expect(mgr2.list()).toHaveLength(0);
	});

	it("imports an existing project without node_modules, isolates edits, resets, promotes, and syncs back", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox, copiedFiles } = await mgr.create({
			sourcePath: sourceProjectDir,
			ephemeral: false,
		});
		expect(copiedFiles).toBeGreaterThanOrEqual(2);
		expect(existsSync(join(sandbox.path, "package.json"))).toBe(true);
		expect(existsSync(join(sandbox.path, "src", "index.ts"))).toBe(true);
		// Heavy cache dir node_modules is skipped
		expect(existsSync(join(sandbox.path, "node_modules"))).toBe(false);

		// Mutate file inside sandbox -> original sourceProjectDir is 100% untouched
		writeFileSync(join(sandbox.path, "src", "index.ts"), "export const x = 999;\n", "utf-8");
		writeFileSync(join(sandbox.path, "src", "new-file.ts"), "export const added = true;\n", "utf-8");
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sourceProjectDir, "src", "new-file.ts"))).toBe(false);

		// Promote to a new formal project directory
		const formalDir = join(tempRoot, "promoted-app");
		const promoted = await mgr.promote(sandbox.id, formalDir);
		expect(promoted.copiedFiles).toBeGreaterThanOrEqual(3);
		expect(readFileSync(join(formalDir, "src", "index.ts"), "utf-8")).toBe("export const x = 999;\n");

		// Reset sandbox -> restores clean state from sourceProjectDir
		await mgr.reset(sandbox.id);
		expect(readFileSync(join(sandbox.path, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");
		expect(existsSync(join(sandbox.path, "src", "new-file.ts"))).toBe(false);

		// Modify again and applyToSource -> updates sourceProjectDir while preserving .git and pruning deleted files
		writeFileSync(join(sandbox.path, "src", "index.ts"), "export const x = 42;\n", "utf-8");
		writeFileSync(join(sandbox.path, ".git", "HEAD"), "corrupted\n", "utf-8");
		// Remove package.json in sandbox -> applyToSource should prune it in sourceProjectDir as well
		rmSync(join(sandbox.path, "package.json"));
		const applyRes = await mgr.applyToSource(sandbox.id);
		expect(applyRes.deletedFiles).toBe(1);
		expect(existsSync(join(sourceProjectDir, "package.json"))).toBe(false);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 42;\n");
		expect(readFileSync(join(sourceProjectDir, ".git", "HEAD"), "utf-8")).toBe("ref: refs/heads/main\n");
	});

	it("enforces hard jail isolation on write, edit, edit_soft, patch, bash, sftp, and mail", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox } = await mgr.create({
			sourcePath: sourceProjectDir,
			ephemeral: true,
		});

		// 1. Inside sandbox is allowed
		expect(isStrictlyInsideSandbox("src/index.ts", sandbox.path, sandbox.path)).toBe(true);
		expect(evaluateSandboxJail(sandbox, "write", { path: "src/index.ts" }, sandbox.path)).toBeNull();
		expect(evaluateSandboxJail(sandbox, "edit", { path: join(sandbox.path, "README.md") }, sandbox.path)).toBeNull();

		// 2. Outside sandbox (../ traversal or sourceProjectDir) is hard-blocked
		expect(isStrictlyInsideSandbox("../escape.txt", sandbox.path, sandbox.path)).toBe(false);
		expect(evaluateSandboxJail(sandbox, "write", { path: "../escape.txt" }, sandbox.path)).not.toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "edit_soft", { path: join(sourceProjectDir, "src/index.ts") }, sandbox.path),
		).not.toBeNull();

		// 3. Patch tool path extraction and jail check
		const safePatch =
			"*** Begin Patch\n*** Update File: src/index.ts\n@@\n-export const x = 1;\n+export const x = 2;\n";
		const evilPatch = "*** Begin Patch\n*** Add File: ../outside.ts\n+evil\n";
		expect(extractPatchTargetPaths(safePatch)).toEqual(["src/index.ts"]);
		expect(evaluateSandboxJail(sandbox, "patch", { patch: safePatch }, sandbox.path)).toBeNull();
		expect(evaluateSandboxJail(sandbox, "patch", { patch: evilPatch }, sandbox.path)).not.toBeNull();

		// 4. Bash command referencing sourcePath or `cd ..` from sandbox root is blocked
		expect(evaluateSandboxJail(sandbox, "bash", { command: "npm test" }, sandbox.path)).toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "bash", { command: `cat "${sourceProjectDir}/package.json"` }, sandbox.path),
		).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "cd .. && ls" }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "(cd .. && ls)" }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: 'cd "$HOME/.."' }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: 'cd "${HOME}/.."' }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "cd ~/.ssh" }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "rm -rf /etc/hosts" }, sandbox.path)).not.toBeNull();
		expect(
			evaluateSandboxJail(sandbox, "bash", { command: "rm -rf ~/Desktop/important" }, sandbox.path),
		).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "echo pwn > /etc/passwd" }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "npm install -g typescript" }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "echo ok > build.log" }, sandbox.path)).toBeNull();
		expect(evaluateSandboxJail(sandbox, "bash", { command: "npm test > /dev/null" }, sandbox.path)).toBeNull();

		// 5. SFTP & Mail external side-effect gates
		expect(evaluateSandboxJail(sandbox, "sftp", { action: "plan" }, sandbox.path)).toBeNull();
		expect(evaluateSandboxJail(sandbox, "sftp", { action: "sync", dryRun: true }, sandbox.path)).toBeNull();
		expect(evaluateSandboxJail(sandbox, "sftp", { action: "sync", dryRun: false }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "sftp", { action: "rm", path: "/srv/app" }, sandbox.path)).not.toBeNull();
		expect(evaluateSandboxJail(sandbox, "mail", { action: "list" }, sandbox.path)).toBeNull();
		expect(evaluateSandboxJail(sandbox, "mail", { action: "send" }, sandbox.path)).not.toBeNull();

		// 6. withSandboxJailGate wrapper blocks out-of-bounds execution
		let executed = false;
		const dummyWriteTool = {
			name: "write",
			label: "write",
			description: "write",
			parameters: {} as any,
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "ok" }], details: {} } as any;
			},
		} satisfies ToolDefinition;

		const gated = withSandboxJailGate(
			dummyWriteTool,
			() => sandbox,
			() => sandbox.path,
			() => "zh",
		);
		const deniedRes = (await gated.execute(
			"call-1",
			{ path: "../outside.txt", content: "bad" } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(executed).toBe(false);
		expect(deniedRes.isError).toBe(true);
		expect(deniedRes.details?.sandboxDenied).toBe(true);

		const allowedRes = (await gated.execute(
			"call-2",
			{ path: "inside.txt", content: "good" } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(executed).toBe(true);
		expect(allowedRes.isError).toBeUndefined();
	});

	it("AI sandbox tool supports create, list, diff, approval-gated apply_to_source, reset, and destroy", async () => {
		const mgr = new SandboxManager(dataDir);
		let currentCwd = sourceProjectDir;
		let approvalAllow = false;
		let approvalCalls = 0;

		const tool = makeSandboxTool(
			{
				sandboxes: mgr,
				getCwd: () => currentCwd,
				setCwd: async (next) => {
					currentCwd = next;
				},
				onSandboxesChanged: async () => {},
				askApproval: async () => {
					approvalCalls++;
					return approvalAllow ? { decision: "approve" } : { decision: "deny", reason: "Not ready yet" };
				},
			},
			() => "en",
		);

		// 1. Create imported sandbox and switch to it
		const createRes = (await tool.execute(
			"c1",
			{ action: "create", mode: "import", name: "AI Refactor Lab", switchTo: true } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		const sbxId = createRes.details.sandbox.id;
		const sbxPath = createRes.details.sandbox.path;
		expect(currentCwd).toBe(sbxPath);

		// 2. Modify a file and add a new file inside the sandbox
		writeFileSync(join(sbxPath, "src", "index.ts"), "export const x = 777;\n", "utf-8");
		writeFileSync(join(sbxPath, "src", "helper.ts"), "export const h = 1;\n", "utf-8");

		// 3. Diff detects 1 added and 1 modified file
		const diffRes = (await tool.execute("c2", { action: "diff" } as never, undefined, undefined, {} as any)) as any;
		expect(diffRes.details.added).toEqual(["src/helper.ts"]);
		expect(diffRes.details.modified).toEqual(["src/index.ts"]);
		expect(diffRes.details.deleted).toEqual([]);

		// 4. apply_to_source is blocked when user denies approval
		const deniedApply = (await tool.execute(
			"c3",
			{ action: "apply_to_source" } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(approvalCalls).toBe(1);
		expect(deniedApply.isError).toBe(true);
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 1;\n");

		// 5. apply_to_source succeeds once user approves
		approvalAllow = true;
		const allowedApply = (await tool.execute(
			"c4",
			{ action: "apply_to_source" } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(approvalCalls).toBe(2);
		expect(allowedApply.isError).toBeUndefined();
		expect(readFileSync(join(sourceProjectDir, "src", "index.ts"), "utf-8")).toBe("export const x = 777;\n");
		expect(existsSync(join(sourceProjectDir, "src", "helper.ts"))).toBe(true);

		// 6. Destroy cleans up sandbox and switches back to sourceProjectDir
		const destroyRes = (await tool.execute(
			"c5",
			{ action: "destroy", sandbox: sbxId } as never,
			undefined,
			undefined,
			{} as any,
		)) as any;
		expect(destroyRes.isError).toBeUndefined();
		expect(currentCwd.replace(/\\/g, "/")).toBe(sourceProjectDir.replace(/\\/g, "/"));
		expect(existsSync(sbxPath)).toBe(false);
	});
});

describe("patch 围栏的 hashline 段头识别（0.104 审计）", () => {
	let tempRoot: string;
	let dataDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-hashline-"));
		dataDir = join(tempRoot, "data");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("extractPatchTargetPaths 识别 [path#TAG] / [path] 段头（patch 工具实际消费的格式）", () => {
		const hashlinePatch = "[src/index.ts#a1b2]\nDEL <1: 3\nPUT <1: export const x = 2;\n";
		expect(extractPatchTargetPaths(hashlinePatch)).toContain("src/index.ts");
		const newFilePatch = "[new-file.ts]\nPUT <1: hello\n";
		expect(extractPatchTargetPaths(newFilePatch)).toContain("new-file.ts");
	});

	it("hashline 补丁的越界目标被围栏硬拒（此前提取出 0 目标、检查空转）", async () => {
		const mgr = new SandboxManager(dataDir);
		const { sandbox } = await mgr.create({ name: "hashline-lab", ephemeral: true });
		const evilHashline = "[../escape.ts]\nPUT <1: evil\n";
		expect(evaluateSandboxJail(sandbox, "patch", { patch: evilHashline }, sandbox.path)).not.toBeNull();
		const goodHashline = "[inside.ts]\nPUT <1: ok\n";
		expect(evaluateSandboxJail(sandbox, "patch", { patch: goodHashline }, sandbox.path)).toBeNull();
	});
});
