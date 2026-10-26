import { fromMarkdown } from "mdast-util-from-markdown";
import { slugify } from "./utils.js";
import { compareCodePoint } from "./vault-format.js";
function diag(severity, code, path, message) {
    return { severity, code, path, message };
}
function normalizeWikilinkTarget(target) {
    return target.trim().replace(/\\$/, "");
}
// Blank out code spans, fenced/indented code blocks, and raw HTML (the same
// node types the link walk skips), preserving length so offsets stay valid.
function maskCodeRegions(tree, body) {
    if (!tree)
        return body;
    const ranges = [];
    function visit(node) {
        const position = node
            .position;
        if (node.type === "inlineCode" || node.type === "code" || node.type === "html") {
            if (position)
                ranges.push([position.start.offset, position.end.offset]);
        }
        if ("children" in node && Array.isArray(node.children)) {
            for (const child of node.children) {
                visit(child);
            }
        }
    }
    visit(tree);
    if (ranges.length === 0)
        return body;
    const chars = body.split("");
    for (const [start, end] of ranges) {
        for (let i = start; i < end && i < chars.length; i++) {
            if (i >= 0)
                chars[i] = " ";
        }
    }
    return chars.join("");
}
export function extractKnowledgeLinks(body) {
    const markdown = [];
    const wikilinks = [];
    // Parse with CommonMark AST
    let tree = null;
    try {
        tree = fromMarkdown(body);
    }
    catch {
        tree = null;
    }
    // Extract legacy wikilinks. A table-safe alias uses an escaped pipe: [[target\\|alias]].
    // Scan the code-masked body so [[...]] inside code is not a real link.
    const scanBody = maskCodeRegions(tree, body);
    for (const match of scanBody.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        wikilinks.push({ target: normalizeWikilinkTarget(match[1]), offset: match.index ?? 0 });
    }
    if (!tree)
        return { markdown, wikilinks };
    // Build definition map (case-insensitive)
    const defs = new Map();
    function collectDefs(node) {
        if (node.type === "definition") {
            defs.set(node.identifier.toLowerCase(), node);
        }
        if ("children" in node && Array.isArray(node.children)) {
            for (const child of node.children) {
                collectDefs(child);
            }
        }
    }
    collectDefs(tree);
    // Track used definitions
    const usedDefs = new Set();
    // Visit nodes for links
    function visit(node) {
        // Skip code spans, fenced/indented code blocks, and raw HTML
        if (node.type === "inlineCode" || node.type === "code" || node.type === "html")
            return;
        if (node.type === "link") {
            const link = node;
            // Skip autolinks (source starts with <)
            if (link.url && link.position) {
                const source = body.slice(link.position.start.offset, link.position.end.offset);
                if (!source.startsWith("<")) {
                    markdown.push({ target: link.url, offset: link.position.start.offset ?? 0 });
                }
            }
        }
        if (node.type === "linkReference") {
            const ref = node;
            const ident = (ref.identifier ?? "").toLowerCase();
            const def = defs.get(ident);
            if (def && !usedDefs.has(ident)) {
                usedDefs.add(ident);
                if (ref.position) {
                    markdown.push({ target: def.url, offset: ref.position.start.offset ?? 0 });
                }
            }
        }
        // Recurse into children
        if ("children" in node && Array.isArray(node.children)) {
            for (const child of node.children) {
                visit(child);
            }
        }
    }
    visit(tree);
    return { markdown, wikilinks };
}
export function extractLegacyWikilinks(body) {
    const links = [];
    for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        links.push({ target: normalizeWikilinkTarget(match[1]), offset: match.index ?? 0 });
    }
    return links;
}
export function buildWikilinkIndex(ids) {
    const byExact = new Map();
    const byNormPath = new Map();
    const byNormSlug = new Map();
    function push(map, key, value) {
        const existing = map.get(key);
        if (existing)
            existing.push(value);
        else
            map.set(key, [value]);
    }
    for (const id of ids) {
        byExact.set(id.normalize("NFC"), id);
        const segments = id.split("/");
        const normFull = segments.map((s) => slugify(s)).join("/");
        const normBase = slugify(segments[segments.length - 1]);
        push(byNormPath, normFull, id);
        push(byNormSlug, normBase, id);
    }
    return { byExact, byNormPath, byNormSlug };
}
export function resolveWikilink(target, index) {
    const cleaned = target.trim().replace(/\\$/, "");
    if (!cleaned)
        return { kind: "missing", target: "" };
    // Fast path: exact NFC match
    const exact = index.byExact.get(cleaned.normalize("NFC"));
    if (exact)
        return { kind: "resolved", id: exact };
    // Normalized full path (fixes case/space/slug drift in folder-qualified links)
    const normFull = cleaned
        .split("/")
        .map((s) => slugify(s))
        .join("/");
    const pathHits = index.byNormPath.get(normFull);
    if (pathHits && pathHits.length === 1)
        return { kind: "resolved", id: pathHits[0] };
    if (pathHits && pathHits.length > 1)
        return { kind: "ambiguous", target: cleaned, candidates: pathHits };
    // Bare title: match by slugified basename (handles [[zosma harness]] → entities/zosma-harness)
    if (!cleaned.includes("/")) {
        const baseHits = index.byNormSlug.get(slugify(cleaned));
        if (baseHits && baseHits.length === 1)
            return { kind: "resolved", id: baseHits[0] };
        if (baseHits && baseHits.length > 1)
            return { kind: "ambiguous", target: cleaned, candidates: baseHits };
    }
    return { kind: "missing", target: cleaned };
}
function resolveMarkdownTarget(target, sourceId) {
    // Strip query and fragment (earliest delimiter)
    const qIndex = target.indexOf("?");
    const fIndex = target.indexOf("#");
    let clean = target;
    let cut = -1;
    if (qIndex !== -1 && (fIndex === -1 || qIndex < fIndex))
        cut = qIndex;
    else if (fIndex !== -1)
        cut = fIndex;
    if (cut !== -1)
        clean = target.slice(0, cut);
    // Ignore empty fragment-only targets
    if (!clean || clean === "#")
        return { kind: "empty" };
    // Ignore external URI schemes
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean))
        return { kind: "external" };
    // Percent-decode each segment once, but never let malformed user input escape
    // the link diagnostics boundary.
    let decoded;
    try {
        decoded = clean.split("/").map((segment) => decodeURIComponent(segment));
    }
    catch {
        return { kind: "invalid" };
    }
    // Convert decoded backslashes to /
    const normalized = decoded.map((s) => s.replace(/\\/g, "/")).join("/");
    const sourceDir = sourceId.replace(/[^/]*$/, ""); // directory of source
    const parts = normalized.split("/");
    const isRootRelative = normalized.startsWith("/");
    if (isRootRelative) {
        // Root-relative: resolve with explicit stack
        const stack = [];
        for (const part of parts) {
            if (part === "")
                continue;
            if (part === ".")
                continue;
            if (part === "..") {
                if (stack.length === 0)
                    return { kind: "escape" };
                stack.pop();
            }
            else {
                stack.push(part);
            }
        }
        const resolved = stack.join("/");
        if (!resolved.endsWith(".md"))
            return { kind: "empty" };
        return { kind: "concept", id: resolved.slice(0, -3) };
    }
    // For file-relative paths, resolve against source directory
    const baseParts = sourceDir.split("/").filter(Boolean);
    const allParts = [...baseParts];
    for (const part of parts) {
        if (part === "" || part === ".") {
        }
        else if (part === "..") {
            if (allParts.length === 0) {
                return { kind: "escape" };
            }
            allParts.pop();
        }
        else {
            allParts.push(part);
        }
    }
    const resolved = allParts.join("/");
    // Require .md suffix for Markdown links
    if (resolved.endsWith(".md")) {
        return { kind: "concept", id: resolved.slice(0, -3) };
    }
    return { kind: "empty" };
}
export function buildResolvedBacklinks(sourceId, body, index) {
    const diagnostics = [];
    const unresolved = [];
    const targets = new Set();
    const allLinks = extractKnowledgeLinks(body);
    // Process Markdown links
    for (const link of allLinks.markdown) {
        const resolved = resolveMarkdownTarget(link.target, sourceId);
        if (resolved.kind === "escape") {
            diagnostics.push(diag("warning", "link_path_escape", `${sourceId}.md`, `Link escapes bundle root: ${link.target}`));
        }
        else if (resolved.kind === "invalid") {
            diagnostics.push(diag("warning", "link_unresolved", `${sourceId}.md`, `Malformed percent-encoded link: ${link.target}`));
        }
        else if (resolved.kind === "concept") {
            const canonical = index.byExact.get(resolved.id.normalize("NFC"));
            if (canonical) {
                targets.add(canonical);
            }
            else {
                unresolved.push({ target: resolved.id, syntax: "markdown" });
                diagnostics.push(diag("warning", "link_unresolved", `${sourceId}.md`, `Unresolved link: ${resolved.id}`));
            }
        }
        // external and empty are silently ignored
    }
    // Process wikilinks (lenient: exact → normalized path → bare title)
    for (const link of allLinks.wikilinks) {
        const res = resolveWikilink(link.target, index);
        if (res.kind === "resolved") {
            targets.add(res.id);
        }
        else if (res.kind === "ambiguous") {
            diagnostics.push(diag("warning", "link_ambiguous", `${sourceId}.md`, `Ambiguous wikilink: ${res.target} (candidates: ${res.candidates.join(", ")})`));
        }
        else {
            unresolved.push({ target: res.target, syntax: "wikilink" });
            diagnostics.push(diag("warning", "link_unresolved", `${sourceId}.md`, `Unresolved wikilink: ${res.target}`));
        }
    }
    // Sort and deduplicate
    const sorted = [...targets].sort(compareCodePoint);
    return { targets: sorted, unresolved, diagnostics };
}
const WIKILINK_REPLACE_RE = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;
/**
 * Audit a markdown body's wikilinks against the page index.
 *
 * - Collects `link_unresolved` / `link_ambiguous` diagnostics for every link
 *   that does not resolve to exactly one page (skipped for "off").
 * - In "normalize" mode, additionally rewrites each link that DOES resolve to
 *   its canonical page id. Only the target token is replaced (the parser's own
 *   regex is reused), so `|alias`, escaping, and surrounding text are preserved.
 *
 * Pure: no I/O. The caller supplies the index (typically `buildWikilinkIndex`
 * over existing page ids plus the ids created by the same commit).
 */
