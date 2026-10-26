import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createKnowledgeDocument, parseKnowledgeDocument, parseMarkdownFrontmatter, serializeKnowledgeDocument, } from "./knowledge-document.js";
import { readJson } from "./utils.js";
import { discoverKnowledgeDocuments, inspectVaultFormat } from "./vault-format.js";
const RECOVERABLE = new Set([
    "frontmatter_missing",
    "frontmatter_parse_error",
    "concept_missing_type",
]);
const TRANSACTION_PREFIX = "legacy-repair-";
const JOURNAL_NAME = "journal.json";
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
function inferredType(path, registryType) {
    if (typeof registryType === "string" && registryType.trim())
        return registryType;
    const folder = path.split("/")[0];
    return ({
        sources: "source",
        entities: "entity",
        concepts: "concept",
        syntheses: "synthesis",
        analyses: "analysis",
        requirements: "requirement",
        skills: "skill",
        cases: "case",
    }[folder] ?? "concept");
}
function inferredTitle(path, content, registryTitle) {
    if (typeof registryTitle === "string" && registryTitle.trim())
        return registryTitle;
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading)
        return heading;
    return basename(path, ".md").replace(/[-_]+/g, " ").trim() || "Recovered page";
}
function splitBrokenFrontmatter(content) {
    const normalized = content.replace(/\r\n?/g, "\n");
    if (!normalized.startsWith("---\n"))
        return { raw: "", body: normalized };
    const closing = normalized.indexOf("\n---\n", 4);
    if (closing === -1) {
        throw new Error("Cannot safely repair frontmatter without an unambiguous closing delimiter");
    }
    return {
        raw: normalized.slice(4, closing),
        body: normalized.slice(closing + 5).replace(/^\n/, ""),
    };
}
function repairedContent(path, content, diagnostics, type, title) {
    if (diagnostics.includes("concept_missing_type")) {
        const parsed = parseMarkdownFrontmatter(content, path);
        if (parsed.ok) {
            const candidate = content.replace(/^---\r?\n/, `---\ntype: ${JSON.stringify(type)}\n`);
            if (parseKnowledgeDocument(candidate, path).ok)
                return candidate;
        }
    }
    const broken = splitBrokenFrontmatter(content);
    return serializeKnowledgeDocument(createKnowledgeDocument(path, {
        type,
        title,
        legacy_repair: true,
        ...(broken.raw ? { legacy_frontmatter: broken.raw } : {}),
    }, broken.body));
}
function containedPath(root, path, physicalRoot = root) {
    const target = resolve(root, path);
    const relation = relative(root, target);
    if (relation === "" ||
        relation === ".." ||
        relation.startsWith(`..${sep}`) ||
        isAbsolute(relation)) {
        throw new Error(`Unsafe legacy repair path: ${path}`);
    }
    let current = resolve(physicalRoot);
    const physicalRelation = relative(current, target);
    if (physicalRelation === ".." ||
        physicalRelation.startsWith(`..${sep}`) ||
        isAbsolute(physicalRelation)) {
        throw new Error(`Unsafe legacy repair path: ${path}`);
    }
    for (const part of ["", ...physicalRelation.split(sep)]) {
        if (part)
            current = join(current, part);
        if (!existsSync(current))
            break;
        if (lstatSync(current).isSymbolicLink()) {
            throw new Error(`Legacy repair refuses symlinked path: ${current}`);
        }
    }
    return target;
}
function syncDirectory(path) {
    let handle;
    try {
        handle = openSync(path, "r");
        fsyncSync(handle);
    }
    catch (error) {
        if (process.platform !== "win32")
            throw error;
    }
    finally {
        if (handle !== undefined)
            closeSync(handle);
    }
}
function ensurePrivateParent(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}
function durableWriteNew(path, content) {
    ensurePrivateParent(path);
    const handle = openSync(path, "wx", 0o600);
    try {
        writeFileSync(handle, content);
        fsyncSync(handle);
    }
    finally {
        closeSync(handle);
    }
    syncDirectory(dirname(path));
}
function atomicWriteJson(path, value) {
    ensurePrivateParent(path);
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
    durableWriteNew(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
}
function prepareReplacement(path, content, metadata) {
    const mode = metadata.mode & 0o7777;
    let created = false;
    try {
        const existing = readFileSync(path);
        if (sha256(existing) !== sha256(content)) {
            throw new Error(`Legacy repair temporary file changed: ${path}`);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        const handle = openSync(path, "wx", mode);
        try {
            writeFileSync(handle, content);
            fsyncSync(handle);
            created = true;
        }
        finally {
            closeSync(handle);
        }
    }
    if (!created) {
        chmodSync(path, mode);
        utimesSync(path, new Date(metadata.atime_ms), new Date(metadata.mtime_ms));
    }
    chmodSync(path, mode);
    utimesSync(path, new Date(metadata.atime_ms), new Date(metadata.mtime_ms));
    syncDirectory(dirname(path));
}
function readRegularFile(path) {
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = openSync(path, flags);
    try {
        const stat = fstatSync(handle);
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new Error(`Legacy repair requires a regular, non-hard-linked file: ${path}`);
        }
        return { stat, content: readFileSync(handle) };
    }
    finally {
        closeSync(handle);
    }
}
function installReplacement(paths, pagePath, repaired, entry, transactionDir) {
    const preparedPath = `${pagePath}.legacy-repair-${entry.after_sha256.slice(0, 16)}`;
    const displacedPath = containedPath(join(transactionDir, "displaced"), entry.path, paths.root);
    containedPath(paths.wiki, entry.path, paths.root);
    containedPath(paths.wiki, relative(paths.wiki, preparedPath), paths.root);
    ensurePrivateParent(displacedPath);
    prepareReplacement(preparedPath, repaired, entry);
    if (existsSync(pagePath) && !existsSync(displacedPath)) {
        renameSync(pagePath, displacedPath);
        syncDirectory(dirname(pagePath));
        syncDirectory(dirname(displacedPath));
    }
    if (!existsSync(displacedPath) || sha256(readFileSync(displacedPath)) !== entry.before_sha256) {
        if (!existsSync(pagePath) && existsSync(displacedPath)) {
            renameSync(displacedPath, pagePath);
            syncDirectory(dirname(pagePath));
            syncDirectory(dirname(displacedPath));
        }
        if (existsSync(preparedPath))
            unlinkSync(preparedPath);
        throw new Error(`Legacy page changed during repair: ${entry.path}`);
    }
    try {
        linkSync(preparedPath, pagePath);
        syncDirectory(dirname(pagePath));
        unlinkSync(preparedPath);
        syncDirectory(dirname(preparedPath));
    }
    catch (error) {
        if (existsSync(preparedPath))
            unlinkSync(preparedPath);
        throw error;
    }
}
function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function acquireLock(paths) {
    const path = join(paths.dotWiki, ".legacy-repair.lock");
    const operationId = randomUUID();
    const content = `${JSON.stringify({ operation_id: operationId, pid: process.pid, started: new Date().toISOString() })}\n`;
    try {
        durableWriteNew(path, content);
        return { path, operationId };
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    let observed;
    let current;
    try {
        observed = readFileSync(path, "utf8");
        current = JSON.parse(observed);
    }
    catch {
        throw new Error(`Legacy repair lock is unreadable: ${path}`);
    }
    if (processAlive(current.pid))
        throw new Error(`Legacy repair is already running: ${path}`);
    const takeoverPath = `${path}.takeover`;
    const takeoverId = randomUUID();
    try {
        durableWriteNew(takeoverPath, `${takeoverId}\n`);
    }
    catch (error) {
        if (error.code === "EEXIST") {
            throw new Error(`Legacy repair lock takeover is already running: ${takeoverPath}`);
        }
        throw error;
    }
    try {
        if (readFileSync(path, "utf8") !== observed || processAlive(current.pid)) {
            throw new Error(`Legacy repair lock changed during takeover: ${path}`);
        }
        unlinkSync(path);
        syncDirectory(dirname(path));
        durableWriteNew(path, content);
    }
    finally {
        if (existsSync(takeoverPath) && readFileSync(takeoverPath, "utf8") === `${takeoverId}\n`) {
            unlinkSync(takeoverPath);
            syncDirectory(dirname(takeoverPath));
        }
    }
    return { path, operationId };
}
function releaseLock(lock) {
    if (!existsSync(lock.path))
        return;
    const current = JSON.parse(readFileSync(lock.path, "utf8"));
    if (current.operation_id !== lock.operationId)
        return;
    unlinkSync(lock.path);
    syncDirectory(dirname(lock.path));
}
function inProgressJournal(paths) {
    if (!existsSync(paths.outputs))
        return undefined;
    const journals = readdirSync(paths.outputs)
        .filter((entry) => entry.startsWith(TRANSACTION_PREFIX))
        .map((entry) => join(paths.outputs, entry, JOURNAL_NAME))
        .filter(existsSync);
    if (journals.length > 1)
        throw new Error("Multiple incomplete legacy repair journals found");
    return journals[0];
}
function readJournal(path, paths) {
    const journal = JSON.parse(readFileSync(path, "utf8"));
    if (journal.version !== 1 ||
        journal.root !== paths.root ||
        typeof journal.operation_id !== "string" ||
        !Array.isArray(journal.entries) ||
        !Array.isArray(journal.completed)) {
        throw new Error(`Invalid legacy repair journal: ${path}`);
    }
    return journal;
}
function applyJournal(paths, journalPath, journal, diagnostics, afterCheckpoint, beforeCommit) {
    const transactionDir = dirname(journalPath);
    for (const entry of journal.entries) {
        const pagePath = containedPath(paths.wiki, entry.path, paths.root);
        const backupPath = containedPath(join(transactionDir, "wiki"), entry.path, paths.root);
        const repairedPath = containedPath(join(transactionDir, "repaired"), entry.path, paths.root);
        const backup = readFileSync(backupPath);
        const repaired = readFileSync(repairedPath);
        if (sha256(backup) !== entry.before_sha256 || sha256(repaired) !== entry.after_sha256) {
            throw new Error(`Legacy repair transaction verification failed: ${entry.path}`);
        }
        const currentHash = existsSync(pagePath) ? sha256(readFileSync(pagePath)) : undefined;
        if (currentHash === entry.before_sha256 || currentHash === undefined) {
            beforeCommit?.(entry.path);
            installReplacement(paths, pagePath, repaired, entry, transactionDir);
        }
        else if (currentHash !== entry.after_sha256) {
            throw new Error(`Legacy page changed during repair: ${entry.path}`);
        }
        const preparedPath = `${pagePath}.legacy-repair-${entry.after_sha256.slice(0, 16)}`;
        if (existsSync(preparedPath)) {
            if (sha256(readFileSync(preparedPath)) !== entry.after_sha256) {
                throw new Error(`Legacy repair temporary file changed: ${preparedPath}`);
            }
            unlinkSync(preparedPath);
            syncDirectory(dirname(preparedPath));
        }
        if (!journal.completed.includes(entry.path)) {
            journal.completed.push(entry.path);
            atomicWriteJson(journalPath, journal);
            afterCheckpoint?.(entry.path);
        }
    }
    const manifestPath = join(transactionDir, "manifest.json");
    atomicWriteJson(manifestPath, {
        version: 1,
        repaired_at: new Date().toISOString(),
        entries: journal.entries.map(({ mode: _mode, atime_ms: _atime, mtime_ms: _mtime, ...entry }) => ({
            ...entry,
            displaced: relative(paths.root, containedPath(join(transactionDir, "displaced"), entry.path, paths.root)).replace(/\\/g, "/"),
        })),
    });
    unlinkSync(journalPath);
    syncDirectory(transactionDir);
    return {
        repaired: journal.entries.length,
        backupDir: transactionDir,
        manifestPath,
        entries: journal.entries,
        diagnostics,
    };
}
function createJournal(paths, diagnostics, operationId, now) {
    const byPath = new Map();
    for (const diagnostic of diagnostics) {
        if (!RECOVERABLE.has(diagnostic.code))
            continue;
        const current = byPath.get(diagnostic.path) ?? [];
        current.push(diagnostic);
        byPath.set(diagnostic.path, current);
    }
    if (byPath.size === 0)
        return undefined;
    mkdirSync(paths.outputs, { recursive: true });
    const transactionDir = join(paths.outputs, `${TRANSACTION_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}-${operationId}`);
    mkdirSync(transactionDir, { mode: 0o700 });
    syncDirectory(paths.outputs);
    const registry = readJson(join(paths.meta, "registry.json"), {});
    const entries = [];
    for (const [path, pathDiagnostics] of [...byPath].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
        const pagePath = containedPath(paths.wiki, path, paths.root);
        const { stat, content: original } = readRegularFile(pagePath);
        const content = original.toString("utf8");
        if (!Buffer.from(content).equals(original))
            throw new Error(`Legacy page is not UTF-8: ${path}`);
        const id = path.replace(/\.md$/i, "");
        const registryEntry = registry.pages?.[id];
        const type = inferredType(path, registryEntry?.type);
        const title = inferredTitle(path, content, registryEntry?.title);
        const codes = [...new Set(pathDiagnostics.map((diagnostic) => diagnostic.code))];
        const repaired = Buffer.from(repairedContent(path, content, codes, type, title));
        if (!parseKnowledgeDocument(repaired.toString("utf8"), path).ok) {
            throw new Error(`Repair did not produce a valid page: ${path}`);
        }
        const backupPath = containedPath(join(transactionDir, "wiki"), path, paths.root);
        const repairedPath = containedPath(join(transactionDir, "repaired"), path, paths.root);
        durableWriteNew(backupPath, original);
        durableWriteNew(repairedPath, repaired);
        entries.push({
            path,
            backup: relative(paths.root, backupPath).replace(/\\/g, "/"),
            before_sha256: sha256(original),
            after_sha256: sha256(repaired),
            diagnostics: codes,
            mode: Number(stat.mode),
            atime_ms: Number(stat.atimeMs),
            mtime_ms: Number(stat.mtimeMs),
        });
    }
    const journal = {
        version: 1,
        operation_id: operationId,
        root: paths.root,
        started: now.toISOString(),
        entries,
        completed: [],
    };
    const path = join(transactionDir, JOURNAL_NAME);
    atomicWriteJson(path, journal);
    return { path, journal };
}
/** Repair malformed legacy pages with durable backups and crash-resumable checkpoints. */
export function repairLegacyKnowledgeDocuments(paths, now = new Date(), afterCheckpoint, beforeCommit) {
    containedPath(paths.root, relative(paths.root, paths.dotWiki), paths.root);
    containedPath(paths.root, relative(paths.root, paths.wiki), paths.root);
    containedPath(paths.root, relative(paths.root, paths.outputs), paths.root);
    const initialState = inspectVaultFormat(paths);
    if (initialState.knowledgeFormat !== "legacy") {
        return { repaired: 0, entries: [], diagnostics: initialState.diagnostics };
    }
    const lock = acquireLock(paths);
    try {
        const state = inspectVaultFormat(paths);
        const discovery = discoverKnowledgeDocuments(paths);
        if (state.knowledgeFormat !== "legacy") {
            return { repaired: 0, entries: [], diagnostics: discovery.diagnostics };
        }
        const existing = inProgressJournal(paths);
        if (existing) {
            return applyJournal(paths, existing, readJournal(existing, paths), discovery.diagnostics, afterCheckpoint, beforeCommit);
        }
        const created = createJournal(paths, discovery.diagnostics, lock.operationId, now);
        if (!created)
            return { repaired: 0, entries: [], diagnostics: discovery.diagnostics };
        return applyJournal(paths, created.path, created.journal, discovery.diagnostics, afterCheckpoint, beforeCommit);
    }
    finally {
        releaseLock(lock);
    }
}
