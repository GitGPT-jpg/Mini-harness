import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeExecutionFingerprint, computeWorkspaceContentFingerprint } from "../../server/loop/fingerprint.js";
import { resolvePack } from "../../server/loop/packs.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
	const dir = fs.mkdtempSync(join(tmpdir(), "fingerprint-f4-"));
	dirs.push(dir);
	return dir;
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function repo() {
	const dir = temp();
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "fixture@localhost");
	git(dir, "config", "user.name", "fixture");
	fs.writeFileSync(join(dir, "code.txt"), "aaaa");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "fixture");
	return dir;
}
const fp = (workspace: string) => computeExecutionFingerprint({ workspace, validateCmd: "true" });

describe("F4 actual execution content", () => {
	it("H01-H04 distinguishes same-length tracked/staged/unstaged/untracked bytes without changing index", () => {
		const dir = repo();
		const clean = fp(dir);
		fs.writeFileSync(join(dir, "code.txt"), "bbbb");
		expect(fp(dir).contentHash).not.toBe(clean.contentHash);
		git(dir, "add", ".");
		const staged = fp(dir);
		fs.writeFileSync(join(dir, "code.txt"), "cccc");
		git(dir, "add", ".");
		expect(fp(dir).contentHash).not.toBe(staged.contentHash);
		const index = fs.readFileSync(join(dir, ".git", "index"));
		const both = fp(dir);
		fs.writeFileSync(join(dir, "code.txt"), "dddd");
		expect(fp(dir).contentHash).not.toBe(both.contentHash);
		expect(fs.readFileSync(join(dir, ".git", "index"))).toEqual(index);
		fs.writeFileSync(join(dir, "未跟踪.bin"), Buffer.from([0, 255, 1]));
		const untracked = fp(dir);
		fs.writeFileSync(join(dir, "未跟踪.bin"), Buffer.from([0, 255, 2]));
		expect(fp(dir).contentHash).not.toBe(untracked.contentHash);
	});

	it("H05 detects rename/delete/executable mode and internal symlink target", () => {
		const dir = repo();
		const original = fp(dir);
		fs.renameSync(join(dir, "code.txt"), join(dir, "中文\n文件"));
		expect(fp(dir).contentHash).not.toBe(original.contentHash);
		const renamed = fp(dir);
		fs.chmodSync(join(dir, "中文\n文件"), 0o755);
		expect(fp(dir).contentHash).not.toBe(renamed.contentHash);
		fs.symlinkSync("中文\n文件", join(dir, "entry"));
		const linked = fp(dir);
		fs.writeFileSync(join(dir, "中文\n文件"), "next");
		expect(fp(dir).contentHash).not.toBe(linked.contentHash);
		fs.unlinkSync(join(dir, "entry"));
		fs.unlinkSync(join(dir, "中文\n文件"));
		expect(fp(dir).contentHash).not.toBe(linked.contentHash);
	});

	it("H06 scopes to real cwd, supports non-Git and unborn Git, and isolates sibling/worktree content", () => {
		const plain = temp();
		fs.writeFileSync(join(plain, "arbitrary.bin"), "one");
		const first = fp(plain);
		fs.writeFileSync(join(plain, "arbitrary.bin"), "two");
		expect(fp(plain).contentHash).not.toBe(first.contentHash);
		git(plain, "init", "-q");
		expect(fp(plain).gitHead).toBeNull();
		const dir = repo();
		fs.mkdirSync(join(dir, "sub"));
		fs.writeFileSync(join(dir, "sub", "file"), "sub");
		const sub = fp(join(dir, "sub"));
		fs.writeFileSync(join(dir, "code.txt"), "sibling");
		expect(fp(join(dir, "sub"))).toEqual(sub);
		const link = join(temp(), "alias");
		fs.symlinkSync(join(dir, "sub"), link);
		expect(fp(link)).toEqual(sub);
		const wt = join(temp(), "tree");
		git(dir, "worktree", "add", "--detach", wt, "HEAD");
		expect(fp(wt).workspace).toBe(fs.realpathSync(wt));
		expect(fp(wt).contentHash).not.toBe(fp(dir).contentHash);
	});

	it("H07 binds current pack, full acceptance contract, explicit target; ignores display title", () => {
		const dir = repo();
		const input = {
			workspace: dir,
			packId: "cache-loss",
			packVersion: "stale",
			validateCmd: "true",
			inputs: { cache_hit: 0, enabled: false },
			metricTolerance: 0,
			metricThreshold: 20,
			hardConstraints: [{ name: "precision", metric: "acc", op: "gte" as const, value: 1, unit: "%" }],
		};
		const first = computeExecutionFingerprint(input);
		const pack = resolvePack("cache-loss")!;
		expect(first.packVersion).toBe(pack.version);
		expect(computeExecutionFingerprint({ ...input, packVersion: "other-stale" })).toEqual(first);
		for (const patch of [
			{ metricTolerance: 0.01 },
			{ metricThreshold: 0 },
			{ validateCmd: "false" },
			{ metricScenario: "new" },
			{ hardConstraints: [{ ...input.hardConstraints[0]!, unit: "ratio" }] },
		])
			expect(computeExecutionFingerprint({ ...input, ...patch }).inputsHash).not.toBe(first.inputsHash);
		expect(computeExecutionFingerprint({ ...input, targetIdentity: { podUid: "new" } }).envHash).not.toBe(
			first.envHash,
		);
		const version = pack.version;
		const title = pack.title;
		try {
			pack.title = "display only";
			expect(computeExecutionFingerprint(input)).toEqual(first);
			pack.version = "next";
			expect(computeExecutionFingerprint(input).inputsHash).not.toBe(first.inputsHash);
			expect(computeExecutionFingerprint(input).packVersion).toBe("next");
		} finally {
			pack.version = version;
			pack.title = title;
		}
	});

	it("H08 ignores outputs/secrets without opening them, but includes explicit ignored dependencies", () => {
		const dir = repo();
		fs.mkdirSync(join(dir, "build"));
		fs.mkdirSync(join(dir, ".ssh"));
		fs.writeFileSync(join(dir, ".gitignore"), "ignored/\n");
		fs.mkdirSync(join(dir, "ignored"));
		fs.writeFileSync(join(dir, "ignored", "validator.py"), "aaaa");
		fs.writeFileSync(join(dir, ".ssh", "private"), "fixture-secret");
		fs.writeFileSync(join(dir, ".env"), "fixture-secret");
		const open = fs.openSync;
		const reads: string[] = [];
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
			reads.push(String(file));
			return (open as any)(file, ...args);
		}) as typeof fs.openSync);
		const first = fp(dir);
		fs.writeFileSync(join(dir, "build", "out.log"), "growing output");
		expect(fp(dir)).toEqual(first);
		expect(reads.some((file) => file.endsWith(".env") || file.endsWith("private"))).toBe(false);
		const input = { workspace: dir, dependencies: ["ignored/validator.py"] };
		const dep = computeExecutionFingerprint(input);
		fs.writeFileSync(join(dir, "ignored", "validator.py"), "bbbb");
		expect(computeExecutionFingerprint(input).contentHash).not.toBe(dep.contentHash);
		expect(() => computeExecutionFingerprint({ workspace: dir, dependencies: [".env"] })).toThrow("unsafe-path");
		expect(() => computeExecutionFingerprint({ workspace: dir, dependencies: ["absent"] })).toThrow("read");
		expect(() => computeWorkspaceContentFingerprint(dir, { maxFileBytes: 1 })).toThrow("limit");
		expect(() => computeWorkspaceContentFingerprint(dir, { maxFiles: 1 })).toThrow("limit");
		fs.writeFileSync(join(dir, "connection.yaml"), "fixture-credential");
		const credentialInput = { workspace: dir, inputs: { kubeconfig: "connection.yaml" } };
		reads.length = 0;
		const credential = computeExecutionFingerprint(credentialInput);
		fs.writeFileSync(join(dir, "connection.yaml"), "rotated-credential");
		expect(computeExecutionFingerprint(credentialInput)).toEqual(credential);
		expect(reads.some((file) => file.endsWith("connection.yaml"))).toBe(false);
	});

	it("H05/H08 blocks outside/sensitive links, submodules and permission errors", () => {
		const dir = repo();
		const outside = temp();
		fs.writeFileSync(join(outside, "file"), "do not read");
		fs.symlinkSync(join(outside, "file"), join(dir, "external"));
		expect(() => fp(dir)).toThrow("unsafe-path");
		fs.unlinkSync(join(dir, "external"));
		fs.writeFileSync(join(dir, ".env"), "secret");
		fs.symlinkSync(".env", join(dir, "alias"));
		expect(() => fp(dir)).toThrow("unsafe-path");
		fs.unlinkSync(join(dir, "alias"));
		const open = fs.openSync;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
			if (String(file).endsWith("code.txt")) throw Object.assign(new Error("fixture"), { code: "EACCES" });
			return (open as any)(file, ...args);
		}) as typeof fs.openSync);
		expect(() => fp(dir)).toThrow("read");
		vi.restoreAllMocks();
		git(dir, "update-index", "--add", "--cacheinfo", `160000,${git(dir, "rev-parse", "HEAD").trim()},submodule`);
		expect(() => fp(dir)).toThrow("unsupported");
	});

	it("detects deterministic cross-process same-length mutation between reads; retries are bounded", () => {
		const dir = temp();
		const file = join(dir, "data");
		fs.writeFileSync(file, "aaaa");
		const close = fs.closeSync;
		let changes = 0;
		vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
			close(fd);
			execFileSync(process.execPath, [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1],process.argv[2])",
				file,
				++changes % 2 ? "bbbb" : "aaaa",
			]);
		});
		expect(() => computeWorkspaceContentFingerprint(dir, { retries: 1 })).toThrow("unstable");
		expect(changes).toBe(2);
	});
});
