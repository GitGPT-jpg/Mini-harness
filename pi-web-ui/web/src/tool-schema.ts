/**
 * tool-schema.ts — 参数 JSON Schema → 可读表格行的**纯函数**（单测覆盖）。
 *
 * 用途：工具定义弹窗（ToolInfoDialog）把 TypeBox 生成的 JSON Schema 摊成
 * 「参数名 / 类型 / 必填 / 说明」四列，比直接甩一坨 JSON 好读得多。
 *
 * 设计取舍：
 *  - **只认结构，不认方言**：SDK 的 schema 由 TypeBox 生成（`type` / `properties` /
 *    `required` / `items` / `anyOf` / `enum` / `$ref` 混用），这里只做保守解释 ——
 *    认不出来的一律画成 `any` 并把原始 JSON 留在弹窗里给用户自己看（宁可少说，不要瞎猜）。
 *  - **深度封顶**：嵌套对象递归展开到 maxDepth 层，再深就只标类型（`object`），
 *    免得一个递归 schema 把弹窗撑爆。
 *  - **行数封顶**：超过 maxRows 直接截断（脏 schema 不该让 UI 卡死）。
 */

/** 表格里的一行（`depth` 用来做缩进：嵌套对象属性缩进一层）。 */
export interface SchemaRow {
	/** 参数名（嵌套时是 `parent.child` 的完整路径，便于一眼看清层级）。 */
	name: string;
	/** 类型标签（`string` / `string (enum)` / `array<string>` / `object` / `any`…）。 */
	type: string;
	required: boolean;
	description?: string;
	/** 额外提示：默认值 / 取值示例等（渲染在类型列下方，弱化样式）。 */
	hint?: string;
	depth: number;
}

interface SchemaRowsOptions {
	/** 递归展开的最大层数（默认 3：根对象 + 两层嵌套）。 */
	maxDepth?: number;
	/** 最多输出多少行（默认 200）。 */
	maxRows?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ROWS = 200;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取字符串（非字符串/空白 → undefined）。 */
function str(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	return s ? s : undefined;
}

/** 联合成员的类型标签，去重后用 `|` 连接；成员过多时截断（`anyOf` 有时很长）。 */
function unionLabel(list: unknown[], depth: number): string {
	const parts: string[] = [];
	for (const item of list) {
		const label = typeLabel(item, depth);
		if (!parts.includes(label)) parts.push(label);
		if (parts.length >= 4) {
			parts.push("…");
			break;
		}
	}
	return parts.join(" | ") || "any";
}

/** 枚举值预览（最多 6 个，多了省略）。 */
function enumHint(values: unknown[]): string | undefined {
	const shown = values.slice(0, 6).map((v) => (typeof v === "string" ? v : (JSON.stringify(v) ?? String(v))));
	if (shown.length === 0) return undefined;
	return `enum: ${shown.join(" | ")}${values.length > shown.length ? " | …" : ""}`;
}

/**
 * 一个 schema 节点 → 类型标签（纯函数）。
 *
 * `depth` 只用于数组元素/联合成员的递归（防止自引用 schema 无限展开）。
 */
export function typeLabel(schema: unknown, depth = 0): string {
	if (depth > 6) return "any";
	if (!isObject(schema)) return "any";
	// $ref：TypeBox 的内联展开会带 $ref（SDK 工具 schema 里少见），只标注不解析。
	if (str(schema.$ref)) return "ref";
	const type = str(schema.type);
	if (type === "array") {
		const items = schema.items;
		const inner = items === undefined ? "any" : typeLabel(items, depth + 1);
		return `array<${inner}>`;
	}
	if (type) {
		// 有 enum 的 string/number 之类额外标出候选值（在 hint 里更完整，这里只提示存在）。
		return type;
	}
	// 没有 type：可能是 anyOf/oneOf/allOf 或纯 properties（TypeBox 的 Object() 带 type，
	// 但手写的 schema 可能省了）。
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const list = schema[key];
		if (Array.isArray(list) && list.length > 0) return unionLabel(list, depth + 1);
	}
	if (isObject(schema.properties)) return "object";
	if (isObject(schema.additionalProperties)) return `record<${typeLabel(schema.additionalProperties, depth + 1)}>`;
	return "any";
}

/** 一行里的附加提示：默认值 / 枚举候选 / const（都是「一眼想知道」的补充信息）。 */
function rowHint(schema: Record<string, unknown>): string | undefined {
	const bits: string[] = [];
	const enums = schema.enum;
	if (Array.isArray(enums) && enums.length > 0) {
		const hint = enumHint(enums);
		if (hint) bits.push(hint);
	}
	if (schema.const !== undefined) bits.push(`const: ${JSON.stringify(schema.const)}`);
	if (schema.default !== undefined) bits.push(`default: ${JSON.stringify(schema.default)}`);
	return bits.length > 0 ? bits.join(" · ") : undefined;
}

/**
 * 参数 schema → 表格行（纯函数）。
 *
 * 只处理**对象型** schema（工具参数按契约都是 object）：非对象返回空数组，
 * 弹窗据此退回「只有原始 JSON」的展示。属性顺序 = schema 里的声明顺序
 * （TypeBox 保序，顺序本身是有意义的排版信息，不排序）。
 */
export function schemaRows(schema: unknown, opts: SchemaRowsOptions = {}): SchemaRow[] {
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
	const root = schema;
	if (!isObject(root)) return [];
	const rootProps = root.properties;
	if (!isObject(rootProps)) return [];

	const rows: SchemaRow[] = [];
	const required = new Set(
		(Array.isArray(root.required) ? root.required : []).filter((r): r is string => typeof r === "string"),
	);

	const walk = (props: Record<string, unknown>, prefix: string, depth: number, requiredSet: Set<string>): void => {
		if (rows.length >= maxRows) return;
		for (const [key, raw] of Object.entries(props)) {
			if (rows.length >= maxRows) return;
			const node = isObject(raw) ? raw : {};
			const name = prefix ? `${prefix}.${key}` : key;
			const row: SchemaRow = {
				name,
				type: typeLabel(node, depth),
				required: requiredSet.has(key),
				depth,
			};
			const description = str(node.description);
			if (description) row.description = description;
			const hint = rowHint(node);
			if (hint) row.hint = hint;
			rows.push(row);

			// 嵌套对象：递归展开（数组里的对象只标 `array<object>`，不展开 —— 位置语义
			// 在表格里表达不了，展开反而误导）。
			if (depth + 1 < maxDepth && isObject(node.properties)) {
				const childRequired = new Set(
					(Array.isArray(node.required) ? node.required : []).filter((r): r is string => typeof r === "string"),
				);
				walk(node.properties, name, depth + 1, childRequired);
			}
		}
	};

	walk(rootProps, "", 0, required);
	return rows;
}

/** 参数行是否值得画成表格（一个属性都没有时弹窗直接显示原始 JSON）。 */
export function hasSchemaRows(schema: unknown): boolean {
	return schemaRows(schema, { maxRows: 1 }).length > 0;
}
