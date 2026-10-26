import { join } from "node:path";
/**
 * Package-private normalized adapter over the pinned @tobilu/qmd SDK.
 *
 * This is the ONLY production module allowed to import @tobilu/qmd. It hides
 * SDK-specific types, collection config, model identity, and close behavior so
 * the rest of the extension never touches QMD internals or tables directly.
 */
export const QMD_PACKAGE_VERSION = "2.8.3";
export const QMD_DEFAULT_MODELS = {
    embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
    generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
    rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
};
/**
 * Mirror collection a hit came from: the SDK reports virtual paths
 * "qmd://<collection>/<path>.md", and the mirror layout is
 * ".../documents/<role>/<pageId>.md". Either form resolves the role.
 */
function roleFromFile(file) {
    return /(?:^|\/)documents\/canonical\/|^qmd:\/\/canonical\//.test(file)
        ? "canonical"
        : "evidence";
}
/** Normalize raw within-store scores to 0..1 against this list's max. */
function withNormalizedScores(hits) {
    const max = Math.max(...hits.map((h) => h.raw), 1e-9);
    return hits.map(({ raw, ...rest }) => ({ ...rest, score: raw / max }));
}
const mapLexHit = (r) => ({
    collection: roleFromFile(r.filepath),
    file: r.filepath,
    title: r.title,
    source: r.source,
    raw: r.score,
});
const mapHybridHit = (r) => ({
    collection: roleFromFile(r.file),
    file: r.file,
    title: r.title,
    source: "fts",
    body: r.bestChunk,
    raw: r.score,
});
/**
 * Open a QMD index store over the mirror documents directory, with two
 * non-overlapping collections (canonical and evidence).
 */
export async function openQmdIndexStore(input) {
    // @tobilu/qmd is an optional dependency (issue #264): on restricted
    // machines its native subtree (better-sqlite3) fails to install and npm
    // skips it. Load lazily so the package installs everywhere — only QMD
    // operations fail, with an actionable message.
    let createStore;
    try {
        ({ createStore } = await import("@tobilu/qmd"));
    }
    catch {
        throw new Error("@tobilu/qmd is unavailable (optional dependency skipped during install — its " +
            "better-sqlite3 native build needs GitHub access or C++ build tools). Re-run " +
            "npm install in a network with GitHub reachable, or with build tools available.");
    }
    const store = await createStore({
        dbPath: input.dbPath,
        config: {
            global_context: "Validated LLM Wiki knowledge",
            collections: {
                canonical: {
                    path: join(input.documentsPath, "canonical"),
                    pattern: "**/*.md",
                    context: { "/": "Reusable conclusions, entities, requirements, and procedures" },
                },
                evidence: {
                    path: join(input.documentsPath, "evidence"),
                    pattern: "**/*.md",
                    context: { "/": "Source evidence, observations, trajectories, and unpromoted notes" },
                },
            },
        },
    });
    return {
        update: (onProgress) => store.update({ onProgress }),
        embed: ({ force, onProgress }) => store.embed({ force, chunkStrategy: "regex", onProgress }),
        status: async () => {
            const status = await store.getStatus();
            const counts = Object.fromEntries(status.collections.map((collection) => [collection.name, collection.documents]));
            return {
                totalDocuments: status.totalDocuments,
                needsEmbedding: status.needsEmbedding,
                hasVectorIndex: status.hasVectorIndex,
                canonicalDocuments: counts.canonical ?? 0,
                evidenceDocuments: counts.evidence ?? 0,
            };
        },
        close: () => store.close(),
        searchLex: async (query, limit = 40) => withNormalizedScores((await store.searchLex(query, { limit })).map(mapLexHit)),
        searchTyped: async (query, limit = 10) => withNormalizedScores((await store.search({
            queries: [
                { type: "lex", query },
                { type: "vec", query },
            ],
            rerank: false,
            candidateLimit: 40,
            limit,
            explain: true,
        })).map(mapHybridHit)),
        searchExpanded: async (query, intent, limit = 10) => withNormalizedScores((await store.search({
            query,
            intent,
            rerank: true,
            candidateLimit: 40,
            limit,
            explain: true,
        })).map(mapHybridHit)),
    };
}
/** Resolve model identities from env, defaulting to pinned models. No downloads. */
export function resolveQmdModels(env = process.env) {
    return {
        embed: env.QMD_EMBED_MODEL?.trim() || QMD_DEFAULT_MODELS.embed,
        generate: env.QMD_GENERATE_MODEL?.trim() || QMD_DEFAULT_MODELS.generate,
        rerank: env.QMD_RERANK_MODEL?.trim() || QMD_DEFAULT_MODELS.rerank,
    };
}
