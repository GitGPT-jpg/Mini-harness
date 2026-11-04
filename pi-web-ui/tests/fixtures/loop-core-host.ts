/**
 * Independent service host for restart tests. Real ClientSession.resumeLoop,
 * extension tools/events, storage, runner and HTTP routes; only model/session
 * transport is replaced by a deterministic local adapter (no model credentials).
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { ClientSession } from "../../server/agent-service.js";
import {
	createLoopExtension,
	createLoopRun,
	loadLoopState,
	recoverRun,
	observeRunOperation,
} from "../../server/loop/extension.js";
import { registerLoopRoutes } from "../../server/loop/routes.js";
import { listOperations } from "../../server/loop/operation.js";
import { runCommand } from "../../server/loop/run-command.js";

const workspace = process.env.FIXTURE_WORKSPACE!;
const data = process.env.FIXTURE_DATA!;
const sid = "restart-fixture-session";
const tools = new Map<string, any>();
const handlers = new Map<string, any>();
const notices: unknown[] = [];
const models = [
	{ provider: "fixture", id: "deepseek-main" },
	{ provider: "fixture", id: "gpt-planner" },
	{ provider: "fixture", id: "glm-reviewer" },
];
/** start 消息可配置 reviewer 返回固定结论（"block"）；持久到 data 文件供恢复宿主 B 沿用。 */
const reviewerModeFile = () => path.join(data, "review-mode.json");
const reviewerMode = () => {
	try {
		return JSON.parse(fs.readFileSync(reviewerModeFile(), "utf8")).mode as "block" | "hang" | null;
	} catch {
		return null;
	}
};
const ctx = {
	cwd: workspace,
	sessionManager: { getSessionId: () => sid },
	model: models[0],
	modelRegistry: {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAll: () => models,
		getAvailable: () => models,
		complete: async (model: any) => {
			if (model.id === "gpt-planner") return { content: [{ type: "text", text: "validate existing workspace" }] };
			if (reviewerMode() === "block")
				return { content: [{ type: "text", text: '{"verdict":"block","reasons":["not ready"]}' }] };
			fs.appendFileSync(path.join(data, "review-starts.jsonl"), JSON.stringify({ host: process.pid }) + "\n");
			return new Promise<never>(() => {});
		},
	},
};
const pi: any = {
	registerTool: (tool: any) => tools.set(tool.name, tool),
	on: (name: string, handler: any) => handlers.set(name, handler),
	exec: (cmd: string, args: string[], opts: any) => runCommand(cmd, args, { ...opts, cwd: opts?.cwd ?? workspace }),
	sendUserMessage: (text: string) => notices.push(text),
};
createLoopExtension()(pi);
const call = (name: string, params = {}) => tools.get(name).execute("fixture", params, undefined, undefined, ctx);
const end = () => handlers.get("agent_end")({}, ctx);
const session = Object.create(ClientSession.prototype) as any;
session.loopResuming = new Set();
session.convs = new Map([["main", { id: "main", isSubagent: false, session: { sessionId: sid } }]]);
session.activeId = "main";
session.flushSnapshot = () => {};
session.emit = (event: unknown) => notices.push(event);
session.emitNotice = (...args: unknown[]) => notices.push(args);
session.prompt = async () => {
	await call("loop_done", { summary: "continue recorded acceptance" });
	await end();
};
const app = express();
app.use(express.json());
app.use((req, res, next) => {
	if (req.headers.authorization !== `Bearer ${process.env.FIXTURE_TOKEN}`) {
		res.sendStatus(401);
		return;
	}
	next();
});
registerLoopRoutes(app, { dataDir: data, agentDir: path.join(data, "agent") });
const server = app.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string" || address.port < 8900) throw new Error("Invalid fixture port");
	process.send?.({ ready: true, port: address.port, pid: process.pid });
});
process.on("message", async (message: any) => {
	try {
		let result: unknown;
		switch (message.action) {
			case "start": {
				fs.writeFileSync(
					reviewerModeFile(),
					JSON.stringify({ mode: message.reviewBlock === true ? "block" : message.review === true ? "hang" : null }),
				);
				const created = createLoopRun({
					sessionId: sid,
					cwd: workspace,
					goal: "restart acceptance",
					validateCmd: message.command,
					useReviewer: message.review === true,
					maxRounds: message.maxRounds ?? 1,
					...(message.constraints ?? {}),
				});
				if (!created.ok) throw new Error(created.error);
				if (message.review) await handlers.get("before_agent_start")({}, ctx);
				await call("loop_done", { summary: "start original validator" });
				void end().catch((error: unknown) => notices.push(String(error)));
				result = created;
				break;
			}
			case "recover":
				result = recoverRun(message.runId);
				break;
			case "observe":
				result = await observeRunOperation(message.runId);
				break;
			case "resume":
				await session.resumeLoop(message.runId);
				result = { state: loadLoopState(message.runId), notices };
				break;
			case "duplicate":
				await call("loop_done", { summary: "duplicate completion" });
				await end();
				await end();
				result = loadLoopState(message.runId);
				break;
			case "inspect":
				result = { state: loadLoopState(message.runId), operations: listOperations(message.runId), notices };
				break;
			default:
				throw new Error("Unknown fixture action");
		}
		process.send?.({ id: message.id, result });
	} catch (error) {
		process.send?.({ id: message.id, error: String((error as Error).stack) });
	}
});
process.on("disconnect", () => {
	server.close();
});
