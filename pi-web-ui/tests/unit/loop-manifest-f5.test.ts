import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { normalizeTaskInputs, parseNamespaceFromManifest, resolveTaskContext } from "../../server/loop/discovery.js";
import { computeExecutionFingerprint, computeWorkspaceContentFingerprint } from "../../server/loop/fingerprint.js";

const root = fs.mkdtempSync(join(tmpdir(), "manifest-f5-"));
let sequence = 0;
const workspace = () => {
	const dir = join(root, String(++sequence));
	fs.mkdirSync(dir);
	return dir;
};
const manifest = (namespace: string) =>
	`apiVersion: v1\nkind: Pod\nmetadata:\n  name: fixture\n  namespace: ${namespace}\n`;
const context = (dir: string, inputs: Record<string, unknown> = {}) =>
	resolveTaskContext("service-config-verify", dir, inputs);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("F5 bounded YAML manifest discovery", () => {
	it("parses multi-document metadata and ignores ConfigMap bodies, annotations and spec namespaces", () => {
		const dir = workspace();
		const content = `apiVersion: v1
kind: ConfigMap
metadata:
  name: fixture
  namespace: "prod-infer" # actual identity
  annotations: {namespace: wrong-annotation}
data:
  launch.sh: |
    namespace: wrong-body
    metadata:
      namespace: also-wrong
---
apiVersion: v1
kind: Pod
metadata: {name: fixture, namespace: prod-infer}
spec:
  namespace: wrong-spec
`;
		fs.writeFileSync(join(dir, "selected.yaml"), content);
		const result = context(dir, { deploy_yaml: "selected.yaml" });
		expect(result.error).toBeUndefined();
		expect(result.normalizedInputs?.namespace).toBe("prod-infer");
		expect(result.inputs.find((item) => item.id === "namespace")).toMatchObject({
			source: "project-config",
			confirmed: true,
		});
		expect(parseNamespaceFromManifest("kind: ConfigMap\ndata:\n  body: |\n    namespace: wrong\n")).toBeNull();
	});

	it("resolves YAML aliases and List resources without treating scalar payload as metadata", () => {
		expect(parseNamespaceFromManifest("common: &ns {namespace: prod}\nmetadata: *ns\n")).toBe("prod");
		expect(parseNamespaceFromManifest("common: &ns {namespace: prod}\nmetadata:\n  <<: *ns\n")).toBe("prod");
		expect(
			parseNamespaceFromManifest(`kind: List\nitems:\n- metadata: {namespace: prod}\n- metadata: {namespace: prod}\n`),
		).toBe("prod");
		expect(() =>
			parseNamespaceFromManifest(`kind: List\nitems:\n- metadata: {namespace: one}\n- metadata: {namespace: two}\n`),
		).toThrow("冲突");
	});

	it.each([
		manifest("one") + "---\n" + manifest("two"),
		"metadata:\n  namespace: one\n  namespace: two\n",
		"metadata: [broken\n",
		"metadata: {namespace: 123}\n",
		"metadata: {namespace: null}\n",
		"metadata: {namespace: !!str Invalid_Upper}\n",
		"metadata: !unknown {namespace: prod}\n",
		"metadata: *absent\n",
		"metadata: text\n",
		"- metadata: {namespace: prod}\n",
	])("propagates invalid/conflicting YAML through TaskContext.error: %s", (content) => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "fixture.yaml"), content);
		const result = context(dir, { manifest: "fixture.yaml" });
		expect(result.error).toMatch(/manifest/);
		expect(result.normalizedInputs?.namespace).toBeUndefined();
	});

	it("rejects alias expansion and document/byte budgets without exposing source text", () => {
		const bombs = [
			"a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b]\n",
			Array.from({ length: 33 }, () => manifest("prod")).join("---\n"),
			"#" + "x".repeat(256 * 1024),
		];
		for (const text of bombs) expect(() => parseNamespaceFromManifest(text)).toThrow(/manifest/);
		const dir = workspace();
		fs.writeFileSync(join(dir, "fixture.yaml"), "metadata: [PRIVATE_FIXTURE_DATA\n");
		const result = context(dir, { manifest: "fixture.yaml" });
		expect(result.error).toContain("解析失败");
		expect(result.error).not.toContain("PRIVATE_FIXTURE_DATA");
	});

	it("checks explicit namespace even when it would otherwise bypass discovery", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "selected.yaml"), manifest("prod"));
		const bad = context(dir, { deploy_yaml: "selected.yaml", namespace: "other" });
		expect(bad.error).toContain("冲突");
		expect(bad.conflicts[0]?.inputId).toBe("namespace");
		expect(context(dir, { manifest: "selected.yaml", namespace: "prod" }).error).toBeUndefined();
		expect(context(dir, { manifest: "selected.yaml", namespace: "INVALID" }).error).toContain("namespace");
	});

	it("explicit files override unrelated candidates; both explicit aliases are checked", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "deploy.yaml"), "broken: [\n");
		fs.writeFileSync(join(dir, "selected.yaml"), manifest("prod"));
		fs.writeFileSync(join(dir, "other.yaml"), manifest("other"));
		const selected = context(dir, { manifest: "selected.yaml" });
		expect(selected.error).toBeUndefined();
		expect(selected.normalizedInputs).toMatchObject({ deploy_yaml: "selected.yaml", namespace: "prod" });
		expect(context(dir, { deploy_yaml: "selected.yaml", manifest: "other.yaml" }).error).toContain("冲突");
		expect(context(dir).error).toContain("解析失败");
	});

	it("checks conflicting discovered files and enforces file count budget", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "deploy.yaml"), manifest("one"));
		fs.writeFileSync(join(dir, "decode.yaml"), manifest("two"));
		expect(context(dir).error).toContain("冲突");
		fs.mkdirSync(join(dir, "deploy"));
		for (let i = 0; i < 17; i++) fs.writeFileSync(join(dir, "deploy", `${i}.yaml`), manifest("one"));
		expect(context(dir).error).toContain("16");
		expect(context(dir, { manifest: "deploy.yaml" }).error).toBeUndefined();
	});

	it("preserves legacy task config and ordinary tasks without a manifest", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "task.yaml"), "namespace: radix-cache\n");
		expect(context(dir).normalizedInputs?.namespace).toBe("radix-cache");
		fs.writeFileSync(join(dir, "task.yaml"), "broken: [\n");
		expect(resolveTaskContext("cache-loss", dir, { validateCmd: "true" }).error).toBeUndefined();
		expect(context(dir).error).toContain("解析失败");
		const empty = workspace();
		expect(context(empty).error).toBeUndefined();
		expect(context(empty).missing.some((item) => item.id === "deploy_yaml")).toBe(true);
		expect(parseNamespaceFromManifest("kind: Pod\nnamespace: fake\nmetadata: {namespace: real}\n")).toBe("real");
	});

	it("normalizes top-level file inputs and detects namespace conflicts before reading", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "selected.yaml"), manifest("prod"));
		const norm = normalizeTaskInputs({ manifest: "selected.yaml", namespace: "prod" });
		expect(context(dir, norm.inputs).error).toBeUndefined();
		expect(normalizeTaskInputs({ namespace: "prod", inputs: { namespace: "other" } }).ok).toBe(false);
		expect(normalizeTaskInputs({ manifest: false }).ok).toBe(false);
		expect(
			resolveTaskContext("service-config-verify", dir, {}, { manifest: "selected.yaml" }).normalizedInputs?.namespace,
		).toBe("prod");
	});

	it("rejects outside/sensitive/symlink/credential aliases before opening them", () => {
		const dir = workspace();
		const external = workspace();
		fs.writeFileSync(join(external, "outside.yaml"), manifest("prod"));
		fs.writeFileSync(join(dir, "connection.yaml"), manifest("prod"));
		fs.writeFileSync(join(dir, ".env"), manifest("prod"));
		fs.linkSync(join(dir, "connection.yaml"), join(dir, "hardlink.yaml"));
		fs.symlinkSync(join(external, "outside.yaml"), join(dir, "symlink.yaml"));
		fs.symlinkSync(external, join(dir, "linked-dir"));
		const opened: string[] = [];
		const original = fs.openSync;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
			opened.push(String(file));
			return (original as any)(file, ...args);
		}) as typeof fs.openSync);
		for (const file of [
			join(external, "outside.yaml"),
			"../outside.yaml",
			".env",
			"symlink.yaml",
			"linked-dir/outside.yaml",
			"connection.yaml",
			"hardlink.yaml",
		]) {
			const result = context(dir, { manifest: file, kubeconfig: "connection.yaml" });
			expect(result.error).toMatch(/manifest/);
		}
		expect(opened).toEqual([]);
		vi.stubEnv("KUBECONFIG", join(dir, "connection.yaml"));
		expect(context(dir, { manifest: "hardlink.yaml" }).error).toContain("凭据");
	});

	it("rejects oversized, missing, unreadable and non-UTF8 files", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "large.yaml"), Buffer.alloc(256 * 1024 + 1));
		fs.writeFileSync(join(dir, "bad.yaml"), Buffer.from([0xff, 0xfe]));
		expect(context(dir, { manifest: "large.yaml" }).error).toContain("上限");
		expect(context(dir, { manifest: "missing.yaml" }).error).toContain("读取");
		expect(context(dir, { manifest: "bad.yaml" }).error).toContain("编码");
		fs.writeFileSync(join(dir, "denied.yaml"), manifest("prod"));
		vi.spyOn(fs, "openSync").mockImplementation(() => {
			throw Object.assign(new Error("private fixture"), { code: "EACCES" });
		});
		expect(context(dir, { manifest: "denied.yaml" }).error).toContain("读取");
	});

	it("detects same-length mutation during read and rechecks after preview", () => {
		const dir = workspace();
		const file = join(dir, "selected.yaml");
		fs.writeFileSync(file, manifest("one"));
		expect(context(dir, { manifest: "selected.yaml", namespace: "one" }).error).toBeUndefined();
		fs.writeFileSync(file, manifest("two"));
		expect(context(dir, { manifest: "selected.yaml", namespace: "one" }).error).toContain("冲突");
		const original = fs.readSync;
		let changed = false;
		vi.spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
			const count = (original as any)(...args);
			if (!changed) {
				changed = true;
				fs.writeFileSync(file, manifest("one"));
			}
			return count;
		}) as typeof fs.readSync);
		expect(context(dir, { manifest: "selected.yaml" }).error).toContain("变化");
	});
});

