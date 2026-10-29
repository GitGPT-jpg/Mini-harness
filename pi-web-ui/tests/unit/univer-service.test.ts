/**
 * univer-service 纯函数单测：映射验证、类型安全、边界条件与扩展名兼容。
 */
import { describe, expect, it } from "vitest";
import { getOfficeUnitTypeAndFormat, UniverService } from "../../server/univer-service.js";

describe("getOfficeUnitTypeAndFormat", () => {
	it("正确将 Excel 扩展名映射为 UNIVER_SHEET (2) 和 xlsx 格式", () => {
		expect(getOfficeUnitTypeAndFormat("test.xlsx")).toEqual({ unitType: 2, format: "xlsx" });
		expect(getOfficeUnitTypeAndFormat("path/to/data.xlsm")).toEqual({ unitType: 2, format: "xlsx" });
		expect(getOfficeUnitTypeAndFormat("OLD.XLS")).toEqual({ unitType: 2, format: "xlsx" });
	});

	it("正确将 Word 扩展名映射为 UNIVER_DOC (1) 和 docx 格式", () => {
		expect(getOfficeUnitTypeAndFormat("report.docx")).toEqual({ unitType: 1, format: "docx" });
		expect(getOfficeUnitTypeAndFormat("DOCUMENT.DOC")).toEqual({ unitType: 1, format: "docx" });
	});

	it("正确将 PowerPoint 扩展名映射为 UNIVER_SLIDE (3) 和 pptx 格式", () => {
		expect(getOfficeUnitTypeAndFormat("slides.pptx")).toEqual({ unitType: 3, format: "pptx" });
		expect(getOfficeUnitTypeAndFormat("pitch.pptm")).toEqual({ unitType: 3, format: "pptx" });
		expect(getOfficeUnitTypeAndFormat("demo.ppsx")).toEqual({ unitType: 3, format: "pptx" });
		expect(getOfficeUnitTypeAndFormat("template.potx")).toEqual({ unitType: 3, format: "pptx" });
	});

	it("正确将 CSV / TSV 映射为 UNIVER_SHEET (2) 和对应格式", () => {
		expect(getOfficeUnitTypeAndFormat("data.csv")).toEqual({ unitType: 2, format: "csv" });
		expect(getOfficeUnitTypeAndFormat("data.tsv")).toEqual({ unitType: 2, format: "tsv" });
	});

	it("未知扩展名安全兜底为 UNIVER_SHEET (2)", () => {
		expect(getOfficeUnitTypeAndFormat("unknown.xyz")).toEqual({ unitType: 2, format: "xlsx" });
		expect(getOfficeUnitTypeAndFormat("")).toEqual({ unitType: 2, format: "xlsx" });
	});
});

describe("UniverService instance safety", () => {
	it("单例服务实例健康且拥有核心编辑与导出接口", () => {
		const s = new UniverService();
		expect(typeof s.ensureStarted).toBe("function");
		expect(typeof s.openDocument).toBe("function");
		expect(typeof s.saveDocument).toBe("function");
		expect(typeof s.inspectDocument).toBe("function");
		expect(typeof s.readSheetRange).toBe("function");
		expect(typeof s.executeOnDocument).toBe("function");
		expect(typeof s.editSheetRange).toBe("function");
		expect(typeof s.stop).toBe("function");
	});
});
