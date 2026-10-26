import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
/** Project config directory name per host. */
const CONFIG_DIR = { pi: ".pi", omp: ".omp" };
/** Settings file names inside a config directory, lowest → highest precedence. */
const SETTINGS_FILES = ["settings.json", "config.yml", "config.yaml"];
/**
 * Detect which agent is hosting this extension.
 *
 * Ordered by reliability:
 *  1. `LLM_WIKI_HOST` — explicit escape hatch (tests, exotic embeddings).
 *  2. The agent directory path: pi resolves `~/.pi/agent`, omp `~/.omp/agent`.
 *     A `PI_CODING_AGENT_DIR` override that keeps the marker segment still
 *     classifies correctly; anything else falls through.
 *  3. `OMP_PROFILE`, which omp sets on itself whenever a profile is active.
 *  4. Default `pi` — the historical behaviour.
 */
export function detectHost() {
    const forced = process.env.LLM_WIKI_HOST?.trim().toLowerCase();
    if (forced === "omp" || forced === "pi")
        return forced;
    let agentDir = "";
    try {
        agentDir = getAgentDir();
    }
    catch {
        agentDir = "";
    }
    if (agentDir) {
        const segments = agentDir.split(/[\\/]/);
        if (segments.includes(".omp"))
            return "omp";
        if (segments.includes(".pi"))
            return "pi";
    }
    if (process.env.OMP_PROFILE)
        return "omp";
    return "pi";
}
/**
 * Every project settings file that may hold `llm-wiki` configuration, ordered
 * from lowest to highest precedence so callers can merge left-to-right.
 *
 * The host's *native* directory is last (wins). The foreign directory is still
 * read so a vault configured under pi keeps working after omp takes over the
 * repository, and vice versa. Within a directory `config.yml` follows
 * `settings.json`, matching omp's own project-settings precedence.
 */
export function listProjectSettingsFiles(cwd, host = detectHost()) {
    const foreign = host === "omp" ? "pi" : "omp";
    const files = [];
    for (const kind of [foreign, host]) {
        const dir = join(cwd, CONFIG_DIR[kind]);
        for (const name of SETTINGS_FILES)
            files.push(join(dir, name));
    }
    return files;
}
/**
 * User-level settings files, lowest → highest precedence.
 *
 * `getAgentDir()` already resolves per host (`~/.pi/agent` vs `~/.omp/agent`),
 * so only the file names differ: omp migrates `settings.json` into `config.yml`
 * on first start, and a migrated install has *only* the YAML file.
 */
export function listGlobalSettingsFiles() {
    let agentDir = "";
    try {
        agentDir = getAgentDir();
    }
    catch {
        return [];
    }
    if (!agentDir)
        return [];
    return SETTINGS_FILES.map((name) => join(agentDir, name));
}
/**
 * The project settings file this extension writes to.
 *
 * Always JSON (`settings.json`) — both hosts read it, and rewriting a user's
 * hand-authored `config.yml` would destroy comments and formatting.
 *
 * Directory choice: an already-existing project config directory wins (so a
 * repo that only has `.pi/` keeps a single settings file), otherwise the
 * detected host's native directory is created.
 */
export function resolveProjectSettingsPath(cwd, host = detectHost()) {
    const native = join(cwd, CONFIG_DIR[host]);
    if (existsSync(native))
        return join(native, "settings.json");
    const foreign = join(cwd, CONFIG_DIR[host === "omp" ? "pi" : "omp"]);
    if (existsSync(foreign))
        return join(foreign, "settings.json");
    return join(native, "settings.json");
}
/**
 * The global (user-level) settings file this extension writes to.
 *
 * Always writes to `settings.json` inside the agent dir — both hosts read it.
 */
export function resolveGlobalSettingsPath(_host = detectHost()) {
    let agentDir = "";
    try {
        agentDir = getAgentDir();
    }
    catch {
        agentDir = "";
    }
    if (!agentDir) {
        // Fallback: ~/.pi/agent/settings.json
        const home = process.env.HOME || "~";
        return join(home, ".pi", "agent", "settings.json");
    }
    return join(agentDir, "settings.json");
}
