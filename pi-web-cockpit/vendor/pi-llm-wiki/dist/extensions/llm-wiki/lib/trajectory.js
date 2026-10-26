import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { appendEvent, rebuildMetadataLight } from "./metadata.js";
import { searchWikiLayered } from "./recall.js";
import { fmtDate, nextTrajectoryId, readJson, resolveVaultPaths, writeJson, } from "./utils.js";
import { assertWritableVault, inspectWritableVault } from "./vault-format.js";
// Max characters of a single tool result preserved in the packet preview.
const TOOL_PREVIEW_LIMIT = 600;
const ASSISTANT_PREVIEW_LIMIT = 1200;
function textFromContent(content, limit) {
    if (typeof content === "string")
        return content.slice(0, limit);
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        if (block && typeof block === "object" && block.type === "text") {
            parts.push(String(block.text ?? ""));
        }
    }
    return parts.join("\n").trim().slice(0, limit);
}
/**
 * Extract a normalized trajectory from the live session.
 *
 * Reads message entries from the current branch and flattens pi's
 * AgentMessage content blocks (text / toolCall / toolResult) into compact
 * steps. Defensive about shapes so it degrades gracefully across pi versions.
 */
export function extractTrajectoryFromSession(sessionManager) {
    const sm = sessionManager;
    const entries = (typeof sm?.getBranch === "function" ? sm.getBranch() : undefined) ??
        (typeof sm?.getEntries === "function" ? sm.getEntries() : undefined) ??
        [];
    const steps = [];
    let model;
    let prompt = "";
    for (const entry of entries) {
        const e = entry;
        if (e?.type !== "message" || !e.message)
            continue;
        const msg = e.message;
        if (msg.role === "user") {
            const text = textFromContent(msg.content, ASSISTANT_PREVIEW_LIMIT);
            if (!prompt && text)
                prompt = text;
            steps.push({ role: "user", text });
        }
        else if (msg.role === "assistant") {
            if (!model && msg.model)
                model = msg.model;
            const toolCalls = [];
            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    const b = block;
                    if (b?.type === "toolCall") {
                        toolCalls.push({
                            id: String(b.id ?? ""),
                            name: String(b.name ?? "unknown"),
                            arguments: b.arguments ?? {},
                        });
                    }
                }
            }
            const text = textFromContent(msg.content, ASSISTANT_PREVIEW_LIMIT);
            const step = { role: "assistant" };
            if (text)
                step.text = text;
            if (toolCalls.length > 0)
                step.tool_calls = toolCalls;
            if (step.text || step.tool_calls)
                steps.push(step);
        }
        else if (msg.role === "toolResult") {
            steps.push({
                role: "tool",
                tool_call_id: msg.toolCallId ? String(msg.toolCallId) : undefined,
                tool_name: msg.toolName ? String(msg.toolName) : undefined,
                text: textFromContent(msg.content, TOOL_PREVIEW_LIMIT),
                is_error: Boolean(msg.isError),
            });
        }
    }
    return { steps, model, prompt };
}
// ─── Capture ───────────────────────────────────────────
/** Build a human/LLM-readable README summary of a trajectory packet. */
function buildTrajectoryReadme(packet, title) {
    const toolCalls = packet.steps.flatMap((s) => s.tool_calls ?? []);
    const toolCounts = new Map();
    for (const tc of toolCalls)
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1);
    const toolSummary = [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name}×${n}`)
        .join(", ") || "none";
    const lines = [
        `# Trajectory ${packet.id}: ${title}`,
        "",
        `- **Captured:** ${packet.captured}`,
        `- **Model:** ${packet.model || "unknown"}`,
        `- **Steps:** ${packet.steps.length}`,
        `- **Tools used:** ${toolSummary}`,
        "",
        "## Task",
        "",
        packet.prompt || "_No prompt recorded._",
        "",
        "## Tool-call sequence",
        "",
    ];
    let i = 1;
    for (const step of packet.steps) {
        if (step.role === "assistant" && step.tool_calls?.length) {
            for (const tc of step.tool_calls) {
                lines.push(`${i}. \`${tc.name}\``);
                i++;
            }
        }
    }
    if (i === 1)
        lines.push("_No tool calls recorded._");
    lines.push("");
    return lines.join("\n");
}
/**
 * Capture an agent task trajectory into an immutable packet plus a
 * self-contained summary (extracted.md). No `[LLM:]` case skeleton is emitted
 * (issue #80) — case pages, if wanted, are written during distillation via
 * wiki_ensure_page(type='case').
 */
