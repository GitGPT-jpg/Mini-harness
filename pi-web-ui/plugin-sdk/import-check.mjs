/**
 * import-check.mjs — 插件目录的静态 import 自检（纯 ESM、零依赖）。
 *
 * 为什么需要：宿主**只暴露 `/plugins/<id>/client/*`**（`server/plugins.ts` 的
 * `resolvePluginClientFile` 把根钉在 `client/`）。客户端代码里任何解析到 `client/`
 * 之外的相对 import，浏览器都会以
 *
 *   Failed to fetch dynamically imported module: /plugins/<id>/client/entry.mjs
 *
 * 整体失败（**bundle 一行都不执行**，不是只坏那一条 import），而服务端完全看不出来
 * —— manifest 校验 0 错、插件 `active:true`、`error:null`（issue #546）。
 *
 * 脚手架（`pi-web-ui plugin create`）生成后用它自检；插件作者也可以对自己的插件跑一遍：
 *
 *   node --input-type=module -e "const m = await import('./sdk/import-check.mjs');
 *     console.log(m.checkPluginImports(process.cwd()))"
 *
 * 只做**字面量**匹配（静态 import/export-from + `import("...")` 字面量），不引 AST 依赖：
 * 插件代码的 import 目标都是字符串字面量，够用且零成本。注释里的示例代码先被词法扫描
 * 屏蔽（不是真 import），模板字面量内的 import 不识别（要引依赖请在顶层静态写）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** 扫描的源码扩展名。 */
const SCAN_EXT = [".mjs", ".js"];
/** 不进入的目录（依赖/版本库）。 */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** 静态 import / export-from / 字面量动态 import 的目标（作用在屏蔽过注释的骨架上）。 */
const SPEC_PATTERNS = [
	/(?:^|[\s;{}()])import\s+[^;'"`]*?from\s*["'](S\d+)["']/g, // import x from "S0" / import { y } from "S0"
	/(?:^|[\s;{}()])export\s+[^;'"`]*?from\s*["'](S\d+)["']/g, // export { x } from "S0" / export * from "S0"
	/(?:^|[\s;{}()])import\s*["'](S\d+)["']/g, // 副作用 import "S0"
	/(?:^|[\s;{}()])import\s*\(\s*["'](S\d+)["']/g, // import("S0")
];

/**
 * 极简词法扫描：把注释抹成空白、把字符串/模板字面量换成占位符 `S<n>`（引号保留），
 * 返回 `{ skeleton, literals }`。这样后续正则只在真代码上匹配，且能从占位符取回原文
 * —— 注释里的 `import ... from "..."`（SDK 文件头就是这种示例）不会被误判成真依赖。
 */
function skeletonize(src) {
	const out = [];
	const literals = [];
	let mode = "code";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (mode === "code") {
			if (c === "/" && src[i + 1] === "/") {
				mode = "line";
				out.push(" ", " ");
				i += 2;
				continue;
			}
			if (c === "/" && src[i + 1] === "*") {
				mode = "block";
				out.push(" ", " ");
				i += 2;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				let j = i + 1;
				let buf = "";
				while (j < src.length) {
					if (src[j] === "\\") {
						buf += src[j + 1] ?? "";
						j += 2;
						continue;
					}
					if (src[j] === c) break;
					buf += src[j];
					j++;
				}
				const id = literals.push(buf) - 1;
				out.push(c, `S${id}`, c);
				i = j + 1;
				continue;
			}
			out.push(c);
			i++;
			continue;
		}
		if (mode === "line") {
			if (c === "\n") {
				mode = "code";
				out.push("\n");
			} else out.push(" ");
			i++;
			continue;
		}
		// block comment
		if (c === "*" && src[i + 1] === "/") {
			mode = "code";
			out.push(" ", " ");
			i += 2;
			continue;
		}
		out.push(c === "\n" ? "\n" : " ");
		i++;
	}
	return { skeleton: out.join(""), literals };
}

/** 提取源码里的 import 目标（去重、保序；注释里的示例不算）。 */
export function staticImportSpecifiers(src) {
	const { skeleton, literals } = skeletonize(src);
	const out = [];
	const seen = new Set();
	for (const re of SPEC_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(skeleton)) !== null) {
			const spec = literals[Number(m[1].slice(1))];
			if (spec === undefined || spec === "" || seen.has(spec)) continue;
			seen.add(spec);
			out.push(spec);
		}
	}
	return out;
}

/** 递归列出目录里待扫描的模块（相对 root 的 posix 路径，排序稳定）。 */
export function listPluginModules(root) {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
				continue;
			}
			if (e.isFile() && SCAN_EXT.some((ext) => e.name.endsWith(ext)))
				out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
		}
	};
	walk(root);
	return out.sort();
}

/** 是否为「相对路径 import」（`./x`、`../x`）；裸包名、`node:`、URL 都不算。 */
function isRelativeSpec(spec) {
	return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * 扫整个插件目录的相对 import（其余 specifier 原样跳过）。
 *
 * 返回 `[{ file, spec, target, missing, client, escapesClient }]`：
 *  - `file` / `target` 都是相对 root 的 posix 路径（跨平台稳定；target 已去 query/hash）
 *  - `client`：import 的发起方位于 `client/` 内
 *  - `escapesClient`：`client/` 内的文件 import 到了 `client/` 之外 —— 浏览器必然加载失败
 *  - `missing`：目标文件不存在（拼错 / 忘拷依赖，如 `sdk/index.mjs` re-export 的
 *    `client-utils.mjs` —— 少它连服务端 `import()` 都会 ERR_MODULE_NOT_FOUND）
 */
export function scanPluginImports(root) {
	const clientRoot = resolve(root, "client");
	const rows = [];
	for (const file of listPluginModules(root)) {
		let src;
		try {
			src = readFileSync(join(root, file), "utf8");
		} catch {
			continue;
		}
		const absFile = resolve(root, file);
		const isClient = absFile === clientRoot || absFile.startsWith(clientRoot + sep);
		for (const spec of staticImportSpecifiers(src)) {
			if (!isRelativeSpec(spec)) continue;
			const abs = resolve(resolve(absFile, ".."), spec.replace(/[?#].*$/, ""));
			let missing = true;
			try {
				missing = !statSync(abs).isFile();
			} catch {
				missing = true;
			}
			rows.push({
				file,
				spec,
				target: relative(root, abs).split(sep).join("/"),
				missing,
				client: isClient,
				escapesClient: isClient && abs !== clientRoot && !abs.startsWith(clientRoot + sep),
			});
		}
	}
	return rows;
}

/**
 * 自检结论：`{ scanned, problems }`。`kind` 为 `"escapes-client"`（客户端越界，打不开
 * 插件页的致命伤）或 `"missing"`（目标不存在）；越界排前面。
 */
export function checkPluginImports(root) {
	const scanned = listPluginModules(root);
	const problems = [];
	for (const row of scanPluginImports(root)) {
		if (row.escapesClient)
			problems.push({ kind: "escapes-client", file: row.file, spec: row.spec, target: row.target });
		else if (row.missing) problems.push({ kind: "missing", file: row.file, spec: row.spec, target: row.target });
	}
	const rank = (p) => (p.kind === "escapes-client" ? 0 : 1);
	return { scanned, problems: problems.sort((a, b) => rank(a) - rank(b)) };
}
