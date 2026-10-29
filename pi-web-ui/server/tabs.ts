/**
 * tabs — choose what an instance offers.
 *
 * pi-web-ui shows Chat, Terminal, Git, Search, Background tasks and Settings,
 * always, plus a tab per installed plugin. On the machine you are working on
 * that is the point of the tool. Exposed to other people it is not: Terminal
 * opens a shell as the server's user, and Git shows the working copy with
 * commit and diff a click away. Today there is no way to leave those out.
 *
 * `PI_WEB_TABS=chat,search,settings` is that way. Absent — the default —
 * means every tab, so nothing changes for anybody who does not set it.
 *
 * The rule that shapes the whole thing: **a hidden tab whose messages the
 * server still accepts is a hidden tab, not a disabled one.** Anything that
 * can open the WebSocket can send `terminal_create`. So the client stops
 * drawing them and the server stops answering them, and the second half is the
 * one that matters.
 *
 * Chat is never off: it is the application.
 */

/** Every tab that can be listed. `chat` is always on and is listed for symmetry. */
export const ALL_TABS = ["chat", "terminal", "git", "search", "tasks", "settings", "plugins"] as const;

export type Tab = (typeof ALL_TABS)[number];

/**
 * The messages each tab owns exclusively.
 *
 * Only exclusive ones: `abort_bash` stops the agent's own bash tool inside a
 * chat answer, not a terminal the user opened, so it is not listed — turning
 * off the Terminal tab must not change what the agent can do in a conversation.
 *
 * `run_command` is listed under terminal because it starts a process in one:
 * leaving it out would take the tab away and leave the shell reachable, which
 * is exactly the failure this module exists to prevent.
 */
const OWNED: Partial<Record<Tab, readonly string[]>> = {
	terminal: ["terminal_create", "terminal_input", "terminal_resize", "terminal_kill", "rename_terminal", "run_command"],
	git: ["scm_status", "scm_history", "scm_filediff", "scm_commit"],
	tasks: ["list_bg_servers", "kill_background_server", "kill_background_servers"],
	search: ["search_files", "search_sessions"],
};

/**
 * The allow-list, or null when there is none.
 *
 * Case and spaces are forgiven because this is written by hand in a systemd
 * unit or a compose file. Unknown names are kept rather than rejected: a
 * plugin tab, or a tab a later version adds, should not make the server fail
 * to start.
 */
export function parseTabs(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
	const raw = (env.PI_WEB_TABS ?? "").trim();
	if (!raw) return null;
	const tabs = new Set(
		raw
			.split(",")
			.map((t) => t.trim().toLowerCase())
			.filter(Boolean),
	);
	if (tabs.size === 0) return null;
	tabs.add("chat");
	return tabs;
}

/** Whether a tab is offered. No list means every tab. */
export function isTabAllowed(tab: string, tabs: Set<string> | null): boolean {
	if (!tabs) return true;
	if (tab === "chat") return true;
	return tabs.has(tab.toLowerCase());
}

/**
 * The reason to refuse a message, or null when it may proceed.
 *
 * Returning the sentence rather than a boolean keeps the call site one line and
 * puts the explanation next to the rule: the user sees why, instead of a
 * message that vanishes.
 */
export function tabsRefusal(type: string, tabs: Set<string> | null): string | null {
	if (!tabs) return null;
	for (const [tab, messages] of Object.entries(OWNED) as [Tab, readonly string[]][]) {
		if (!messages.includes(type)) continue;
		if (isTabAllowed(tab, tabs)) return null;
		return `The ${tab} tab is not enabled on this instance (PI_WEB_TABS).`;
	}
	return null;
}
