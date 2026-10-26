import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serializeKnowledgeDocument } from "./knowledge-document.js";
import { discoverKnowledgeDocuments } from "./vault-format.js";
export const QMD_MANIFEST_VERSION = 1;
const CANONICAL_TYPES = new Set([
    "concept",
    "entity",
    "analysis",
    "synthesis",
    "requirement",
    "skill",
    "case",
]);
/** Classify a page type into a QMD collection role. Unknown types are evidence. */
export function roleForDocumentType(type) {
    return CANONICAL_TYPES.has(type.trim().toLowerCase()) ? "canonical" : "evidence";
}
/** Build the deterministic generated mirror path for a role + page id. */
export function manifestKey(role, pageId) {
    return `${["documents", role, ...pageId.split("/")].join("/")}.md`;
}
export function hashQmdContent(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}
export function hashQmdManifest(manifest) {
    const entries = Object.fromEntries(Object.entries(manifest.entries).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    return hashQmdContent(JSON.stringify({ version: manifest.version, vaultId: manifest.vaultId, entries }));
}
async function atomicWrite(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
}
/**
 * Resolve a manifest key to a physical path, rejecting anything that could
 * escape `paths.qmd` or traverse via `..`. Never trust paths from JSON.
 */
function manifestKeyToPath(paths, key) {
    if (isAbsolute(key)) {
        throw new Error("qmd_manifest_invalid: manifest key is absolute");
    }
    const parts = key.split("/");
    if (parts.some((part) => part === ".." || part === "" || part.includes("\\"))) {
        throw new Error("qmd_manifest_invalid: manifest key contains unsafe path segments");
    }
    if (parts[0] !== "documents") {
        throw new Error("qmd_manifest_invalid: manifest key outside documents");
    }
    const resolved = resolve(paths.qmd, key);
    if (!resolved.startsWith(resolve(paths.qmd) + sep)) {
        throw new Error("qmd_manifest_invalid: manifest key escapes qmd directory");
    }
    return resolved;
}
/** Load and validate a previously published manifest for this vault. */
export async function readQmdManifest(paths, expectedVaultId) {
    let raw;
    try {
        raw = await readFile(paths.qmdManifest, "utf8");
    }
    catch {
        return { version: QMD_MANIFEST_VERSION, vaultId: expectedVaultId, entries: {} };
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        throw new Error("qmd_manifest_invalid: manifest is not valid JSON");
    }
    if (typeof data !== "object" ||
        data === null ||
        data.version !== QMD_MANIFEST_VERSION) {
        throw new Error("qmd_manifest_invalid: unsupported manifest version");
    }
    const vaultId = data.vaultId;
    if (typeof vaultId !== "string" || vaultId !== expectedVaultId) {
        throw new Error("qmd_manifest_invalid: manifest vaultId mismatch");
    }
    const rawEntries = data.entries;
    if (typeof rawEntries !== "object" || rawEntries === null) {
        throw new Error("qmd_manifest_invalid: manifest entries missing");
    }
    const entries = {};
    const wikiRoot = resolve(paths.wiki) + sep;
    for (const [key, value] of Object.entries(rawEntries)) {
        // Reject absolute keys and traversal keys before trusting any entry.
        if (isAbsolute(key) || key.includes("\\") || key.split("/").includes("..")) {
            throw new Error("qmd_manifest_invalid: unsafe manifest key");
        }
        const entry = value;
        if (typeof entry !== "object" ||
            entry === null ||
            typeof entry.sourcePath !== "string" ||
            typeof entry.pageId !== "string" ||
            typeof entry.contentHash !== "string" ||
            typeof entry.type !== "string" ||
            (entry.role !== "canonical" && entry.role !== "evidence")) {
            throw new Error("qmd_manifest_invalid: malformed manifest entry");
        }
        // The key is deterministic: documents/<role>/<pageId>.md. The entry must
        // match both the role and page id encoded in its key.
        if (!key.startsWith("documents/")) {
            throw new Error("qmd_manifest_invalid: manifest key outside documents");
        }
        const rest = key.slice("documents/".length);
        const slash = rest.indexOf("/");
        if (slash <= 0 || !rest.endsWith(".md")) {
            throw new Error("qmd_manifest_invalid: manifest key lacks role/page id");
        }
        const keyRole = rest.slice(0, slash);
        const keyPageId = rest.slice(slash + 1, -3);
        if (keyRole !== entry.role || keyPageId !== entry.pageId || keyPageId === "") {
            throw new Error("qmd_manifest_invalid: manifest key/entry mismatch");
        }
        if (entry.vaultId !== vaultId) {
            throw new Error("qmd_manifest_invalid: entry vaultId mismatch");
        }
        if (entry.type.trim() === "") {
            throw new Error("qmd_manifest_invalid: entry type is empty");
        }
        if (!/^[0-9a-f]{64}$/.test(entry.contentHash)) {
            throw new Error("qmd_manifest_invalid: entry contentHash is not a sha256 hex");
        }
        // Source paths are authoritative page files under paths.wiki, therefore
        // under paths.root and outside paths.qmd.
        const source = resolve(entry.sourcePath);
        if (!isAbsolute(entry.sourcePath) || !source.startsWith(wikiRoot)) {
            throw new Error("qmd_manifest_invalid: entry sourcePath outside wiki");
        }
        entries[key] = entry;
    }
    return { version: QMD_MANIFEST_VERSION, vaultId, entries };
}
function mirrorDiagnostic(code, path, message) {
    return { severity: "warning", code, path, message };
}
/**
 * Reconcile the generated QMD mirror against parser-valid authoritative pages.
 * Publishes a validated manifest and only writes/removes generated files.
 */
export async function reconcileQmdMirror(paths, vaultId, scope) {
    const diagnostics = [];
    const discovery = discoverKnowledgeDocuments(paths);
    diagnostics.push(...discovery.diagnostics);
    let prior;
    try {
        prior = await readQmdManifest(paths, vaultId);
    }
    catch (error) {
        prior = { version: QMD_MANIFEST_VERSION, vaultId, entries: {} };
        diagnostics.push(mirrorDiagnostic("qmd_manifest_invalid", paths.qmdManifest, error.message));
    }
    // Build the desired manifest from parser-valid documents. Serialize each
    // document once; the mirror file and its content hash use that exact string.
    const desired = { version: QMD_MANIFEST_VERSION, vaultId, entries: {} };
    const serializedByKey = new Map();
    for (const doc of discovery.documents) {
        const role = roleForDocumentType(doc.frontmatter.type);
        const key = manifestKey(role, doc.id);
        const serialized = serializeKnowledgeDocument(doc);
        serializedByKey.set(key, serialized);
        desired.entries[key] = {
            sourcePath: doc.absolutePath,
            vaultId,
            pageId: doc.id,
            contentHash: hashQmdContent(serialized),
            role,
            type: String(doc.frontmatter.type),
        };
    }
    const counts = { indexed: 0, updated: 0, unchanged: 0, removed: 0 };
    // Determine which prior entries are unsafe (deleted, malformed, or role-moved)
    // and must be removed from the manifest before files change.
    const removedEntries = {};
    for (const [key, entry] of Object.entries(prior.entries)) {
        const desiredEntry = desired.entries[key];
        if (!desiredEntry || desiredEntry.pageId !== entry.pageId) {
            removedEntries[key] = entry;
        }
    }
    if (Object.keys(removedEntries).length > 0) {
        const intermediate = {
            version: QMD_MANIFEST_VERSION,
            vaultId,
            entries: Object.fromEntries(Object.entries(prior.entries).filter(([key]) => !removedEntries[key])),
        };
        await atomicWrite(paths.qmdManifest, JSON.stringify(intermediate, null, 2));
    }
    // Write new/changed mirror files.
    for (const [key, entry] of Object.entries(desired.entries)) {
        const priorEntry = prior.entries[key];
        const mirrorPath = manifestKeyToPath(paths, key);
        const content = serializedByKey.get(key) ?? "";
        const changed = !priorEntry || priorEntry.contentHash !== entry.contentHash;
        if (scope === "all" || changed) {
            // Full scope still rewrites every file; count unchanged pages by their
            // content identity so the totals reconcile with the final manifest.
            if (changed) {
                await atomicWrite(mirrorPath, content);
                if (!priorEntry)
                    counts.indexed++;
                else
                    counts.updated++;
            }
            else {
                counts.unchanged++;
            }
        }
        else {
            counts.unchanged++;
        }
    }
    // Remove orphaned generated files that are no longer in the desired manifest.
    await removeOrphans(paths, desired);
    // Final desired manifest.
    await atomicWrite(paths.qmdManifest, JSON.stringify(desired, null, 2));
    counts.removed = Object.keys(removedEntries).length;
    // Remove generated mirror files for removed entries.
    for (const key of Object.keys(removedEntries)) {
        try {
            await rm(manifestKeyToPath(paths, key), { force: true });
        }
        catch {
            // Already absent.
        }
    }
    const finalManifest = desired;
    return {
        manifest: finalManifest,
        manifestHash: hashQmdManifest(finalManifest),
        counts,
        diagnostics,
    };
}
/**
 * Remove generated mirror files under documents/ that are not referenced by the
 * desired manifest, plus empty directories. Does not follow symlinks.
 */
async function removeOrphans(paths, desired) {
    const documentsRoot = join(paths.qmd, "documents");
    const referenced = new Set(Object.keys(desired.entries));
    async function walk(dir) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        let isEmpty = true;
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                let stillEmpty;
                try {
                    stillEmpty = (await readdir(full)).length === 0;
                }
                catch {
                    stillEmpty = true;
                }
                if (stillEmpty) {
                    try {
                        await rm(full, { recursive: false, force: true });
                    }
                    catch {
                        // Ignore
                    }
                }
                else {
                    isEmpty = false;
                }
            }
            else if (entry.name.endsWith(".md")) {
                // Manifest keys are rooted at paths.qmd (e.g. "documents/canonical/...").
                const rel = relative(paths.qmd, full).split(sep).join("/");
                if (!referenced.has(rel)) {
                    try {
                        await rm(full, { force: true });
                    }
                    catch {
                        // Ignore
                    }
                }
                else {
                    isEmpty = false;
                }
            }
            else {
                isEmpty = false;
            }
        }
        if (isEmpty && dir !== documentsRoot) {
            try {
                await rm(dir, { recursive: false, force: true });
            }
            catch {
                // Ignore
            }
        }
    }
    try {
        await stat(documentsRoot);
        await walk(documentsRoot);
    }
    catch {
        // No documents dir yet.
    }
}
/**
 * Safety-only path used when metadata projection fails: may only REMOVE mirror
 * entries for missing or rejected pages. Never adds or updates valid documents.
 */
