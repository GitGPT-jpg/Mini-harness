import { existsSync } from "node:fs";
import { join } from "node:path";
import { awaitQmdIndexQueue, readQmdIndexStatus, reindexQmdVault, } from "./qmd-indexing.js";
import { QMD_PACKAGE_VERSION, resolveQmdModels } from "./qmd-store.js";
import { getPersonalWikiPaths, isPersonalVault, readJson } from "./utils.js";
import { compareCodePoint, discoverKnowledgeDocuments, inspectVaultFormat, inspectWritableVault, } from "./vault-format.js";
/**
 * Search the registry for matching concepts.
 *
 * Matches ID, title, type, state, status, category, domain, tags, aliases, and recall triggers.
 * Preserves unknown types as strings.
 */
export function searchRegistry(paths, query, typeFilter) {
    const diagnostics = [];
    const vaultState = inspectVaultFormat(paths);
    diagnostics.push(...vaultState.diagnostics);
    const registryPath = join(paths.meta, "registry.json");
    if (!existsSync(registryPath)) {
        return { matches: [], diagnostics };
    }
    const registry = readJson(registryPath, {
        version: "1.0",
        last_updated: "",
        pages: {},
    });
    const normalizedQuery = query.toLowerCase();
    const matches = [];
    for (const [id, entry] of Object.entries(registry.pages)) {
        // Apply type filter
        if (typeFilter && String(entry.type).toLowerCase() !== typeFilter.toLowerCase()) {
            continue;
        }
        // Check if query matches any searchable field
        if (matchesField(id, entry, normalizedQuery)) {
            matches.push({
                id,
                title: String(entry.title || id),
                type: String(entry.type || "unknown"),
            });
        }
    }
    // Sort by code point order for determinism
    matches.sort((a, b) => compareCodePoint(a.id, b.id));
    return { matches, diagnostics };
}
function matchesField(id, entry, query) {
    // Match ID
    if (id.toLowerCase().includes(query))
        return true;
    // Match title
    if (String(entry.title || "")
        .toLowerCase()
        .includes(query))
        return true;
    // Match type
    if (String(entry.type || "")
        .toLowerCase()
        .includes(query))
        return true;
    // Match state
    if (String(entry.state || "")
        .toLowerCase()
        .includes(query))
        return true;
    // Match status
    if (String(entry.status || "")
        .toLowerCase()
        .includes(query))
        return true;
    // Match category/domain
    if (String(entry.category || "")
        .toLowerCase()
        .includes(query))
        return true;
    if (String(entry.domain || "")
        .toLowerCase()
        .includes(query))
        return true;
    // Match tags (array or string)
    const tags = entry.tags;
    if (Array.isArray(tags)) {
        if (tags.some((t) => String(t).toLowerCase().includes(query)))
            return true;
    }
    else if (typeof tags === "string" && tags.toLowerCase().includes(query)) {
        return true;
    }
    // Match aliases (array or string)
    const aliases = entry.aliases;
    if (Array.isArray(aliases)) {
        if (aliases.some((a) => String(a).toLowerCase().includes(query)))
            return true;
    }
    else if (typeof aliases === "string" && aliases.toLowerCase().includes(query)) {
        return true;
    }
    // Match recall_triggers (array or string)
    const triggers = entry.recall_triggers;
    if (Array.isArray(triggers)) {
        if (triggers.some((t) => String(t).toLowerCase().includes(query)))
            return true;
    }
    else if (typeof triggers === "string" && triggers.toLowerCase().includes(query)) {
        return true;
    }
    return false;
}
/**
 * Get a status snapshot of the wiki.
 *
 * Reports resolved knowledge_format, page counts, blocking diagnostics, and
 * generated QMD index status (read without opening any QMD store).
 */
export async function getWikiStatus(paths) {
    const vaultState = inspectVaultFormat(paths);
    const diagnostics = [...vaultState.diagnostics];
    // Also check discovery for current concept health
    const discovery = discoverKnowledgeDocuments(paths);
    diagnostics.push(...discovery.diagnostics);
    const registryPath = join(paths.meta, "registry.json");
    let registry;
    if (existsSync(registryPath)) {
        registry = readJson(registryPath, { version: "1.0", last_updated: "", pages: {} });
    }
    const byType = {};
    let totalPages = 0;
    if (registry) {
        for (const entry of Object.values(registry.pages)) {
            totalPages++;
            const type = String(entry.type || "unknown");
            byType[type] = (byType[type] || 0) + 1;
        }
    }
    return {
        knowledgeFormat: vaultState.knowledgeFormat,
        totalPages,
        byType,
        blockingDiagnostics: diagnostics.filter((d) => d.severity === "error"),
        lastUpdated: registry?.last_updated || "",
        qmd: await readQmdIndexStatus(paths),
    };
}
function blockedReindexResult(scope, components, code, message) {
    return {
        ok: false,
        scope,
        components,
        documents: { indexed: 0, updated: 0, unchanged: 0, removed: 0 },
        vectors: { generated: 0, skipped: 0, errors: 0 },
        elapsedMs: 0,
        status: {
            state: "error",
            qmdVersion: QMD_PACKAGE_VERSION,
            models: resolveQmdModels(),
            totalDocuments: 0,
            canonicalDocuments: 0,
            evidenceDocuments: 0,
            needsEmbedding: 0,
            hasVectorIndex: false,
            repairComponents: [],
            issues: [{ code, message }],
        },
        warnings: [],
        errors: [{ code, message }],
    };
}
/**
 * Reindex QMD stores for selected vaults, sequentially. Validates each vault
 * immediately before work. One vault's failure does not prevent the others.
 */
export async function reindexWiki(activePaths, input) {
    const scope = input.scope ?? "changed";
    const components = input.components ?? ["lexical", "vectors"];
    const force = input.force ?? false;
    const vault = input.vault ?? "active";
    const signal = input.signal;
    const onProgress = input.onProgress;
    const personalPaths = getPersonalWikiPaths();
    const activeIsPersonal = isPersonalVault(activePaths);
    const targets = [];
    switch (vault) {
        case "active":
            targets.push({ paths: activePaths, label: activeIsPersonal ? "personal" : "active" });
            break;
        case "personal":
            targets.push({ paths: personalPaths, label: "personal" });
            break;
        case "project":
            if (!activeIsPersonal)
                targets.push({ paths: activePaths, label: "project" });
            break;
        case "all":
            if (!activeIsPersonal)
                targets.push({ paths: activePaths, label: "project" });
            targets.push({ paths: personalPaths, label: "personal" });
            break;
    }
    const seen = new Set();
    const results = [];
    for (const target of targets) {
        if (seen.has(target.paths.root))
            continue;
        seen.add(target.paths.root);
        const check = inspectWritableVault(target.paths);
        if (!check.ok) {
            results.push({
                root: target.paths.root,
                label: target.label,
                result: blockedReindexResult(scope, components, check.diagnostics[0]?.code ?? "config_invalid_knowledge_format", check.diagnostics[0]?.message ?? "Vault is not writable"),
            });
            continue;
        }
        const result = await reindexQmdVault(target.paths, {
            scope,
            components,
            force,
            signal,
            onProgress: (p) => onProgress?.({ vault: target.paths.root, progress: p }),
        });
        results.push({ root: target.paths.root, label: target.label, result });
    }
    return { vault, results };
}
/** Test-only: drain/await in-process QMD reindex queue work for a vault root. */
export function awaitWikiQmdIndexQueue(root) {
    return awaitQmdIndexQueue(root);
}
