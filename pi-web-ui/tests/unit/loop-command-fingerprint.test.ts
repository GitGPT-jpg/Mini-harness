import fs from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeExecutionFingerprint } from "../../server/loop/fingerprint.js";
import { normalizeTaskInputs } from "../../server/loop/discovery.js";

const dirs: string[] = [];
const workspace = () => {
	const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "command-fingerprint-")));
	dirs.push(dir);
	fs.mkdirSync(join(dir, "build"));
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("F4 command-declared local file identity", () => {
	it("binds ignored Python entry bytes without validatorPath, including same-length exit changes", () => {
		const dir = workspace();
		const script = join(dir, "build", "validator.py");
		fs.writeFileSync(script, "exit(0)\n");
		const input = { workspace: dir, validateCmd: "python build/validator.py" };
		const before = computeExecutionFingerprint(input);
		expect(spawnSync("python3", [script]).status).toBe(0);
		fs.writeFileSync(script, "exit(1)\n");
		expect(spawnSync("python3", [script]).status).toBe(1);
		const after = computeExecutionFingerprint(input);
		expect(after.contentHash).not.toBe(before.contentHash);
		expect(after.inputsHash).toBe(before.inputsHash);
		expect(after.gitHead).toBeNull();
	});

	it("includes Git-ignored entries, quoted spaces, interpreter flags and precheck commands", () => {
		const dir = workspace();
		execFileSync("git", ["init", "-q"], { cwd: dir });
		fs.writeFileSync(join(dir, ".gitignore"), "build/\n");
		fs.writeFileSync(join(dir, "build", "验证 脚本.py"), "exit(0)\n");
		const command = "  python3 -u 'build/验证 脚本.py'  ";
		const input = { workspace: dir, validateCmd: "true", precheckCmd: command };
		const before = computeExecutionFingerprint(input);
		fs.writeFileSync(join(dir, "build", "验证 脚本.py"), "exit(1)\n");
		expect(computeExecutionFingerprint(input).contentHash).not.toBe(before.contentHash);
		expect(normalizeTaskInputs(input).precheckCmd).toBe(command);
	});

	it("binds direct executable bytes and literal file options", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "build", "validator"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		fs.writeFileSync(join(dir, "build", "config.json"), '{"ok":0}');
		const input = { workspace: dir, validateCmd: "./build/validator --config=build/config.json" };
		const before = computeExecutionFingerprint(input);
		fs.writeFileSync(join(dir, "build", "config.json"), '{"ok":1}');
		const configured = computeExecutionFingerprint(input);
		expect(configured.contentHash).not.toBe(before.contentHash);
		fs.writeFileSync(join(dir, "build", "validator"), "#!/bin/sh\nexit 1\n");
		expect(computeExecutionFingerprint(input).contentHash).not.toBe(configured.contentHash);
	});

	it.each([
		"python $VALIDATOR",
		"python build/*.py",
		"cd build && python validator.py",
		"python build/validator.py | cat",
		"bash -lc 'python build/validator.py'",
		"python -c \"exec(open('build/validator.py').read())\"",
		"python -m validator",
		"env PYTHONPATH=build python -m validator",
		"python < build/validator.py",
	])("keeps complex command compatibility and accepts optional explicit dependencies: %s", (validateCmd) => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(0)\n");
		const input = { workspace: dir, validateCmd };
		const compatible = computeExecutionFingerprint(input);
		expect(computeExecutionFingerprint({ ...input, validateCmd: validateCmd + " " }).inputsHash).not.toBe(
			compatible.inputsHash,
		);
		const declared = { ...input, dependencies: ["build/validator.py"] };
		const before = computeExecutionFingerprint(declared);
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(1)\n");
		expect(computeExecutionFingerprint(declared).contentHash).not.toBe(before.contentHash);
	});

	it("preserves ordinary commands and literal escaping without reading output text as paths", () => {
		const dir = workspace();
		for (const validateCmd of ["true", "false", "npm test", "python3 --version", "printf '%s' end\\ "]) {
			expect(() => computeExecutionFingerprint({ workspace: dir, validateCmd })).not.toThrow();
			expect(normalizeTaskInputs({ validateCmd }).validateCmd).toBe(validateCmd);
		}
		expect(() =>
			computeExecutionFingerprint({ workspace: dir, validateCmd: "printf '%s' '/etc/passwd'" }),
		).not.toThrow();
	});

	it("does not execute substitutions while checking command identity", () => {
		const dir = workspace();
		const marker = join(dir, "unexpected");
		expect(() =>
			computeExecutionFingerprint({
				workspace: dir,
				validateCmd: `python $(touch '${marker}')`,
			}),
		).not.toThrow();
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("retains dependency safety checks for sensitive, missing and external script entries", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, ".env"), "fixture-secret");
		expect(() => computeExecutionFingerprint({ workspace: dir, validateCmd: "python .env" })).toThrow("unsafe-path");
		expect(() => computeExecutionFingerprint({ workspace: dir, validateCmd: "python build/missing.py" })).toThrow(
			"read",
		);
		expect(() => computeExecutionFingerprint({ workspace: dir, validateCmd: "python ../external.py" })).toThrow(
			"unsafe-path",
		);
	});

	it.each([
		"python build/validator.py | cat",
		"true && python build/validator.py",
		"python build/validator.py>result.txt",
		'python build/validator.py "$@"',
	])("still binds provable literal entries inside complex commands: %s", (validateCmd) => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(0)\n");
		const input = { workspace: dir, validateCmd };
		const before = computeExecutionFingerprint(input);
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(1)\n");
		expect(computeExecutionFingerprint(input).contentHash).not.toBe(before.contentHash);
	});

	it("allows real delayed node -e validators and shell wrappers without dependencies", () => {
		const dir = workspace();
		const inline = `${process.execPath} -e 'setTimeout(() => process.stdout.write("fixture"), 40)'`;
		for (const validateCmd of [inline, `bash -lc "printf fixture"`, `${inline} | cat`]) {
			const input = { workspace: dir, validateCmd };
			const before = computeExecutionFingerprint(input);
			const result = spawnSync("bash", ["-c", validateCmd], { cwd: dir, encoding: "utf8", timeout: 5000 });
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("fixture");
			expect(computeExecutionFingerprint(input)).toEqual(before);
			expect(normalizeTaskInputs(input).validateCmd).toBe(validateCmd);
		}
	});

	it("uses existing validatorPath/configPath inputs for dynamic ignored dependencies", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(0)\n");
		fs.writeFileSync(join(dir, "build", "config.json"), '{"ok":0}');
		const input = {
			workspace: dir,
			validateCmd: "bash -lc 'python \"$VALIDATOR\"'",
			inputs: { validatorPath: "build/validator.py", configPath: "build/config.json" },
		};
		const before = computeExecutionFingerprint(input);
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(1)\n");
		const scriptChanged = computeExecutionFingerprint(input);
		expect(scriptChanged.contentHash).not.toBe(before.contentHash);
		fs.writeFileSync(join(dir, "build", "config.json"), '{"ok":1}');
		expect(computeExecutionFingerprint(input).contentHash).not.toBe(scriptChanged.contentHash);
	});

	it("records the dynamic dependency boundary without inventing cwd or executing inline code", () => {
		const dir = workspace();
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(0)\n");
		const input = { workspace: dir, validateCmd: "cd build && python validator.py" };
		const before = computeExecutionFingerprint(input);
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(1)\n");
		// No claim of dynamic ignored-file coverage without the existing explicit input.
		expect(computeExecutionFingerprint(input)).toEqual(before);
		const declared = { ...input, inputs: { validatorPath: "build/validator.py" } };
		const withPath = computeExecutionFingerprint(declared);
		fs.writeFileSync(join(dir, "build", "validator.py"), "exit(2)\n");
		expect(computeExecutionFingerprint(declared).contentHash).not.toBe(withPath.contentHash);
		fs.writeFileSync(join(dir, "tracked-input.txt"), "actual workspace snapshot");
		expect(computeExecutionFingerprint(input).contentHash).not.toBe(before.contentHash);
	});
});
