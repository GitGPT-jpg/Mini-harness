import { describe, expect, it } from "vitest";
import { createShallowSchema, extractConciseParamHint, formatCompactSignature } from "../../server/tool-signature.js";

describe("tool-signature", () => {
	it("extracts concise English hints from descriptions", () => {
		expect(extractConciseParamHint({ description: "Workspace-relative or absolute file path" })).toBe(
			"Workspace-relative",
		);
		expect(extractConciseParamHint({ description: "The shell command to run" })).toBe("shell command");
		expect(extractConciseParamHint({ description: "Line number to start reading from (1-indexed)" })).toBe(
			"Line number",
		);
		expect(extractConciseParamHint({ description: "Optional timeout in seconds" })).toBe("timeout in");
	});

	it("falls back to parameter type if description is absent", () => {
		expect(extractConciseParamHint({ type: "string" })).toBe("string");
		expect(extractConciseParamHint({ type: "number" })).toBe("number");
		expect(extractConciseParamHint({})).toBe("");
		expect(extractConciseParamHint(null)).toBe("");
	});

	it("formats compact signature with required and optional flags", () => {
		const schema = {
			properties: {
				path: { description: "The file path" },
				offset: { description: "Line number to start from" },
				limit: { type: "number" },
			},
			required: ["path"],
		};
		const sig = formatCompactSignature(schema);
		expect(sig).toBe("(path: file path, offset?: Line number, limit?: number)");
	});

	it("returns empty string when parameters has no properties", () => {
		expect(formatCompactSignature({})).toBe("");
		expect(formatCompactSignature({ properties: {} })).toBe("");
		expect(formatCompactSignature(null)).toBe("");
	});

	it("creates lightweight shallow schema stripping nested complexities", () => {
		const fullSchema = {
			type: "object",
			properties: {
				steps: {
					type: "array",
					description: "List of plan steps",
					items: {
						type: "object",
						properties: {
							id: { type: "string", description: "Unique step ID" },
							title: { type: "string", description: "Short step title" },
						},
					},
				},
				activeStepId: {
					type: "string",
					description: "ID of the step currently being executed",
				},
			},
			required: ["steps"],
		};
		const shallow = createShallowSchema(fullSchema);
		expect(shallow).toEqual({
			type: "object",
			properties: {
				steps: {
					type: "array",
					description: "List of",
				},
				activeStepId: {
					type: "string",
					description: "ID of",
				},
			},
			required: ["steps"],
		});
	});

	it("handles empty or invalid schemas safely in createShallowSchema", () => {
		expect(createShallowSchema(null)).toBeUndefined();
		expect(createShallowSchema({})).toEqual({ type: "object" });
		expect(createShallowSchema({ properties: {} })).toEqual({ type: "object", properties: {} });
	});
});
