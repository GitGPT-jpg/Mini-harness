/**
 * server/tool-signature.ts
 *
 * Generates compact parameter signatures with concise English hints (1-2 words / <= 20 chars)
 * and produces lightweight shallow schemas (skeleton schemas) from tool JSON Schema / TypeBox definitions.
 *
 * Strictly pure English to keep model prompts concise and conform to hygiene guards.
 */

/** Clean and extract a concise English hint from a parameter's schema. */
export function extractConciseParamHint(prop: unknown): string {
	if (!prop || typeof prop !== "object") return "";
	const p = prop as { description?: string; type?: string };
	const desc = (p.description || "").trim();
	if (desc) {
		// Strip parenthetical notes like "(default 30)", "(1-indexed)"
		const cleaned = desc.replace(/\([^)]*\)/g, "").trim();
		// Take first clause before punctuation or newline
		const clause = cleaned.split(/[,.;:—\n]/)[0]?.trim() || "";
		// Strip leading articles/adjectives: "the", "optional", "a", "an"
		const stripped = clause.replace(/^(the|optional|a|an)\s+/i, "").trim();
		// Extract up to 2 words, max 20 chars, without truncating words
		const words = stripped.split(/\s+/).filter(Boolean);
		const picked: string[] = [];
		let len = 0;
		for (const w of words) {
			if (picked.length >= 2) break;
			const nextLen = len === 0 ? w.length : len + 1 + w.length;
			if (nextLen > 20) {
				if (picked.length === 0) picked.push(w.slice(0, 20));
				break;
			}
			picked.push(w);
			len = nextLen;
		}
		if (picked.length > 0) return picked.join(" ");
	}
	if (p.type && typeof p.type === "string") {
		return p.type;
	}
	return "";
}

/**
 * Format a compact parameter signature for a tool definition's parameters:
 * e.g. `(steps: step list, activeStepId?: step ID)`
 */
export function formatCompactSignature(parameters: unknown): string {
	if (!parameters || typeof parameters !== "object") return "";
	const schema = parameters as { properties?: Record<string, unknown>; required?: unknown };
	const props = schema.properties;
	if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
		return "";
	}
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const entries = Object.entries(props);
	// Limit to first 6 properties to keep lines compact
	const visibleEntries = entries.slice(0, 6);
	const formatted = visibleEntries.map(([key, val]) => {
		const isReq = required.has(key);
		const hint = extractConciseParamHint(val);
		return `${key}${isReq ? "" : "?"}${hint ? `: ${hint}` : ""}`;
	});
	if (entries.length > visibleEntries.length) {
		formatted.push("...");
	}
	return `(${formatted.join(", ")})`;
}

/**
 * Creates a lightweight "shallow schema" (skeleton schema) from a full TypeBox / JSON Schema.
 * Retains only top-level property types and concise hints while stripping heavy nested
 * enum descriptions, complex sub-schemas, and markdown examples.
 *
 * Reduces token footprint by ~80-90% while keeping native function calling fully compatible.
 */
export function createShallowSchema(parameters: unknown): Record<string, unknown> | undefined {
	if (!parameters || typeof parameters !== "object") return undefined;
	const schema = parameters as {
		type?: string;
		properties?: Record<string, unknown>;
		required?: unknown;
	};
	const props = schema.properties;
	if (!props || typeof props !== "object") {
		return { type: schema.type || "object" };
	}
	const shallowProps: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(props)) {
		if (!val || typeof val !== "object") continue;
		const p = val as { type?: string };
		const hint = extractConciseParamHint(val);
		shallowProps[key] = {
			type: p.type || "string",
			...(hint ? { description: hint } : {}),
		};
	}
	const req = Array.isArray(schema.required) ? schema.required : undefined;
	return {
		type: "object",
		properties: shallowProps,
		...(req && req.length > 0 ? { required: req } : {}),
	};
}