describe("H05/H08 fingerprint remaining input boundaries", () => {
	it("H07 includes token metrics/tokenizer identity while excluding credential values", () => {
		const dir = workspace();
		const input = { workspace: dir, inputs: { tokens_parity: 1, max_tokens: 1024, accessToken: "fixture-a" } };
		const before = computeExecutionFingerprint(input);
		expect(
			computeExecutionFingerprint({ ...input, inputs: { ...input.inputs, tokens_parity: 0 } }).inputsHash,
		).not.toBe(before.inputsHash);
		expect(
			computeExecutionFingerprint({ ...input, inputs: { ...input.inputs, accessToken: "fixture-b" } }).inputsHash,
		).toBe(before.inputsHash);
		expect(computeExecutionFingerprint({ ...input, targetIdentity: { tokenizerVersion: "v2" } }).envHash).not.toBe(
			before.envHash,
		);
		expect(() => computeExecutionFingerprint({ ...input, targetIdentity: { apiKey: "fixture" } })).toThrow("contract");
	});

	it("represents a deleted tracked directory without treating deletion as read failure", () => {
		const dir = workspace();
		execFileSync("git", ["init", "-q"], { cwd: dir });
		fs.mkdirSync(join(dir, "src"));
		fs.writeFileSync(join(dir, "src", "file"), "one");
		execFileSync("git", ["add", "."], { cwd: dir });
		const before = computeWorkspaceContentFingerprint(dir);
		fs.rmSync(join(dir, "src"), { recursive: true });
		expect(computeWorkspaceContentFingerprint(dir).contentHash).not.toBe(before.contentHash);
	});

	it("never opens a hardlink of explicitly declared kubeconfig", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "connection.yaml"), "fixture-credential");
		fs.linkSync(join(dir, "connection.yaml"), join(dir, "alias"));
		const original = fs.openSync;
		const reads: string[] = [];
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
			reads.push(String(file));
			return (original as any)(file, ...args);
		}) as typeof fs.openSync);
		const input = { workspace: dir, inputs: { kubeconfig: "connection.yaml" } };
		const before = computeExecutionFingerprint(input);
		expect(reads).toEqual([]);
		fs.writeFileSync(join(dir, "connection.yaml"), "rotated-credential");
		expect(computeExecutionFingerprint(input)).toEqual(before);
		expect(() => computeExecutionFingerprint({ ...input, dependencies: ["alias"] })).toThrow("unsafe-path");
	});
});

