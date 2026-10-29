import { describe, expect, it } from "vitest";
import { computeFloatingPosition } from "../../web/src/use-floating-panel.js";

describe("computeFloatingPosition", () => {
	const viewport = { width: 1000, height: 800 };

	it("默认右对齐：面板右缘与触发器右缘对齐，挂在下方", () => {
		const anchor = { left: 400, right: 500, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport);
		// x = anchor.right (500) - panel.width (200) = 300
		expect(pos.x).toBe(300);
		// y = anchor.bottom (130) + gap (6) = 136
		expect(pos.y).toBe(136);
	});

	it("左对齐：面板左缘与触发器左缘对齐", () => {
		const anchor = { left: 400, right: 500, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { align: "left" });
		// x = anchor.left = 400
		expect(pos.x).toBe(400);
		expect(pos.y).toBe(136);
	});

	it("右边缘超出视口时安全钳制（右侧留出 margin）", () => {
		const anchor = { left: 900, right: 980, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { align: "left", margin: 10 });
		// 900 + 200 = 1100 > 1000 - 10 = 990，应被钳制在 1000 - 200 - 10 = 790
		expect(pos.x).toBe(790);
	});

	it("左边缘超出视口时安全钳制（左侧留出 margin）", () => {
		const anchor = { left: 50, right: 100, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { align: "right", margin: 10 });
		// 100 - 200 = -100 < 10，应被钳制在 margin = 10
		expect(pos.x).toBe(10);
	});

	it("下方放不下时自动向上翻转", () => {
		// 触发器靠近视口底部：bottom=750，height=800
		const anchor = { left: 400, right: 500, top: 720, bottom: 750 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport);
		// 下方 750 + 6 + 150 = 906 > 800 - 8 = 792
		// 翻到上方：720 - 150 - 6 = 564
		expect(pos.y).toBe(564);
	});

	it("上下两边都放不下但能在视口内完整展示：钳制在视口底部安全区域", () => {
		// 面板高度 750，视口 800，触发器在中间 400-430
		const anchor = { left: 400, right: 500, top: 400, bottom: 430 };
		const panel = { width: 200, height: 750 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { margin: 8 });
		// 下方 430 + 6 + 750 = 1186 超出
		// 上方 400 - 750 - 6 = -356 超出
		// 钳制在 maxH = 800 - 750 - 8 = 42，底部留出 8px 安全边距
		expect(pos.y).toBe(42);
	});

	it("面板高度超出视口时贴顶钳制（y = margin，留出空间由内部 max-height 滚动）", () => {
		// 面板高度 900 > 视口 800
		const anchor = { left: 400, right: 500, top: 400, bottom: 430 };
		const panel = { width: 200, height: 900 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { margin: 8 });
		expect(pos.y).toBe(8);
	});

	it("side='top'：上方放得下在上方，放不下翻转到下方", () => {
		const panel = { width: 200, height: 100 };
		// 上方放得下
		const anchor1 = { left: 400, right: 500, top: 300, bottom: 330 };
		const pos1 = computeFloatingPosition(anchor1, panel, viewport, { side: "top", gap: 5 });
		expect(pos1.y).toBe(300 - 100 - 5);

		// 上方放不下（top=50，panel=100）
		const anchor2 = { left: 400, right: 500, top: 50, bottom: 80 };
		const pos2 = computeFloatingPosition(anchor2, panel, viewport, { side: "top", gap: 5 });
		// 翻到下方：80 + 5 = 85
		expect(pos2.y).toBe(85);
	});
});
