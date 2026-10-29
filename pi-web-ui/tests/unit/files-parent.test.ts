import { describe, expect, it } from "vitest";
import { absoluteParent, MACHINE_ROOT, normWirePath } from "../../server/files-service.js";

describe("files-service: absoluteParent 与目录层级导航", () => {
	it("机器根、空串以及 posix 根返回 null", () => {
		expect(absoluteParent(MACHINE_ROOT)).toBeNull();
		expect(absoluteParent("")).toBeNull();
		expect(absoluteParent("/")).toBeNull();
		expect(absoluteParent("///")).toBeNull();
	});

	it("posix 路径逐级向上，最终到达 / 并返回 null", () => {
		expect(absoluteParent("/home/user/project")).toBe("/home/user");
		expect(absoluteParent("/home/user")).toBe("/home");
		expect(absoluteParent("/home")).toBe("/");
		expect(absoluteParent("/")).toBeNull();
	});

	it("Windows 盘符路径逐级向上，盘符根返回 MACHINE_ROOT", () => {
		expect(absoluteParent("C:/Users/test/project")).toBe("C:/Users/test");
		expect(absoluteParent("C:/Users/test")).toBe("C:/Users");
		expect(absoluteParent("C:/Users")).toBe("C:");
		expect(absoluteParent("C:/")).toBe(MACHINE_ROOT);
		expect(absoluteParent("C:")).toBe(MACHINE_ROOT);
		expect(absoluteParent("D:")).toBe(MACHINE_ROOT);
	});

	it("项目根目录（rel === ''）点击上一级计算项目文件夹父级", () => {
		// 模拟 listFiles 中对 rel === "" 的 parent 计算逻辑：
		// const rootWire = normWirePath(root.split(sep).join("/"));
		// const parent = absoluteParent(rootWire);

		// 普通嵌套项目（Windows）：
		const winProjectWire = normWirePath("E:/workspace/pi-web-ui".replace(/\\/g, "/"));
		expect(absoluteParent(winProjectWire)).toBe("E:/workspace");

		// 位于盘符一级的项目（Windows）：
		const winTopLevelWire = normWirePath("E:/pi-web-ui".replace(/\\/g, "/"));
		expect(absoluteParent(winTopLevelWire)).toBe("E:");

		// 盘符根作为项目（Windows）：
		const winDriveRootWire = normWirePath("E:/".replace(/\\/g, "/"));
		expect(absoluteParent(winDriveRootWire)).toBe(MACHINE_ROOT);

		// 普通嵌套项目（Posix）：
		const posixProjectWire = normWirePath("/home/user/project".replace(/\\/g, "/"));
		expect(absoluteParent(posixProjectWire)).toBe("/home/user");

		// 系统根作为项目（Posix）：
		const posixRootWire = normWirePath("/".replace(/\\/g, "/"));
		expect(absoluteParent(posixRootWire)).toBeNull();
	});
});
