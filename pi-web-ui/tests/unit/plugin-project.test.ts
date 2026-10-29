/**
 * 插件「组装项目」单测（server/plugin-project.ts，issue #146）。
 *
 * 覆盖三块：clone / 写文件 / git init 的正常路径，失败即停 + 日志保留，
 * 以及**路径越界防护**（`..`、绝对路径、符号链接/junction）。
 * 全程零网络：仓库都是临时目录里的本地 file:// 仓库；本机没有 git 则整块跳过
 * （纯函数那组不依赖 git，永远跑）。
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, isInsideRoot, resolveInsideRoot } from "../../server/plugin-project.js";

/** 本机有没有 git：没有就跳过需要真实 clone 的那组（CI 上 Windows/Linux 都带 git）。 */
const hasGit = ((): boolean => {
	try {
		return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
})();

let base: string;
/** 授权目录（被测模块的 root）：base/ws。 */
let ws: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "pi-plugin-project-"));
	ws = join(base, "ws");
	mkdirSync(ws, { recursive: true });
});

afterEach(() => {
	// Windows 上 git 子进程刚退出时目录可能还锁着（EBUSY/EPERM）：带退避重试，
	// 否则清理失败会盖掉真正的断言失败信息。
	rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 跑一次真实 git（仅用于造 fixture 仓库）。 */
function gitCli(args: string[], cwd: string) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
}

/** commit 需要身份：用 `-c` 现传，不依赖（也不污染）用户全局 git 配置。 */
const IDENTITY = [
	"-c",
	"user.email=pi-web-ui-test@example.com",
	"-c",
	"user.name=pi-web-ui-test",
	"-c",
	"commit.gpgsign=false",
];

/** 造一个本地 git 仓库（一次提交），返回它的 file:// URL。 */
function makeRepo(name: string, files: Record<string, string>): string {
	const dir = join(base, "repos", name);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
	expect(gitCli(["init", "--quiet"], dir).status).toBe(0);
	expect(gitCli([...IDENTITY, "add", "-A"], dir).status).toBe(0);
	expect(gitCli([...IDENTITY, "commit", "--quiet", "-m", "init"], dir).status).toBe(0);
	return pathToFileURL(dir).href;
}

/**
 * 读 clone 出来的文件：git 在 Windows 上会按 core.autocrlf 把 LF 换成 CRLF，
 * 这是 git 的正常行为（本模块不覆盖用户的 git 配置），断言前统一归一。
 */
function readText(p: string): string {
	return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

/** 手动 commit（ref 那组造第二条分支用）。 */
function commitAll(dir: string, message: string): void {
	expect(gitCli([...IDENTITY, "add", "-A"], dir).status).toBe(0);
	expect(gitCli([...IDENTITY, "commit", "--quiet", "-m", message], dir).status).toBe(0);
}

describe("路径判定（纯函数，不需要 git）", () => {
	it("relative() 判定越界；win32 大小写不敏感", () => {
		expect(isInsideRoot(ws, ws)).toBe(true);
		expect(isInsideRoot(ws, join(ws, "a", "b"))).toBe(true);
		expect(isInsideRoot(ws, join(base, "outside"))).toBe(false);
		expect(isInsideRoot(ws, join(ws, ".."))).toBe(false);
		// 大小写只对 win32 无意义：那里 `E:\A` 与 `e:\a` 是同一个目录。
		expect(isInsideRoot(ws, ws.toUpperCase())).toBe(process.platform === "win32");
	});

	it("resolveInsideRoot：正常相对路径 → 绝对路径；越界/绝对/空 → null", () => {
		expect(resolveInsideRoot(ws, "a/b.txt")).toBe(join(ws, "a", "b.txt"));
		expect(resolveInsideRoot(ws, "./a/../b.txt")).toBe(join(ws, "b.txt"));
		expect(resolveInsideRoot(ws, "../x")).toBeNull();
		expect(resolveInsideRoot(ws, "a/../../x")).toBeNull();
		expect(resolveInsideRoot(ws, join(base, "abs.txt"))).toBeNull();
		expect(resolveInsideRoot(ws, "")).toBeNull();
		if (process.platform === "win32") {
			// 盘符绝对路径（POSIX 上它只是个含冒号的普通文件名，落在 root 里无害）。
			expect(resolveInsideRoot(ws, "C:\\Windows\\evil.txt")).toBeNull();
		}
	});
});

describe.skipIf(!hasGit)("组装项目（本地 file:// 仓库，零网络）", () => {
	it("clone 本地仓库到 subdir：文件真的落到 <dir>/<subdir> 下", async () => {
		const url = makeRepo("basic", { "README.md": "# hello\n", "src/index.ts": "export {};\n" });
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] });
		expect(res.ok).toBe(true);
		expect(res.error).toBeUndefined();
		expect(res.dir).toBe(ws);
		expect(readText(join(ws, "sub", "README.md"))).toBe("# hello\n");
		expect(existsSync(join(ws, "sub", "src", "index.ts"))).toBe(true);
		expect(res.log).toContain(`clone ${url} → sub`);
	});

	it("repos 缺省 subdir = clone 进根目录本身", async () => {
		const url = makeRepo("atroot", { "a.txt": "a\n" });
		const res = await createProject({ dir: ws, repos: [{ url }] });
		expect(res.ok).toBe(true);
		expect(existsSync(join(ws, "a.txt"))).toBe(true);
		// 根目录本身不 mkdir、也不参与「目标已存在」判定（它当然存在）。
		expect(res.log.some((l) => l.startsWith("mkdir"))).toBe(false);
	});

	it("ref 指定分支：clone 出来的是该分支的内容", async () => {
		const url = makeRepo("branches", { "base.txt": "base\n" });
		const repoDir = join(base, "repos", "branches");
		const defaultBranch = gitCli(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).stdout.trim();
		expect(gitCli(["checkout", "--quiet", "-b", "feature"], repoDir).status).toBe(0);
		writeFileSync(join(repoDir, "feature-only.txt"), "feature\n", "utf8");
		commitAll(repoDir, "feature");

		const onFeature = await createProject({ dir: ws, repos: [{ url, subdir: "feat", ref: "feature" }] });
		expect(onFeature.ok).toBe(true);
		expect(existsSync(join(ws, "feat", "feature-only.txt"))).toBe(true);

		// 不传 ref 时 clone 跟随源仓库 HEAD（这里 HEAD 停在 feature 上），所以显式点名另一条分支。
		const onDefault = await createProject({ dir: ws, repos: [{ url, subdir: "main", ref: defaultBranch }] });
		expect(onDefault.ok).toBe(true);
		expect(existsSync(join(ws, "main", "feature-only.txt"))).toBe(false);
		expect(readText(join(ws, "main", "base.txt"))).toBe("base\n");
	}, 30000); // 两次真实 clone（fixture + 组装），满负荷跑全量时 5s 默认超时不够

	it("files 写入：自动建中间目录、内容逐字节正确", async () => {
		const res = await createProject({
			dir: ws,
			files: { ".code-workspace": `{ "folders": [] }\n`, "deep/a/b/中文.txt": "多字节内容 ✓\n" },
		});
		expect(res.ok).toBe(true);
		expect(readFileSync(join(ws, ".code-workspace"), "utf8")).toBe(`{ "folders": [] }\n`);
		expect(readFileSync(join(ws, "deep", "a", "b", "中文.txt"), "utf8")).toBe("多字节内容 ✓\n");
		expect(res.log).toContain("write deep/a/b/中文.txt"); // 日志里的相对路径统一 `/`
	});

	it("clone + 写文件 + git init 一条龙；进度回调与 log 一致", async () => {
		const url = makeRepo("full", { "a.txt": "a\n" });
		const lines: string[] = [];
		const res = await createProject(
			{ dir: ws, repos: [{ url, subdir: "repo" }], files: { "cfg/app.json": "{}\n" }, gitInit: true },
			{ onProgress: (line) => lines.push(line) },
		);
		expect(res.ok).toBe(true);
		expect(lines).toEqual(res.log);
		expect(res.log).toContain("mkdir repo");
		expect(res.log).toContain("write cfg/app.json");
		expect(res.log).toContain("git init");
		// git 自己的 stdout/stderr 也进日志（stderr 才是 git 的主输出通道）。
		expect(res.log.some((l) => l.startsWith("git: "))).toBe(true);
		expect(existsSync(join(ws, ".git"))).toBe(true);
		expect(existsSync(join(ws, "repo", "a.txt"))).toBe(true);
		expect(readFileSync(join(ws, "cfg", "app.json"), "utf8")).toBe("{}\n");
	});

	it("进度回调抛错不影响组装（UI 层的事不拖累执行）", async () => {
		const res = await createProject(
			{ dir: ws, files: { "a.txt": "a" } },
			{
				onProgress: () => {
					throw new Error("ui boom");
				},
			},
		);
		expect(res.ok).toBe(true);
		expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a");
	});
});

