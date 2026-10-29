#!/usr/bin/env node
/**
 * release-notes.mjs — 生成 GitHub Release 说明文件，翻译增量自动公示。
 *
 * Release 说明 = CHANGELOG.md 里该版本的小节正文（去掉 ## 标题行，与原来 awk 摘取一致），
 * 其中 `### i18n` 小节每次都用 scripts/i18n-diff.mjs 现场重新生成并替换——
 * 即使写 CHANGELOG 时忘了整理 i18n，Release 页面上依然有准确的翻译增量公示。
 *
 * 用法：
 *   node scripts/release-notes.mjs 0.72.0 [--base v0.71.0] [--out /tmp/notes.md]
 *   node scripts/release-notes.mjs 0.72.0 --write-changelog   # 把生成的 i18n 小节同步回 CHANGELOG.md
 *   node scripts/release-notes.mjs 0.72.0 --out /tmp/notes.md --create  # 直接 gh release create
 *   node scripts/release-notes.mjs --unreleased             # 把当前文案增量自动记入 ## [Unreleased]（幂等）
 *   npm run release:notes -- 0.72.0 --out /tmp/notes.md
 *   npm run changelog:i18n                                  # = --unreleased
 *
 * --base 缺省时自动取上一个 tag（见 i18n-diff.mjs resolveBase）。
 * 注意：在发版当下运行，此时工作区即发版内容，diff 才准确。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffWorktreeVsBase, renderI18nSection, resolveBase } from "./i18n-diff.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(root, "CHANGELOG.md");

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

/** 摘出 CHANGELOG 里某版本的小节，返回 {header, body}（body 不含 ## 标题行）。 */
function extractSection(src, version) {
	const ver = version.replace(/^v/, "");
	const lines = src.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`## [${ver}]`));
	if (start === -1) fail(`CHANGELOG.md 里找不到 ## [${ver}] 小节，先按发布流程第 2 步写好 CHANGELOG`);
	let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
	if (end === -1) end = lines.length;
	return {
		header: lines[start],
		body: lines
			.slice(start + 1, end)
			.join("\n")
			.replace(/\n+$/, ""),
	};
}

/** 把 body 里的 ### i18n 小节替换为新内容；没有则追加到末尾。返回新 body。 */
function replaceI18n(body, i18nLines) {
	const lines = body.split("\n");
	const idx = lines.findIndex((l) => l.trim() === "### i18n");
	const block = ["### i18n", "", ...i18nLines];
	if (idx === -1) return [...lines, "", ...block].join("\n");
	let end = lines.findIndex((l, i) => i > idx && l.startsWith("### "));
	if (end === -1) end = lines.length;
	return [...lines.slice(0, idx), ...block, ...lines.slice(end)].join("\n");
}

/** diff 里是否有文案增量。 */
function hasDelta(d) {
	return (
		d.frontend.added.length > 0 ||
		d.frontend.removed.length > 0 ||
		d.frontend.changedZh.length > 0 ||
		d.frontend.changedEn.length > 0 ||
		d.server.added.length > 0 ||
		d.server.removed.length > 0 ||
		d.server.changed.length > 0
	);
}

const AUTO_START = "<!-- auto-i18n:start -->";
const AUTO_END = "<!-- auto-i18n:end -->";
const UNRELEASED_PLACEHOLDER = "暂无未发布内容。";

