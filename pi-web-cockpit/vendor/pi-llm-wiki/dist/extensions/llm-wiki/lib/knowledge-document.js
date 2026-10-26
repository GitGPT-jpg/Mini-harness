import { readFileSync, writeFileSync } from "node:fs";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, stringify } from "yaml";
export const FRONTMATTER_MAX_BYTES = 128 * 1024;
export const FRONTMATTER_MAX_DEPTH = 32;
const STANDARD_FIELDS = new Set([
    "type",
    "title",
    "description",
    "resource",
    "tags",
    "sources",
    "generated",
    "verified",
    "status",
    "stale_after",
    "category",
    "domain",
    "aliases",
    "recall_triggers",
    "created",
    "updated",
    "summary",
    "raw_path",
    "source_id",
]);
const LEGACY_COMPAT_FIELDS = new Set(["created", "updated", "summary", "raw_path", "source_id"]);
function diag(severity, code, path, message, line, column) {
    return { severity, code, path, message, line, column };
}
function classifySources(raw) {
    if (raw === undefined)
        return { kind: "absent" };
    if (raw === null)
        return { kind: "unknown-shape", value: null };
    if (typeof raw === "string")
        return { kind: "legacy-scalar", value: raw };
    if (Array.isArray(raw)) {
        if (raw.every((v) => typeof v === "string")) {
            return { kind: "legacy-list", value: raw };
        }
        if (raw.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
            return { kind: "canonical", value: raw };
        }
    }
    return { kind: "unknown-shape", value: raw };
}
function hasAlias(node) {
    if (isAlias(node))
        return true;
    if (isMap(node)) {
        return node.items.some((item) => hasAlias(item.key) || hasAlias(item.value));
    }
    if (isSeq(node)) {
        return node.items.some((item) => hasAlias(item));
    }
    return false;
}
function hasCustomTag(node) {
    if (node && typeof node === "object" && "tag" in node && typeof node.tag === "string") {
        if (node.tag.startsWith("!"))
            return true;
    }
    if (isMap(node)) {
        return node.items.some((item) => hasCustomTag(item.key) || hasCustomTag(item.value));
    }
    if (isSeq(node)) {
        return node.items.some((item) => hasCustomTag(item));
    }
    return false;
}
function maxDepth(node, current) {
    if (isMap(node)) {
        let deepest = current + 1;
        for (const item of node.items) {
            deepest = Math.max(deepest, maxDepth(item.key, current + 1), maxDepth(item.value, current + 1));
        }
        return deepest;
    }
    if (isSeq(node)) {
        let deepest = current + 1;
        for (const item of node.items) {
            deepest = Math.max(deepest, maxDepth(item, current + 1));
        }
        return deepest;
    }
    return current;
}
function toKnowledgeValue(node) {
    if (node === null)
        return null;
    if (isScalar(node)) {
        const v = node.value;
        if (v === null)
            return null;
        if (typeof v === "boolean" || typeof v === "number" || typeof v === "string")
            return v;
        return String(v);
    }
    if (isSeq(node)) {
        return node.items.map(toKnowledgeValue);
    }
    if (isMap(node)) {
        const obj = Object.create(null);
        for (const item of node.items) {
            const key = String(isScalar(item.key) ? item.key.value : item.key);
            obj[key] = toKnowledgeValue(item.value);
        }
        return obj;
    }
    return null;
}
function detectLegacyWikilinks(body) {
    return /\[\[[^\]]+\]\]/.test(body);
}
function parseFrontmatterBlock(content, path, requireType) {
    const diagnostics = [];
    // Normalize line endings
    const normalized = content.replace(/\r\n?/g, "\n");
    // Require opening --- on line 1
    if (!normalized.startsWith("---\n")) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_missing", path, "Missing frontmatter opening delimiter"),
            ],
        };
    }
    // Find closing ---
    // Per spec: when a candidate immediately follows a YAML explicit-end line ...
    // and another delimiter exists later, treat that candidate as an internal
    // second-document marker and continue to the later closing fence.
    let closingIndex = -1;
    let i = 4; // skip opening ---\n
    const candidates = [];
    let lastLineWasExplicitEnd = false;
    while (i < normalized.length) {
        const newlinePos = normalized.indexOf("\n", i);
        const lineEnd = newlinePos === -1 ? normalized.length : newlinePos;
        const line = normalized.slice(i, lineEnd);
        if (line === "---") {
            candidates.push({ index: i, followsExplicitEnd: lastLineWasExplicitEnd });
            lastLineWasExplicitEnd = false;
        }
        else if (line === "...") {
            lastLineWasExplicitEnd = true;
        }
        else {
            lastLineWasExplicitEnd = false;
        }
        i = lineEnd + 1;
    }
    // Find the proper closing fence
    if (candidates.length === 1) {
        closingIndex = candidates[0].index;
    }
    else if (candidates.length > 1) {
        // If first candidate follows explicit end and there's another later,
        // skip the first (it's a second-document marker)
        if (candidates[0].followsExplicitEnd && candidates.length >= 2) {
            closingIndex = candidates[1].index;
        }
        else {
            closingIndex = candidates[0].index;
        }
    }
    if (closingIndex === -1) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_parse_error", path, "Missing frontmatter closing delimiter"),
            ],
        };
    }
    const yamlText = normalized.slice(4, closingIndex);
    // Check byte limit
    const byteLength = Buffer.byteLength(yamlText, "utf8");
    if (byteLength > FRONTMATTER_MAX_BYTES) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_limit_bytes", path, `Frontmatter exceeds ${FRONTMATTER_MAX_BYTES} bytes`),
            ],
        };
    }
    // Parse with yaml library - use lenient mode first, then validate
    let docs;
    try {
        docs = parseAllDocuments(yamlText, {
            schema: "core",
            merge: false,
            uniqueKeys: true,
        });
    }
    catch (e) {
        const err = e;
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_parse_error", path, `YAML parse error: ${err.message}`, err.line ?? undefined, err.col ?? undefined),
            ],
        };
    }
    // YAML parser errors must be surfaced before conversion. `yaml` records
    // malformed syntax and nested duplicate keys on the Document instead of
    // throwing from parseAllDocuments.
    const yamlErrors = docs.flatMap((document) => document.errors);
    if (yamlErrors.length > 0) {
        const duplicate = yamlErrors.find((error) => error.code === "DUPLICATE_KEY");
        const error = duplicate ?? yamlErrors[0];
        return {
            ok: false,
            diagnostics: [
                diag("error", duplicate ? "frontmatter_duplicate_key" : "frontmatter_parse_error", path, `YAML parse error: ${error.message}`),
            ],
        };
    }
    // Check for multiple documents
    if (docs.length !== 1) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_multiple_documents", path, "Multiple YAML documents in frontmatter"),
            ],
        };
    }
    const doc = docs[0];
    const contents = doc.contents;
    // Must be a mapping
    if (!isMap(contents)) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_parse_error", path, "Frontmatter must be a YAML mapping"),
            ],
        };
    }
    // Check for aliases
    if (hasAlias(contents)) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_alias_forbidden", path, "YAML aliases are not allowed"),
            ],
        };
    }
    // Check for custom tags
    if (hasCustomTag(contents)) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_custom_tag_forbidden", path, "Custom YAML tags are not allowed"),
            ],
        };
    }
    // Check for duplicate keys
    const seenKeys = new Set();
    for (const item of contents.items) {
        const key = String(isScalar(item.key) ? item.key.value : item.key);
        if (seenKeys.has(key)) {
            return {
                ok: false,
                diagnostics: [
                    diag("error", "frontmatter_duplicate_key", path, `Duplicate key: ${key}`, undefined, undefined),
                ],
            };
        }
        seenKeys.add(key);
    }
    // Check depth
    const depth = maxDepth(contents, 0);
    if (depth > FRONTMATTER_MAX_DEPTH) {
        return {
            ok: false,
            diagnostics: [
                diag("error", "frontmatter_limit_depth", path, `Frontmatter nesting exceeds ${FRONTMATTER_MAX_DEPTH}`),
            ],
        };
    }
    const mapping = toKnowledgeValue(contents);
    // Build body: remove closing fence and one optional blank separator line
    let body = normalized.slice(closingIndex + 4); // skip closing ---\n
    if (body.startsWith("\n")) {
        // Remove exactly one leading blank separator line; additional leading blanks belong to body
        body = body.slice(1);
    }
    if (!requireType) {
        return {
            ok: true,
            mapping,
            body,
            diagnostics,
        };
    }
    // Require type field
    const rawType = mapping.type;
    if (typeof rawType !== "string" || rawType.trim() === "") {
        return {
            ok: false,
            diagnostics: [diag("error", "concept_missing_type", path, "Missing or empty type field")],
        };
    }
    // Classify sources
    const sources = classifySources(mapping.sources);
    // Split standard fields from extensions
    const frontmatter = { type: rawType };
    const extensions = Object.create(null);
    const legacyFields = [];
    for (const [key, value] of Object.entries(mapping)) {
        if (key === "sources")
            continue; // handled separately
        if (STANDARD_FIELDS.has(key)) {
            frontmatter[key] = value;
            if (LEGACY_COMPAT_FIELDS.has(key)) {
                legacyFields.push(key);
            }
        }
        else {
            extensions[key] = value;
        }
    }
    // Record legacy source shape
    if (sources.kind === "legacy-scalar" || sources.kind === "legacy-list") {
        legacyFields.push("sources");
    }
    const hasLegacyWikilinks = detectLegacyWikilinks(body);
    if (hasLegacyWikilinks) {
        legacyFields.push("wikilinks");
    }
    return {
        ok: true,
        document: {
            id: path.replace(/\.md$/, ""),
            path,
            frontmatter,
            sources,
            extensions,
            body,
            compatibility: {
                legacyFields,
                hasLegacyWikilinks,
            },
        },
        diagnostics,
    };
}
export function parseMarkdownFrontmatter(content, path) {
    const result = parseFrontmatterBlock(content, path, false);
    if ("ok" in result && result.ok && "mapping" in result) {
        return result;
    }
    return result;
}
export function parseKnowledgeDocument(content, path) {
    const result = parseFrontmatterBlock(content, path, true);
    return result;
}
export function serializeKnowledgeDocument(document) {
    // Rebuild mapping from frontmatter, sources, and extensions
    const mapping = Object.create(null);
    // Standard frontmatter fields (excluding sources)
    for (const key of STANDARD_FIELDS) {
        if (key === "sources")
            continue;
        const value = document.frontmatter[key];
        if (value !== undefined) {
            mapping[key] = value;
        }
    }
    // Sources
    if (document.sources.kind !== "absent") {
        mapping.sources = document.sources.value;
    }
    // Extensions
    for (const [key, value] of Object.entries(document.extensions)) {
        mapping[key] = value;
    }
    const yaml = stringify(mapping, {
        aliasDuplicateObjects: false,
        lineWidth: 0,
    })
        .replace(/\r\n?/g, "\n")
        .replace(/\n*$/, "\n");
    const body = document.body.replace(/\r\n?/g, "\n").replace(/\n*$/, "");
    return body ? `---\n${yaml}---\n\n${body}\n` : `---\n${yaml}---\n`;
}
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** Escape wikilink alias pipes only inside Markdown table rows.
 *
 * A bare `|` inside `[[target|alias]]` would be read as a table cell
 * delimiter when the row renders, so table rows need the pipe escaped as
 * `[[target\|alias]]`. Prose, lists, headings, and fenced code keep their
 * pipes literal, so the written file stays valid for external readers
 * (Obsidian, VS Code Wiki Links) that don't understand the escaped form. */