describe.skipIf(!hasGit)("失败即停（ok:false + 可读原因 + 保留日志）", () => {
	it("clone 不存在的仓库 → ok:false、log 非空、原因可读", async () => {
		const url = pathToFileURL(join(base, "repos", "missing")).href;
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] });
		expect(res.ok).toBe(false);
		expect(res.error).toBeTruthy();
		expect(res.error).toMatch(/clone/i);
		expect(res.error?.length ?? 0).toBeGreaterThan(0);
		expect(res.log.length).toBeGreaterThan(0);
		expect(res.log.join("\n")).toContain(`clone ${url} → sub`);
		expect(res.log.join("\n")).toContain("失败：");
	});

	it("多仓库中途失败：前面的成果与日志保留，后面的步骤不再执行", async () => {
		const good = makeRepo("good", { "a.txt": "a\n" });
		const bad = pathToFileURL(join(base, "repos", "missing")).href;
		const res = await createProject({
			dir: ws,
			repos: [
				{ url: good, subdir: "one" },
				{ url: bad, subdir: "two" },
			],
			files: { "cfg/x.json": "{}" },
			gitInit: true,
		});
		expect(res.ok).toBe(false);
		expect(existsSync(join(ws, "one", "a.txt"))).toBe(true); // 已完成的步骤不回滚
		expect(res.log.join("\n")).toContain(`clone ${good} → one`);
		expect(existsSync(join(ws, "cfg", "x.json"))).toBe(false); // 失败即停
		expect(existsSync(join(ws, ".git"))).toBe(false);
	});

	it("目标子目录已存在且未给 replace → ok:false，且绝不静默覆盖", async () => {
		const url = makeRepo("exists", { "a.txt": "a\n" });
		mkdirSync(join(ws, "sub"), { recursive: true });
		writeFileSync(join(ws, "sub", "mine.txt"), "我的东西\n", "utf8");
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("已存在");
		expect(readFileSync(join(ws, "sub", "mine.txt"), "utf8")).toBe("我的东西\n");
		expect(existsSync(join(ws, "sub", "a.txt"))).toBe(false);
	});

	it("replace:true → 删掉目标再来，旧内容不再残留", async () => {
		const url = makeRepo("replace", { "a.txt": "a\n" });
		mkdirSync(join(ws, "sub"), { recursive: true });
		writeFileSync(join(ws, "sub", "mine.txt"), "old\n", "utf8");
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub", replace: true }] });
		expect(res.ok).toBe(true);
		expect(existsSync(join(ws, "sub", "mine.txt"))).toBe(false);
		expect(readText(join(ws, "sub", "a.txt"))).toBe("a\n");
		expect(res.log.join("\n")).toContain("rm -rf sub");
	});

	it("replace 指向项目根目录 → 拒绝（授权只覆盖这个目录，不是「可以删它」）", async () => {
		const url = makeRepo("replaceroot", { "a.txt": "a\n" });
		writeFileSync(join(ws, "keep.txt"), "keep\n", "utf8");
		const res = await createProject({ dir: ws, repos: [{ url, replace: true }] });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("replace");
		expect(readFileSync(join(ws, "keep.txt"), "utf8")).toBe("keep\n");
	});

	it("dir 校验：相对路径 / 不存在 / 不是目录 全部拒绝", async () => {
		const relative = await createProject({ dir: join("relative", "ws"), gitInit: true });
		expect(relative.ok).toBe(false);
		expect(relative.error).toContain("绝对路径");
		expect(relative.log.length).toBeGreaterThan(0);

		const missing = join(base, "not-there");
		const absent = await createProject({ dir: missing, gitInit: true });
		expect(absent.ok).toBe(false);
		expect(absent.error).toContain("不存在");
		expect(existsSync(missing)).toBe(false); // 不擅自创建用户没指定的新根

		const asFile = join(base, "file.txt");
		writeFileSync(asFile, "x", "utf8");
		const notDir = await createProject({ dir: asFile, gitInit: true });
		expect(notDir.ok).toBe(false);
		expect(notDir.error).toContain("文件夹");
	});

	it("url / ref 以 '-' 开头（git 选项注入）→ 拒绝", async () => {
		const url = await createProject({ dir: ws, repos: [{ url: "--upload-pack=touch pwned" }] });
		expect(url.ok).toBe(false);
		expect(url.error).toContain("注入");

		const ref = await createProject({ dir: ws, repos: [{ url: "https://example.com/x.git", ref: "-c" }] });
		expect(ref.ok).toBe(false);
		expect(ref.error).toContain("ref");
	});

	it("gitBin 指向不存在的可执行文件 → ok:false、不抛异常", async () => {
		const res = await createProject(
			{ dir: ws, repos: [{ url: "file:///nowhere/repo.git" }] },
			{ gitBin: join(base, "no-such-git-binary") },
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("git");
		expect(res.log.length).toBeGreaterThan(0);
	});

	it("gitTimeoutMs 超时 → 杀掉进程树并报「超时」（不挂死）", async () => {
		const url = makeRepo("slow", { "a.txt": "a\n" });
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "sub" }] }, { gitTimeoutMs: 1 });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("超时");
	}, 30000);

	it("files 条目数与单文件大小超限 → 拒绝", async () => {
		const tooMany: Record<string, string> = {};
		for (let i = 0; i < 33; i++) tooMany[`f${i}.txt`] = "x";
		const many = await createProject({ dir: ws, files: tooMany });
		expect(many.ok).toBe(false);
		expect(many.error).toContain("超限");

		const big = await createProject({ dir: ws, files: { "big.txt": "x".repeat(1024 * 1024 + 1) } });
		expect(big.ok).toBe(false);
		expect(big.error).toContain("1MB");

		expect(readdirSync(ws)).toEqual([]); // 校验失败不落任何文件
	});
});

