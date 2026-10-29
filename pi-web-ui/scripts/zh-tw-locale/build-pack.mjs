// 把轉換結果寫成 repo 的 locales/<code>.json（格式與其他語言包一致：tab 縮排、結尾換行）。
// 用法：node build-pack.mjs <strings.json> <repo> [code] [nativeName] [version]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [
	stringsPath,
	repo,
	code = "zh-TW",
	nativeName = code === "zh-HK" ? "繁體中文（香港）" : code === "zh-Hant" ? "繁體中文" : "繁體中文（台灣）",
	version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version,
] = process.argv.slice(2);

const strings = JSON.parse(readFileSync(stringsPath, "utf8"));
const pack = { code, nativeName, version, strings };
writeFileSync(join(repo, `locales/${code}.json`), JSON.stringify(pack, null, "\t") + "\n");
console.log(`wrote ${Object.keys(strings).length} keys → locales/${code}.json (v${version})`);