function escapeWikilinkAliasPipes(body) {
    let inFence = false;
    return body
        .split("\n")
        .map((line) => {
        if (/^\s*(`{3,}|~{3,})/.test(line)) {
            inFence = !inFence;
            return line;
        }
        if (inFence)
            return line;
        return TABLE_ROW.test(line)
            ? line.replace(/\[\[([^\]\n]*?)(?<!\\)\|([^\]\n]*?)\]\]/g, "[[$1\\|$2]]")
            : line;
    })
        .join("\n");
}
export function createKnowledgeDocument(path, fields, body, sources) {
    if (Object.hasOwn(fields, "sources")) {
        throw new Error("Pass canonical sources as the fourth argument");
    }
    const frontmatter = { type: fields.type };
    const extensions = Object.create(null);
    for (const [key, value] of Object.entries(fields)) {
        if (key === "type")
            continue;
        if (STANDARD_FIELDS.has(key)) {
            frontmatter[key] = value;
        }
        else {
            extensions[key] = value;
        }
    }
    const sourcesUnion = sources
        ? { kind: "canonical", value: sources }
        : { kind: "absent" };
    const normalizedBody = escapeWikilinkAliasPipes(body.replace(/\r\n?/g, "\n")).replace(/\n*$/, "");
    return {
        id: path.replace(/\.md$/, ""),
        path,
        frontmatter,
        sources: sourcesUnion,
        extensions,
        body: normalizedBody,
        compatibility: {
            legacyFields: [],
            hasLegacyWikilinks: detectLegacyWikilinks(normalizedBody),
        },
    };
}
export function patchKnowledgeDocument(document, patch) {
    const newFrontmatter = { ...document.frontmatter };
    if (patch.fields) {
        for (const [key, value] of Object.entries(patch.fields)) {
            if (value !== undefined) {
                newFrontmatter[key] = value;
            }
        }
    }
    const newBody = patch.body
        ? escapeWikilinkAliasPipes(patch.body.replace(/\r\n?/g, "\n"))
        : document.body;
    return {
        ...document,
        frontmatter: newFrontmatter,
        body: newBody,
    };
}
export function readKnowledgeDocumentFile(path, id) {
    const content = readFileSync(path, "utf8");
    return parseKnowledgeDocument(content, id);
}
export function writeKnowledgeDocumentFile(path, document) {
    const content = serializeKnowledgeDocument(document);
    writeFileSync(path, content, "utf8");
}
