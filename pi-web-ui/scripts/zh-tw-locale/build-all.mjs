// 一鍵產生與更新繁體中文全套語言包（zh-TW 台灣繁體、zh-Hant 通用繁體、zh-HK 香港繁體）。
// 用法：node --import tsx scripts/zh-tw-locale/build-all.mjs [repo]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenCC } from "./opencc.mjs";

const repo = process.argv[2] || process.cwd();
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const version = pkg.version;

// 1. 載入簡中字典
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { zh } = await import(pathToFileURL(join(repo, "web/src/i18n.tsx")).href);
const zhKeys = Object.keys(zh);
console.log(`已載入簡中字典：${zhKeys.length} 個 key`);

// 標點修正規則
const punct = [
	[/“([^”]*)”/g, "「$1」"],
	[/([一-鿿])\s?\(([^()]*[一-鿿][^()]*)\)/g, "$1（$2）"],
	[/([一-鿿]):\s?/g, "$1："],
	[/([一-鿿])\?/g, "$1？"],
];

const applyList = (s, list) => {
	for (const [from, to] of list) s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
	return s;
};

// 2. 建立 zh-TW（台灣繁體）
const glossaryPath = join(repo, "scripts/zh-tw-locale/glossary.mjs");
const manualPath = join(repo, "scripts/zh-tw-locale/manual.json");
const twRules = existsSync(glossaryPath) ? await import(pathToFileURL(glossaryPath).href) : { pre: [], post: [] };
const twManual = existsSync(manualPath) ? JSON.parse(readFileSync(manualPath, "utf8")) : {};
const twBase = OpenCC.Converter({ from: "cn", to: "twp" });

const twStrings = {};
for (const [k, v] of Object.entries(zh)) {
	let r = applyList(applyList(twBase(applyList(v, twRules.pre || [])), twRules.post || []), punct);
	const m = twManual[k];
	if (typeof m === "string") r = m;
	else if (Array.isArray(m))
		for (const [from, to] of m) {
			if (!r.includes(from)) throw new Error(`manual patch for ${k}: 找不到 ${JSON.stringify(from)}`);
			r = r.split(from).join(to);
		}
	twStrings[k] = r;
}
const twPack = { code: "zh-TW", nativeName: "繁體中文（台灣）", version, strings: twStrings };
writeFileSync(join(repo, "locales/zh-TW.json"), JSON.stringify(twPack, null, "\t") + "\n");
console.log(`✓ 已寫出 locales/zh-TW.json (${Object.keys(twStrings).length} keys)`);

// 3. 建立 zh-Hant（通用繁體）
const hantBase = OpenCC.Converter({ from: "cn", to: "t" });
const hantStrings = {};
for (const [k, v] of Object.entries(zh)) {
	hantStrings[k] = applyList(hantBase(v), punct);
}
if (hantStrings.toolApprovalEditAndRun) {
	hantStrings.toolApprovalEditAndRun = "修改後執行 (Edit & Run)";
}
const hantPack = { code: "zh-Hant", nativeName: "繁體中文", version, strings: hantStrings };
writeFileSync(join(repo, "locales/zh-Hant.json"), JSON.stringify(hantPack, null, "\t") + "\n");
console.log(`✓ 已寫出 locales/zh-Hant.json (${Object.keys(hantStrings).length} keys)`);

// 4. 建立 zh-HK（香港繁體）
const hkBase = OpenCC.Converter({ from: "cn", to: "hk" });
const hkPost = [
	[/終端(?!機)/g, "終端機"],
	["登錄", "登入"],
	["鼠標", "滑鼠"],
	["服務器", "伺服器"],
	["默認", "預設"],
];
const hkStrings = {};
for (const [k, v] of Object.entries(zh)) {
	hkStrings[k] = applyList(applyList(hkBase(v), hkPost), punct);
}
if (hkStrings.toolApprovalEditAndRun) {
	hkStrings.toolApprovalEditAndRun = "修改後執行 (Edit & Run)";
}
const hkPack = { code: "zh-HK", nativeName: "繁體中文（香港）", version, strings: hkStrings };
writeFileSync(join(repo, "locales/zh-HK.json"), JSON.stringify(hkPack, null, "\t") + "\n");
console.log(`✓ 已寫出 locales/zh-HK.json (${Object.keys(hkStrings).length} keys)`);
