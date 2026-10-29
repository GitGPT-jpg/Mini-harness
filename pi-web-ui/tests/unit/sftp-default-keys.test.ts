import { describe, expect, it } from "vitest";
import { normalizeConnection, publicConnection } from "../../plugins/sftp/lib/config.mjs";
import { DEFAULT_KEY_PATHS, expandHome, findDefaultPrivateKey, resolvePublicKey } from "../../plugins/sftp/lib/ssh.mjs";

describe("sftp default ssh keys fallback", () => {
	it("DEFAULT_KEY_PATHS 遵循标准 OpenSSH 常用密钥顺序", () => {
		expect(DEFAULT_KEY_PATHS).toEqual(["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa", "~/.ssh/id_dsa"]);
	});

	it("findDefaultPrivateKey 优先找到第一个存在的密钥", async () => {
		const ed25519Path = expandHome("~/.ssh/id_ed25519");
		const rsaPath = expandHome("~/.ssh/id_rsa");

		const mockFs = {
			readFile: async (file: string) => {
				if (file === ed25519Path) return "---MOCK ED25519 KEY---";
				if (file === rsaPath) return "---MOCK RSA KEY---";
				throw new Error("ENOENT");
			},
		};

		const found = await findDefaultPrivateKey(mockFs as any);
		expect(found).not.toBeNull();
		expect(found?.path).toBe("~/.ssh/id_ed25519");
		expect(found?.content).toBe("---MOCK ED25519 KEY---");
	});

	it("当 id_ed25519 不存在时，自动回退到 id_rsa", async () => {
		const rsaPath = expandHome("~/.ssh/id_rsa");

		const mockFs = {
			readFile: async (file: string) => {
				if (file === rsaPath) return "---MOCK RSA KEY---";
				throw new Error("ENOENT");
			},
		};

		const found = await findDefaultPrivateKey(mockFs as any);
		expect(found).not.toBeNull();
		expect(found?.path).toBe("~/.ssh/id_rsa");
		expect(found?.content).toBe("---MOCK RSA KEY---");
	});

	it("当没有常用密钥时，返回 null", async () => {
		const mockFs = {
			readFile: async () => {
				throw new Error("ENOENT");
			},
		};

		const found = await findDefaultPrivateKey(mockFs as any);
		expect(found).toBeNull();
	});

	it("normalizeConnection 对未配置 privateKeyPath 的 key 认证不报警，且 hasCredentials 为 true", () => {
		const warnings: string[] = [];
		const conn = normalizeConnection(
			"prod",
			{
				host: "example.com",
				remotePath: "/var/www",
				auth: { method: "key" },
			},
			{},
			warnings,
		);

		const pub = publicConnection(conn);
		expect(warnings).toHaveLength(0);
		expect(conn.auth.method).toBe("key");
		expect(pub).not.toBeNull();
		expect(pub?.hasCredentials).toBe(true);
	});

	it("resolvePublicKey 优先解析指定路径的 .pub", async () => {
		const customKey = "E:/keys/mykey";
		const customPub = "E:/keys/mykey.pub";

		const mockFs = {
			readFile: async (file: string) => {
				if (file === customPub) return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICUSTOM user@pc\n";
				throw new Error("ENOENT");
			},
		};

		const found = await resolvePublicKey(customKey, mockFs as any);
		expect(found).not.toBeNull();
		expect(found?.path).toBe(customPub);
		expect(found?.content).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICUSTOM user@pc");
	});

	it("resolvePublicKey 未指定路径时自动寻找 ~/.ssh/ 默认公钥", async () => {
		const defaultEdPub = expandHome("~/.ssh/id_ed25519.pub");

		const mockFs = {
			readFile: async (file: string) => {
				if (file === defaultEdPub) return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEFAULT\n";
				throw new Error("ENOENT");
			},
		};

		const found = await resolvePublicKey(undefined, mockFs as any);
		expect(found).not.toBeNull();
		expect(found?.path).toBe(defaultEdPub);
		expect(found?.content).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEFAULT");
	});
});