describe.skipIf(!hasGit)("路径越界防护", () => {
	it("files 的 ../ 与绝对路径 key → ok:false，磁盘上没有多出任何文件", async () => {
		const escapeRel = join(base, "evil.txt");
		const escapeAbs = join(base, "abs-evil.txt");
		const res = await createProject({
			dir: ws,
			files: { "../evil.txt": "pwn", [escapeAbs]: "pwn", "ok.txt": "ok" },
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("越界");
		expect(existsSync(escapeRel)).toBe(false);
		expect(existsSync(escapeAbs)).toBe(false);
		// 越界是**校验阶段**就拒的：连同一个 spec 里合法的那条也不写（不留半成品）。
		expect(existsSync(join(ws, "ok.txt"))).toBe(false);
		expect(readdirSync(ws)).toEqual([]);
	});

	it("subdir 越界 → ok:false，且目录内什么都没建出来", async () => {
		const url = makeRepo("escape", { "a.txt": "a\n" });
		const escapeTarget = join(tmpdir(), "pi-plugin-project-escape-x");
		const res = await createProject({ dir: ws, repos: [{ url, subdir: "../../pi-plugin-project-escape-x" }] });
		expect(res.ok).toBe(false);
		expect(res.error).toContain("越界");
		expect(existsSync(escapeTarget)).toBe(false);
		expect(readdirSync(ws)).toEqual([]);
	});

	it("符号链接指向 dir 之外 → 拒绝（realpath 复核，不是字符串比对）", async () => {
		const outside = join(base, "outside");
		mkdirSync(outside, { recursive: true });
		try {
			symlinkSync(outside, join(ws, "link"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			// Windows 上没有开发者模式/权限建不了链接：跳过这条（其余越界防护不受影响）。
			return;
		}

		const viaFile = await createProject({ dir: ws, files: { "link/evil.txt": "pwn" } });
		expect(viaFile.ok).toBe(false);
		expect(viaFile.error).toContain("越界");
		expect(existsSync(join(outside, "evil.txt"))).toBe(false);

		const url = makeRepo("linkrepo", { "a.txt": "a\n" });
		const viaRepo = await createProject({ dir: ws, repos: [{ url, subdir: "link/sub" }] });
		expect(viaRepo.ok).toBe(false);
		expect(viaRepo.error).toContain("越界");
		expect(existsSync(join(outside, "sub"))).toBe(false);
	});
});
