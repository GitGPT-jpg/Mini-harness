/**
 * Live2D 看板娘服务端入口
 * 负责提供 AI 操控工具、HTTP 路由 API 以及状态事件双向同步
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync, createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

function findZipEocd(buf) {
	const sig = 0x06054b50;
	const minLen = 22;
	if (buf.length < minLen) throw new Error("不是有效的 ZIP 文件（文件过小）");
	const start = Math.max(0, buf.length - 65536 - minLen);
	for (let i = buf.length - minLen; i >= start; i--) {
		if (buf.readUInt32LE(i) === sig) return i;
	}
	throw new Error("不是有效的 ZIP 文件（未找到 EOCD）");
}

function extractZipBuffer(buf, targetDir) {
	const MAX_ENTRIES = 20000; // 条目数上限：防 zip 炸弹（海量小文件撑爆目录项）
	const MAX_FILE_BYTES = 512 * 1024 * 1024; // 单文件解压上限（Live2D 模型资源单文件极少超过此值）
	const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 解压总量上限：防 zip 炸弹（高压缩比）
	const eocd = findZipEocd(buf);
	const cdCount = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	let p = cdOffset;
	let totalOut = 0;
	for (let i = 0; i < cdCount; i++) {
		if (i >= MAX_ENTRIES) throw new Error("ZIP 条目数超出上限");
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;

		if (name.includes("..") || path.isAbsolute(name)) continue;

		const lh = localOffset;
		if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error("ZIP 局部头损坏");
		const lhNameLen = buf.readUInt16LE(lh + 26);
		const lhExtraLen = buf.readUInt16LE(lh + 28);
		const dataStart = lh + 30 + lhNameLen + lhExtraLen;
		const raw = buf.subarray(dataStart, dataStart + compSize);

		// 规范化后再判界：防 Windows 反斜杠/混合分隔符等 `..` 变体逃逸出 targetDir。
		const outPath = path.resolve(targetDir, name);
		const root = path.resolve(targetDir);
		if (outPath !== root && !outPath.startsWith(root + path.sep)) continue;
		if (name.endsWith("/")) {
			mkdirSync(outPath, { recursive: true });
			continue;
		}

		mkdirSync(path.dirname(outPath), { recursive: true });
		let decompressed;
		if (method === 0) {
			decompressed = raw;
		} else if (method === 8) {
			// maxOutputLength：节点侧硬上限，超限直接抛错而不是打爆内存。
			decompressed = inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES + 1 });
		} else {
			continue;
		}
		if (decompressed.length > MAX_FILE_BYTES) throw new Error("ZIP 单文件解压超出上限");
		totalOut += decompressed.length;
		if (totalOut > MAX_TOTAL_BYTES) throw new Error("ZIP 解压总量超出上限");
		writeFileSync(outPath, decompressed);
	}
}

const DEFAULT_MODELS = [
	{
		key: "shizuku",
		name: "🌸 雫 (Shizuku - Cubism 2)",
		type: "cubism2",
		expressions: ["f01", "f02", "f03", "f04"],
		motions: ["idle", "tap_body", "pinch_in", "pinch_out", "shake", "flick_head"],
	},
	{
		key: "haru",
		name: "🌿 春 (Haru - Cubism 4)",
		type: "cubism4",
		expressions: ["f00", "f01", "f02", "f03", "f04", "f05", "f06", "f07"],
		motions: ["Idle", "Tap"],
	},
	{
		key: "hiyori",
		name: "☀️ 日和 (Hiyori - Cubism 4)",
		type: "cubism4",
		expressions: ["happy", "sad", "angry", "surprised"],
		motions: ["Idle", "TapBody"],
	},
	{
		key: "wanko",
		name: "🐶 萌柴 (Wanko - Cubism 4)",
		type: "cubism4",
		expressions: ["happy", "surprised"],
		motions: ["Idle", "TapBody"],
	},
];

export default {
	activate(host) {
		const stateFile = path.join(host.dir, "state.json");
		const customModelsFile = path.join(host.dir, "custom_models.json");
		const uploadsDir = path.join(host.dir, "uploads");
		if (!existsSync(uploadsDir)) {
			try {
				mkdirSync(uploadsDir, { recursive: true });
			} catch {}
		}

		let currentState = {
			currentModel: "shizuku",
			mode: "mouse",
		};

		async function loadState() {
			try {
				if (existsSync(stateFile)) {
					const data = JSON.parse(await fs.readFile(stateFile, "utf-8"));
					Object.assign(currentState, data);
				}
			} catch {}
		}

		async function saveState() {
			try {
				await fs.writeFile(stateFile, JSON.stringify(currentState, null, 2), "utf-8");
			} catch {}
		}

		async function loadCustomModels() {
			try {
				if (existsSync(customModelsFile)) {
					return JSON.parse(await fs.readFile(customModelsFile, "utf-8"));
				}
			} catch {}
			return [];
		}

		async function saveCustomModels(models) {
			try {
				await fs.writeFile(customModelsFile, JSON.stringify(models, null, 2), "utf-8");
			} catch {}
		}

		async function getAllModels() {
			const customs = await loadCustomModels();
			const list = [...DEFAULT_MODELS];
			for (const c of customs) {
				if (!list.some((m) => m.key === c.key)) {
					list.push(c);
				}
			}
			return list;
		}

		/** 递归查找目录下的 .model3.json 或 .model.json 配置文件 */
		async function findModelConfig(dir) {
			async function scan(currentDir, currentRel, depth) {
				if (depth > 4) return null;
				let entries = [];
				try {
					entries = await fs.readdir(currentDir, { withFileTypes: true });
				} catch {
					return null;
				}
				// 优先查找当前层的配置文件
				for (const ent of entries) {
					if (ent.isFile()) {
						const lower = ent.name.toLowerCase();
						if (lower.endsWith(".model3.json") || lower.endsWith(".model.json")) {
							return {
								fullPath: path.join(currentDir, ent.name),
								relPath: (currentRel ? `${currentRel}/${ent.name}` : ent.name).replace(/\\/g, "/"),
							};
						}
					}
				}
				// 再递归查找子目录
				for (const ent of entries) {
					if (ent.isDirectory()) {
						const nextRel = currentRel ? `${currentRel}/${ent.name}` : ent.name;
						const found = await scan(path.join(currentDir, ent.name), nextRel, depth + 1);
						if (found) return found;
					}
				}
				return null;
			}
			return await scan(dir, "", 1);
		}

		/** 读取 model json 并组装自定义模型对象 */
		async function parseModelEntry(modelKey, targetDir, foundConfig, fallbackName) {
			let content = {};
			try {
				content = JSON.parse(await fs.readFile(foundConfig.fullPath, "utf-8"));
			} catch {}
			const isCubism4 = foundConfig.relPath.toLowerCase().endsWith(".model3.json") || content.Version === 3;
			// 模型包内 name 外部可控：剥掉 HTML 危险字符并限长，展示层仍会二次转义。
			const rawName = String(
				content.name || fallbackName || path.basename(foundConfig.fullPath).replace(/\.model(?:3)?\.json$/i, ""),
			)
				.trim()
				.slice(0, 64)
				.replace(/[<>&"']/g, "");
			const expressions = [];
			const motions = [];

			if (isCubism4) {
				if (Array.isArray(content.FileReferences?.Expressions)) {
					for (const exp of content.FileReferences.Expressions) {
						if (exp.Name) expressions.push(exp.Name);
					}
				}
				if (content.FileReferences?.Motions && typeof content.FileReferences.Motions === "object") {
					for (const group of Object.keys(content.FileReferences.Motions)) {
						motions.push(group);
					}
				}
			} else {
				if (Array.isArray(content.expressions)) {
					for (const exp of content.expressions) {
						if (exp.name) expressions.push(exp.name);
					}
				}
				if (content.motions && typeof content.motions === "object") {
					for (const group of Object.keys(content.motions)) {
						motions.push(group);
					}
				}
			}

			return {
				key: modelKey,
				name: `✨ ${rawName}`,
				nameEn: `✨ ${rawName}`,
				url: `/plugins-api/live2d/uploads/${modelKey}/${foundConfig.relPath}`,
				type: isCubism4 ? "cubism4" : "cubism2",
				expressions: expressions.length > 0 ? expressions : ["happy", "sad", "angry", "surprised"],
				motions: motions.length > 0 ? motions : ["Idle", "TapBody"],
				isUploaded: true,
				scale: 1.0,
				offsetY: 0,
			};
		}

		void loadState();

		// ── 1. HTTP 路由 API ──────────────────────────────────────────
		const unroutes = [];

		function route(method, routePath, handler) {
			const off = host.route(method, routePath, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					host.log("error", `[live2d] ${method} ${routePath} 失败: ${err?.message || err}`);
					if (!res.headersSent) {
						res.status(500).json({ ok: false, error: err?.message || "Internal error" });
					}
				}
			});
			unroutes.push(off);
		}

		// GET /models
		route("GET", "/models", async (_req, res) => {
			const models = await getAllModels();
			res.json({
				ok: true,
				current: currentState.currentModel,
				mode: currentState.mode,
				models,
			});
		});

		// GET /current-model
		route("GET", "/current-model", async (_req, res) => {
			res.json({
				ok: true,
				model: currentState.currentModel,
				mode: currentState.mode,
			});
		});

		// GET /expressions
		route("GET", "/expressions", async (req, res) => {
			const modelKey = req.query?.model || currentState.currentModel;
			const models = await getAllModels();
			const entry = models.find((m) => m.key === modelKey) || models[0];
			res.json({
				ok: true,
				model: entry.key,
				expressions: entry.expressions || ["happy", "sad", "angry", "surprised"],
			});
		});

		// POST /action (与 E:/live2d_pet 的 /action 协议全面兼容)
		route("POST", "/action", async (req, res) => {
			const payload = req.body || {};
			const action = payload.action;

			if (action === "expression") {
				const name = payload.name;
				if (!name) return res.status(400).json({ ok: false, error: "missing 'name' field" });
				host.broadcast({
					type: "live2d:action",
					action: "expression",
					name,
					duration: payload.duration || 4000,
				});
				return res.json({ ok: true, expression: name });
			}

			if (action === "message" || action === "bubble") {
				const text = payload.text;
				if (!text) return res.status(400).json({ ok: false, error: "missing 'text' field" });
				host.broadcast({
					type: "live2d:action",
					action: "bubble",
					text,
					duration: payload.duration || 4000,
					expression: payload.expression,
				});
				return res.json({ ok: true, text });
			}

			if (action === "mode") {
				const mode = payload.mode;
				if (!["mouse", "idle"].includes(mode)) {
					return res.status(400).json({ ok: false, error: "mode must be 'mouse' or 'idle'" });
				}
				currentState.mode = mode;
				void saveState();
				host.broadcast({
					type: "live2d:action",
					action: "mode",
					mode,
				});
				return res.json({ ok: true, mode });
			}

			if (action === "model_switch") {
				const model = payload.model;
				if (!model) return res.status(400).json({ ok: false, error: "missing 'model' field" });
				currentState.currentModel = model;
				void saveState();
				host.broadcast({
					type: "live2d:action",
					action: "model_switch",
					model,
				});
				return res.json({ ok: true, model });
			}

			if (action === "play_audio") {
				const url = payload.url;
				if (!url) return res.status(400).json({ ok: false, error: "missing 'url' field" });
				host.broadcast({
					type: "live2d:action",
					action: "play_audio",
					url,
					name: payload.name || "",
					volume: payload.volume,
				});
				return res.json({ ok: true, url });
			}

			if (action === "stop_audio") {
				host.broadcast({
					type: "live2d:action",
					action: "stop_audio",
				});
				return res.json({ ok: true });
			}

			if (action === "blink") {
				host.broadcast({
					type: "live2d:action",
					action: "blink",
					blinkType: payload.blinkType || "both",
				});
				return res.json({ ok: true });
			}

			res.status(400).json({ ok: false, error: `unknown action: ${action}` });
		});

		// ── 静态托管用户上传的模型资源 GET /uploads/* ────────────────
		route("GET", "/uploads/*", async (req, res) => {
			const rawPath = req.pluginPath || req.url || "";
			const rel = rawPath.replace(/^\/?(?:plugins-api\/live2d\/)?uploads\//, "");
			// 规范化后必须仍在 uploadsDir 内：只剥开头 `..` 挡不住 `a/../../x` 中间段穿越。
			const root = path.resolve(uploadsDir);
			const fullPath = path.resolve(root, rel);
			if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
				return res.status(403).end("Forbidden");
			}

			if (!existsSync(fullPath)) {
				return res.status(404).end("File not found");
			}
			let stat;
			try {
				stat = await fs.stat(fullPath);
			} catch {
				return res.status(404).end("File not accessible");
			}
			if (!stat.isFile()) {
				return res.status(404).end("Not a file");
			}

			const ext = path.extname(fullPath).toLowerCase();
			const mimeMap = {
				".json": "application/json; charset=utf-8",
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".webp": "image/webp",
				".moc": "application/octet-stream",
				".moc3": "application/octet-stream",
				".mtn": "application/octet-stream",
				".motion3.json": "application/json; charset=utf-8",
				".physics3.json": "application/json; charset=utf-8",
				".cdi3.json": "application/json; charset=utf-8",
				".mp3": "audio/mpeg",
				".wav": "audio/wav",
			};

			res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
			res.setHeader("Content-Length", stat.size);
			res.setHeader("Cache-Control", "public, max-age=86400");
			const stream = createReadStream(fullPath);
			stream.pipe(res);
		});

		// ── 上传 ZIP 模型压缩包 POST /upload-zip ────────────────────
		const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 请求体上限 1GB：Live2D 模型包远小于此，纯防无界内存
		route("POST", "/upload-zip", async (req, res) => {
			const modelKey = "upload_" + Date.now();
			const targetDir = path.join(uploadsDir, modelKey);
			await fs.mkdir(targetDir, { recursive: true });

			const chunks = [];
			let totalBytes = 0;
			for await (const chunk of req) {
				totalBytes += chunk.length;
				if (totalBytes > MAX_ZIP_BYTES) {
					try {
						await fs.rm(targetDir, { recursive: true, force: true });
					} catch {}
					return res.status(413).json({ ok: false, error: "ZIP 包过大（> 1GB）" });
				}
				chunks.push(chunk);
			}
			const zipBuf = Buffer.concat(chunks);
			try {
				extractZipBuffer(zipBuf, targetDir);
			} catch (err) {
				try {
					await fs.rm(targetDir, { recursive: true, force: true });
				} catch {}
				return res.status(400).json({ ok: false, error: "ZIP 解压失败: " + (err.message || String(err)) });
			}

			// 自动查找 .model3.json 或 .model.json
			const found = await findModelConfig(targetDir);
			if (!found) {
				try {
					await fs.rm(targetDir, { recursive: true, force: true });
				} catch {}
				return res.status(400).json({
					ok: false,
					error: "ZIP 压缩包中未检测到 .model3.json 或 .model.json 配置文件，请确认模型包格式是否正确",
				});
			}

			const rawName = req.query?.name ? decodeURIComponent(String(req.query.name)) : "";
			const entry = await parseModelEntry(modelKey, targetDir, found, rawName);

			const customs = await loadCustomModels();
			customs.push(entry);
			await saveCustomModels(customs);

			host.broadcast({ type: "live2d:custom-models-updated", models: customs });
			host.log(`[live2d] 成功导入本地模型: ${entry.name} (${modelKey})`);

			res.json({ ok: true, model: entry });
		});

		// ── 文件夹单文件上传 POST /upload-file ──────────────────────
		route("POST", "/upload-file", async (req, res) => {
			const query = req.query || {};
			const modelKey = String(query.key || "").replace(/[^a-zA-Z0-9_-]/g, "");
			const relPath = String(query.relPath || "");
			if (!modelKey || !relPath) {
				return res.status(400).json({ ok: false, error: "missing key or relPath" });
			}
			// 只剥开头 `..` 挡不住 `a/../../x` 这类中间段穿越：规范化后必须仍在
			// <uploadsDir>/<modelKey>/ 内，否则可借上传接口任意写盘（覆盖配置/脚本）。
			const root = path.resolve(uploadsDir, modelKey);
			const targetFile = path.resolve(root, relPath);
			if (targetFile !== root && !targetFile.startsWith(root + path.sep)) {
				return res.status(400).json({ ok: false, error: "relPath 越界" });
			}
			await fs.mkdir(path.dirname(targetFile), { recursive: true });

			const ws = createWriteStream(targetFile);
			req.pipe(ws);

			await new Promise((resolve, reject) => {
				ws.on("finish", resolve);
				ws.on("error", reject);
				req.on("error", reject);
			});

			res.json({ ok: true });
		});

		// ── 完成文件夹模型上传并建立配置 POST /finish-folder-upload ───
		route("POST", "/finish-folder-upload", async (req, res) => {
			const body = req.body || {};
			const modelKey = String(body.key || "").replace(/[^a-zA-Z0-9_-]/g, "");
			const fallbackName = body.name || "";
			if (!modelKey) return res.status(400).json({ ok: false, error: "missing key" });

			const targetDir = path.join(uploadsDir, modelKey);
			const found = await findModelConfig(targetDir);
			if (!found) {
				try {
					await fs.rm(targetDir, { recursive: true, force: true });
				} catch {}
				return res.status(400).json({
					ok: false,
					error: "上传的文件夹中未找到 .model3.json 或 .model.json 配置文件",
				});
			}

			const entry = await parseModelEntry(modelKey, targetDir, found, fallbackName);
			const customs = await loadCustomModels();
			customs.push(entry);
			await saveCustomModels(customs);

			host.broadcast({ type: "live2d:custom-models-updated", models: customs });
			host.log(`[live2d] 成功导入文件夹模型: ${entry.name} (${modelKey})`);

			res.json({ ok: true, model: entry });
		});

		// ── 删除自定义模型 POST /delete-model ───────────────────────
		route("POST", "/delete-model", async (req, res) => {
			const body = req.body || {};
			const key = body.key;
			if (!key) return res.status(400).json({ ok: false, error: "missing key" });

			const customs = await loadCustomModels();
			const idx = customs.findIndex((m) => m.key === key);
			if (idx === -1) {
				return res.status(404).json({ ok: false, error: "model not found in customs" });
			}
			customs.splice(idx, 1);
			await saveCustomModels(customs);

			// 清理上传目录
			const uploadTarget = path.join(uploadsDir, key);
			if (existsSync(uploadTarget)) {
				try {
					await fs.rm(uploadTarget, { recursive: true, force: true });
				} catch {}
			}

			if (currentState.currentModel === key) {
				currentState.currentModel = "shizuku";
				void saveState();
				host.broadcast({ type: "live2d:action", action: "model_switch", model: "shizuku" });
			}

			host.broadcast({ type: "live2d:custom-models-updated", models: customs });
			host.log(`[live2d] 已移除自定义模型: ${key}`);

			res.json({ ok: true });
		});

		// ── 2. 注册 AI 操控工具 (Agent Tools) ────────────────────────
		const untools = [];

		if (typeof host.registerAgentTool === "function") {
			// 1) live2d_list_models
			untools.push(
				host.registerAgentTool({
					name: "live2d_list_models",
					label: "列出看板娘模型",
					description:
						"List all available Live2D companion pet models with keys and supported expressions. Response indicates the active model.",
					promptSnippet: "inspect available Live2D pet models",
					promptGuidelines: ["Call before live2d_switch_model to obtain valid model keys."],
					parameters: {
						type: "object",
						properties: {},
					},
					async execute() {
						const models = await getAllModels();
						return JSON.stringify({
							current: currentState.currentModel,
							mode: currentState.mode,
							models: models.map((m) => ({ key: m.key, name: m.name, expressions: m.expressions })),
						});
					},
				}),
			);

			// 2) live2d_get_current_model
			untools.push(
				host.registerAgentTool({
					name: "live2d_get_current_model",
					label: "获取当前看板娘",
					description:
						"Get the currently loaded Live2D companion model key, active interaction mode, and available expressions.",
					promptSnippet: "inspect the active Live2D model and state",
					promptGuidelines: ["Use to verify which pet model is active before playing specific expressions."],
					parameters: {
						type: "object",
						properties: {},
					},
					async execute() {
						const models = await getAllModels();
						const entry = models.find((m) => m.key === currentState.currentModel) || models[0];
						return JSON.stringify({
							current: currentState.currentModel,
							mode: currentState.mode,
							modelName: entry.name,
							expressions: entry.expressions || [],
						});
					},
				}),
			);

			// 3) live2d_list_expressions
			untools.push(
				host.registerAgentTool({
					name: "live2d_list_expressions",
					label: "列出看板娘表情",
					description: "List all available expression names for the active or specified Live2D companion model.",
					promptSnippet: "discover valid emotions for the pet",
					promptGuidelines: ["Call before live2d_play_expression if you need to inspect exact expression names."],
					parameters: {
						type: "object",
						properties: {
							model: {
								type: "string",
								description: "Model key to query. Omit to query the currently active model.",
							},
						},
					},
					async execute(_id, params) {
						const targetKey = params?.model || currentState.currentModel;
						const models = await getAllModels();
						const entry = models.find((m) => m.key === targetKey) || models[0];
						return JSON.stringify({
							model: entry.key,
							expressions: entry.expressions || ["happy", "sad", "angry", "surprised"],
						});
					},
				}),
			);

			// 4) live2d_play_expression
			untools.push(
				host.registerAgentTool({
					name: "live2d_play_expression",
					label: "播放看板娘表情",
					description:
						"Trigger an emotional facial expression on the on-screen Live2D companion (e.g. happy, sad, angry, surprised, blush, wink).",
					promptSnippet: "express emotions through the pet",
					promptGuidelines: ["Use to show excitement, empathy, or concentration when interacting with the user."],
					parameters: {
						type: "object",
						required: ["name"],
						properties: {
							name: {
								type: "string",
								description: "Expression name or alias (happy, sad, angry, surprised, blush, wink, neutral).",
							},
							duration: {
								type: "number",
								description: "Duration in milliseconds before reverting to neutral (default 4000).",
							},
						},
					},
					async execute(_id, params) {
						const name = params?.name || "happy";
						const duration = params?.duration || 4000;
						host.broadcast({
							type: "live2d:action",
							action: "expression",
							name,
							duration,
						});
						return `Live2D pet played expression: ${name}`;
					},
				}),
			);

			// 5) live2d_show_bubble
			untools.push(
				host.registerAgentTool({
					name: "live2d_show_bubble",
					label: "显示气泡对话",
					description:
						"Display a speech bubble dialogue above the on-screen Live2D companion with an optional emotion.",
					promptSnippet: "speak concise dialogue above the pet",
					promptGuidelines: ["Keep messages concise (1-2 sentences) so the speech bubble stays readable."],
					parameters: {
						type: "object",
						required: ["text"],
						properties: {
							text: {
								type: "string",
								description: "The speech text to display in the bubble.",
							},
							expression: {
								type: "string",
								description: "Optional expression to play simultaneously (happy, surprised, wink, etc.).",
							},
							duration: {
								type: "number",
								description: "Duration in milliseconds to keep bubble visible (default 4500).",
							},
						},
					},
					async execute(_id, params) {
						const text = params?.text || "";
						const expression = params?.expression;
						const duration = params?.duration || 4500;
						host.broadcast({
							type: "live2d:action",
							action: "bubble",
							text,
							expression,
							duration,
						});
						return `Live2D pet says: ${text}`;
					},
				}),
			);

			// 6) live2d_switch_mode
			untools.push(
				host.registerAgentTool({
					name: "live2d_switch_mode",
					label: "切换看板娘模式",
					description:
						"Switch the Live2D companion interaction mode between 'mouse' (eye and head follow cursor) and 'idle' (calm breathing).",
					promptSnippet: "toggle pet interaction mode",
					promptGuidelines: ["Only 'mouse' and 'idle' are valid mode values."],
					parameters: {
						type: "object",
						required: ["mode"],
						properties: {
							mode: {
								type: "string",
								enum: ["mouse", "idle"],
								description: "Target mode: 'mouse' or 'idle'.",
							},
						},
					},
					async execute(_id, params) {
						const mode = params?.mode;
						if (mode !== "mouse" && mode !== "idle") {
							return `Invalid mode: ${mode}. Must be 'mouse' or 'idle'.`;
						}
						currentState.mode = mode;
						void saveState();
						host.broadcast({
							type: "live2d:action",
							action: "mode",
							mode,
						});
						return `Live2D pet mode switched to: ${mode}`;
					},
				}),
			);

			// 7) live2d_switch_model
			untools.push(
				host.registerAgentTool({
					name: "live2d_switch_model",
					label: "切换看板娘角色",
					description:
						"Switch the active Live2D companion to another configured model. Use live2d_list_models to find valid keys.",
					promptSnippet: "switch the active Live2D pet",
					promptGuidelines: ["Ensure the model key exists in live2d_list_models."],
					parameters: {
						type: "object",
						required: ["model"],
						properties: {
							model: {
								type: "string",
								description: "Model key to switch to (e.g. 'shizuku', 'haru', 'hiyori', 'wanko').",
							},
						},
					},
					async execute(_id, params) {
						let model = params?.model;
						if (model === "koharu") model = "haru";
						const models = await getAllModels();
						const found = models.find((m) => m.key === model);
						if (!found) {
							return `Model '${model}' not found. Available models: ${models.map((m) => m.key).join(", ")}`;
						}
						currentState.currentModel = model;
						void saveState();
						host.broadcast({
							type: "live2d:action",
							action: "model_switch",
							model,
						});
						return `Live2D model switched to: ${found.name}`;
					},
				}),
			);

			// 8) live2d_play_audio
			untools.push(
				host.registerAgentTool({
					name: "live2d_play_audio",
					label: "播放音乐口型对齐",
					description: "Play music or speech audio with real-time mouth lip sync on the Live2D companion.",
					promptSnippet: "play audio with pet lip-sync",
					promptGuidelines: ["Use an accessible audio URL to play music or speech through the pet."],
					parameters: {
						type: "object",
						required: ["url"],
						properties: {
							url: {
								type: "string",
								description: "Direct audio URL (e.g. mp3/wav/ogg/aac link) or base64 data URI.",
							},
							name: {
								type: "string",
								description: "Optional track name or speech title for display.",
							},
							volume: {
								type: "number",
								description: "Playback volume from 0.0 to 1.0 (default 0.85).",
							},
						},
					},
					async execute(_id, params) {
						const url = params?.url;
						if (!url) return "Error: 'url' parameter is required.";
						const name = params?.name || "";
						const volume = typeof params?.volume === "number" ? params.volume : 0.85;
						host.broadcast({
							type: "live2d:action",
							action: "play_audio",
							url,
							name,
							volume,
						});
						return `Playing audio on Live2D pet with lip sync: ${name || url}`;
					},
				}),
			);

			// 9) live2d_stop_audio
			untools.push(
				host.registerAgentTool({
					name: "live2d_stop_audio",
					label: "停止播放音频",
					description: "Stop currently playing music or audio playback on the Live2D companion.",
					promptSnippet: "stop pet audio playback",
					promptGuidelines: ["Call when user asks to stop playing music or voice on the companion."],
					parameters: {
						type: "object",
						properties: {},
					},
					async execute() {
						host.broadcast({
							type: "live2d:action",
							action: "stop_audio",
						});
						return "Live2D pet audio playback stopped.";
					},
				}),
			);

			// 10) live2d_trigger_blink
			untools.push(
				host.registerAgentTool({
					name: "live2d_trigger_blink",
					label: "看板娘眨眼动作",
					description: "Trigger a cute blinking or winking eye animation on the Live2D companion.",
					promptSnippet: "blink or wink companion eyes",
					promptGuidelines: ["type can be 'both', 'wink_left', or 'wink_right'."],
					parameters: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: ["both", "wink_left", "wink_right"],
								description: "Blink type: 'both' for natural double blink, or 'wink_left'/'wink_right' for winking.",
							},
						},
					},
					async execute(_id, params) {
						const blinkType = params?.type || "both";
						host.broadcast({
							type: "live2d:action",
							action: "blink",
							blinkType,
						});
						return `Live2D pet triggered ${blinkType} eye animation.`;
					},
				}),
			);
		}

		// ── 3. 伴随 AI 会话运行事件的情绪联动 ──────────────────────
		const unevents = [];
		if (typeof host.onRunEvent === "function") {
			const off = host.onRunEvent((event) => {
				const type = event?.type;
				if (type === "run_start") {
					host.broadcast({ type: "live2d:agent-event", status: "thinking" });
				} else if (type === "run_end") {
					const hasError = Boolean(event?.error);
					host.broadcast({ type: "live2d:agent-event", status: hasError ? "error" : "done" });
				}
			});
			unevents.push(off);
		}

		// ── 4. 监听宿主插件配置变更 ──────────────────────────────────
		const unset = [];
		if (typeof host.onSettingsChanged === "function") {
			const off = host.onSettingsChanged((settings) => {
				host.broadcast({ type: "live2d:settings-updated", settings });
			});
			unset.push(off);
		}

		host.log("Live2D 看板娘插件已成功激活");

		return () => {
			for (const u of unroutes) {
				try {
					u();
				} catch {}
			}
			for (const u of untools) {
				try {
					u();
				} catch {}
			}
			for (const u of unevents) {
				try {
					u();
				} catch {}
			}
			for (const u of unset) {
				try {
					u();
				} catch {}
			}
		};
	},
};
