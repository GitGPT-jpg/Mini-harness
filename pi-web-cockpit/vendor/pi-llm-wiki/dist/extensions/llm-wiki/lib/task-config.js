import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { detectHost, listGlobalSettingsFiles, listProjectSettingsFiles, resolveGlobalSettingsPath, resolveProjectSettingsPath, } from "./host.js";
export const TASK_DEFAULTS = {};
/**
 * Resolve whether user-facing wiki notices are enabled (issue #77). Defaults
 * to `true`; only an explicit `notices: false` disables them.
 */
export function noticesEnabled(config) {
    return config?.notices !== false;
}
/**
 * Resolve whether automatic `before_agent_start` recall is enabled (issue
 * #262). Same polarity as {@link noticesEnabled}: defaults to `true`; only an
 * explicit `autoRecall: false` disables the automatic recall injection. The
 * `wiki_recall` tool, MCP tools, and `/wiki-*` commands are unaffected.
 */
export function autoRecallEnabled(config) {
    return config?.autoRecall !== false;
}
const WIKILINK_VALIDATION_MODES = [
    "off",
    "warn",
    "strict",
    "normalize",
];
/**
 * Resolve the wikilink write-gate mode (issue #172, Layer 2). Defaults to
 * `warn` — ingest always writes and reports; only an explicit `strict` blocks.
 * Unknown values fall back to `warn` rather than failing the ingest.
 */
export function resolveWikilinkValidation(config) {
    const v = config?.wikilinkValidation;
    if (v && WIKILINK_VALIDATION_MODES.includes(v))
        return v;
    return "warn";
}
/**
 * Resolve whether the personal vault may serve as this project's ambient
 * vault. Explicit `ambientPersonalVault` wins; otherwise the host decides
 * (see the field docs on {@link TaskConfig.ambientPersonalVault}).
 */
export function personalVaultIsAmbient(config, host = detectHost()) {
    if (typeof config?.ambientPersonalVault === "boolean")
        return config.ambientPersonalVault;
    return host === "pi";
}
/**
 * Resolve whether agent-trajectory working-memory is enabled (issue #80).
 * INVERSE polarity of `noticesEnabled`: defaults to `false`; only an explicit
 * `trajectories: true` turns it on.
 */
export function trajectoriesEnabled(config) {
    return config?.trajectories === true;
}
const SETTINGS_KEY = "llm-wiki";
function readModelSpec(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const v = value;
    if (typeof v.provider === "string" && typeof v.id === "string" && v.provider && v.id) {
        return { provider: v.provider, id: v.id };
    }
    return undefined;
}
function readNamespacedConfig(path) {
    try {
        const raw = readSettingsObject(path);
        const nested = raw[SETTINGS_KEY];
        if (!nested || typeof nested !== "object")
            return {};
        const section = nested;
        const out = {};
        const taskModel = readModelSpec(section.taskModel);
        if (taskModel)
            out.taskModel = taskModel;
        for (const key of [
            "embeddingProvider",
            "embeddingModel",
            "embeddingBaseUrl",
            "embeddingApiKey",
            "embeddingApiKeyEnv",
        ]) {
            const value = section[key];
            if (typeof value === "string" && value.trim())
                out[key] = value.trim();
        }
        if (typeof section.taskModelBaseUrl === "string")
            out.taskModelBaseUrl = section.taskModelBaseUrl;
        if (typeof section.taskModelApiKey === "string")
            out.taskModelApiKey = section.taskModelApiKey;
        if (typeof section.taskModelApiKeyEnv === "string") {
            out.taskModelApiKeyEnv = section.taskModelApiKeyEnv;
        }
        const weight = section.semanticWeight;
        if (typeof weight === "number" && Number.isFinite(weight)) {
            out.semanticWeight = Math.min(1, Math.max(0, weight));
        }
        const threshold = section.recallLinksThreshold;
        if (typeof threshold === "number" && Number.isFinite(threshold)) {
            out.recallLinksThreshold = Math.max(0, Math.floor(threshold));
        }
        const inlineMax = section.recallSkillInlineMax;
        if (typeof inlineMax === "number" && Number.isFinite(inlineMax)) {
            out.recallSkillInlineMax = Math.max(0, Math.floor(inlineMax));
        }
        if (typeof section.notices === "boolean") {
            out.notices = section.notices;
        }
        if (typeof section.autoRecall === "boolean") {
            out.autoRecall = section.autoRecall;
        }
        if (typeof section.ambientPersonalVault === "boolean") {
            out.ambientPersonalVault = section.ambientPersonalVault;
        }
        if (typeof section.trajectories === "boolean") {
            out.trajectories = section.trajectories;
        }
        const lang = section.synthesisLanguage;
        if (typeof lang === "string" && lang.trim()) {
            const canonical = validateSynthesisLanguage(lang.trim());
            if (canonical)
                out.synthesisLanguage = canonical;
        }
        const maxTokens = section.synthesisMaxTokens;
        if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
            out.synthesisMaxTokens = Math.floor(maxTokens);
        }
        const wl = section.wikilinkValidation;
        if (typeof wl === "string" && WIKILINK_VALIDATION_MODES.includes(wl)) {
            out.wikilinkValidation = wl;
        }
        const ct = section.customTypes;
        if (ct && typeof ct === "object" && !Array.isArray(ct)) {
            const entries = Object.entries(ct);
            const valid = {};
            for (const [k, v] of entries) {
                if (typeof k === "string" && typeof v === "string" && k && v) {
                    valid[k] = v;
                }
            }
            if (Object.keys(valid).length)
                out.customTypes = valid;
        }
        return out;
    }
    catch {
        return {};
    }
}
/**
 * Parse a `"provider/id"` model reference (issue #69). Splits on the FIRST
 * slash so model ids that themselves contain slashes (e.g.
 * `openrouter/meta/llama-3`) are preserved. Returns `undefined` for empty,
 * slashless, or partial (`provider/` / `/id`) refs so callers can reject bad
 * input. Whitespace is trimmed.
 */
