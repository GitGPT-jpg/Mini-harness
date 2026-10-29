import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FilesService,
	MAX_UPLOAD_BYTES,
	MAX_UPLOAD_BASE64_CHARS,
	WS_MAX_PAYLOAD_BYTES,
	isUploadDataTooLong,
} from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeService(cwd: string) {
	const seen: ServerMessage[] = [];
	const svc = new FilesService({
		emit: (m) => void seen.push(m),
		isDisposed: () => false,
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
	});
	return { svc, seen };
}

describe("ws/upload cap alignment", () => {
	it("100MB cap 对应的 base64 上限", () => {
		expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(139810136);
	});
	it("WS maxPayload 与上传 cap 对齐（非 256MB）", () => {
		expect(WS_MAX_PAYLOAD_BYTES).toBe(MAX_UPLOAD_BASE64_CHARS + 1024 * 1024);
		expect(WS_MAX_PAYLOAD_BYTES).toBeLessThan(256 * 1024 * 1024);
		expect(WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BASE64_CHARS);
	});
	it("isUploadDataTooLong 边界", () => {
		expect(isUploadDataTooLong(4, 3)).toBe(false);
		expect(isUploadDataTooLong(5, 3)).toBe(true);
		expect(isUploadDataTooLong(MAX_UPLOAD_BASE64_CHARS)).toBe(false);
		expect(isUploadDataTooLong(MAX_UPLOAD_BASE64_CHARS + 1)).toBe(true);
	});
	it("uploadFile 小文件成功、空文件拒绝", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-ws-upload-test-"));
		dirs.push(cwd);
		const { svc, seen } = makeService(cwd);
		const data = Buffer.from("hello").toString("base64");
		await svc.uploadFile("", "a.txt", data);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello");
		await svc.uploadFile("", "empty.txt", "");
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBeGreaterThan(0);
	});
	it("uploadFile 超长 base64 快拒且不落盘（不分配 Buffer）", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "piweb-ws-upload-test-"));
		dirs.push(cwd);
		const { svc, seen } = makeService(cwd);
		// length getter 冒充超长文本：走快拒分支即返回，Buffer.from 永不执行，
		// 单测无需分配 140MB 字符串。
		const fake = { length: MAX_UPLOAD_BASE64_CHARS + 1 } as unknown as string;
		await svc.uploadFile("", "big.txt", fake);
		const errs = seen.filter((m) => m.type === "notice" && m.level === "error");
		expect(errs.length).toBe(1);
		expect(() => readFileSync(join(cwd, "big.txt"))).toThrow();
	});
});