export async function invalidateUnsafeQmdEntries(paths, vaultId) {
    const diagnostics = [];
    const discovery = discoverKnowledgeDocuments(paths);
    diagnostics.push(...discovery.diagnostics);
    let prior;
    let priorUnsafe = false;
    try {
        prior = await readQmdManifest(paths, vaultId);
    }
    catch {
        // Fail closed in the removal direction: a corrupt prior manifest cannot be
        // trusted, so treat every previously generated mirror entry as unsafe and
        // remove only files we can enumerate safely from disk.
        prior = { version: QMD_MANIFEST_VERSION, vaultId, entries: {} };
        priorUnsafe = true;
    }
    if (priorUnsafe) {
        // Remove every generated mirror file under documents/ that can be
        // enumerated safely, so stale deleted-page candidates cannot survive.
        const documentsRoot = join(paths.qmd, "documents");
        const removedFiles = [];
        async function collect(dir) {
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    await collect(full);
                }
                else if (entry.isFile() && entry.name.endsWith(".md")) {
                    removedFiles.push(full);
                }
            }
        }
        await collect(documentsRoot);
        for (const file of removedFiles) {
            try {
                await rm(file, { force: true });
            }
            catch {
                // Already absent.
            }
        }
        await atomicWrite(paths.qmdManifest, JSON.stringify({ version: QMD_MANIFEST_VERSION, vaultId, entries: {} }, null, 2));
        return {
            manifest: { version: QMD_MANIFEST_VERSION, vaultId, entries: {} },
            manifestHash: hashQmdManifest({ version: QMD_MANIFEST_VERSION, vaultId, entries: {} }),
            counts: { indexed: 0, updated: 0, unchanged: 0, removed: removedFiles.length },
            diagnostics: [
                ...diagnostics,
                {
                    severity: "warning",
                    code: "qmd_manifest_invalid",
                    path: paths.qmdManifest,
                    message: "Corrupt QMD manifest during invalidation; removed generated mirror entries fail-closed",
                },
            ],
        };
    }
    // The set of still-valid mirror entries (present and parser-valid now).
    const validHashes = new Map();
    for (const doc of discovery.documents) {
        const role = roleForDocumentType(doc.frontmatter.type);
        const key = manifestKey(role, doc.id);
        const serialized = serializeKnowledgeDocument(doc);
        validHashes.set(key, hashQmdContent(serialized));
    }
    const removed = {};
    const kept = {};
    for (const [key, entry] of Object.entries(prior.entries)) {
        if (!validHashes.has(key)) {
            removed[key] = entry;
        }
        else {
            kept[key] = entry;
        }
    }
    if (Object.keys(removed).length > 0) {
        await atomicWrite(paths.qmdManifest, JSON.stringify({ version: QMD_MANIFEST_VERSION, vaultId, entries: kept }, null, 2));
        for (const key of Object.keys(removed)) {
            try {
                await rm(manifestKeyToPath(paths, key), { force: true });
            }
            catch {
                // Already absent.
            }
        }
    }
    const finalManifest = { version: QMD_MANIFEST_VERSION, vaultId, entries: kept };
    return {
        manifest: finalManifest,
        manifestHash: hashQmdManifest(finalManifest),
        counts: { indexed: 0, updated: 0, unchanged: 0, removed: Object.keys(removed).length },
        diagnostics,
    };
}