export function auditWikilinks(body, index, sourceId, mode) {
    if (mode === "off")
        return { diagnostics: [], body, changed: false };
    const diagnostics = [];
    for (const { target } of extractKnowledgeLinks(body).wikilinks) {
        const resolved = resolveWikilink(target, index);
        if (resolved.kind === "ambiguous") {
            diagnostics.push({
                severity: "warning",
                code: "link_ambiguous",
                path: sourceId,
                message: `Wikilink target "${target}" matches multiple pages (${resolved.candidates.join(", ")}).`,
            });
        }
        else if (resolved.kind === "missing") {
            diagnostics.push({
                severity: "warning",
                code: "link_unresolved",
                path: sourceId,
                message: `Wikilink target "${target}" does not match any page.`,
            });
        }
    }
    let out = body;
    if (mode === "normalize") {
        out = body.replace(WIKILINK_REPLACE_RE, (full, raw, alias) => {
            const resolved = resolveWikilink(normalizeWikilinkTarget(raw), index);
            return resolved.kind === "resolved" ? `[[${resolved.id}${alias ?? ""}]]` : full;
        });
    }
    return { diagnostics, body: out, changed: out !== body };
}
/**
 * Apply the pre-write wikilink gate to a body. Wraps {@link auditWikilinks}:
 * blocks (ok:false) only in strict mode with issues, rewrites in normalize mode,
 * and always returns the diagnostics so callers can surface them (warn/normalize).
 */
export function applyWikilinkGate(body, index, sourceId, mode) {
    if (mode === "off")
        return { ok: true, body, diagnostics: [] };
    const audit = auditWikilinks(body, index, sourceId, mode);
    return {
        ok: !(mode === "strict" && audit.diagnostics.length > 0),
        body: mode === "normalize" ? audit.body : body,
        diagnostics: audit.diagnostics,
    };
}
