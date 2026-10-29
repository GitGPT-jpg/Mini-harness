import { describe, expect, it } from "vitest";
import {
	isValidProjectName,
	joinProjectPath,
	MACHINE_ROOT,
	parentOf,
	browseQuery,
} from "../../web/src/components/DirectoryBrowser.js";

describe("DirectoryBrowser utils", () => {
	it("browseQuery: 确保路径以 / 结尾", () => {
		expect(browseQuery("/home/user")).toBe("/home/user/");
		expect(browseQuery("/home/user/")).toBe("/home/user/");
	});

	it("parentOf: 正常计算各种路径的父级", () => {
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("/")).toBeNull();
		expect(parentOf("/home")).toBe("/");
		expect(parentOf("/home/user")).toBe("/home");
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/Users")).toBe("C:/");
		expect(parentOf("C:/Users/name")).toBe("C:/Users");
	});

	it("joinProjectPath: 正确拼接子目录名", () => {
		expect(joinProjectPath("/home/user", "project1")).toBe("/home/user/project1");
		expect(joinProjectPath("/home/user/", "project1")).toBe("/home/user/project1");
		expect(joinProjectPath("C:", "project1")).toBe("C:/project1");
		expect(joinProjectPath("C:/", "project1")).toBe("C:/project1");
	});

	it("isValidProjectName: 校验项目名称合法性", () => {
		expect(isValidProjectName("")).toBe(false);
		expect(isValidProjectName("   ")).toBe(false);
		expect(isValidProjectName(".")).toBe(false);
		expect(isValidProjectName("..")).toBe(false);
		expect(isValidProjectName("foo/bar")).toBe(false);
		expect(isValidProjectName("foo\\bar")).toBe(false);
		expect(isValidProjectName("my-project")).toBe(true);
		expect(isValidProjectName("proj_1")).toBe(true);
	});
});
