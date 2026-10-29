import { afterEach, describe, expect, it, vi } from "vitest";
import { announceUiLocale, currentUiLocale, initializeUiLocale, UI_LOCALE_EVENT } from "../../web/src/ui-locale.js";

describe("ui locale reporting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the browser-selected locale as the effective hello locale", () => {
		const setItem = vi.fn();
		vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });

		expect(initializeUiLocale(null, ["zh-TW", "en-US"])).toBe("zh-TW");
		expect(currentUiLocale()).toBe("zh-TW");
		expect(setItem).not.toHaveBeenCalled();
	});

	it("broadcasts an automatic locale without persisting it", () => {
		const setItem = vi.fn();
		const dispatchEvent = vi.fn();
		vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });
		vi.stubGlobal("window", { dispatchEvent });

		announceUiLocale("zh-Hant");

		expect(currentUiLocale()).toBe("zh-Hant");
		expect(setItem).not.toHaveBeenCalled();
		expect(dispatchEvent).toHaveBeenCalledTimes(1);
		const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<string>;
		expect(event.type).toBe(UI_LOCALE_EVENT);
		expect(event.detail).toBe("zh-Hant");
	});

	it("ignores empty locale announcements", () => {
		const dispatchEvent = vi.fn();
		vi.stubGlobal("window", { dispatchEvent });
		initializeUiLocale(null, ["en"]);

		announceUiLocale("  ");

		expect(currentUiLocale()).toBe("en");
		expect(dispatchEvent).not.toHaveBeenCalled();
	});
});
