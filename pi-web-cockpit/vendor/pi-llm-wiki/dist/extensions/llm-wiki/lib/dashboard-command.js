import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { collectDashboardStats } from "./dashboard.js";
const TYPE_ORDER = [
    "concept",
    "entity",
    "source",
    "skill",
    "analysis",
    "synthesis",
    "requirement",
    "short",
    "shared",
];
const KIND_ORDER = ["observe", "retro", "synth", "intake"];
function orderedPairs(counts) {
    const keys = Object.keys(counts);
    const known = TYPE_ORDER.filter((k) => counts[k] !== undefined);
    const rest = keys
        .filter((k) => !TYPE_ORDER.includes(k))
        .sort()
        .slice(0, 3); // cap the tail: the dashboard is a glance, not a census
    const all = [...known, ...rest];
    if (all.length === 0)
        return "—";
    return all.map((k) => `${k} ${counts[k]}`).join(" · ");
}
function orderedKinds(counts) {
    const keys = Object.keys(counts);
    const known = KIND_ORDER.filter((k) => counts[k] !== undefined);
    const rest = keys
        .filter((k) => !KIND_ORDER.includes(k))
        .sort()
        .slice(0, 3);
    return [...known, ...rest].map((k) => `${k} ${counts[k]}`).join(" · ");
}
function renderStatsLines(s) {
    const emb = s.embEnabled ? `${s.embFiles}/${s.pageCount}` : "—";
    return [
        `Wiki Dashboard · ${s.root}`,
        "",
        `Pages   ${s.pageCount} · ${s.sizeKB}KB · ${orderedPairs(s.byType)}`,
        `Fresh   last touch ${s.lastTouch || "never"} · stale(>30d) ${s.staleCount}`,
        `Acts 7d ${s.last7dTotal > 0 ? orderedKinds(s.last7dByKind) : "none"} · total ${s.last7dTotal}/${s.totalEvents}`,
        `Queue   raw ${s.rawQueue} · emb ${emb}`,
        `Links   zero-backlink ${s.zeroBacklinks} · full scan: /wiki-lint`,
        "",
        "Esc to close",
    ];
}
/** One-screen read-only TUI; handles Esc and `q`. */
export class DashboardScreen extends Container {
    doneFn;
    constructor(lines, close) {
        super();
        this.doneFn = close;
        this.addChild(new Text(lines.join("\n"), 1, 1));
    }
    handleInput(data) {
        // ponytail: matchesKey handles every terminal key shape (raw bytes,
        // kitty CSI-u like \u001b[27u for Esc, ctrl combos) — a raw === "\u001b"
        // check only works in terminals without the kitty keyboard protocol,
        // which is exactly where Ghostty users' Esc went nowhere.
        if (matchesKey(data, "escape") || matchesKey(data, "q")) {
            this.doneFn();
        }
    }
}
// ponytail: overlay options matching pi-blackhole's config modal style
const OVERLAY_OPTS = {
    overlay: true,
    overlayOptions: { anchor: "center", width: "92%", maxHeight: "95%" },
};
/**
 * Register the /wiki-dashboard command.
 */
export function registerWikiDashboardCommand(pi, runtime) {
    pi.registerCommand("wiki-dashboard", {
        description: "Show a read-only LLM Wiki dashboard (pages, freshness, activity, queue, links, emb)",
        handler: async (_args, ctx) => {
            runtime.ensureConfig(ctx.cwd);
            if (!ctx.hasUI) {
                ctx.ui.notify("LLM Wiki: /wiki-dashboard requires an interactive UI.", "warning");
                return;
            }
            const stats = await collectDashboardStats(ctx.cwd);
            await ctx.ui.custom((_tui, _theme, _keybindings, close) => {
                return new DashboardScreen(renderStatsLines(stats), close);
            }, OVERLAY_OPTS);
        },
    });
}
