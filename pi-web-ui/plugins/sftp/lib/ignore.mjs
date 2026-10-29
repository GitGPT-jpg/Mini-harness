/**
 * 排除规则（ignore / glob）—— 纯函数，无外部依赖，便于单测与复用。
 *
 * 语义对齐 gitignore 的**最后匹配者生效**：
 *   - 规则按声明顺序求值，`!rule` 取反（负向规则可以把前面忽略掉的东西放回来）；
 *   - 不含斜杠的规则（`dist`、`*.log`）在**任意层级**生效，并且同名的目录会连其下内容一起忽略；
 *   - `**` 跨层、`*` 不跨 `/`、`?` 匹配单个非 `/` 字符；
 *   - 规则两端的 `/` 会被剥掉（`/dist/` 等价于 `dist`）。
 *
 * 另外有一组**内部护栏**（INTERNAL_SEGMENTS）永远生效、且无法被用户负向规则放回：
 * 插件自己的垃圾桶（`.sftp-trash`）与临时文件（`.sftp-tmp`）绝不能再被同步回双方，
 * 否则「删掉→进垃圾桶→下次同步又把垃圾桶传上去」会自我循环。
 */

/** 无论用户怎么配都不会被同步的目录名（路径里出现该段即忽略）。 */
const INTERNAL_DIRS = new Set([".sftp-trash"]);
/** 内部临时文件名前缀（`.sftp-tmp-<pid>-<n>-<原名>`：传输中途的半成品）。 */
const INTERNAL_FILE_PREFIX = ".sftp-tmp";

/** 单条 glob → RegExp。 */
export function globToRegExp(pattern) {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				// 尾部 `**`：跨层匹配剩余全部
				if (i >= pattern.length - 1) re += ".*";
				else if (pattern[i + 1] === "/") {
					i++;
					re += "(?:[^/]*/)*"; // `**/` 匹配零层或多层目录
				} else re += ".*";
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}

/** 一条规则 → 需要全部试过的 RegExp 列表。 */
function ruleToRegExps(raw) {
	const pat = String(raw ?? "")
		.trim()
		.replace(/^\/+|\/+$/g, "");
	if (!pat) return [];
	if (pat === "**") return [/.*/];
	const list = [globToRegExp(pat)];
	if (!pat.includes("/")) {
		list.push(globToRegExp(`**/${pat}`)); // 任意层级的同名段
		list.push(globToRegExp(`${pat}/**`)); // 顶层同名目录下的内容
		list.push(globToRegExp(`**/${pat}/**`)); // 任意层级同名目录下的内容
	}
	if (pat.endsWith("/**")) list.push(globToRegExp(pat.slice(0, -3))); // `a/**` 也忽略 a 本身
	return list;
}

/**
 * 编译用户规则集 → `(rel) => boolean`。
 * @param {string[]} patterns
 */
export function compileIgnore(patterns) {
	const rules = [];
	for (const raw of patterns ?? []) {
		const s = String(raw ?? "").trim();
		if (!s) continue;
		const neg = s.startsWith("!");
		const res = ruleToRegExps(neg ? s.slice(1) : s);
		if (res.length) rules.push({ neg, res });
	}
	return (rel) => {
		const p = String(rel ?? "").replace(/^\/+/, "");
		if (!p) return false;
		let ignored = false;
		for (const r of rules) {
			if (r.res.some((re) => re.test(p))) ignored = !r.neg;
		}
		return ignored;
	};
}

/** 路径是否落在插件内部护栏目录里（垃圾桶 / 临时区）。 */
export function isInternalPath(rel) {
	return String(rel ?? "")
		.split("/")
		.some((seg) => INTERNAL_DIRS.has(seg) || seg.startsWith(INTERNAL_FILE_PREFIX));
}

/**
 * 从 ignore 规则里挑出「可以直接交给 `find -prune` 的纯目录名」。
 *
 * 只认**没被取反、不含 `/` 也没通配符**的规则（`node_modules`、`.git`、`dist`）—— 这些名字在
 * 任意层级含义一致，`-prune` 剪掉子树与逐条 ignore 判定完全等价，白白省下遍历整棵 node_modules。
 * 其余（`*.log`、`src/tmp`、`!keep`）一律还是交给 JS 逐条判定：快不是目的，不错才是。
 *
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function pruneDirNames(patterns) {
	const out = new Set();
	for (const raw of patterns ?? []) {
		const s = String(raw ?? "").trim();
		if (!s || s.startsWith("!")) continue;
		const pat = s.replace(/^\/+|\/+$/g, "");
		if (!pat || pat === "**") continue;
		if (pat.includes("/") || /[\\*?[\]]/.test(pat)) continue;
		out.add(pat);
	}
	return [...out];
}

/**
 * 组合判定器：先看内部护栏（不可被负向规则放回），再看用户规则。
 * @param {string[]} patterns
 * @returns {(rel: string) => boolean}
 */
export function makeMatcher(patterns) {
	const user = compileIgnore(patterns);
	return (rel) => isInternalPath(rel) || user(rel);
}