it("production HTTP discover and createLoopRun block invalid manifest", async () => {
	const dir = workspace();
	fs.writeFileSync(join(dir, "selected.yaml"), manifest("one") + "---\n" + manifest("two"));
	const previous = process.env.MINI_HARNESS_RUNTIME_ROOT;
	process.env.MINI_HARNESS_RUNTIME_ROOT = root;
	const { registerLoopRoutes } = await import("../../server/loop/routes.js");
	const { createLoopRun } = await import("../../server/loop/extension.js");
	if (previous === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
	else process.env.MINI_HARNESS_RUNTIME_ROOT = previous;
	const created = createLoopRun({
		cwd: dir,
		sessionId: "manifest-f5-blocked",
		goal: "fixture",
		packId: "service-config-verify",
		inputs: { manifest: "selected.yaml" },
		worktree: false,
		useReviewer: false,
	});
	expect(created.ok).toBe(false);
	if (!created.ok) expect(created.error).toContain("冲突");
	const app = express();
	app.use(express.json());
	registerLoopRoutes(app, { dataDir: root, agentDir: root });
	let server: Server | undefined;
	let port = 19290;
	try {
		for (; port < 19310; port++) {
			try {
				server = await new Promise<Server>((resolve, reject) => {
					const candidate = app.listen(port, "127.0.0.1", () => resolve(candidate));
					candidate.once("error", reject);
				});
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			}
		}
		if (!server) throw new Error("no fixture port");
		const response = await fetch(`http://127.0.0.1:${port}/api/mini-harness/discover`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ packId: "service-config-verify", workspace: dir, inputs: { manifest: "selected.yaml" } }),
		});
		expect(response.ok).toBe(false);
		expect(((await response.json()) as any).context.error).toContain("冲突");
	} finally {
		if (server)
			await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
	}
});
