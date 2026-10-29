// Settings feature — protocol smoke test (no model calls).
//
// Verifies the full wire path for the settings panel: settings_state pushed on
// attach / get_settings / set_settings (prompt append+replace, skill and
// extension toggles) / save_preset / apply_preset / delete_preset, plus
// per-client persistence across a reconnect.
//
// Runs against the compiled server on a dedicated port (8931). With an
// isolated fake agent dir (PI_CODING_AGENT_DIR → temp) it exercises the
// protocol only; point it at a real agent dir to also exercise the
// skill/extension toggle round-trip (see settings-live flow in git history).
// Usage: npm run build && node settings-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.argv[2] || 8931);
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-web-set-test-"));
console.log("data-dir:", DATA_DIR);

const server = spawn(process.execPath, ["dist/server/index.js"], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_WEB_CWD: process.cwd(),
		PI_CODING_AGENT_DIR: join(DATA_DIR, "agent"),
		// 预设分享：分享关掉（绝不真在共享仓库开 Issue），目录指向回环地址
		// （被 SSRF 收口拦下）——两条都是确定性的离线断言，见文末预设分享段。
		PI_WEB_PRESET_REPO: "0",
		PI_WEB_PRESET_CATALOG_URL: "https://127.0.0.1/index.json",
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on("data", (d) => process.stdout.write(`[srv-err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		ws.on("message", (d) => this.received.push(JSON.parse(d.toString())));
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Wait for a message; optional predicate. `type` may be an array of
	 *  acceptable types (snapshot OR snapshot_delta — incremental snapshots
	 *  mean post-action checkpoints often arrive as deltas). A set_settings
	 *  pushes settings_state twice (immediately + after the reload), so stale
	 *  duplicates are consumed while scanning. */
	async waitFor(type, timeout = 8000, pred) {
		const start = Date.now();
		const types = Array.isArray(type) ? type : [type];
		while (Date.now() - start < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const m = this.received[i];
				if (!types.includes(m.type)) continue;
				this.received.splice(i, 1);
				if (!pred || pred(m)) return m;
				i--;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
}

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((res, rej) => {
				ws.on("open", res);
				ws.on("error", rej);
			});
			return new Client(ws);
		} catch {
			await sleep(500);
		}
	}
	throw new Error("server not ready");
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

let c;
try {
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st0 = await c.waitFor("settings_state");
	check("settings_state pushed on attach", !!st0.settings);
	check("has skills array", Array.isArray(st0.settings.skills));
	check("has extensions array", Array.isArray(st0.settings.extensions));
	check("has presets array", Array.isArray(st0.settings.presets));
	check(
		"settings_state carries compose template + overrides (default empty)",
		typeof st0.settings.promptTemplate === "string" &&
			st0.settings.promptTemplate === "" &&
			typeof st0.settings.promptOverrides === "object" &&
			typeof st0.settings.promptSourceDefaults === "object" &&
			typeof st0.settings.effectiveSystemPrompt === "string" &&
			typeof st0.settings.visionBridgeDefaultPrompt === "string" &&
			st0.settings.visionBridgeDefaultPrompt.length > 0,
	);
	console.log(`  skills=${st0.settings.skills.length} extensions=${st0.settings.extensions.length}`);

	c.send({ type: "get_settings" });
	const st1 = await c.waitFor("settings_state");
	check("get_settings echoes state", typeof st1.settings.promptTemplate === "string");

	// compose 模板 + 单来源覆盖持久化，然后存为预设
	const SAVED_TEMPLATE = "{{soul}}\n\n我的固定开场。\n\n{{context}}";
	const SAVED_SOUL = "你是降世神龙，专精代码重构。";
	c.send({ type: "set_settings", promptTemplate: SAVED_TEMPLATE });
	const st2 = await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === SAVED_TEMPLATE);
	check("compose template persisted", st2.settings.promptTemplate === SAVED_TEMPLATE);
	const stEff = await c.waitFor("settings_state", 10000, (m) =>
		(m.settings.effectiveSystemPrompt ?? "").includes("我的固定开场。"),
	);
	check(
		"effective prompt = compose render（只拼模板里的 token）",
		stEff.settings.effectiveSystemPrompt.includes("我的固定开场。") &&
			stEff.settings.effectiveSystemPrompt.includes("<project_context>") &&
			stEff.settings.effectiveSystemPrompt.includes("You are an expert coding assistant") &&
			!stEff.settings.effectiveSystemPrompt.includes("Available tools:") &&
			!stEff.settings.effectiveSystemPrompt.includes("{{soul}}") &&
			!stEff.settings.effectiveSystemPrompt.includes("{{context}}"),
	);
	const dflt = stEff.settings.promptSourceDefaults ?? {};
	check(
		"promptSourceDefaults = per-source auto text（soul/cwd 等未覆盖时展开值）",
		typeof dflt === "object" &&
			typeof dflt.soul === "string" &&
			dflt.soul.includes("You are an expert coding assistant") &&
			typeof dflt.cwd === "string" &&
			dflt.cwd.startsWith("Current working directory:"),
	);
	c.send({ type: "set_settings", promptOverrides: { soul: SAVED_SOUL } });
	const stOv = await c.waitFor("settings_state", 8000, (m) => m.settings.promptOverrides?.soul === SAVED_SOUL);
	check("per-source override persisted", stOv.settings.promptOverrides?.soul === SAVED_SOUL);
	const stEff2 = await c.waitFor("settings_state", 10000, (m) =>
		(m.settings.effectiveSystemPrompt ?? "").includes(SAVED_SOUL),
	);
	check(
		"override 替换灵魂段生效",
		stEff2.settings.effectiveSystemPrompt.includes(SAVED_SOUL) &&
			!stEff2.settings.effectiveSystemPrompt.includes("You are an expert coding assistant"),
	);

	// 预设捕获终端工具开关：保存前显式设为开，应用预设时（当前已关）应恢复为开
	c.send({ type: "set_settings", terminalToolsEnabled: true });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === true);

	c.send({ type: "save_preset", name: "测试预设" });
	const st6 = await c.waitFor("settings_state", 8000, (m) => m.settings.presets.some((p) => p.name === "测试预设"));
	check(
		"preset saved",
		st6.settings.presets.some((p) => p.name === "测试预设"),
	);

	// 覆盖清空 = 恢复自动内容
	c.send({ type: "set_settings", promptOverrides: { soul: "" } });
	const stOv2 = await c.waitFor("settings_state", 8000, (m) => !("soul" in (m.settings.promptOverrides ?? {})));
	check("override cleared when sent empty", !("soul" in stOv2.settings.promptOverrides));
	// 恢复默认模板
	c.send({ type: "set_settings", promptTemplate: "" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === "");

	// terminal tools toggle：默认关 → 开 → 关 → 重连后仍记住；预设捕获该开关（保存前已显式设开）
	check("terminalToolsEnabled defaults off", st0.settings.terminalToolsEnabled === false);
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	const stT = await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);
	check("terminalToolsEnabled off persisted", stT.settings.terminalToolsEnabled === false);
	// 终端接管 bash：开关 + 阈值往返（回归：dispatch 曾漏转发导致点击无效）
	check("terminalBash defaults off", st0.settings.terminalBash === false);
	check("terminalBashIdleMs defaults 15000", st0.settings.terminalBashIdleMs === 15000);
	check("terminalBashMaxForegroundMs defaults 60000", st0.settings.terminalBashMaxForegroundMs === 60000);
	c.send({ type: "set_settings", terminalBash: true, terminalBashIdleMs: 5000, terminalBashMaxForegroundMs: 30000 });
	const stTB = await c.waitFor("settings_state", 8000, (m) => m.settings.terminalBash === true);
	check("terminalBash on round-trips", stTB.settings.terminalBash === true);
	check("terminalBashIdleMs round-trips", stTB.settings.terminalBashIdleMs === 5000);
	check("terminalBashMaxForegroundMs round-trips", stTB.settings.terminalBashMaxForegroundMs === 30000);
	c.send({ type: "set_settings", terminalBash: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptMode === "append");
	// 思考折叠开关：默认关（折叠）→ 开 → 再关（纯 UI 偏好，持久化即可）
	check("thinkingWrap defaults off", st0.settings.thinkingWrap === false);
	c.send({ type: "set_settings", thinkingWrap: false });
	const stTW = await c.waitFor("settings_state", 8000, (m) => m.settings.thinkingWrap === false);
	check("thinkingWrap off round-trips", stTW.settings.thinkingWrap === false);
	c.send({ type: "set_settings", thinkingWrap: true });
	await c.waitFor("settings_state", 8000, (m) => m.settings.thinkingWrap === true);

	// 保留已结束的运行对话（切走时不释放 runtime，手动 ✕ 才移出）：默认关 → 开 → 再关
	// （回归：dispatch 白名单漏转发该字段 → 点开关不落盘、刷新回退，同 terminalBash 那次）
	check("retainFinishedConversations defaults off", st0.settings.retainFinishedConversations === false);
	c.send({ type: "set_settings", retainFinishedConversations: true });
	const stRF = await c.waitFor("settings_state", 8000, (m) => m.settings.retainFinishedConversations === true);
	check("retainFinishedConversations on round-trips", stRF.settings.retainFinishedConversations === true);
	c.send({ type: "set_settings", retainFinishedConversations: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.retainFinishedConversations === false);

	// skill toggle
	const skillName = st0.settings.skills[0]?.name;
	if (skillName) {
		c.send({ type: "set_settings", disabledSkills: [skillName] });
		const st3 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledSkills.includes(skillName));
		check("skill disabled", st3.settings.disabledSkills.includes(skillName));
		const s = st3.settings.skills.find((x) => x.name === skillName);
		check("disabled skill still listed (re-enableable)", s && !s.enabled);
		c.send({ type: "set_settings", disabledSkills: [] });
		const st4 = await c.waitFor(
			"settings_state",
			8000,
			(m) =>
				m.settings.disabledSkills.length === 0 && m.settings.skills.find((x) => x.name === skillName)?.enabled === true,
		);
		check("skill re-enabled", st4.settings.skills.find((x) => x.name === skillName)?.enabled === true);
	} else {
		console.log("  (no skills loaded — skipping)");
	}

	// extension toggle
	const extId = st0.settings.extensions[0]?.id;
	if (extId) {
		c.send({ type: "set_settings", disabledExtensions: [extId] });
		const st5 = await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.includes(extId));
		check("extension disabled", st5.settings.disabledExtensions.includes(extId));
		const e = st5.settings.extensions.find((x) => x.id === extId);
		check("disabled extension still listed", e && !e.enabled);
		c.send({ type: "set_settings", disabledExtensions: [] });
		await c.waitFor("settings_state", 8000, (m) => m.settings.disabledExtensions.length === 0);
		check("extension re-enabled", true);
	} else {
		console.log("  (no extensions loaded — skipping)");
	}

	// apply preset → 恢复保存时的 compose 模板 + 覆盖
	c.send({ type: "set_settings", promptTemplate: "临时模板 {{cwd}}" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === "临时模板 {{cwd}}");
	c.send({ type: "apply_preset", name: "测试预设" });
	const st7 = await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.promptTemplate === SAVED_TEMPLATE && m.settings.promptOverrides?.soul === SAVED_SOUL,
	);
	check("preset applied (template restored)", st7.settings.promptTemplate === SAVED_TEMPLATE);
	check("preset applied (override restored)", st7.settings.promptOverrides?.soul === SAVED_SOUL);
	// 预设保存时开关是开 → 应用预设把它恢复为 true（验证预设捕获该开关）
	check("preset applied (terminal toggle restored to captured value)", st7.settings.terminalToolsEnabled === true);

	c.send({ type: "delete_preset", name: "测试预设" });
	const st8 = await c.waitFor("settings_state", 8000, (m) => !m.settings.presets.some((p) => p.name === "测试预设"));
	check("preset deleted", !st8.settings.presets.some((p) => p.name === "测试预设"));

	/* ---- 预设分享（server/preset-share.ts）：导出 / 导入 / 网址导入 / 分享 / 目录 ---- */
	// 先摆一个有辨识度的状态（模板 + 单来源覆盖），导出→改掉→导入应用，验证真往返。
	const EXPORT_TEMPLATE = "导出用模板 {{cwd}}";
	c.send({ type: "set_settings", promptTemplate: EXPORT_TEMPLATE, promptOverrides: { soul: SAVED_SOUL } });
	await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.promptTemplate === EXPORT_TEMPLATE && m.settings.promptOverrides?.soul === SAVED_SOUL,
	);
	c.send({ type: "preset_export", source: "current", requestId: "ex1" });
	const ex1 = await c.waitFor("preset_export_result", 8000, (m) => m.requestId === "ex1");
	check("preset_export ok", ex1.ok === true && typeof ex1.json === "string" && ex1.json.length > 0);
	check("preset_export file name", /^[a-z0-9-]+-[0-9a-f]{7}\.json$/.test(String(ex1.fileName)));
	const exportDoc = JSON.parse(ex1.json);
	check(
		"export doc shape (format/version/settings)",
		exportDoc.format === "pi-web-ui-preset" &&
			exportDoc.version === 1 &&
			typeof exportDoc.settings === "object" &&
			exportDoc.settings.promptTemplate === EXPORT_TEMPLATE &&
			exportDoc.settings.promptOverrides?.soul === SAVED_SOUL,
	);
	check("export doc carries no name inside settings", !("name" in exportDoc.settings));
	// 全量预设：以前不进预设的字段现在也在（工具开关/文案、界面偏好、专用提示词）
	check(
		"export doc 带全量字段（含以前排除的运行开关与 UI 偏好）",
		typeof exportDoc.settings.toolLazyLoading === "boolean" &&
			typeof exportDoc.settings.readDirEnabled === "boolean" &&
			typeof exportDoc.settings.toolPromptOverrides === "object" &&
			typeof exportDoc.settings.uiLayout === "object" &&
			typeof exportDoc.settings.thinkingWrap === "boolean",
	);

	// dryRun 预览：只回预览，不落盘（随后真导入时才出现在 presets 里）
	c.send({ type: "preset_import", json: ex1.json, dryRun: true, requestId: "im1" });
	const im1 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im1");
	check(
		"preset_import dryRun preview",
		im1.ok === true && im1.dryRun === true && Array.isArray(im1.preview?.fields) && im1.preview.fields.length > 0,
	);
	check("preview reports no replace for a fresh name", im1.preview?.replaces === false);

	// 真导入（改名 + 立即应用）：先改掉当前设置，导入后应被预设值恢复
	c.send({ type: "set_settings", promptTemplate: "被导入覆盖掉的模板" });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === "被导入覆盖掉的模板");
	c.send({ type: "preset_import", json: ex1.json, name: "导入的预设", apply: true, requestId: "im2" });
	const im2 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im2");
	check("preset_import saved", im2.ok === true && im2.dryRun === false && im2.preview?.name === "导入的预设");
	const stImp = await c.waitFor(
		"settings_state",
		8000,
		(m) => m.settings.presets.some((p) => p.name === "导入的预设") && m.settings.promptTemplate === EXPORT_TEMPLATE,
	);
	check(
		"imported preset listed",
		stImp.settings.presets.some((p) => p.name === "导入的预设"),
	);
	check("import with apply restored the exported template", stImp.settings.promptTemplate === EXPORT_TEMPLATE);
	check("import with apply restored the exported override", stImp.settings.promptOverrides?.soul === SAVED_SOUL);

	// 净化：未知字段忽略、类型不符丢弃（预览里明说）
	c.send({
		type: "preset_import",
		json: JSON.stringify({
			format: "pi-web-ui-preset",
			version: 1,
			name: "净化测试",
			settings: { customSystemPrompt: "ok", evil: { a: 1 }, disabledSkills: "nope" },
		}),
		dryRun: true,
		requestId: "im3",
	});
	const im3 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im3");
	check("unknown fields reported as ignored", im3.preview?.ignored?.includes("evil") === true);
	check("wrong-typed field reported as rejected", im3.preview?.rejected?.includes("disabledSkills") === true);
	check("whitelisted field survives sanitizing", im3.preview?.customSystemPrompt === "ok");

	// 可选导入：只带一部分字段 → 落盘预设里只有那些字段（未勾选的保持当前值）
	c.send({
		type: "preset_import",
		json: JSON.stringify({
			format: "pi-web-ui-preset",
			version: 1,
			name: "部分导入",
			settings: { customSystemPrompt: "partial-only", disabledSkills: ["s1"] },
		}),
		fields: ["customSystemPrompt"],
		requestId: "im3b",
	});
	const im3b = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im3b");
	check("可选导入回执只列实际写入的字段", im3b.ok === true && im3b.preview?.fields?.join(",") === "customSystemPrompt");
	// 一个都没勾 → 拒写
	c.send({
		type: "preset_import",
		json: JSON.stringify({
			format: "pi-web-ui-preset",
			version: 1,
			name: "空选",
			settings: { customSystemPrompt: "x" },
		}),
		fields: [],
		requestId: "im3c",
	});
	const im3c = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im3c");
	check("一个字段都没勾时拒绝导入", im3c.ok === false && typeof im3c.error === "string");

	// 坏文档：错误回执带 error（不抛、不改设置）
	c.send({ type: "preset_import", json: "{oops", requestId: "im4" });
	const im4 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im4");
	check("bad JSON returns ok:false + error", im4.ok === false && typeof im4.error === "string");

	// 网址导入：内网/回环地址被 SSRF 收口拦下（不抓取）
	c.send({ type: "preset_import_url", url: "http://127.0.0.1/preset.json", requestId: "im5" });
	const im5 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im5");
	check("url import blocks loopback hosts", im5.ok === false && typeof im5.error === "string");
	c.send({ type: "preset_import_url", url: "file:///etc/passwd", requestId: "im6" });
	const im6 = await c.waitFor("preset_import_result", 8000, (m) => m.requestId === "im6");
	check("url import rejects non-http schemes", im6.ok === false);

	// 分享：本测试环境显式关掉（PI_WEB_PRESET_REPO=0）→ 明确拒绝但 json 仍然回传
	c.send({ type: "preset_share", name: "导入的预设", requestId: "sh1" });
	const sh1 = await c.waitFor("preset_share_result", 8000, (m) => m.requestId === "sh1");
	check("share disabled by env returns ok:false", sh1.ok === false && typeof sh1.error === "string");
	check("share still returns the JSON for manual sharing", typeof sh1.json === "string" && sh1.json.length > 0);

	// 目录：地址被收口拦下 → ok:false（形状必须仍然完整，前端靠 entries 展示）
	c.send({ type: "preset_catalog", requestId: "ct1" });
	const ct1 = await c.waitFor("preset_catalog_result", 10000, (m) => m.requestId === "ct1");
	check(
		"catalog result shape",
		Array.isArray(ct1.entries) && typeof ct1.source === "string" && typeof ct1.cached === "boolean",
	);
	check("catalog refuses a loopback source", ct1.ok === false && typeof ct1.error === "string");

	// 收尾：删掉导入的预设，并把模板恢复为后面的重连断言期待的值
	c.send({ type: "delete_preset", name: "导入的预设" });
	await c.waitFor("settings_state", 8000, (m) => !m.settings.presets.some((p) => p.name === "导入的预设"));
	c.send({ type: "set_settings", promptTemplate: SAVED_TEMPLATE });
	await c.waitFor("settings_state", 8000, (m) => m.settings.promptTemplate === SAVED_TEMPLATE);

	// keepRecentMessages（消息折叠窗口）：set_settings 在 index.ts 里逐字段转发，
	// 漏转发会导致面板改了、重开又变回去——这里整段做 wire 往返 + 钳制 + 重连持久化
	c.send({ type: "set_settings", keepRecentMessages: 9999 });
	const stK = await c.waitFor("settings_state", 8000, (m) => m.settings.keepRecentMessages === 100);
	check("keepRecentMessages clamped to 100 over the wire", stK.settings.keepRecentMessages === 100);
	c.send({ type: "set_settings", keepRecentMessages: 45 });
	await c.waitFor("settings_state", 8000, (m) => m.settings.keepRecentMessages === 45);

	// persistence across reconnect：重新关掉终端工具再断线，重连后应记住
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);
	c.ws.close();
	await sleep(300);
	c = await connect();
	c.send({ type: "hello", clientId: "settings-test-client" });
	await c.waitFor("ready");
	await c.waitFor(["snapshot", "snapshot_delta"]);
	const st9 = await c.waitFor("settings_state");
	check("compose template survives reconnect", st9.settings.promptTemplate === SAVED_TEMPLATE);
	check("override survives reconnect", st9.settings.promptOverrides?.soul === SAVED_SOUL);
	check("terminalToolsEnabled survives reconnect (off)", st9.settings.terminalToolsEnabled === false);
	check("keepRecentMessages survives reconnect", st9.settings.keepRecentMessages === 45);
	// 恢复默认，别影响后续断言
	c.send({ type: "set_settings", keepRecentMessages: 15 });
	await c.waitFor("settings_state", 8000, (m) => m.settings.keepRecentMessages === 15);
	// 恢复默认关，避免影响后续断言
	c.send({ type: "set_settings", terminalToolsEnabled: false });
	await c.waitFor("settings_state", 8000, (m) => m.settings.terminalToolsEnabled === false);

	// extensions_reload：外部变更（如终端里 pi remove 完成）后重发现扩展
	c.send({ type: "extensions_reload" });
	await c.waitFor("settings_state", 15000);
	check("extensions_reload re-pushes settings", true);
	c.ws.close();

	console.log(`\n${pass} passed, ${fail} failed`);
} catch (err) {
	console.error("TEST ERROR:", err.message);
	fail++;
} finally {
	server.kill("SIGTERM");
	await sleep(300);
}
process.exit(fail > 0 ? 1 : 0);
