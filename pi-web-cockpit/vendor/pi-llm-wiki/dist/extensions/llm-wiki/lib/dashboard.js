/**
 * Read-only vault statistics for the /wiki-dashboard screen.
 *
 * Everything is computed from pre-existing on-disk state:
 *  - page tree (paths.wiki + skills dir): counts, mtimes, sizes
 *  - meta/registry.json: page types (values; keys can carry legacy prefix noise)
 *  - meta/backlinks.json: zero-inbound pages
 *  - meta/events.jsonl: activity stream (observes/retros/syntheses...)
 *  - raw/sources: pending ingest queue
 *  - emb/: embedding coverage
 *
 * No writes, no LLM calls, no new files. Pure reader.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { readJson, resolveVaultPaths } from "./utils.js";
/** Directories excluded from the page walk (infrastructure, not pages). */
const SKIP_DIRS = new Set([
    "templates",
    "cases",
    "outputs",
    ".discoveries",
    "raw",
    "meta",
    "emb",
    ".git",
]);
async function walkPages(dir, rel, out) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name))
                    continue;
                await walkPages(`${dir}/${e.name}`, childRel, out);
                continue;
            }
            if (!e.name.endsWith(".md"))
                continue;
            try {
                const st = await stat(`${dir}/${e.name}`);
                out.push({ rel: childRel, mtime: st.mtimeMs, bytes: st.size });
            }
            catch {
                // unreadable file: skip
            }
        }
    }
    catch {
        // missing dir (empty vault): nothing to walk
    }
}
function humanAge(ms) {
    const mins = Math.floor(ms / 60_000);
    if (mins < 1)
        return "now";
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48)
        return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
}
async function readEvents(metaDir) {
    const byKind = {};
    let recent = 0;
    let total = 0;
    try {
        const raw = await readFile(`${metaDir}/events.jsonl`, "utf-8");
        const cutoff = Date.now() - 7 * 86400_000;
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            let ev;
            try {
                ev = JSON.parse(line);
            }
            catch {
                continue; // corrupted line: skip, not fatal
            }
            const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : Number.NaN;
            const kind = typeof ev.kind === "string" && ev.kind ? ev.kind : "event";
            total += 1;
            if (Number.isFinite(ts) && ts >= cutoff) {
                byKind[kind] = (byKind[kind] ?? 0) + 1;
                recent += 1;
            }
        }
    }
    catch {
        // no events file: zeros
    }
    return { byKind, recent, total };
}
/**
 * Collect all dashboard stats for the vault reachable from `cwd`.
 * Reuses the extension's own path resolution (same root the tools see).
 */
export async function collectDashboardStats(cwd) {
    const paths = resolveVaultPaths(cwd);
    const pages = [];
    await walkPages(paths.wiki, "", pages);
    // skill pages register as type:skill and live under <dotWiki>/skills
    try {
        const st = await stat(`${paths.dotWiki}/skills`);
        if (st.isDirectory()) {
            await walkPages(`${paths.dotWiki}/skills`, "skills", pages);
        }
    }
    catch {
        // no skills dir: fine
    }
    // type map from registry values — keys may carry legacy noise, so normalize
    const registry = readJson(`${paths.meta}/registry.json`, { pages: {} });
    const typeByKey = {};
    for (const [key, val] of Object.entries(registry.pages ?? {})) {
        const norm = key.startsWith('"') ? key.slice(1) : key;
        if (val?.type)
            typeByKey[norm] = val.type;
    }
    const byType = {};
    for (const p of pages) {
        const slug = p.rel.endsWith(".md") ? p.rel.slice(0, -3) : p.rel;
        const type = typeByKey[slug] ?? p.rel.split("/")[0] ?? "other";
        byType[type] = (byType[type] ?? 0) + 1;
    }
    let sizeBytes = 0;
    let latestMtime = 0;
    const staleCutoff = Date.now() - 30 * 86400_000;
    let stale = 0;
    for (const p of pages) {
        sizeBytes += p.bytes;
        if (p.mtime > latestMtime)
            latestMtime = p.mtime;
        if (p.mtime < staleCutoff)
            stale += 1;
    }
    const events = await readEvents(paths.meta);
    let rawQueue = 0;
    try {
        const pkts = await readdir(paths.rawSources, { withFileTypes: true });
        for (const e of pkts) {
            if (e.isDirectory())
                rawQueue += 1; // each subdirectory is one packet
        }
    }
    catch {
        // no raw/sources: empty queue
    }
    const backlinks = readJson(`${paths.meta}/backlinks.json`, {});
    const zeroBacklinks = Object.values(backlinks).filter((v) => (v ?? []).length === 0).length;
    let embFiles = 0;
    try {
        const embEntries = await readdir(`${paths.dotWiki}/emb`);
        embFiles = embEntries.filter((f) => f.endsWith(".bin")).length;
    }
    catch {
        // no emb dir: none
    }
    return {
        root: paths.root,
        pageCount: pages.length,
        byType,
        sizeKB: Math.max(1, Math.round(sizeBytes / 1024)),
        lastTouch: pages.length === 0 ? "" : humanAge(Date.now() - latestMtime),
        staleCount: stale,
        last7dByKind: events.byKind,
        last7dTotal: events.recent,
        totalEvents: events.total,
        rawQueue,
        zeroBacklinks,
        embFiles,
        embEnabled: embFiles > 0,
    };
}
