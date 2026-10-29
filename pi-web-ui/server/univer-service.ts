/**
 * Univer 真实渲染守护服务 —— 管理本地 Univer Gateway 子进程，
 * 为 PPTX / XLSX / DOCX 提供 1:1 原生 Canvas 渲染与在线交互。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

export interface UniverDocInfo {
	univerPath: string;
	unitId: string;
	viewerUrl: string;
	fileKey: string;
	unitType: number;
	format: string;
}

export function getOfficeUnitTypeAndFormat(extOrPath: string): { unitType: number; format: string } {
	const ext = extname(extOrPath).toLowerCase();
	switch (ext) {
		case ".xlsx":
		case ".xlsm":
		case ".xls":
			return { unitType: 2, format: "xlsx" };
		case ".docx":
		case ".doc":
			return { unitType: 1, format: "docx" };
		case ".pptx":
		case ".pptm":
		case ".ppsx":
		case ".potx":
		case ".ppt":
			return { unitType: 3, format: "pptx" };
		case ".csv":
			return { unitType: 2, format: "csv" };
		case ".tsv":
			return { unitType: 2, format: "tsv" };
		default:
			return { unitType: 2, format: "xlsx" };
	}
}

export class UniverService {
	private port = 9520;
	private proc: ChildProcess | null = null;
	private cache = new Map<string, UniverDocInfo>();
	private cacheDir = join(tmpdir(), "pi-univer-cache");
	private starting: Promise<void> | null = null;
	private ready = false;
	private gatewayEntry: string | null = null;
	private workerEntry: string | null = null;
	private nodeModules: string | null = null;

	private async getFreePort(start = 9520): Promise<number> {
		return new Promise((resolvePort) => {
			const s = createServer();
			s.listen(start, "127.0.0.1", () => {
				const port = (s.address() as { port: number }).port;
				s.close(() => resolvePort(port));
			});
			s.on("error", () => resolvePort(this.getFreePort(start + 1)));
		});
	}

	private async waitForGateway(origin: string, timeoutMs = 15000): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const r = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) });
				if (r.ok) return true;
			} catch {}
			await new Promise((r) => setTimeout(r, 200));
		}
		return false;
	}

	public async ensureStarted(): Promise<boolean> {
		if (this.ready) return true;
		if (this.starting) {
			await this.starting;
			return this.ready;
		}

		this.starting = (async () => {
			try {
				mkdirSync(this.cacheDir, { recursive: true });

				// 资产路径：优先用户数据目录 (~/.pi-web/plugins/office)，回落开发源码目录
				const dataDir = process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web");
				const candidateBases = [
					join(dataDir, "plugins", "office"),
					join(REPO_ROOT, "plugins", "office"),
					join(REPO_ROOT, "..", "plugins", "office"),
				];

				let baseDir = "";
				for (const cand of candidateBases) {
					if (existsSync(join(cand, "artifacts", "gateway.cjs"))) {
						baseDir = cand;
						break;
					}
				}

				if (!baseDir) {
					console.warn("[univer-service] 未找到 Univer Gateway 运行时资产 (artifacts/gateway.cjs)");
					this.ready = false;
					return;
				}

				const gatewayEntry = join(baseDir, "artifacts", "gateway.cjs");
				const viewerRoot = join(baseDir, "artifacts", "viewer");
				const nodeModules = join(baseDir, "node_modules");
				const workerEntry = join(baseDir, "artifacts", "unit-content-worker.mjs");

				this.gatewayEntry = gatewayEntry;
				this.workerEntry = existsSync(workerEntry) ? workerEntry : null;
				this.nodeModules = existsSync(nodeModules) ? nodeModules : null;

				this.port = await this.getFreePort();
				const origin = `http://127.0.0.1:${this.port}`;

				const childEnv = {
					...process.env,
					UNIVER_COLLAB_GATEWAY_PORT: String(this.port),
					UNIVER_VIEW_ASSETS_ROOT: viewerRoot,
					NODE_PATH: [nodeModules, process.env.NODE_PATH].filter(Boolean).join(";"),
				};

				this.proc = spawn(process.execPath, [gatewayEntry], {
					env: childEnv,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});

				this.proc.stderr?.on("data", () => {
					// 调试级别
				});

				const ok = await this.waitForGateway(origin);
				if (ok) {
					this.ready = true;
					console.log(`[univer-service] Univer 原生画布渲染网关已启动: ${origin}`);
				} else {
					console.warn(`[univer-service] Univer Gateway 启动超时 (port: ${this.port})`);
					this.stop();
				}
			} catch (err) {
				console.error("[univer-service] 启动 Univer Gateway 失败:", err);
				this.stop();
			} finally {
				this.starting = null;
			}
		})();

		await this.starting;
		return this.ready;
	}

	public async openDocument(absPath: string): Promise<UniverDocInfo> {
		const ok = await this.ensureStarted();
		if (!ok) throw new Error("Univer 渲染网关尚未就绪");

		const st = statSync(absPath);
		const cacheKey = `${absPath}:${st.mtimeMs}`;
		if (this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey)!;
		}

		const base = `http://127.0.0.1:${this.port}`;
		const fileName = basename(absPath);
		const hash = Buffer.from(absPath).toString("hex").slice(0, 16);
		const univerPath = join(this.cacheDir, `doc_${hash}.univer`);

		try {
			unlinkSync(univerPath);
		} catch {}

		const fileKey = Buffer.from(univerPath, "utf8").toString("base64url");
		await fetch(`${base}/uf/${fileKey}`, { method: "POST" });

		const fileBuf = readFileSync(absPath);
		const boundary = `----UniverUpload${Date.now()}`;
		const body = Buffer.concat([
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
			),
			fileBuf,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]);

		const uRes = await fetch(`${base}/uf/${fileKey}/universer-api/stream/file/upload?source=1&size=${fileBuf.length}`, {
			method: "POST",
			headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
			body,
		});
		const uData = (await uRes.json()) as { FileId?: string; fileID?: string };
		const fileID = uData.FileId || uData.fileID;
		if (!fileID) throw new Error("上传文件至 Univer 转换网关失败");

		const iRes = await fetch(`${base}/uf/${fileKey}/universer-api/exchange/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileID, outputType: 1 }),
		});
		const iData = (await iRes.json()) as { taskID: string };
		const taskID = iData.taskID;

		let unitID: string | null = null;
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 120));
			const tRes = await fetch(`${base}/uf/${fileKey}/universer-api/exchange/task/${taskID}`);
			const tData = (await tRes.json()) as {
				status: string;
				import?: { unitID?: string };
				result?: { unitID?: string };
			};
			if (tData.status === "done") {
				unitID = tData.import?.unitID || tData.result?.unitID || null;
				break;
			}
		}

		if (!unitID) {
			const unitsRes = await fetch(`${base}/uf/${fileKey}/units`);
			const unitsData = (await unitsRes.json()) as { units?: Array<{ unitId: string }> };
			unitID = unitsData.units?.[0]?.unitId || null;
		}

		if (!unitID) throw new Error("Univer 转换未生成有效单元");

		const { unitType, format } = getOfficeUnitTypeAndFormat(absPath);
		const result: UniverDocInfo = {
			univerPath,
			unitId: unitID,
			viewerUrl: `${base}/?file=${encodeURIComponent(univerPath)}&unit=${encodeURIComponent(unitID)}`,
			fileKey,
			unitType,
			format,
		};

		this.cache.set(cacheKey, result);
		return result;
	}

	/**
	 * 将指定 Office 文件的 Univer 状态导出并安全写回原文件（或目标路径）。
	 */
	public async saveDocument(
		absPath: string,
		targetPath?: string,
	): Promise<{ ok: boolean; path: string; size: number }> {
		const doc = await this.openDocument(absPath);
		const base = `http://127.0.0.1:${this.port}`;

		// 1. 发起导出任务
		const expRes = await fetch(`${base}/uf/${doc.fileKey}/universer-api/exchange/${doc.unitType}/export`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ unitID: doc.unitId, format: doc.format }),
		});
		const expData = (await expRes.json()) as { error?: { code: number; message: string }; taskID?: string };
		if (!expData.taskID) {
			throw new Error(`Univer 导出任务创建失败: ${expData.error?.message || "未知原因"}`);
		}

		// 2. 轮询导出完成
		let expFileId: string | null = null;
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 120));
			const tRes = await fetch(`${base}/uf/${doc.fileKey}/universer-api/exchange/task/${expData.taskID}`);
			const tData = (await tRes.json()) as {
				status: string;
				export?: { fileID?: string };
				result?: { fileID?: string };
				error?: { message?: string };
			};
			if (tData.status === "done") {
				expFileId = tData.export?.fileID || tData.result?.fileID || null;
				break;
			}
			if (tData.status === "failed") {
				throw new Error(`Univer 导出失败: ${tData.error?.message || "未知错误"}`);
			}
		}

		if (!expFileId) {
			throw new Error("Univer 导出超时未生成文件");
		}

		// 3. 下载导出内容
		const dlRes = await fetch(`${base}/uf/${doc.fileKey}/universer-api/file/${expFileId}/content`);
		if (!dlRes.ok) {
			throw new Error(`下载 Univer 导出文件失败: HTTP ${dlRes.status}`);
		}
		const buf = Buffer.from(await dlRes.arrayBuffer());

		// 4. 原子写回目标路径
		const outPath = targetPath ? resolve(targetPath) : absPath;
		const tmpOut = `${outPath}.${Date.now()}.tmp`;
		writeFileSync(tmpOut, buf);
		renameSync(tmpOut, outPath);

		// 更新 mtime 缓存 key
		try {
			const newSt = statSync(outPath);
			this.cache.set(`${absPath}:${newSt.mtimeMs}`, doc);
		} catch {}

		return { ok: true, path: outPath, size: buf.length };
	}

	/** 在独立进程中执行 Univer Worker 请求 */
	private async runWorker(payload: Record<string, unknown>, timeoutMs = 20000): Promise<any> {
		if (!this.workerEntry || !existsSync(this.workerEntry)) {
			throw new Error("Univer unit-content-worker 资产不存在");
		}
		return new Promise((resolveResult, reject) => {
			const wp = spawn(process.execPath, [this.workerEntry!], {
				env: {
					...process.env,
					NODE_PATH: [this.nodeModules, process.env.NODE_PATH].filter(Boolean).join(";"),
				},
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			let out = "";
			let err = "";
			const timer = setTimeout(() => {
				try {
					wp.kill();
				} catch {}
				reject(new Error(`Univer Worker 执行超时 (${timeoutMs}ms)`));
			}, timeoutMs);

			wp.stdout?.on("data", (d) => (out += String(d)));
			wp.stderr?.on("data", (d) => (err += String(d)));
			wp.on("close", (code) => {
				clearTimeout(timer);
				try {
					const res = JSON.parse(out);
					if (res.ok) resolveResult(res.result);
					else reject(new Error(res.error?.message || `Worker 失败 (code ${code}): ${err}`));
				} catch {
					reject(new Error(`Worker 解析失败 (code ${code}): ${out} ${err}`));
				}
			});
			wp.stdin?.write(JSON.stringify(payload));
			wp.stdin?.end();
		});
	}

	/** 结构化检查文档（查询工作簿工作表列表、行列统计、使用区域等） */
	public async inspectDocument(absPath: string, query?: Record<string, unknown>): Promise<any> {
		const doc = await this.openDocument(absPath);
		const defaultKind = doc.unitType === 2 ? "workbook" : doc.unitType === 1 ? "document" : "presentation";

		return await this.runWorker({
			operation: "inspect",
			gatewayOrigin: `http://127.0.0.1:${this.port}`,
			commitTimeoutMs: 10000,
			fileKey: doc.fileKey,
			filePath: doc.univerPath,
			unitId: doc.unitId,
			unitType: doc.unitType,
			query: query || { kind: defaultKind },
		});
	}

	/** 读取 Excel 工作表指定范围的值与排版 */
	public async readSheetRange(absPath: string, params: { sheet?: string; range: string }): Promise<any> {
		const query: Record<string, unknown> = {
			kind: "worksheet-range",
			ranges: [
				{
					range: params.range,
					worksheet: params.sheet ? { name: params.sheet } : { index: 0 },
				},
			],
		};
		const result = await this.inspectDocument(absPath, query);
		const r = result?.ranges?.[0];
		return {
			sheet: r?.worksheet?.name || params.sheet || "Sheet1",
			range: r?.resolvedRange || params.range,
			values: r?.displayValues || [],
			cellData: r?.cellData || [],
		};
	}

	/**
	 * 在独立协作分支上执行自定义 Univer Facade JS 脚本，并在合并后自动导出写回磁盘。
	 */
	public async executeOnDocument(
		absPath: string,
		code: string,
		options?: { autoSave?: boolean; targetPath?: string },
	): Promise<{ ok: boolean; revision: number; value: any; saved?: boolean; outPath?: string }> {
		const doc = await this.openDocument(absPath);
		const base = `http://127.0.0.1:${this.port}`;

		// 1. 创建协作 worktree
		const wtRes = await fetch(`${base}/uf/${doc.fileKey}/worktrees`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: "pi-agent", name: `edit-${Date.now()}` }),
		});
		const wtData = (await wtRes.json()) as { worktreeId: string };
		const worktreeId = wtData.worktreeId;
		if (!worktreeId) throw new Error("无法在 Univer Gateway 创建协作分支");

		try {
			// 2. 执行 Worker
			const execResult = await this.runWorker({
				operation: "execute",
				gatewayOrigin: base,
				commitTimeoutMs: 15000,
				fileKey: doc.fileKey,
				filePath: doc.univerPath,
				unitId: doc.unitId,
				unitType: doc.unitType,
				worktreeId,
				code,
			});

			// 若没有变动直接 discard
			if (execResult?.committed === false) {
				try {
					await fetch(`${base}/uf/${doc.fileKey}/worktrees/${worktreeId}/discard`, { method: "POST" });
				} catch {}
				return {
					ok: true,
					revision: 0,
					value: execResult?.value ?? null,
					saved: false,
				};
			}

			// 3. 标记 ready 并 merge
			await fetch(`${base}/uf/${doc.fileKey}/worktrees/${worktreeId}/ready`, { method: "POST" });
			const mergeRes = await fetch(`${base}/uf/${doc.fileKey}/worktrees/${worktreeId}/merge`, { method: "POST" });
			const mergeData = (await mergeRes.json()) as { ok?: boolean; error?: { message?: string } };
			if (!mergeData.ok) {
				throw new Error(`Univer 分支合并失败: ${mergeData.error?.message || "未知原因"}`);
			}

			let saved = false;
			let outPath: string | undefined;
			if (options?.autoSave !== false) {
				const saveRes = await this.saveDocument(absPath, options?.targetPath);
				saved = saveRes.ok;
				outPath = saveRes.path;
			}

			return {
				ok: true,
				revision: execResult?.revision ?? 0,
				value: execResult?.value ?? null,
				saved,
				outPath,
			};
		} catch (err) {
			try {
				await fetch(`${base}/uf/${doc.fileKey}/worktrees/${worktreeId}/discard`, { method: "POST" });
			} catch {}
			throw err;
		}
	}

	/**
	 * 便捷结构化更新工作表：增减工作表、设置范围数据并保存。
	 */
	public async editSheetRange(
		absPath: string,
		params: {
			sheet?: string;
			range?: string;
			values?: any[][];
			addSheet?: string;
			autoSave?: boolean;
			targetPath?: string;
		},
	): Promise<{ ok: boolean; revision: number; value: any; saved?: boolean; outPath?: string }> {
		const lines: string[] = [];
		if (params.addSheet) {
			lines.push(`workbook.create(${JSON.stringify(params.addSheet)}, 100, 26);`);
		}
		const sheetSelector = params.sheet
			? `workbook.getSheetByName(${JSON.stringify(params.sheet)})`
			: `workbook.getActiveSheet()`;
		lines.push(`const targetSheet = ${sheetSelector};`);
		lines.push(
			`if (!targetSheet) throw new Error("Worksheet not found: " + ${JSON.stringify(params.sheet || "(active)")});`,
		);

		if (params.range && params.values && params.values.length > 0) {
			lines.push(`const r = targetSheet.getRange(${JSON.stringify(params.range)});`);
			lines.push(`r.setValues(${JSON.stringify(params.values)});`);
		}

		return await this.executeOnDocument(absPath, lines.join("\n"), {
			autoSave: params.autoSave,
			targetPath: params.targetPath,
		});
	}

	public stop(): void {
		this.ready = false;
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {}
			this.proc = null;
		}
	}
}

export const univerService = new UniverService();
