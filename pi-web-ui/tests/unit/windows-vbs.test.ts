import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../bin/pi-web-ui.mjs", import.meta.url), "utf8");

/** Evaluate the actual CLI function, not a copy, without its main() or COM/spawn side effects. */
function functionSource(name: string): string {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`Missing CLI function: ${name}`);
	const end = source.indexOf("\n}", start);
	if (end < 0) throw new Error(`Missing function terminator: ${name}`);
	return source.slice(start, end + 2);
}

const PWSH = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;

/** Build the hidden-launcher VBS with winPowershell() stubbed to the spaced PowerShell 7 path. */
function buildVbs(ps1Path: string): string {
	const cli = runInNewContext(
		`${functionSource("buildWinHiddenVbs")}
({ buildWinHiddenVbs })`,
		{
			// winPowershell probes `where.exe pwsh.exe`; stub it to the real-world spaced path
			// (that is exactly the value that used to break WScript.Shell.Run with 80070002).
			winPowershell: () => PWSH,
		},
	) as { buildWinHiddenVbs(ps1Path: string): string };
	return cli.buildWinHiddenVbs(ps1Path);
}

/** The VBS source line that assigns the command string. */
function cmdLine(vbs: string): string {
	const line = vbs.split("\r\n").find((l) => l.startsWith("cmd = "));
	if (!line) throw new Error("Missing `cmd = ...` line in generated VBS");
	return line;
}

describe("Windows hidden VBS launcher", () => {
	it("quotes the PowerShell executable so a spaced path resolves (issue #534)", () => {
		const ps1Path = String.raw`C:\Users\X\AppData\Roaming\pi-web-ui\pi-web-ui.ps1`;
		const line = cmdLine(buildVbs(ps1Path));

		// Literal VBS source: `"""exe""` = outer string quotes + VBScript-escaped quotes around the exe.
		expect(line.startsWith(`cmd = """${PWSH}"" `)).toBe(true);
		// The .ps1 argument is still `""`-escaped and intact.
		expect(line.endsWith(`-File ""${ps1Path}"""`)).toBe(true);
		// No `\"` anywhere, and an even number of quotes → the string literal cannot end early.
		expect(line).not.toContain(String.raw`\"`);
		expect((line.match(/"/g) ?? []).length % 2).toBe(0);
		expect(buildVbs(ps1Path)).toContain("sh.Run cmd, 0, False");
	});

	it("quotes both paths when the ps1 path itself contains spaces", () => {
		const ps1Path = String.raw`C:\Users\Some User\AppData\Roaming\pi-web-ui\pi-web-ui.ps1`;
		const line = cmdLine(buildVbs(ps1Path));

		expect(line).toContain(`"""${PWSH}""`);
		expect(line).toContain(`""${ps1Path}"""`);
		expect(line).not.toContain(String.raw`\"`);
		expect((line.match(/"/g) ?? []).length % 2).toBe(0);
	});
});
