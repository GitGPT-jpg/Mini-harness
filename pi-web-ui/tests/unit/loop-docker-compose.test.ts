// @vitest-environment node
/**
 * P6：默认 Docker Compose 的 Loop 存储路径落在持久卷内；存储门禁区分错误原因。
 * 容器端到端（真实镜像 + 重建容器）需要 Docker 运行环境，本单测只做配置解析与
 * 存储错误信息区分；容器验证状态在执行记录中单独标注。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { checkStorageTopology } from "../../server/loop/storage.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("默认 Compose 的 Loop 存储路径", () => {
	it("compose 把 MINI_HARNESS_RUNTIME_ROOT 指向持久卷内的目录", () => {
		const text = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
		const docs = parseAllDocuments(text, { strict: true, uniqueKeys: true });
		expect(docs.length).toBe(1);
		const compose = docs[0]!.toJS() as {
			services: {
				"pi-web-ui": { environment?: Record<string, string>; volumes?: string[] };
			};
			volumes?: Record<string, unknown>;
		};
		const env = compose.services["pi-web-ui"].environment ?? {};
		// 默认值 ~/.mini-harness/runs 在容器内落在 OverlayFS 可写层：门禁会拒绝且重建即丢。
		expect(env.MINI_HARNESS_RUNTIME_ROOT).toBe("/app/.pi-web/loop-runs");
		const volumes = compose.services["pi-web-ui"].volumes ?? [];
		expect(volumes.some((v) => v.includes("pi-web-data:/app/.pi-web"))).toBe(true);
		expect(compose.volumes?.["pi-web-data"]).toBeDefined();
	});

	it("Dockerfile 以 node 用户运行前创建并归属数据卷挂载点", () => {
		const text = readFileSync(join(ROOT, "Dockerfile"), "utf8");
		expect(text).toContain("PI_WEB_DATA_DIR=/app/.pi-web");
		expect(text).toMatch(/mkdir -p \/app\/\.pi-web && chown node:node \/app\/\.pi-web/);
		const chownLine = text.indexOf("chown node:node /app/.pi-web");
		const userLine = text.indexOf("USER node\n");
		expect(chownLine).toBeGreaterThan(-1);
		expect(userLine).toBeGreaterThan(chownLine);
	});

	it("存储门禁错误信息区分拓扑与目录问题，不与真实租约竞争混淆", () => {
		// 拓扑提示注入：明确报「存储拓扑」，而不是「租约被占用」。
		const prev = process.env.MINI_HARNESS_STORAGE_TOPOLOGY;
		process.env.MINI_HARNESS_STORAGE_TOPOLOGY = "overlay";
		try {
			const topology = checkStorageTopology(process.cwd());
			expect(topology.ok).toBe(false);
			expect(String((topology as { error: string }).error)).toContain("存储拓扑");
		} finally {
			if (prev === undefined) delete process.env.MINI_HARNESS_STORAGE_TOPOLOGY;
			else process.env.MINI_HARNESS_STORAGE_TOPOLOGY = prev;
		}
		// 正常本地目录通过门禁：门禁不是「一律拒绝」。
		expect(checkStorageTopology(process.cwd()).ok).toBe(true);
	});
});