export function parseModelRef(ref) {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0)
        return undefined;
    const provider = trimmed.slice(0, slash).trim();
    const id = trimmed.slice(slash + 1).trim();
    if (!provider || !id)
        return undefined;
    return { provider, id };
}
/**
 * Validate and canonicalize a BCP 47 language tag for synthesisLanguage (issue #124).
 * Returns the canonical tag, or undefined if invalid or suspicious.
 * Uses Intl.getCanonicalLocales for validation; rejects tags containing
 * newlines, quotes, or other prompt-injection candidates.
 */
export function validateSynthesisLanguage(tag) {
    // Reject obvious injection attempts: newlines, quotes, braces, angle brackets
    if (/\n|\r|"|'|<|>|{|}/.test(tag))
        return undefined;
    // Reject if it looks like an instruction (contains "write", "ignore", "translate", etc.)
    const lower = tag.toLowerCase();
    if (/\b(write|ignore|translate|system|prompt|instruction)\b/.test(lower))
        return undefined;
    // Basic BCP 47 pattern: language[-script][-region][-variant]*
    // Must start with 2-3 letter language code
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{1,8})*$/.test(tag))
        return undefined;
    const canonical = Intl.getCanonicalLocales(tag);
    if (canonical.length === 0)
        return undefined;
    return canonical[0];
}
/**
 * Read a settings file as a plain object, or `{}` when it is absent or
 * corrupt. Reads directly (no `existsSync` pre-check) so there is no
 * check-then-use race: a missing file throws ENOENT, which the catch treats
 * the same as an empty file.
 *
 * `config.yml` / `config.yaml` are parsed as YAML — that is the format oh-my-pi
 * migrates its settings to. Everything else is JSON. JSON is a YAML subset, so
 * the YAML parser also accepts a `.yml` file that actually holds JSON.
 */
function readSettingsObject(path) {
    try {
        const text = readFileSync(path, "utf-8");
        const parsed = path.endsWith(".yml") || path.endsWith(".yaml") ? parseYaml(text) : JSON.parse(text);
        if (parsed && typeof parsed === "object")
            return parsed;
    }
    catch {
        // Missing or corrupt settings file: start from an empty object.
    }
    return {};
}
/**
 * Rewrite the `llm-wiki` section of the global settings file.
 */
function updateGlobalSection(mutate) {
    const settingsPath = resolveGlobalSettingsPath();
    const raw = readSettingsObject(settingsPath);
    const existing = raw[SETTINGS_KEY];
    const section = existing && typeof existing === "object" ? { ...existing } : {};
    mutate(section);
    raw[SETTINGS_KEY] = section;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}
