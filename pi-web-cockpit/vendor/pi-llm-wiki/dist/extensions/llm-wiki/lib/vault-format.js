import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseKnowledgeDocument, parseMarkdownFrontmatter, } from "./knowledge-document.js";
import { relativePhysicalPath } from "./utils.js";
export class VaultWriteError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics[0]?.message ?? "Wiki vault is not writable");
        this.diagnostics = diagnostics;
        this.name = "VaultWriteError";
    }
}
const RESERVED_NAMES = new Set(["index", "log"]);
export function compareCodePoint(a, b) {
    const left = a.normalize("NFC");
    const right = b.normalize("NFC");
    return left < right ? -1 : left > right ? 1 : 0;
}
function diag(severity, code, path, message) {
    return { severity, code, path, message };
}
function isReservedName(filename) {
    const name = filename.toLowerCase();
    return name === "index.md" || name === "log.md";
}
export function readVaultConfig(paths) {
    const path = join(paths.dotWiki, "config.json");
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("config.json must contain an object");
        }
        return { ok: true, config: parsed };
    }
    catch (error) {
        return {
            ok: false,
            diagnostic: diag("error", "config_invalid_knowledge_format", "config.json", `Cannot read valid wiki config: ${error.message}`),
        };
    }
}
export function inspectVaultFormat(paths) {
    const diagnostics = [];
    let blocking = false;
    const configResult = readVaultConfig(paths);
    if (!configResult.ok) {
        return {
            knowledgeFormat: "legacy",
            diagnostics: [configResult.diagnostic],
            blocking: true,
        };
    }
    const config = configResult.config;
    const rawFormat = config.knowledge_format;
    // Resolve format
    let format;
    if (rawFormat === undefined) {
        format = "legacy";
    }
    else if (rawFormat === "legacy" || rawFormat === "okf-0.2") {
        format = rawFormat;
    }
    else {
        return {
            knowledgeFormat: "legacy",
            diagnostics: [
                diag("error", "config_invalid_knowledge_format", "config.json", `Invalid knowledge_format value: ${JSON.stringify(rawFormat)}`),
            ],
            blocking: true,
        };
    }
    // In OKF mode, check root index version
    // Missing root index is repairable; version mismatch blocks until explicitly handled
    if (format === "okf-0.2") {
        const rootIndexPath = join(paths.wiki, "index.md");
        let rootContent;
        try {
            rootContent = readFileSync(rootIndexPath, "utf8");
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                diagnostics.push(diag("error", "okf_version_mismatch", "wiki/index.md", `Cannot read OKF root index: ${error.message}`));
                blocking = true;
            }
        }
        if (rootContent !== undefined) {
            const frontmatter = parseMarkdownFrontmatter(rootContent, "index.md");
            if (!frontmatter.ok || frontmatter.mapping.okf_version !== "0.2") {
                diagnostics.push(diag("error", "okf_version_mismatch", "wiki/index.md", frontmatter.ok
                    ? 'OKF root index must declare okf_version "0.2"'
                    : `Malformed OKF root index: ${frontmatter.diagnostics[0].message}`));
                blocking = true;
            }
        }
    }
    // In legacy mode, check if root index declares unsupported version
    if (format === "legacy") {
        const rootIndexPath = join(paths.wiki, "index.md");
        try {
            const content = readFileSync(rootIndexPath, "utf8");
            const frontmatter = parseMarkdownFrontmatter(content, "index.md");
            if (frontmatter.ok && frontmatter.mapping.okf_version !== undefined) {
                if (frontmatter.mapping.okf_version !== "0.2") {
                    diagnostics.push(diag("error", "okf_version_mismatch", "wiki/index.md", `Root index declares unsupported okf_version "${frontmatter.mapping.okf_version}"`));
                    blocking = true;
                }
            }
        }
        catch {
            // No root index in legacy mode - fine
        }
    }
    return {
        knowledgeFormat: format,
        diagnostics,
        blocking,
    };
}
function collectMarkdownFiles(dir, wikiRoot) {
    const files = [];
    const diagnostics = [];
    let entries;
    try {
        entries = readdirSync(dir).sort(compareCodePoint);
    }
    catch (error) {
        diagnostics.push(diag("error", "frontmatter_parse_error", relative(wikiRoot, dir).replace(/\\/g, "/") || ".", `Failed to scan knowledge directory: ${error.message}`));
        return { files, diagnostics };
    }
    for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
            const stat = lstatSync(fullPath);
            if (stat.isSymbolicLink())
                continue;
            if (stat.isDirectory()) {
                const child = collectMarkdownFiles(fullPath, wikiRoot);
                files.push(...child.files);
                diagnostics.push(...child.diagnostics);
            }
            else if (stat.isFile() && entry.toLowerCase().endsWith(".md") && !isReservedName(entry)) {
                files.push(fullPath);
            }
        }
        catch (error) {
            diagnostics.push(diag("error", "frontmatter_parse_error", relative(wikiRoot, fullPath).replace(/\\/g, "/"), `Failed to inspect knowledge path: ${error.message}`));
        }
    }
    return { files, diagnostics };
}
/** Validate vault is writable: exists, valid mode, no blocking version mismatch. */
export function inspectWritableVault(paths) {
    // Check vault exists
    if (!existsSync(paths.dotWiki)) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "config_invalid_knowledge_format", paths.dotWiki, "Wiki vault not found. Run wiki_bootstrap first."),
            ],
        };
    }
    const state = inspectVaultFormat(paths);
    if (state.blocking) {
        return { ok: false, diagnostics: state.diagnostics };
    }
    return { ok: true, format: state.knowledgeFormat };
}
/** Assert that an authoritative writer may mutate this vault. */
export function assertWritableVault(paths) {
    const result = inspectWritableVault(paths);
    if (!result.ok)
        throw new VaultWriteError(result.diagnostics);
    return result.format;
}
/** Check if path is a generated OKF reserved file (mode-aware). */
export function isGeneratedOkfPath(path, paths) {
    const state = inspectVaultFormat(paths);
    if (state.blocking || state.knowledgeFormat !== "okf-0.2")
        return false;
    const rel = relativePhysicalPath(paths.wiki, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        return false;
    const parts = rel.split(sep);
    const name = parts.at(-1)?.toLowerCase();
    return name === "index.md" || (parts.length === 1 && name === "log.md");
}
export function discoverKnowledgeDocuments(paths) {
    const diagnostics = [];
    const documents = [];
    let blocking = false;
    const seenIds = new Map();
    const scan = collectMarkdownFiles(paths.wiki, paths.wiki);
    diagnostics.push(...scan.diagnostics);
    if (scan.diagnostics.length > 0)
        blocking = true;
    for (const file of scan.files) {
        const physicalPath = relative(paths.wiki, file).replace(/\\/g, "/");
        const normalizedPath = physicalPath.normalize("NFC");
        const id = normalizedPath.replace(/\.md$/, "");
        // Check for reserved names (case-insensitive)
        const filename = (normalizedPath.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase();
        if (RESERVED_NAMES.has(filename)) {
            continue;
        }
        // Check for identity collision
        const collisionKey = id.toLowerCase();
        const existing = seenIds.get(collisionKey);
        if (existing && existing.physicalPath !== physicalPath) {
            diagnostics.push(diag("error", "concept_identity_collision", physicalPath, `Identity collision between ${existing.physicalPath} and ${physicalPath}`));
            blocking = true;
            continue;
        }
        seenIds.set(collisionKey, { id, physicalPath });
        // Parse the document
        try {
            const content = readFileSync(file, "utf8");
            const result = parseKnowledgeDocument(content, normalizedPath);
            if (!result.ok) {
                diagnostics.push(...result.diagnostics);
                blocking = true;
                continue;
            }
            const doc = result.document;
            if (result.diagnostics.length > 0) {
                diagnostics.push(...result.diagnostics);
            }
            documents.push({
                ...doc,
                id,
                path: normalizedPath,
                absolutePath: file,
            });
        }
        catch (e) {
            const err = e;
            diagnostics.push(diag("error", "frontmatter_parse_error", normalizedPath, `Failed to read file: ${err.message}`));
            blocking = true;
        }
    }
    // Sort documents by code point order
    documents.sort((a, b) => compareCodePoint(a.id, b.id));
    return {
        documents,
        diagnostics,
        blocking,
    };
}
