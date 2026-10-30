import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots";
import { zh, en } from "../../web/src/i18n";
import { HOST_ICON_NAMES } from "../../web/src/host-icon";

const STYLES_PATH = fileURLToPath(new URL("../../web/src/styles.css", import.meta.url));

describe("极简沉浸模式 (Zen / Focus Mode)", () => {
	it("Harness 发行版不在顶栏登记 host:zen-mode 入口（仍可用 Alt+Z / Ctrl+Shift+F 切换）", () => {
		expect(BUILTIN_UI_ITEMS.find((item) => item.id === "host:zen-mode")).toBeUndefined();
	});

	it("i18n 中双语均包含极简模式相关文案", () => {
		const requiredKeys: (keyof typeof zh)[] = ["zenMode", "zenModeTip", "zenModeExit", "zenModeExitTip"];
		for (const key of requiredKeys) {
			expect(zh[key], `zh.${key}`).toBeDefined();
			expect(zh[key].length, `zh.${key}`).toBeGreaterThan(0);
			expect(en[key], `en.${key}`).toBeDefined();
			expect(en[key].length, `en.${key}`).toBeGreaterThan(0);
		}
	});

	it("HOST_ICON_NAMES 包含 feather 图标", () => {
		expect(HOST_ICON_NAMES).toContain("feather");
	});

	it("styles.css 包含完整的极简模式类名与隐藏规则", () => {
		const css = readFileSync(STYLES_PATH, "utf8");
		expect(css).toContain(".app.zen-mode .topbar");
		expect(css).toContain(".app.zen-mode .footer-bar");
		expect(css).toContain(".app.zen-mode .side-dock");
		expect(css).toContain(".app.zen-mode .panel-drawer");
		expect(css).toContain(".zen-exit-pill");
	});
});