/** 刷新 ## [Unreleased] 里的自动 i18n 块（幂等：手动内容不动；无增量时移除块、恢复占位符）。 */
function refreshUnreleased(changelog, i18nLines, delta) {
	const lines = changelog.split("\n");
	const start = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
	if (start === -1) fail("CHANGELOG.md 里找不到 ## [Unreleased] 小节");
	let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
	if (end === -1) end = lines.length;
	const body = lines.slice(start + 1, end);
	// 手动内容 = 去掉占位符和旧自动块、掐头去尾空行
	let manual = body.filter((l) => l.trim() !== UNRELEASED_PLACEHOLDER);
	const s = manual.findIndex((l) => l.trim() === AUTO_START);
	const e = manual.findIndex((l) => l.trim() === AUTO_END);
	if (s !== -1 && e !== -1 && e > s) manual = [...manual.slice(0, s), ...manual.slice(e + 1)];
	while (manual.length > 0 && manual[0].trim() === "") manual.shift();
	while (manual.length > 0 && manual[manual.length - 1].trim() === "") manual.pop();
	let newBody;
	if (delta) {
		newBody = ["", ...manual, "", AUTO_START, "### i18n", "", ...i18nLines, AUTO_END, ""];
		if (manual.length === 0) newBody = ["", AUTO_START, "### i18n", "", ...i18nLines, AUTO_END, ""];
	} else {
		newBody = manual.length === 0 ? ["", UNRELEASED_PLACEHOLDER, ""] : ["", ...manual, ""];
	}
	return [...lines.slice(0, start + 1), ...newBody, ...lines.slice(end)].join("\n");
}

function main() {
	const argv = process.argv.slice(2).filter((a) => a !== "--");
	const getOpt = (name) => {
		const i = argv.indexOf(name);
		return i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
	};
	const pos = argv.filter((a) => !a.startsWith("--"));
	if (argv.includes("-h") || argv.includes("--help") || (pos.length === 0 && !argv.includes("--unreleased"))) {
		console.log(
			"用法：node scripts/release-notes.mjs <版本号> [--base <tag>] [--out 文件] [--write-changelog] [--create]\n" +
				"      node scripts/release-notes.mjs --unreleased [--base <tag>]（刷新 ## [Unreleased] 的自动 i18n 块）",
		);
		return;
	}
	if (argv.includes("--unreleased")) {
		// 未发布内容 = 工作区相对**当前 package.json 版本那个 tag**（HEAD 常常正好停在那
		// 个 tag 上，所以不能让 resolveBase 自己往前推一个，见它的注释）。
		const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
		const base = resolveBase(getOpt("--base"), pkgVersion);
		const diff = diffWorktreeVsBase(base);
		const delta = hasDelta(diff);
		const updated = refreshUnreleased(readFileSync(CHANGELOG, "utf8"), renderI18nSection(diff), delta);
		writeFileSync(CHANGELOG, updated);
		console.log(`✓ ## [Unreleased] 的 ### i18n 已刷新（base ${base}，${delta ? "有增量" : "无增量"}）`);
		return;
	}
	const version = pos[0].replace(/^v/, "");
	const base = resolveBase(getOpt("--base"));
	const diff = diffWorktreeVsBase(base);
	const i18nLines = renderI18nSection(diff);

	const changelog = readFileSync(CHANGELOG, "utf8");
	const { body } = extractSection(changelog, version);
	const notes = `${replaceI18n(body, i18nLines)}\n\n<!-- release-notes: i18n 小节由 scripts/release-notes.mjs 按 ${base}...工作区现场生成 -->\n`;

	if (argv.includes("--write-changelog")) {
		// #498：第二参必须是函数形式——字符串形式的替换串里 `$&`/`` $` ``/`$'`/`$1`
		// 是替换模式，i18n 文案含 `$`（价格示例、代码片段）时会把 CHANGELOG 写坏。
		const patched = changelog.replace(body, () => replaceI18n(body, i18nLines));
		writeFileSync(CHANGELOG, patched);
		console.log(`✓ CHANGELOG.md ## [${version}] 的 ### i18n 已同步（base ${base}）`);
	}

	const out = getOpt("--out");
	if (out) {
		writeFileSync(out, notes);
		console.log(`✓ Release 说明已写入 ${out}`);
	} else if (!argv.includes("--create")) {
		process.stdout.write(notes);
	}

	if (argv.includes("--create")) {
		const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
		const file = join(dir, "notes.md");
		writeFileSync(file, notes);
		execFileSync("gh", ["release", "create", `v${version}`, "--title", `v${version}`, "--notes-file", file], {
			cwd: root,
			stdio: "inherit",
		});
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