/**
 * Rewrite the `llm-wiki` section of the project settings file, preserving every
 * other top-level key and every other setting in the section.
 *
 * The target file is chosen by `resolveProjectSettingsPath` — `.pi/settings.json`
 * or `.omp/settings.json` depending on host and on what already exists — and is
 * always JSON, which both hosts read.
 */
function updateProjectSection(cwd, mutate) {
    const settingsPath = resolveProjectSettingsPath(cwd);
    const raw = readSettingsObject(settingsPath);
    const existing = raw[SETTINGS_KEY];
    const section = existing && typeof existing === "object" ? { ...existing } : {};
    mutate(section);
    raw[SETTINGS_KEY] = section;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}
/**
 * Persist (or clear) the wiki background `taskModel` in the PROJECT settings
 * file under the namespaced `llm-wiki` key (issue #69). Project settings win
 * over global in `loadTaskConfig`, so this takes effect immediately on the next
 * config load. Passing `undefined` removes the key (reverting to the session
 * model).
 */
export function persistTaskModel(cwd, model) {
    updateProjectSection(cwd, (section) => {
        if (model) {
            section.taskModel = { provider: model.provider, id: model.id };
        }
        else {
            // biome-ignore lint/performance/noDelete: one-off settings rewrite, not a hot path; removing the key (vs setting undefined) keeps the JSON clean
            delete section.taskModel;
        }
    });
}
/**
 * Persist the agent-trajectory flag in the PROJECT settings file under the
 * namespaced `llm-wiki` key (issue #80). Mirrors `persistTaskModel`: `true`
 * writes `trajectories: true`; `false` removes the key (reverting to the
 * default-off behavior).
 */
export function persistTrajectoriesEnabled(cwd, enabled) {
    updateProjectSection(cwd, (section) => {
        if (enabled) {
            section.trajectories = true;
        }
        else {
            // biome-ignore lint/performance/noDelete: one-off settings rewrite, not a hot path; removing the key keeps the JSON clean (default is off)
            delete section.trajectories;
        }
    });
}
/**
 * Merge the `llm-wiki` section from every settings file both hosts may use,
 * lowest precedence first: built-in defaults, then user-level files, then
 * project-level files. Absent files contribute nothing.
 */
export function loadTaskConfig(cwd) {
    const config = { ...TASK_DEFAULTS };
    for (const path of listGlobalSettingsFiles()) {
        Object.assign(config, readNamespacedConfig(path));
    }
    for (const path of listProjectSettingsFiles(cwd)) {
        Object.assign(config, readNamespacedConfig(path));
    }
    return config;
}
/**
 * Resolve where each setting is defined: project > global > default.
 */
/** All known setting keys — needed because TASK_DEFAULTS is {} (zero-config). */
const KNOWN_KEYS = [
    "taskModel",
    "embeddingProvider",
    "embeddingModel",
    "embeddingBaseUrl",
    "embeddingApiKey",
    "embeddingApiKeyEnv",
    "taskModelBaseUrl",
    "taskModelApiKey",
    "taskModelApiKeyEnv",
    "semanticWeight",
    "recallLinksThreshold",
    "recallSkillInlineMax",
    "notices",
    "autoRecall",
    "ambientPersonalVault",
    "trajectories",
    "synthesisLanguage",
    "synthesisMaxTokens",
    "wikilinkValidation",
    "customTypes",
];
export function loadTaskConfigSources(cwd) {
    const globalResult = {};
    for (const path of listGlobalSettingsFiles()) {
        Object.assign(globalResult, readNamespacedConfig(path));
    }
    const projectResult = {};
    for (const path of listProjectSettingsFiles(cwd)) {
        Object.assign(projectResult, readNamespacedConfig(path));
    }
    const effective = loadTaskConfig(cwd);
    const out = {};
    for (const key of KNOWN_KEYS) {
        if (key in projectResult)
            out[key] = { value: projectResult[key], source: "project" };
        else if (key in globalResult)
            out[key] = { value: globalResult[key], source: "global" };
        else
            out[key] = { value: effective[key], source: "default" };
    }
    return out;
}
/**
 * Generic setting persist: writes any single setting to the chosen scope.
 */
export function persistSetting(cwd, scope, key, value) {
    const mutate = (section) => {
        if (value === undefined || value === null) {
            delete section[key];
        }
        else {
            section[key] = value;
        }
    };
    if (scope === "project") {
        updateProjectSection(cwd, mutate);
    }
    else if (scope === "global") {
        updateGlobalSection(mutate);
    }
}
