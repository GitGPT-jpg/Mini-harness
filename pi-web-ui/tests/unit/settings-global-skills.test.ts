import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import { SubagentTemplatesStore } from "../../server/subagent-templates.js";
import type { ServerMessage } from "../../server/protocol.js";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

let dir: string;
let home: string;
let cwd: string;
let store: ClientStateStore;
let emitted: ServerMessage[];
const skillName = "global-test-skill";

function makeService(): SettingsService {
	const host: SettingsHost = {
		clientId: "test-client",
		stateStore: store,
		emit: (msg) => void emitted.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		// Disabled skills have already been filtered out by skillsOverride.
		getSession: () =>
			({
				resourceLoader: {
					getSkills: () => ({ skills: [] }),
					getExtensions: () => ({ extensions: [] }),
				},
			}) as never,
		cwd: () => cwd,
		agentDir: () => join(dir, "agent"),
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	};
	return new SettingsService(host, new SubagentTemplatesStore(join(dir, "templates.json")));
}

function installSkill(format: "directory" | "markdown" = "directory") {
	const base = join(home, ".agents", "skills");
	const file = format === "directory" ? join(base, skillName, "SKILL.md") : join(base, `${skillName}.md`);
	mkdirSync(format === "directory" ? join(base, skillName) : base, { recursive: true });
	writeFileSync(file, `---\nname: ${skillName}\ndescription: Test skill\n---\nTest instructions.\n`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "settings-global-skills-"));
	home = join(dir, "home");
	cwd = join(dir, "outside-home");
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.mocked(homedir).mockReturnValue(home);
	store = new ClientStateStore(join(dir, "client-state.json"));
	emitted = [];
	store.saveSettings("test-client", {
		disabledSkills: [skillName],
		reviewDisabledSkills: [skillName],
		skillsFullText: [skillName],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.mocked(homedir).mockReset();
	rmSync(dir, { recursive: true, force: true });
});

describe("global .agents/skills settings (issue #669)", () => {
	it.each([
		["outside home", "directory"],
		["outside home", "markdown"],
		["deep under home", "directory"],
		["deep under home", "markdown"],
	] as const)("preserves disabled %s skills in %s format across settings pushes", (location, format) => {
		if (location === "deep under home") {
			cwd = join(home, "a", "b", "c", "d", "e", "f", "g", "project");
			mkdirSync(cwd, { recursive: true });
		}
		installSkill(format);
		// Also exercise a cleanup write without losing the existing global skill.
		store.saveSettings("test-client", {
			disabledSkills: [skillName, "deleted-test-skill"],
		});
		// Construct again to read the updated persisted settings.
		const updated = makeService();
		updated.push();
		updated.push();
		expect(updated.current.disabledSkills).toEqual([skillName]);
		expect(updated.current.reviewDisabledSkills).toEqual([skillName]);
		expect(updated.current.skillsFullText).toEqual([skillName]);
		const saved = new ClientStateStore(join(dir, "client-state.json")).getSettings("test-client");
		expect(saved.disabledSkills).toEqual([skillName]);
		expect(saved.reviewDisabledSkills).toEqual([skillName]);
		expect(saved.skillsFullText).toEqual([skillName]);
		const state = emitted.filter((msg) => msg.type === "settings_state").at(-1);
		expect(state?.settings.skills).toContainEqual(expect.objectContaining({ name: skillName, enabled: false }));
		expect(state?.settings.reviewSkills).toContainEqual(expect.objectContaining({ name: skillName, enabled: false }));
	});

	it("falls back to homedir when HOME is unset", () => {
		vi.stubEnv("HOME", undefined);
		installSkill();
		const svc = makeService();
		svc.push();
		expect(svc.current.disabledSkills).toEqual([skillName]);
		expect(svc.current.reviewDisabledSkills).toEqual([skillName]);
		expect(svc.current.skillsFullText).toEqual([skillName]);
	});

	it("still prunes settings for a skill that no longer exists", () => {
		const svc = makeService();
		svc.push();
		expect(svc.current.disabledSkills).toEqual([]);
		expect(svc.current.reviewDisabledSkills).toEqual([]);
		expect(svc.current.skillsFullText).toEqual([]);
		const saved = new ClientStateStore(join(dir, "client-state.json")).getSettings("test-client");
		expect(saved.disabledSkills).toEqual([]);
		expect(saved.reviewDisabledSkills).toEqual([]);
		expect(saved.skillsFullText).toEqual([]);
	});
});
