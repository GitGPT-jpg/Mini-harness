import { describe, expect, it } from "vitest";
import { ALL_TABS, isTabAllowed, parseTabs, tabsRefusal } from "../../server/tabs.js";

/**
 * PI_WEB_TABS — choose what an instance offers.
 *
 * Terminal opens a shell as the server's user; Git shows the working copy with
 * commit and diff a click away. On your own machine that is the point of the
 * tool. Exposed to other people — reviewers, colleagues, anybody who reaches
 * the page — they are not features, they are a shell and a repository handed
 * out over HTTP, and there is no way to turn them off today.
 *
 * Absent variable means every tab, exactly as now: nobody who does not set it
 * sees any change.
 *
 * The rule that shapes this: a hidden tab whose messages the server still
 * accepts is a hidden tab, not a disabled one. Anything that can open the
 * socket can send `terminal_create`.
 */
describe("tab allow-list", () => {
	it("absent means everything, like today", () => {
		expect(parseTabs({})).toBeNull();
		expect(parseTabs({ PI_WEB_TABS: "" })).toBeNull();
		expect(parseTabs({ PI_WEB_TABS: "   " })).toBeNull();
		for (const tab of ALL_TABS) expect(isTabAllowed(tab, null), tab).toBe(true);
	});

	it("reads a list the way people write it", () => {
		const t = parseTabs({ PI_WEB_TABS: " chat , Search,settings " });
		expect([...(t as Set<string>)].sort()).toEqual(["chat", "search", "settings"]);
	});

	it("chat is never off: it is the application", () => {
		const t = parseTabs({ PI_WEB_TABS: "settings" });
		expect(isTabAllowed("chat", t)).toBe(true);
		expect(isTabAllowed("terminal", t)).toBe(false);
	});

	it("refuses the messages of the tabs that are off", () => {
		const t = parseTabs({ PI_WEB_TABS: "chat,search,settings" });
		for (const type of ["terminal_create", "terminal_input", "terminal_kill", "rename_terminal", "run_command"]) {
			expect(tabsRefusal(type, t), type).toMatch(/terminal/i);
		}
		for (const type of ["scm_status", "scm_history", "scm_filediff", "scm_commit"]) {
			expect(tabsRefusal(type, t), type).toMatch(/git/i);
		}
		for (const type of ["list_bg_servers", "kill_background_server", "kill_background_servers"]) {
			expect(tabsRefusal(type, t), type).toBeTruthy();
		}
	});

	it("leaves the allowed tabs alone", () => {
		const t = parseTabs({ PI_WEB_TABS: "chat,search,settings" });
		for (const type of ["prompt", "get_state", "search_files", "search_sessions", "get_settings", "set_settings"]) {
			expect(tabsRefusal(type, t), type).toBeNull();
		}
	});

	it("refuses nothing at all when no list is set", () => {
		for (const type of ["terminal_create", "scm_commit", "list_bg_servers", "search_files"]) {
			expect(tabsRefusal(type, null), type).toBeNull();
		}
	});

	/*
	 * The terminal is the one that matters most: run_command starts a process
	 * too, and forgetting it would leave the shell reachable with the tab gone.
	 */
	it("run_command counts as terminal, because it starts a process there", () => {
		const t = parseTabs({ PI_WEB_TABS: "chat" });
		expect(tabsRefusal("run_command", t)).toMatch(/terminal/i);
	});
});
