/**
 * patch-tool.ts — 导出给 AI Agent 的结构化补丁工具（Hashline Patch Tool）。
 *
 * 核心设计：
 * - 解决标准 edit 工具容易因缩进幻觉、空白字符或行号漂移导致编辑失败的问题。
 * - 补丁语言基于 [path#TAG] 内容哈希锚点，支持精确行替换（PUT N.=M:）、
 *   语法块级替换（PUT N*:，自动匹配闭合括号/缩进）、行前/后插入（PUT <N: / PUT >N:）、
 *   剪切与寄存器粘贴（CUT / PUT @reg）、文件删除（REM）与重命名（MV）。
 * - 当文件被外部改动导致哈希不一致时，自动尝试 3-Way Merge 冲突自愈。
 */

import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import {
	applyHashlinePatch,
	formatHashlineHeader,
	globalSnapshotStore,
	type PatchApplyReport,
} from "./hashline-engine.js";
import { getLiveLspDiagnostics } from "./lsp-tool.js";

export const PATCH_TOOL_NAME = "patch";

export interface PatchToolOptions {
	cwd: string;
	ownerId?: string;
	lang?: () => ServerLang;
}

export function makePatchTool(options: PatchToolOptions) {
	const cwd = options.cwd;
	const getLang = options.lang ?? (() => "en");

	return defineTool({
		name: PATCH_TOOL_NAME,
		promptSnippet: "apply content-hashed, line-anchored patches to files",
		label: "Apply Hashline patch",
		description: `Apply content-hashed, line-anchored patches to workspace files — prevents stale edits, line drift, and indentation hallucination.
Each file section starts with \`[path#TAG]\` (or \`[path]\` if the hash is unknown yet). Operations:
- \`PUT N.=M:\` replace lines N..M (inclusive) with the following \`+TEXT\` lines.
- \`PUT N*:\` replace the syntactic block starting at line N (closing brace/indent auto-resolved).
- \`PUT <N:\` / \`PUT >N:\` insert before / after line N (\`<1\` = head, \`>$\` = end).
- \`CUT N.=M [@name]\` / \`CUT N* [@name]\` delete lines into a register; \`PUT <N @name\` / \`PUT >N @name\` paste it.
- \`REM\` delete file; \`MV dest/path\` move/rename.
- Create a file: bare \`[path]\` header (no tag) on a nonexistent path + \`PUT <1:\` / \`PUT >$:\` \`+TEXT\` content.
- Body rows under \`:\` headers MUST start with \`+\` (\`+\` alone = blank line). Divergence triggers a 3-way merge.
Success returns the next anchor tag and live LSP diagnostics.`,
		parameters: Type.Object({
			patch: Type.String({
				description:
					"The complete Hashline patch text containing one or more [path#TAG] sections with PUT/CUT/REM/MV operations.",
			}),
			timeout: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 300,
					description: "Optional execution timeout in seconds.",
				}),
			),
		}),
		async execute(_callId, params: { patch: string; timeout?: number }, _signal, _onUpdate, _ctx) {
			const L = getLang();
			const patchText = typeof params?.patch === "string" ? params.patch : "";
			if (!patchText.trim()) {
				const emptyReport: PatchApplyReport = {
					ok: false,
					summary: "Empty patch text provided.",
					results: [],
					error: "Empty patch",
				};
				return {
					content: [
						{
							type: "text",
							text: pick(L, "错误：未提供任何 patch 补丁内容。", "Error: No patch content provided."),
						},
					],
					details: emptyReport,
				};
			}

			// timeout 此前是死参数：schema 声明了 1-300 秒，execute 从未读取，大补丁
			// 卡住只能等 20 分钟看门狗（issue #462）。这里用 Promise.race 实现真实
			// 超时，覆盖 await 长尾（实时 LSP 诊断等）；applyHashlinePatch 是同步
			// 本地文件操作，同步段无法被中断，race 只能兜异步部分。
			const timeoutSec = params.timeout ? Math.min(Math.max(1, params.timeout), 300) : null;

			const finish = async () => {
				const report = applyHashlinePatch(patchText, {
					cwd,
					snapshotStore: globalSnapshotStore,
				});

				if (!report.ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: pick(L, `补丁应用失败：\n${report.summary}`, `Patch Failed:\n${report.summary}`),
							},
						],
						details: report,
					};
				}

				const textOutput = [report.summary];
				// 为成功修改的文件输出最新的头部标签，方便 Agent 连续进行下一步修改
				for (const r of report.results) {
					if (r.op !== "deleted" && r.newHash) {
						const targetPath = r.newPath || r.filePath;
						textOutput.push(
							pick(
								L,
								`\n${targetPath} 的下一处编辑锚点：\`${formatHashlineHeader(targetPath, r.newHash)}\``,
								`\nNext edit anchor for ${targetPath}: \`${formatHashlineHeader(targetPath, r.newHash)}\``,
							),
						);
						try {
							const fullPath = resolve(cwd, targetPath);
							const diags = await getLiveLspDiagnostics(fullPath, cwd);
							if (diags) {
								textOutput.push(
									pick(
										L,
										`\n${targetPath} 的实时 LSP 诊断：\n${diags}`,
										`\nLive LSP diagnostics for ${targetPath}:\n${diags}`,
									),
								);
							}
						} catch {}
					}
				}

				return {
					content: [{ type: "text" as const, text: textOutput.join("\n") }],
					details: report,
				};
			};

			if (!timeoutSec) return finish();

			const timeoutReply = {
				content: [
					{
						type: "text" as const,
						text: pick(
							L,
							`补丁执行超时（${timeoutSec}s）。补丁可能已部分应用，请检查目标文件后重试。`,
							`Patch execution timed out (${timeoutSec}s). The patch may have been partially applied; check the target files and retry.`,
						),
					},
				],
				details: {
					ok: false,
					summary: `Execution timed out after ${timeoutSec}s`,
					results: [],
					error: "timeout",
				} satisfies PatchApplyReport,
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					finish(),
					new Promise<typeof timeoutReply>((resolveTimeout) => {
						timer = setTimeout(() => resolveTimeout(timeoutReply), timeoutSec * 1000);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	});
}