export function captureTrajectory(paths, input) {
    assertWritableVault(paths);
    const trajectoryId = nextTrajectoryId(paths);
    const packetPath = join(paths.rawTrajectories, trajectoryId);
    mkdirSync(packetPath, { recursive: true });
    const steps = input.steps ?? [];
    const prompt = input.task?.trim() || steps.find((s) => s.role === "user")?.text?.trim() || "";
    const title = input.title?.trim() ||
        (prompt ? prompt.replace(/\s+/g, " ").slice(0, 60) : `Task ${trajectoryId}`);
    const packet = {
        id: trajectoryId,
        captured: fmtDate(),
        packet_version: "1.0",
        prompt,
        ...(input.model ? { model: input.model } : {}),
        steps,
    };
    // Immutable full trajectory.
    writeJson(join(packetPath, "packet.json"), packet);
    // Lightweight manifest so buildRegistry catalogs it uniformly with sources.
    const toolCallCount = steps.reduce((n, s) => n + (s.tool_calls?.length ?? 0), 0);
    writeJson(join(packetPath, "manifest.json"), {
        id: trajectoryId,
        captured: packet.captured,
        packet_version: "1.0",
        title,
        format: "trajectory",
        model: packet.model || "unknown",
        outcome: input.outcome ?? "success",
        step_count: steps.length,
        tool_call_count: toolCallCount,
    });
    // Self-contained, human/LLM-readable summary — no skeleton to flesh later.
    writeFileSync(join(packetPath, "extracted.md"), buildTrajectoryReadme(packet, title), "utf-8");
    appendEvent(paths, {
        kind: "capture_trajectory",
        trajectory_id: trajectoryId,
        step_count: steps.length,
        tool_call_count: toolCallCount,
    });
    rebuildMetadataLight(paths);
    return {
        trajectoryId,
        packetPath,
        stepCount: steps.length,
    };
}
// ─── Tool: wiki_capture_trajectory ─────────────────────
function vaultMissing() {
    return {
        content: [
            {
                type: "text",
                text: "No wiki vault found at this location. Initialize one with wiki_bootstrap first.",
            },
        ],
        details: { error: "no_vault" },
        isError: true,
    };
}
const StepSchema = Type.Object({
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
    text: Type.Optional(Type.String()),
    tool_calls: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        name: Type.String(),
        arguments: Type.Unknown(),
    }))),
    tool_call_id: Type.Optional(Type.String()),
    tool_name: Type.Optional(Type.String()),
    is_error: Type.Optional(Type.Boolean()),
});
export function registerWikiCaptureTrajectory(pi) {
    pi.registerTool({
        name: "wiki_capture_trajectory",
        label: "Wiki Capture Trajectory",
        description: "Capture the just-completed task's tool-call trajectory into an immutable " +
            "packet plus a skeleton case page. By default the trajectory is extracted " +
            "automatically from the live session; pass `steps` to override. This is the " +
            "working-memory counterpart to wiki_capture_source.",
        promptSnippet: "Record the completed task trajectory into the wiki",
        promptGuidelines: [
            "Use wiki_capture_trajectory after a non-trivial task worth learning from. The extension auto-extracts the tool-call trajectory from the session — you usually only need to pass a title.",
            "Then run wiki_distill_skills to generalize captured trajectories into reusable skill pages.",
        ],
        parameters: Type.Object({
            title: Type.Optional(Type.String({ description: "Short descriptive title for the task (≤60 chars)." })),
            task: Type.Optional(Type.String({
                description: "The task/prompt that started the work. Inferred from the session if omitted.",
            })),
            outcome: Type.Optional(Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("partial")], {
                description: "Outcome of the task (default: success).",
            })),
            steps: Type.Optional(Type.Array(StepSchema, {
                description: "Explicit trajectory steps (OpenAI-ish tool-call history). Omit to auto-extract from the live session.",
            })),
            model: Type.Optional(Type.String({ description: "Model that ran the task." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const paths = resolveVaultPaths(ctx.cwd ?? process.cwd());
            const vaultCheck = inspectWritableVault(paths);
            if (!vaultCheck.ok) {
                return {
                    content: [
                        { type: "text", text: `Wiki vault error: ${vaultCheck.diagnostics[0].message}` },
                    ],
                    details: {
                        error: vaultCheck.diagnostics[0].code,
                        diagnostics: vaultCheck.diagnostics,
                    },
                    isError: true,
                };
            }
            let steps = params.steps;
            let model = params.model;
            let task = params.task;
            if (!steps || steps.length === 0) {
                const extracted = extractTrajectoryFromSession(ctx.sessionManager);
                steps = extracted.steps;
                model = model || extracted.model;
                task = task || extracted.prompt;
            }
            if (!steps || steps.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No trajectory could be extracted from the session. Pass `steps` explicitly to capture a trajectory.",
                        },
                    ],
                    details: { error: "empty_trajectory" },
                    isError: true,
                };
            }
            const result = captureTrajectory(paths, {
                title: params.title,
                task,
                steps,
                model,
                outcome: params.outcome,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `🧭 **Trajectory captured**: ${result.trajectoryId}`,
                            "",
                            `- Packet: \`${result.packetPath}/packet.json\``,
                            `- Summary: \`${result.packetPath}/extracted.md\``,
                            `- Steps: ${result.stepCount}`,
                            "",
                            "**Next (optional):** run `wiki_distill_skills` to generalize captured trajectories into reusable skill pages.",
                        ].join("\n"),
                    },
                ],
                details: {
                    trajectoryId: result.trajectoryId,
                    packetPath: result.packetPath,
                    stepCount: result.stepCount,
                },
            };
        },
    });
}
// ─── Tool: wiki_distill_skills ─────────────────────────
/** Determine which trajectory IDs have already been cited by a skill page. */
function distilledTrajectoryIds(paths) {
    const backlinks = readJson(join(paths.meta, "backlinks.json"), {});
    const distilled = new Set();
    for (const [pageId, inbound] of Object.entries(backlinks)) {
        if (!pageId.startsWith("trajectories/"))
            continue;
        if (inbound.some((src) => src.startsWith("skills/"))) {
            distilled.add(pageId.split("/").pop());
        }
    }
    return distilled;
}
export function registerWikiDistillSkills(pi) {
    pi.registerTool({
        name: "wiki_distill_skills",
        label: "Wiki Distill Skills",
        description: "Return a batch of captured trajectories (agent working-memory) that have not " +
            "yet been distilled into skill pages. Read each packet and synthesize reusable " +
            "skill pages (and/or refine case pages) that cite the trajectory IDs.",
        promptSnippet: "Distill captured trajectories into reusable skill pages",
        promptGuidelines: [
            "Use wiki_distill_skills to generalize one or more captured trajectories into reusable skill pages via wiki_ensure_page(type='skill').",
            "Every skill page must cite the trajectory IDs it was distilled from with [[trajectories/TRJ-...]] wikilinks.",
        ],
        parameters: Type.Object({
            trajectory_id: Type.Optional(Type.String({
                description: "Specific trajectory ID to distill. Omit for all undistilled.",
            })),
            batch_size: Type.Optional(Type.Number({ description: "Max trajectories to return (default: 3, max: 5)", default: 3 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const paths = resolveVaultPaths(ctx.cwd ?? process.cwd());
            if (!existsSync(join(paths.dotWiki, "config.json")))
                return vaultMissing();
            const batchSize = Math.min(params.batch_size ?? 3, 5);
            if (!existsSync(paths.rawTrajectories)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No raw/trajectories/ directory. Capture trajectories first with wiki_capture_trajectory.",
                        },
                    ],
                    details: { error: "no_trajectories" },
                };
            }
            const packets = readdirSync(paths.rawTrajectories)
                .filter((d) => d.startsWith("TRJ-"))
                .sort();
            const distilled = distilledTrajectoryIds(paths);
            let toProcess = packets.filter((p) => !distilled.has(p));
            if (params.trajectory_id) {
                if (!packets.includes(params.trajectory_id)) {
                    return {
                        content: [{ type: "text", text: `Trajectory ${params.trajectory_id} not found.` }],
                        details: { trajectory_id: params.trajectory_id, status: "not_found" },
                    };
                }
                toProcess = [params.trajectory_id];
            }
            const batch = toProcess.slice(0, batchSize);
            if (batch.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "✅ All trajectories distilled. Capture more with wiki_capture_trajectory.",
                        },
                    ],
                    details: { distilled: distilled.size, total: packets.length },
                };
            }
            const trajectories = batch.map((id) => {
                const readmePath = join(paths.rawTrajectories, id, "extracted.md");
                const manifestPath = join(paths.rawTrajectories, id, "manifest.json");
                const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf-8") : "";
                const manifest = readJson(manifestPath, {});
                return { id, readme, manifest };
            });
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `🧪 **${batch.length} trajectory(ies) ready** (${toProcess.length - batch.length} remaining)`,
                            "",
                            ...trajectories.map((t) => [
                                `- **${t.id}**: ${t.manifest.title || t.id}`,
                                `  - Tool calls: ${t.manifest.tool_call_count ?? "?"}, steps: ${t.manifest.step_count ?? "?"}`,
                                `  - Packet: \`raw/trajectories/${t.id}/packet.json\``,
                                `  - Summary: \`raw/trajectories/${t.id}/extracted.md\``,
                            ].join("\n")),
                            "",
                            "**Next steps for each trajectory:**",
                            "1. Read packet.json (full tool-call sequence) and extracted.md (summary)",
                            "2. Create/refine reusable skill pages via wiki_ensure_page(type='skill')",
                            "3. Optionally write a case page (a specific past task) via wiki_ensure_page(type='case')",
                            "4. Cite the trajectory with [[trajectories/TRJ-...]] in each skill's 'Distilled From'",
                            "",
                            "The extension auto-updates metadata when you're done.",
                        ].join("\n"),
                    },
                ],
                details: {
                    batch: trajectories.map((t) => t.id),
                    remaining: toProcess.length - batch.length,
                },
            };
        },
    });
}
// ─── Tool: wiki_recall_skill ───────────────────────────
export function registerWikiRecallSkill(pi) {
    pi.registerTool({
        name: "wiki_recall_skill",
        label: "Wiki Recall Skill",
        description: "Search distilled skills and past cases (agent working-memory) for patterns " +
            "relevant to the current task — answers 'have I done something like this before?'. " +
            "Filters layered recall to skill and case pages.",
        promptSnippet: "Recall distilled skills and past cases relevant to the task",
        promptGuidelines: [
            "Use wiki_recall_skill at the START of a task to find reusable skills and similar past cases before doing the work.",
        ],
        parameters: Type.Object({
            query: Type.String({ description: "Search query — use the task description or key terms" }),
            kind: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("case"), Type.Literal("any")], {
                description: "Filter to skills, cases, or both (default: any).",
            })),
            max_results: Type.Optional(Type.Number({ description: "Max results (default: 5, max: 10)", default: 5 })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const paths = resolveVaultPaths(ctx.cwd ?? process.cwd());
            if (!existsSync(join(paths.dotWiki, "config.json")))
                return vaultMissing();
            const maxResults = Math.min(params.max_results ?? 5, 10);
            const kind = params.kind ?? "any";
            // Over-fetch then filter by type, since searchWikiLayered is type-agnostic.
            const raw = searchWikiLayered(paths, params.query, maxResults * 4, 0);
            const wanted = kind === "any" ? ["skill", "case"] : [kind];
            const results = raw.filter((r) => wanted.includes(r.type)).slice(0, maxResults);
            if (results.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `No ${kind === "any" ? "skills or cases" : `${kind}s`} found matching "${params.query}". Capture work with wiki_capture_trajectory and distill it with wiki_distill_skills.`,
                        },
                    ],
                    details: { query: params.query, kind, matches: [] },
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Found ${results.length} ${kind === "any" ? "skill/case" : kind} page(s) matching "${params.query}":\n\n${results
                            .map((r) => {
                            const vault = r.vaultLabel ? ` ${r.vaultLabel}` : "";
                            return `## [[${r.id}]] — ${r.title}${vault}\nType: ${r.type}\nPath: ${r.path}\n\n${r.preview}`;
                        })
                            .join("\n\n---\n\n")}`,
                    },
                ],
                details: { query: params.query, kind, matches: results },
            };
        },
    });
}
