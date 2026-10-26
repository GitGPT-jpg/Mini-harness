# OKF Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe dual legacy/OKF document handling, OKF-canonical page production, mode-aware deterministic projections, CommonMark backlinks, and shared Pi/MCP behavior without migrating existing vaults.

**Architecture:** Introduce one shared `KnowledgeDocument` format layer and route every reader and producer through it. Keep `metadata.ts` as the projection coordinator, but make it compute a complete in-memory generation before atomically replacing derived files. Pi and MCP remain thin adapters over shared recall, registry-search, status, capture, and retro services.

**Tech Stack:** TypeScript ES2022, Node.js filesystem/path APIs, `yaml` 2.9, `mdast-util-from-markdown` 2.0, Vitest, Biome, pnpm.

**Roadmap:** `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md` (sequencing only; non-normative)

**Phase:** Phase 1: Foundation

---

## Normative Inputs and Scope Boundary

Use `docs/superpowers/specs/2026-08-02-okf-foundation-design.md` as the only normative behavior source. The parent roadmap may explain sequencing but cannot add Foundation requirements.

This plan deliberately excludes import, import review, export, explicit migration, transaction journals, trust/freshness scoring, graph UI, git snapshots, expanded extraction adapters, and Attested Computation execution. Per-file temporary-write-plus-rename for derived projections is included; cross-file transaction recovery is not.

Baseline recorded before planning: `pnpm test` passes 29 files and 410 tests.

## File Structure

### New production files

- `extensions/llm-wiki/lib/knowledge-document.ts` — YAML-safe model, parser, serializer, compatibility classification, and canonical/legacy-preserving page writes.
- `extensions/llm-wiki/lib/vault-format.ts` — `knowledge_format` resolution, root OKF version inspection, concept discovery, normalized identity, reserved-name checks, and collision diagnostics.
- `extensions/llm-wiki/lib/knowledge-links.ts` — CommonMark AST extraction plus Markdown/wikilink resolution and backlink diagnostics.
- `extensions/llm-wiki/lib/wiki-service.ts` — shared registry search and status snapshots consumed by Pi and MCP.
- `mcp/operations.ts` — thin, testable MCP operation adapters over shared services.

### New tests and fixtures

- `test/knowledge-document.test.ts`
- `test/vault-format.test.ts`
- `test/knowledge-links.test.ts`
- `test/okf-projections.test.ts`
- `test/okf-integration.test.ts`
- `test/mcp-parity.test.ts`
- `test/fixtures/okf/documents/nested.md`
- `test/fixtures/okf/indexes/root.md`
- `test/fixtures/okf/indexes/concepts.md`
- `test/fixtures/okf/logs/events.jsonl`
- `test/fixtures/okf/logs/log.md`

### Existing files to modify

- `package.json`, `pnpm-lock.yaml` — add maintained YAML and CommonMark AST dependencies.
- `tsconfig.json` — type-check MCP sources as well as extension and tests.
- `extensions/llm-wiki/lib/utils.ts` — remove bespoke frontmatter/link/page scanning; retain path, JSON, slug, and vault-layout utilities.
- `extensions/llm-wiki/lib/metadata.ts` — registry/backlinks/index/log rendering and fail-closed projection publication.
- `extensions/llm-wiki/lib/recall.ts` — parse page bodies through `KnowledgeDocument` and surface mode/version diagnostics.
- `extensions/llm-wiki/lib/embeddings.ts` — derive embedding text from shared documents.
- `extensions/llm-wiki/lib/indexing.ts` — refresh embeddings only after a successful projection rebuild.
- `extensions/llm-wiki/lib/source-packet.ts` — canonical source skeleton serialization.
- `extensions/llm-wiki/lib/ingest-worker.ts` — canonical entity/concept creation and legacy-preserving source updates.
- `extensions/llm-wiki/lib/observation.ts` — canonical observation serialization.
- `extensions/llm-wiki/lib/retro.ts` — canonical insight serialization.
- `extensions/llm-wiki/lib/tools.ts` — mode validation, canonical `wiki_ensure_page`/lint stubs, shared search/status, and rebuild diagnostics.
- `extensions/llm-wiki/lib/guardrails.ts` — mode-aware protection of OKF indexes and root log.
- `extensions/llm-wiki/index.ts` — OKF mode on silent bootstrap and shared status/recall integration.
- `mcp/index.ts` — remove duplicated registry/parser/business logic and call `mcp/operations.ts`.
- `skills/llm-wiki/SKILL.md` — prefer standard Markdown links for new pages while retaining legacy wikilink readability.
- Existing tests that assert quoted scalar values or legacy generated wikilinks — update expectations to semantic YAML values and Markdown links.

---

### Task 1: Add the Shared Knowledge Document Parser and Serializer

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `extensions/llm-wiki/lib/knowledge-document.ts`
- Create: `test/knowledge-document.test.ts`
- Create: `test/fixtures/okf/documents/nested.md`

- [ ] **Step 1: Add maintained format dependencies**

Run:

```bash
pnpm add yaml@^2.9.0 mdast-util-from-markdown@^2.0.3
```

Expected: `package.json` contains both packages under `dependencies`; `pnpm-lock.yaml` resolves them.

- [ ] **Step 2: Write parser/serializer tests first**

Create `test/fixtures/okf/documents/nested.md`:

```markdown
---
type: Attested Computation
title: Revenue Total
description: Deterministic revenue total.
generated:
  by: pi-llm-wiki/model
  at: 2026-08-02T10:00:00Z
verified:
  - by: reviewer@example.com
    at: 2026-08-02T11:00:00Z
sources:
  - id: SRC-2026-08-02-001
    resource: /sources/SRC-2026-08-02-001.md
producer_data:
  nested:
    enabled: true
    weights: [1, 2, 3]
---

# Revenue Total

Body.
```

Create `test/knowledge-document.test.ts` with these concrete cases:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRONTMATTER_MAX_BYTES,
  createKnowledgeDocument,
  parseKnowledgeDocument,
  patchKnowledgeDocument,
  serializeKnowledgeDocument,
} from "../extensions/llm-wiki/lib/knowledge-document.js";

function parsed(content: string, path = "concepts/test.md") {
  const result = parseKnowledgeDocument(content, path);
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error("expected parsed document");
  return result.document;
}

describe("KnowledgeDocument", () => {
  it("parses nested OKF values, timestamps as strings, and unknown mappings", () => {
    const input = readFileSync(join(import.meta.dirname, "fixtures/okf/documents/nested.md"), "utf8");
    const doc = parsed(input, "analyses/revenue-total.md");
    expect(doc.id).toBe("analyses/revenue-total");
    expect(doc.frontmatter.generated).toEqual({
      by: "pi-llm-wiki/model",
      at: "2026-08-02T10:00:00Z",
    });
    expect(typeof (doc.frontmatter.generated as Record<string, unknown>).at).toBe("string");
    expect(doc.extensions.producer_data).toEqual({
      nested: { enabled: true, weights: [1, 2, 3] },
    });
    expect(doc.sources.kind).toBe("canonical");
  });

  it("round-trips unknown values and exact body separator rules", () => {
    const doc = parsed("---\ntype: concept\nunknown: {empty: [], map: {}}\n---\n\n\nFirst\n");
    const output = serializeKnowledgeDocument(doc);
    expect(output).toBe("---\ntype: concept\nunknown:\n  empty: []\n  map: {}\n---\n\n\nFirst\n");
    const again = parsed(output);
    expect(again.extensions.unknown).toEqual({ empty: [], map: {} });
    expect(again.body).toBe("\nFirst\n");
  });

  it("emits no separator blank line for an empty body", () => {
    const doc = createKnowledgeDocument("concepts/empty.md", { type: "concept" }, "");
    expect(serializeKnowledgeDocument(doc)).toBe("---\ntype: concept\n---\n");
  });

  it("accepts CRLF and emits LF with one final newline", () => {
    const doc = parsed("---\r\ntype: concept\r\n---\r\n\r\nBody\r\n");
    expect(serializeKnowledgeDocument(doc)).toBe("---\ntype: concept\n---\n\nBody\n");
  });

  it.each([
    ["frontmatter_duplicate_key", "---\ntype: concept\ntype: entity\n---\n"],
    ["frontmatter_alias_forbidden", "---\ntype: concept\nx: &x [1]\ny: *x\n---\n"],
    ["frontmatter_custom_tag_forbidden", "---\ntype: concept\nx: !producer value\n---\n"],
    [
      "frontmatter_multiple_documents",
      "---\ntype: concept\n...\n---\ntype: entity\n---\n",
    ],
  ])("returns %s without exposing a YAML exception", (code, input) => {
    const result = parseKnowledgeDocument(input, "concepts/bad.md");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(code);
    expect(result.diagnostics[0].path).toBe("concepts/bad.md");
  });

  it("rejects missing frontmatter, missing type, byte overflow, and depth overflow", () => {
    expect(parseKnowledgeDocument("# Body\n", "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_missing",
    );
    expect(parseKnowledgeDocument("---\ntitle: A\n---\n", "concepts/a.md").diagnostics[0].code).toBe(
      "concept_missing_type",
    );
    const large = `---\ntype: concept\nx: ${"a".repeat(FRONTMATTER_MAX_BYTES)}\n---\n`;
    expect(parseKnowledgeDocument(large, "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_limit_bytes",
    );
    const deep = `---\ntype: concept\nx: ${"[".repeat(33)}0${"]".repeat(33)}\n---\n`;
    expect(parseKnowledgeDocument(deep, "concepts/a.md").diagnostics[0].code).toBe(
      "frontmatter_limit_depth",
    );
  });

  it.each([
    ["legacy-scalar", "sources: sources/SRC-1"],
    ["legacy-list", "sources: [sources/SRC-1, sources/SRC-2]"],
  ])("preserves %s sources during an ordinary patch", (_kind, sourceLine) => {
    const doc = parsed(`---\ntype: source\n${sourceLine}\nproducer: {keep: true}\n---\n\nOld\n`);
    const patched = patchKnowledgeDocument(doc, { fields: { status: "ingested" }, body: "New\n" });
    const reparsed = parsed(serializeKnowledgeDocument(patched));
    expect(reparsed.sources).toEqual(doc.sources);
    expect(reparsed.extensions.producer).toEqual({ keep: true });
    expect(reparsed.body).toBe("New\n");
  });
});
```

- [ ] **Step 3: Run the new test and verify failure**

Run:

```bash
pnpm vitest run test/knowledge-document.test.ts
```

Expected: FAIL because `knowledge-document.ts` does not exist.

- [ ] **Step 4: Implement the shared model and diagnostics**

Create `extensions/llm-wiki/lib/knowledge-document.ts` with these public contracts and constants:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, stringify } from "yaml";

export const FRONTMATTER_MAX_BYTES = 128 * 1024;
export const FRONTMATTER_MAX_DEPTH = 32;

export type DiagnosticSeverity = "warning" | "error";
export type DiagnosticCode =
  | "config_invalid_knowledge_format"
  | "frontmatter_missing"
  | "frontmatter_parse_error"
  | "frontmatter_duplicate_key"
  | "frontmatter_alias_forbidden"
  | "frontmatter_custom_tag_forbidden"
  | "frontmatter_multiple_documents"
  | "frontmatter_limit_bytes"
  | "frontmatter_limit_depth"
  | "concept_missing_type"
  | "concept_identity_collision"
  | "concept_reserved_name"
  | "okf_version_mismatch"
  | "link_path_escape"
  | "link_unresolved"
  | "event_invalid_json"
  | "event_invalid_timestamp"
  | "event_missing_kind";

export interface KnowledgeDiagnostic {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export type KnowledgeValue =
  | null
  | boolean
  | number
  | string
  | KnowledgeValue[]
  | { [key: string]: KnowledgeValue };

export type KnowledgeSources =
  | { kind: "absent" }
  | { kind: "canonical"; value: Array<Record<string, KnowledgeValue>> }
  | { kind: "legacy-scalar"; value: string }
  | { kind: "legacy-list"; value: string[] }
  | { kind: "unknown-shape"; value: KnowledgeValue };

export interface KnowledgeFrontmatter {
  type: string;
  title?: KnowledgeValue;
  description?: KnowledgeValue;
  resource?: KnowledgeValue;
  tags?: KnowledgeValue;
  generated?: KnowledgeValue;
  verified?: KnowledgeValue;
  status?: KnowledgeValue;
  stale_after?: KnowledgeValue;
  category?: KnowledgeValue;
  domain?: KnowledgeValue;
  aliases?: KnowledgeValue;
  recall_triggers?: KnowledgeValue;
  created?: KnowledgeValue;
  updated?: KnowledgeValue;
  summary?: KnowledgeValue;
  raw_path?: KnowledgeValue;
  source_id?: KnowledgeValue;
  [key: string]: KnowledgeValue | undefined;
}

export interface KnowledgeDocument {
  id: string;
  path: string;
  frontmatter: KnowledgeFrontmatter;
  sources: KnowledgeSources;
  extensions: Record<string, KnowledgeValue>;
  body: string;
  compatibility: {
    legacyFields: string[];
    hasLegacyWikilinks: boolean;
  };
}

export type ParseKnowledgeResult =
  | { ok: true; document: KnowledgeDocument; diagnostics: KnowledgeDiagnostic[] }
  | { ok: false; diagnostics: KnowledgeDiagnostic[] };

export type ParseFrontmatterResult =
  | {
      ok: true;
      mapping: Record<string, KnowledgeValue>;
      body: string;
      diagnostics: KnowledgeDiagnostic[];
    }
  | { ok: false; diagnostics: KnowledgeDiagnostic[] };

export interface KnowledgePatchFields {
  type?: string;
  title?: KnowledgeValue;
  description?: KnowledgeValue;
  resource?: KnowledgeValue;
  tags?: KnowledgeValue;
  generated?: KnowledgeValue;
  verified?: KnowledgeValue;
  status?: KnowledgeValue;
  stale_after?: KnowledgeValue;
  category?: KnowledgeValue;
  domain?: KnowledgeValue;
  aliases?: KnowledgeValue;
  recall_triggers?: KnowledgeValue;
  created?: KnowledgeValue;
  updated?: KnowledgeValue;
  summary?: KnowledgeValue;
  raw_path?: KnowledgeValue;
  source_id?: KnowledgeValue;
}

export interface KnowledgePatch {
  fields?: KnowledgePatchFields;
  body?: string;
}
```

Use one internal `parseFrontmatterBlock(content, path, requireType)` function. Export `parseMarkdownFrontmatter(content, path)` as its `requireType: false` wrapper for reserved root-index inspection; `parseKnowledgeDocument` is the `requireType: true` wrapper that classifies fields into `KnowledgeDocument`. The shared block parser must:

1. Normalize CRLF and lone CR to LF.
2. Require an opening `---` on line 1 and a closing line containing exactly `---`. Scan delimiter candidates in order. When a candidate immediately follows a YAML explicit-end line `...` and another delimiter exists later, treat that candidate as an internal second-document marker and continue to the later closing fence; this makes multiple documents visible to `parseAllDocuments` instead of misclassifying the second document as Markdown body.
3. Measure only YAML bytes with `Buffer.byteLength(yamlText, "utf8")`.
4. Call `parseAllDocuments(yamlText, { schema: "core", merge: false, uniqueKeys: true })` exactly once.
5. Map duplicate-key parser errors to `frontmatter_duplicate_key`; map every other parser error to `frontmatter_parse_error`; copy safe line/column positions.
6. Reject document count other than one before conversion.
7. Walk YAML nodes before `toJS`: reject aliases, reject any explicit custom tag beginning with `!`, and count mappings/sequences toward the depth limit.
8. Require a mapping root and a non-empty string `type` for concept documents.
9. Remove one optional blank line after the closing fence; preserve any additional leading blank lines in `body`.
10. Classify `sources` into the discriminated union before removing it from the ordinary frontmatter map.
11. Put the listed standard/profile fields in `frontmatter`; put all remaining keys in `extensions`.
12. Record `created`, `updated`, `summary`, `raw_path`, `source_id`, lowercase known types, legacy source shapes, and body wikilinks as compatibility metadata without rejecting them.

Implement serialization by rebuilding a plain mapping from `frontmatter`, the exact `sources` union value, and `extensions`, then calling:

```ts
const yaml = stringify(mapping, {
  aliasDuplicateObjects: false,
  lineWidth: 0,
}).replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
const body = document.body.replace(/\r\n?/g, "\n").replace(/\n*$/, "");
return body ? `---\n${yaml}---\n\n${body}\n` : `---\n${yaml}---\n`;
```

`createKnowledgeDocument(path, fields, body, sources?)` must accept only canonical source mappings for new documents. Its creation fields may include producer extensions through `KnowledgeFrontmatter`'s string index, and the constructor must split known keys from extension keys. Keep `KnowledgePatchFields` closed, with no string index signature. `patchKnowledgeDocument` has no `sources` or arbitrary-extension field, so ordinary updates cannot silently reinterpret or convert legacy provenance. `readKnowledgeDocumentFile` and `writeKnowledgeDocumentFile` must be thin filesystem wrappers around this API and must never expose `yaml` objects.

- [ ] **Step 5: Run parser tests and all type checks**

Run:

```bash
pnpm vitest run test/knowledge-document.test.ts
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit the format layer**

```bash
git add package.json pnpm-lock.yaml extensions/llm-wiki/lib/knowledge-document.ts test/knowledge-document.test.ts test/fixtures/okf/documents/nested.md
git commit -m "feat: add shared OKF knowledge document format"
```

---

### Task 2: Resolve Vault Mode, Version, Identity, and Discovery

**Files:**
- Create: `extensions/llm-wiki/lib/vault-format.ts`
- Create: `test/vault-format.test.ts`
- Modify: `extensions/llm-wiki/lib/utils.ts`
- Modify: `test/slugify.test.ts`

- [ ] **Step 1: Write mode and discovery tests**

Create `test/vault-format.test.ts` covering these exact assertions:

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverKnowledgeDocuments,
  inspectVaultFormat,
} from "../extensions/llm-wiki/lib/vault-format.js";
import { ensureVaultStructure, getVaultPaths, slugify } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
function vault(config: Record<string, unknown>) {
  const root = join(import.meta.dirname, "..", "tmp", `format-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), `${JSON.stringify(config)}\n`);
  return paths;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("vault format", () => {
  it("defaults a missing field to legacy", () => {
    expect(inspectVaultFormat(vault({ name: "Old" })).knowledgeFormat).toBe("legacy");
  });

  it.each(["okf-0.3", 2, null])("fails closed for explicit invalid mode %j", (value) => {
    const state = inspectVaultFormat(vault({ knowledge_format: value }));
    expect(state.blocking).toBe(true);
    expect(state.diagnostics[0].code).toBe("config_invalid_knowledge_format");
  });

  it("repairs a missing root index in OKF mode but blocks an unsupported version", () => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    expect(inspectVaultFormat(paths).blocking).toBe(false);
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');
    const state = inspectVaultFormat(paths);
    expect(state.blocking).toBe(true);
    expect(state.diagnostics[0].code).toBe("okf_version_mismatch");
  });

  it("reports and blocks projections without activating an unsupported legacy root version", () => {
    const paths = vault({ knowledge_format: "legacy" });
    writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');
    const state = inspectVaultFormat(paths);
    expect(state.knowledgeFormat).toBe("legacy");
    expect(state.blocking).toBe(true);
    expect(state.diagnostics.map((d) => d.code)).toContain("okf_version_mismatch");
  });

  it("excludes reserved files and normalizes ids to NFC with slash separators", () => {
    const paths = vault({ knowledge_format: "legacy" });
    mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
    writeFileSync(join(paths.wiki, "concepts", "café.md"), "---\ntype: concept\n---\n");
    writeFileSync(join(paths.wiki, "concepts", "INDEX.md"), "user file");
    writeFileSync(join(paths.wiki, "log.md"), "user file");
    const scan = discoverKnowledgeDocuments(paths);
    expect(scan.documents.map((d) => d.id)).toEqual(["concepts/café"]);
  });

  it("blocks NFC and case-fold collisions without returning a partial scan", () => {
    const paths = vault({ knowledge_format: "okf-0.2" });
    writeFileSync(join(paths.wiki, "A.md"), "---\ntype: concept\n---\n");
    writeFileSync(join(paths.wiki, "a.md"), "---\ntype: concept\n---\n");
    const scan = discoverKnowledgeDocuments(paths);
    expect(scan.blocking).toBe(true);
    expect(scan.diagnostics.map((d) => d.code)).toContain("concept_identity_collision");
  });

  it("never generates reserved slugs", () => {
    expect(slugify("Index")).toBe("index-page");
    expect(slugify("LOG")).toBe("log-page");
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm vitest run test/vault-format.test.ts
```

Expected: FAIL because `vault-format.ts` does not exist and reserved slugs are still returned.

- [ ] **Step 3: Implement exact mode and version inspection**

Create `extensions/llm-wiki/lib/vault-format.ts` with:

```ts
export type KnowledgeFormat = "legacy" | "okf-0.2";

export interface VaultFormatState {
  knowledgeFormat: KnowledgeFormat;
  diagnostics: KnowledgeDiagnostic[];
  blocking: boolean;
}

export interface DiscoveredDocument extends KnowledgeDocument {
  absolutePath: string;
}

export interface DiscoveryResult {
  documents: DiscoveredDocument[];
  diagnostics: KnowledgeDiagnostic[];
  blocking: boolean;
}
```

`inspectVaultFormat(paths)` must read `config.json` without defaulting malformed JSON to an empty object. Missing `knowledge_format` resolves to `legacy`; only exact strings `legacy` and `okf-0.2` are accepted. In OKF mode, parse the root index as generic frontmatter without requiring `type`; missing file is repairable, malformed frontmatter or any version other than string `0.2` blocks projection writes. In legacy mode, root metadata never changes the selected mode; an explicit unsupported `okf_version` blocks projection writes, remains available as an ordinary-read diagnostic, and the user-owned root file is never rewritten.

`discoverKnowledgeDocuments(paths)` must recursively scan `.md` files, exclude final filenames `index.md` and `log.md` case-insensitively, parse through `parseKnowledgeDocument`, normalize relative paths to NFC and `/`, and detect duplicate keys using `id.toLowerCase()` after NFC normalization. Sort results with a code-point comparator:

```ts
export function compareCodePoint(a: string, b: string): number {
  const left = a.normalize("NFC");
  const right = b.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
}
```

Return every diagnostic, but set `blocking` for malformed documents, missing type, reserved concept names, and identity collisions. Do not rename files.

- [ ] **Step 4: Replace reserved slug output at the source**

Modify `slugify` in `extensions/llm-wiki/lib/utils.ts`:

```ts
export function slugify(title: string): string {
  const slug =
    title
      .toLocaleLowerCase()
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "untitled";
  return slug === "index" || slug === "log" ? `${slug}-page` : slug;
}
```

Remove `parseFrontmatterValue`, the bespoke `parseFrontmatter`, `findWikiPages`, and `extractWikilinks` only after their callers have been moved in later tasks; until then, leave deprecated wrappers that call the new modules so the branch remains green after this commit.

- [ ] **Step 5: Run focused tests**

```bash
pnpm vitest run test/vault-format.test.ts test/slugify.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit mode and discovery**

```bash
git add extensions/llm-wiki/lib/vault-format.ts extensions/llm-wiki/lib/utils.ts test/vault-format.test.ts test/slugify.test.ts
git commit -m "feat: add OKF vault mode and concept discovery"
```

---

### Task 3: Add CommonMark and Legacy Link Resolution

**Files:**
- Create: `extensions/llm-wiki/lib/knowledge-links.ts`
- Create: `test/knowledge-links.test.ts`

- [ ] **Step 1: Write link-boundary tests**

Create `test/knowledge-links.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildResolvedBacklinks,
  extractKnowledgeLinks,
} from "../extensions/llm-wiki/lib/knowledge-links.js";

const known = new Set([
  "concepts/source",
  "concepts/inline",
  "concepts/full",
  "concepts/collapsed",
  "concepts/shortcut",
  "concepts/encoded name",
  "shared/root",
]);

describe("knowledge links", () => {
  it("extracts inline and used full/collapsed/shortcut references only", () => {
    const body = [
      "[inline](inline.md#part)",
      "[full][target] [collapsed][] [shortcut]",
      "![image](image.md) ![image-ref][target]",
      "<https://example.com> <concepts/inline.md>",
      "<a href=\"inline.md\">raw</a>",
      "`[code](inline.md)`",
      "\\[escaped](inline.md)",
      "    [indented](inline.md)",
      "```md\n[fenced](inline.md)\n```",
      "[unused]: unused.md",
      "[target]: full.md",
      "[collapsed]: collapsed.md",
      "[shortcut]: shortcut.md",
    ].join("\n");
    expect(extractKnowledgeLinks(body).markdown.map((l) => l.target)).toEqual([
      "inline.md#part",
      "full.md",
      "collapsed.md",
      "shortcut.md",
    ]);
  });

  it("resolves root-relative, file-relative, percent-encoded, and wikilinks", () => {
    const body = [
      "[root](/shared/root.md?x=1)",
      "[relative](../concepts/encoded%20name.md)",
      "[[concepts/inline|Inline]]",
      "[external](https://example.com/x.md)",
    ].join("\n");
    const result = buildResolvedBacklinks("concepts/source", body, known);
    expect(result.targets).toEqual(["concepts/encoded name", "concepts/inline", "shared/root"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects bundle escape and reports unresolved internal targets", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[escape](../../outside.md) [missing](missing.md)",
      known,
    );
    expect(result.targets).toEqual([]);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      "link_path_escape",
      "link_unresolved",
    ]);
  });

  it("deduplicates mixed Markdown and wikilink edges", () => {
    const result = buildResolvedBacklinks(
      "concepts/source",
      "[one](inline.md) [[concepts/inline]] [two](./inline.md)",
      known,
    );
    expect(result.targets).toEqual(["concepts/inline"]);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm vitest run test/knowledge-links.test.ts
```

Expected: FAIL because `knowledge-links.ts` does not exist.

- [ ] **Step 3: Implement AST extraction and safe path resolution**

Create `extensions/llm-wiki/lib/knowledge-links.ts`. Parse with `fromMarkdown(body)` and recursively visit nodes. Build a case-insensitive definition map from `definition` nodes. Accept `link` nodes except CommonMark autolinks whose source slice begins with `<`; accept `linkReference` nodes only when their identifier resolves to a definition. Never visit image/image-reference URLs as links. A reference definition alone produces no edge.

Keep legacy wikilink extraction as a separate compatibility scan:

```ts
export interface ExtractedLink {
  target: string;
  offset: number;
}

export function extractLegacyWikilinks(body: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    links.push({ target: match[1].trim(), offset: match.index ?? 0 });
  }
  return links;
}
```

For Markdown targets, strip the earliest query/fragment delimiter, ignore empty fragment-only targets and external URI schemes, percent-decode each segment once, convert decoded backslashes to `/`, and resolve dot segments with an explicit stack. A `..` against an empty stack returns `link_path_escape`. Require a `.md` suffix, remove only that suffix, normalize NFC, and resolve against the source concept directory. Wikilinks are already bundle-relative concept IDs and do not require `.md`.

`buildResolvedBacklinks(sourceId, body, knownIds)` returns sorted, deduplicated known targets and diagnostics. Use `compareCodePoint`, not `localeCompare`.

- [ ] **Step 4: Run link tests**

```bash
pnpm vitest run test/knowledge-links.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit link support**

```bash
git add extensions/llm-wiki/lib/knowledge-links.ts test/knowledge-links.test.ts
git commit -m "feat: resolve CommonMark and legacy wiki links"
```

---

### Task 4: Build Deterministic OKF Index and Log Renderers

**Files:**
- Modify: `extensions/llm-wiki/lib/metadata.ts`
- Create: `test/okf-projections.test.ts`
- Create: `test/fixtures/okf/indexes/root.md`
- Create: `test/fixtures/okf/indexes/concepts.md`
- Create: `test/fixtures/okf/logs/events.jsonl`
- Create: `test/fixtures/okf/logs/log.md`

- [ ] **Step 1: Add byte-golden fixtures**

Create `test/fixtures/okf/indexes/root.md`:

```markdown
---
okf_version: "0.2"
---

# Example Wiki

## Directories

- [concepts/](concepts/)

## Concepts

- [Welcome](welcome.md) — Entry point.
```

Create `test/fixtures/okf/indexes/concepts.md`:

```markdown
# concepts

## Directories

- [nested/](nested/)

## Concepts

- [RAG \[safe\]](retrieval%20augmented.md) — Grounds generation using evidence.
```

Create `test/fixtures/okf/logs/events.jsonl`:

```jsonl
{"timestamp":"2026-08-01T22:00:00.000Z","kind":"capture","z":1,"a":{"z":2,"a":1}}
not json
{"timestamp":"2026-08-02T10:00:00.000Z","kind":"retro","items":[2,1]}
{"timestamp":"2026-08-02T10:00:00.000Z","kind":"observe"}
{"timestamp":"bad","kind":"ignored"}
```

Create `test/fixtures/okf/logs/log.md`:

```markdown
# Wiki Update Log

## 2026-08-02

- **observe**
- **retro**: {"items":[2,1]}

## 2026-08-01

- **capture**: {"a":{"a":1,"z":2},"z":1}
```

- [ ] **Step 2: Write renderer tests**

In `test/okf-projections.test.ts`, instantiate `KnowledgeDocument` values through `createKnowledgeDocument`, call exported pure functions `buildDirectoryIndexes` and `buildOkfLog`, and assert exact fixture equality. Include these additional assertions:

```ts
expect(buildDirectoryIndexes([], { name: "" }).get("index.md")).toBe(
  '---\nokf_version: "0.2"\n---\n\n# Wiki\n',
);
expect([...indexes.keys()].sort()).toEqual([
  "concepts/index.md",
  "concepts/nested/index.md",
  "index.md",
]);
expect(log.diagnostics.map((d) => d.code).sort()).toEqual([
  "event_invalid_json",
  "event_invalid_timestamp",
]);
```

Also verify enumeration-order independence by passing documents and event object keys in reversed order and comparing exact output.

- [ ] **Step 3: Run projection tests and verify failure**

```bash
pnpm vitest run test/okf-projections.test.ts
```

Expected: FAIL because pure OKF renderers are not exported.

- [ ] **Step 4: Implement directory index rendering**

In `metadata.ts`, add:

```ts
export function buildDirectoryIndexes(
  documents: KnowledgeDocument[],
  config: { name?: unknown },
): Map<string, string>;
```

Build a directory tree only from concept documents. Always emit `index.md` for the root. Emit a subdirectory `index.md` only when that directory contains a concept directly or transitively. For each index, list immediate child directories before direct concepts, omit empty sections, and sort both groups with `compareCodePoint` on normalized relative paths.

Use these helpers:

```ts
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function encodeRelativePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function compactDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact || undefined;
}
```

The root frontmatter must contain only `okf_version: "0.2"`; do not emit a profile key, timestamps, counts, or producer metadata.

- [ ] **Step 5: Implement deterministic root log rendering**

Add:

```ts
export interface OkfLogResult {
  markdown: string;
  diagnostics: KnowledgeDiagnostic[];
}

export function buildOkfLog(eventsJsonl: string, path = "meta/events.jsonl"): OkfLogResult;
```

Keep source line numbers as sequence, reject malformed JSON, missing/invalid timestamps, and empty/non-string kinds, group by UTC date, sort date descending, then timestamp descending, then source sequence descending. Escape `kind` for backslash, `*`, `_`, `[`, and `]`, collapsing whitespace to one space.

Canonicalize detail JSON recursively:

```ts
function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodePoint(a, b))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}
```

The empty event stream renders exactly `# Wiki Update Log\n`.

- [ ] **Step 6: Run golden tests**

```bash
pnpm vitest run test/okf-projections.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit pure renderers and fixtures**

```bash
git add extensions/llm-wiki/lib/metadata.ts test/okf-projections.test.ts test/fixtures/okf/indexes test/fixtures/okf/logs
git commit -m "feat: render deterministic OKF indexes and log"
```

---

### Task 5: Replace Metadata Rebuild with Fail-Closed Projection Publication

**Files:**
- Modify: `extensions/llm-wiki/lib/metadata.ts`
- Modify: `extensions/llm-wiki/lib/indexing.ts`
- Modify: `extensions/llm-wiki/lib/utils.ts`
- Modify: `test/okf-projections.test.ts`
- Modify: `test/indexing.test.ts`

- [ ] **Step 1: Add rebuild integration tests before changing publication**

Extend `test/okf-projections.test.ts` with temp-vault tests for:

1. Legacy mode builds only `meta/registry.json`, `meta/backlinks.json`, `meta/index.md`, and `meta/log.md`; existing `wiki/index.md` and `wiki/log.md` bytes remain unchanged.
2. OKF mode builds root/subdirectory indexes and root log, then removes an obsolete generated subdirectory index after its last concept is deleted.
3. Markdown and wikilink edges are merged and stored only for known targets.
4. A malformed concept after a successful generation leaves all previous registry, backlinks, indexes, and logs byte-identical.
5. An unsupported OKF root version and invalid explicit config mode leave all previous projections byte-identical.
6. An unresolved link and malformed event line publish valid projections while returning non-blocking diagnostics.
7. No `*.tmp-*` files remain after success.

Use a helper that snapshots exact bytes:

```ts
function snapshot(paths: VaultPaths, files: string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [file, readFileSync(join(paths.dotWiki, file), "utf8")]),
  );
}
```

- [ ] **Step 2: Run the focused test and verify failure**

```bash
pnpm vitest run test/okf-projections.test.ts
```

Expected: FAIL because current rebuild publishes partial results and always ignores OKF projections.

- [ ] **Step 3: Replace registry construction with shared discovery**

Change `RegistryEntry.type` from a closed union to `string`; make `created` and `updated` optional. Build entries by flattening semantic `KnowledgeDocument` values, using `title` only when it is a non-empty string and otherwise the final ID segment. Never fill absent timestamps with `fmtDate()`.

Retain raw source/trajectory manifest fallback entries for existing workflows, but do not let a fallback overwrite a parsed concept document and do not invent missing manifest dates. Raw fallback IDs remain registry-only compatibility entries; they are not concept identities for indexes or backlink target resolution unless a parsed source/trajectory page exists at that ID.

Change backlinks to call `buildResolvedBacklinks` for every discovered concept. Initialize parsed concept IDs with empty arrays, resolve only against the discovered-document ID set, store only those resolved targets, and deduplicate each `(source, target)` edge.

- [ ] **Step 4: Compute a complete generation in memory**

Replace the two rebuild paths with one result-bearing function:

```ts
export interface ProjectionResult {
  ok: boolean;
  diagnostics: KnowledgeDiagnostic[];
  registry?: Registry;
  backlinks?: Backlinks;
}

export function rebuildMetadata(paths: VaultPaths): ProjectionResult;
export const rebuildMetadataLight = rebuildMetadata;
```

Before writing anything:

1. Call `inspectVaultFormat`.
2. Call `discoverKnowledgeDocuments`.
3. Stop with `ok: false` when either has blocking diagnostics.
4. Build registry, backlinks, `meta/index.md`, existing rich `meta/log.md`, optional OKF indexes, and optional OKF root log as strings in memory.
5. Keep unresolved-link and event diagnostics but do not mark the generation failed.

Use per-file atomic replacement:

```ts
function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}
```

Write registry/backlinks before optional embedding work. In OKF mode, prune only generated `**/index.md` files not present in the new index map; keep root `index.md`. In legacy mode, never create, rewrite, or prune files under `wiki/`.

Keep multi-file crash recovery out of this task.

- [ ] **Step 5: Gate embedding refresh on metadata success**

Modify `scheduleReindex`:

```ts
const result = rebuildMetadata(paths);
if (!result.ok) continue;
runtime.ensureConfig(root);
const embedder = resolveEmbedder(runtime.config);
if (embedder) await reindexEmbeddings(paths, embedder);
```

Add an indexing test that writes a malformed concept, schedules a pass with a mock embedder, and asserts the embedder call count remains zero and the old registry bytes remain unchanged.

- [ ] **Step 6: Remove the bespoke parser/scanner implementations**

After all metadata callers use the shared modules, delete the deprecated parser, page scanner, and wikilink regex from `utils.ts`. Keep `readJson`, `writeJson`, path helpers, ID generation, `slugify`, and protected-path helpers.

- [ ] **Step 7: Run metadata and indexing tests**

```bash
pnpm vitest run test/okf-projections.test.ts test/indexing.test.ts test/wiki-structure.test.ts
pnpm typecheck
```

Expected: PASS. Update old title assertions from quoted YAML source text to semantic strings, for example `"Test Requirement"` instead of `'"Test Requirement"'`.

- [ ] **Step 8: Commit fail-closed projections**

```bash
git add extensions/llm-wiki/lib/metadata.ts extensions/llm-wiki/lib/indexing.ts extensions/llm-wiki/lib/utils.ts test/okf-projections.test.ts test/indexing.test.ts test/wiki-structure.test.ts
git commit -m "feat: publish OKF projections fail closed"
```

---

### Task 6: Route Recall, Search, Status, and Embeddings Through Shared Documents

**Files:**
- Create: `extensions/llm-wiki/lib/wiki-service.ts`
- Modify: `extensions/llm-wiki/lib/recall.ts`
- Modify: `extensions/llm-wiki/lib/embeddings.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `test/recall.test.ts`
- Modify: `test/embeddings.test.ts`
- Create: `test/okf-integration.test.ts`

- [ ] **Step 1: Write dual-read and diagnostic service tests**

Create `test/okf-integration.test.ts` with a legacy-mode vault containing one scalar-source legacy page and one nested OKF page. Rebuild metadata and assert both are searchable, nested aliases/tags are flattened for scoring, unknown type `Foreign Concept` is returned unchanged, and no `wiki/index.md`/`wiki/log.md` appears.

Add an OKF-mode case with a supported root, then replace the root version with `0.3` after a known-good rebuild. Assert ordinary recall still returns the known-good parseable concept and includes `okf_version_mismatch` in the service diagnostics.

Use these shared service result shapes in assertions:

```ts
export interface RegistrySearchResult {
  matches: Array<{ id: string; title: string; type: string }>;
  diagnostics: KnowledgeDiagnostic[];
}

export interface WikiStatusSnapshot {
  knowledgeFormat: KnowledgeFormat;
  totalPages: number;
  byType: Record<string, number>;
  blockingDiagnostics: KnowledgeDiagnostic[];
  lastUpdated: string;
}
```

- [ ] **Step 2: Run integration tests and verify failure**

```bash
pnpm vitest run test/okf-integration.test.ts
```

Expected: FAIL because shared service snapshots do not exist and recall still uses the bespoke parser.

- [ ] **Step 3: Implement shared registry search and status**

Create `wiki-service.ts` with pure `searchRegistry(paths, query, type?)` and `getWikiStatus(paths)`. Both read the same `Registry` schema used by Pi recall. Both append current mode/version diagnostics from `inspectVaultFormat`; status also calls discovery so malformed current concepts appear as blocking diagnostics even when a known-good registry remains on disk.

Search must match ID, semantic title, type, category, domain, tags, aliases, and recall triggers. Preserve unknown types as strings.

- [ ] **Step 4: Move recall page parsing to `KnowledgeDocument`**

Replace every `parseFrontmatter` call in `recall.ts` with a helper:

```ts
function parsePage(path: string, id: string): KnowledgeDocument | undefined {
  if (!existsSync(path)) return undefined;
  const result = parseKnowledgeDocument(readFileSync(path, "utf8"), `${id}.md`);
  return result.ok ? result.document : undefined;
}
```

Use `document.frontmatter`, `document.extensions`, `document.sources`, and `document.body` for scoring, previews, PRF chunks, and skill/case inlining. Add `description` to preview-relevant metadata. Keep lexical/semantic score formulas unchanged; Foundation adds no trust weighting.

The `wiki_recall` tool must include mode/version diagnostics in `details` and append a concise diagnostic line to text output without hiding parseable results.

- [ ] **Step 5: Move embeddings to `KnowledgeDocument`**

Change `readPageText` in `embeddings.ts` to parse through `parseKnowledgeDocument`; skip malformed pages. Build embedding metadata from semantic known fields plus extensions, preserving current title/type/alias/summary/description/tag/category/domain behavior. Do not add trust-derived score fields.

- [ ] **Step 6: Use shared services in Pi tools**

Replace the inline `wiki_search` registry loop with `searchRegistry`. Replace inline `wiki_status` computation with `getWikiStatus`. Include `knowledge_format` and stable diagnostic codes in both tool `details`; status text must print `Knowledge format: legacy|okf-0.2` and each blocking diagnostic.

- [ ] **Step 7: Run focused reader tests**

```bash
pnpm vitest run test/okf-integration.test.ts test/recall.test.ts test/embeddings.test.ts
pnpm typecheck
```

Expected: PASS with existing lexical, PRF, two-stage, and semantic-ranking assertions unchanged.

- [ ] **Step 8: Commit shared readers**

```bash
git add extensions/llm-wiki/lib/wiki-service.ts extensions/llm-wiki/lib/recall.ts extensions/llm-wiki/lib/embeddings.ts extensions/llm-wiki/lib/tools.ts test/okf-integration.test.ts test/recall.test.ts test/embeddings.test.ts
git commit -m "feat: share OKF readers across wiki services"
```

---

### Task 7: Route Every Wiki Page Producer Through Canonical Serialization

**Files:**
- Modify: `extensions/llm-wiki/lib/source-packet.ts`
- Modify: `extensions/llm-wiki/lib/utils.ts`
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts`
- Modify: `extensions/llm-wiki/lib/observation.ts`
- Modify: `extensions/llm-wiki/lib/retro.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `skills/llm-wiki/SKILL.md`
- Modify: `test/source-capture.test.ts`
- Modify: `test/ingest-worker.test.ts`
- Modify: `test/observation.test.ts`
- Modify: `test/retro.test.ts`
- Modify: `test/wiki-structure.test.ts`
- Modify: `test/package-structure.test.ts`

- [ ] **Step 1: Add producer conformance assertions first**

For each existing producer test, parse the generated `.md` file with `parseKnowledgeDocument` and assert `result.ok === true`. Add these exact behavior checks:

- Source skeleton: semantic `type: source`; no invented `sources`, `generated`, or `verified`.
- Ingested entity/concept: `description` is populated from the one-line synthesis value; `sources.kind === "canonical"`; body links use `/sources/<id>.md`.
- Ingested source rewrite: a pre-existing legacy scalar/list `sources` value and unknown nested producer field survive status/body update unchanged.
- Observation and retro: quoted user text is YAML-safe without manual escaping; generated output has one frontmatter/body separator and one final newline.
- `wiki_ensure_page`: custom `content` is treated as body content and cannot replace required frontmatter; default body uses standard Markdown links.
- Lint-created stub: parses as a canonical concept and uses Markdown links to mentioning pages.
- Reserved titles `Index` and `Log` produce `index-page.md` and `log-page.md`.

Add a package-structure assertion that the page-producing modules import `createKnowledgeDocument`, `serializeKnowledgeDocument`, `patchKnowledgeDocument`, or `writeKnowledgeDocumentFile` from `knowledge-document.ts`.

- [ ] **Step 2: Run producer tests and verify failure**

```bash
pnpm vitest run test/source-capture.test.ts test/ingest-worker.test.ts test/observation.test.ts test/retro.test.ts test/wiki-structure.test.ts test/package-structure.test.ts
```

Expected: FAIL on legacy string templates, wikilinks, and unsafe quoted values.

- [ ] **Step 3: Convert source capture**

Narrow the command runner accepted by source capture before replacing the page builder:

```ts
type ExecApi = Pick<ExtensionAPI, "exec">;

export async function captureUrl(
  pi: ExecApi,
  paths: VaultPaths,
  url: string,
  signal?: AbortSignal,
): Promise<CaptureResult>;

export async function captureFile(
  pi: ExecApi,
  paths: VaultPaths,
  filePath: string,
  signal?: AbortSignal,
): Promise<CaptureResult>;
```

Change `utils.exec` to accept the same `ExecApi`; it uses no other `ExtensionAPI` members. This allows Pi and MCP to share capture without unsafe full-interface casts.

Replace `buildSourcePageSkeleton` string frontmatter with:

```ts
const document = createKnowledgeDocument(
  `sources/${id}.md`,
  {
    type: "source",
    title,
    format,
    source_id: id,
    raw_path: `raw/sources/${id}/extracted.md`,
    captured,
    status: "skeleton",
  },
  body,
);
return serializeKnowledgeDocument(document);
```

Keep immutable raw packet writes unchanged. Append the capture event only after raw files and source page have all succeeded.

- [ ] **Step 4: Convert ingestion and preserve existing legacy source shapes**

Build new entity/concept pages with `description` and canonical sources:

```ts
const sources = [{ id: sourceId, resource: `/sources/${encodeURIComponent(sourceId)}.md` }];
const doc = createKnowledgeDocument(
  `entities/${slug}.md`,
  { type: "entity", title, description: description.trim(), created: date, updated: date },
  body,
  sources,
);
```

Use bundle-root-relative Markdown links in generated bodies. For the source page rewrite, read and parse the existing skeleton, then call:

```ts
const updated = patchKnowledgeDocument(existing, {
  fields: { status: "ingested", updated: date },
  body: buildIngestedSourceBody(manifest, data),
});
writeKnowledgeDocumentFile(result.sourcePage, updated);
```

If the source page is unexpectedly absent, create a canonical source document from known manifest fields. Change persistence to an explicit union so malformed input cannot escape as a YAML-library exception:

```ts
export type CommitSynthesisOutcome =
  | ({ ok: true } & CommitResult)
  | { ok: false; sourceId: string; diagnostics: KnowledgeDiagnostic[] };
```

Update `commitSynthesis`, `runIngestSynthesis`, the background caller in `tools.ts`, and tests to branch on `outcome.ok`. If the existing source page is malformed, return `ok: false` before creating entity/concept pages or appending the ingest event.

- [ ] **Step 5: Convert observation, retro, ensure-page, and lint stubs**

Construct frontmatter objects rather than interpolated YAML. Keep user/model body Markdown byte content except serializer newline normalization. For `wiki_ensure_page`, wrap `params.content` as body; never accept it as a complete file replacement. For lint stubs, pass canonical fields and a body containing standard Markdown links.

New templates must not emit `sources: []` merely because provenance is unknown. Emit canonical structured sources only when a source ID is actually known.

- [ ] **Step 6: Update generated-link guidance**

In `skills/llm-wiki/SKILL.md` and both bootstrap schema strings, state:

```markdown
- New internal links: [label](/folder/page.md)
- Legacy readable links: [[folder/page]]
- Source citation: [source](/sources/SRC-YYYY-MM-DD-NNN.md)
```

Do not rewrite existing wikilinks.

- [ ] **Step 7: Run producer tests**

```bash
pnpm vitest run test/source-capture.test.ts test/ingest-worker.test.ts test/observation.test.ts test/retro.test.ts test/wiki-structure.test.ts test/package-structure.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit canonical producers**

```bash
git add extensions/llm-wiki/lib/source-packet.ts extensions/llm-wiki/lib/utils.ts extensions/llm-wiki/lib/ingest-worker.ts extensions/llm-wiki/lib/observation.ts extensions/llm-wiki/lib/retro.ts extensions/llm-wiki/lib/tools.ts skills/llm-wiki/SKILL.md test/source-capture.test.ts test/ingest-worker.test.ts test/observation.test.ts test/retro.test.ts test/wiki-structure.test.ts test/package-structure.test.ts
git commit -m "feat: serialize all new wiki pages canonically"
```

---

### Task 8: Enforce Mode-Aware Bootstrap, Events, Guardrails, and Rebuild Results

**Files:**
- Modify: `extensions/llm-wiki/index.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `extensions/llm-wiki/lib/guardrails.ts`
- Modify: `extensions/llm-wiki/lib/indexing.ts`
- Modify: `extensions/llm-wiki/lib/observation.ts`
- Modify: `extensions/llm-wiki/lib/retro.ts`
- Modify: `extensions/llm-wiki/lib/trajectory.ts`
- Modify: `test/guardrails.test.ts`
- Modify: `test/background-tools.test.ts`
- Modify: `test/indexing.test.ts`
- Modify: `test/okf-integration.test.ts`

- [ ] **Step 1: Add operation-table tests first**

Add tests for:

- Explicit and silent new-vault bootstrap persist `knowledge_format: "okf-0.2"`.
- Running bootstrap against an existing old-vault config with no `knowledge_format` preserves the missing field and legacy behavior; it does not activate OKF mode.
- Bootstrap appends its event before rebuilding so `wiki/log.md` contains `bootstrap` immediately.
- Opening a config without `knowledge_format` does not create or rewrite `wiki/index.md` or `wiki/log.md`.
- Creating the same page in legacy and OKF modes appends the same event payload after removing timestamps.
- `wiki_rebuild_meta` does not append a `rebuild_meta` event.
- `wiki_log_event` validates mode/version before appending to `meta/events.jsonl`.
- `wiki_reindex_embeddings` validates mode/version before writing `meta/embeddings.json` or appending an event.
- Manual write/edit tracking schedules a rebuild but appends no event.
- Unknown mode blocks every mutating tool, including observation, retro, lint, source/trajectory capture, ingestion commit, ensure-page, manual event logging, and embedding reindex, before authoritative or metadata writes.
- Unsupported OKF root version permits recall but blocks writes/rebuild publication.
- OKF mode blocks writes/edits to root log and every case-insensitive `**/index.md`; legacy mode allows those same user-owned paths.

- [ ] **Step 2: Run the tests and verify failure**

```bash
pnpm vitest run test/guardrails.test.ts test/background-tools.test.ts test/indexing.test.ts test/okf-integration.test.ts
```

Expected: FAIL because bootstrap lacks mode, rebuild emits an event, and guardrails are not mode-aware.

- [ ] **Step 3: Persist OKF mode on every new bootstrap path**

Add `knowledge_format: "okf-0.2"` to silent session bootstrap and to explicit bootstrap only when `config.json` did not exist before the operation. When config already exists, parse and validate it first, preserve its `knowledge_format` exactly (including absence for old vaults), and update only existing bootstrap-owned fields such as name/topic/mode. An invalid explicit mode fails before config, schema, event, or projection writes. Explicit bootstrap sequence after that decision must be:

```ts
writeJson(configPath, config);
writeFileSync(schemaPath, schema, "utf8");
appendEvent(paths, { kind: "bootstrap", topic: params.topic, mode });
const projection = rebuildMetadata(paths);
```

If projection fails, return its stable diagnostics. Existing vaults with a missing field remain legacy; no startup code may add the field to them.

- [ ] **Step 4: Validate writes and report rebuild diagnostics**

Add shared `inspectWritableVault(paths)` in `vault-format.ts`; it combines vault existence, explicit mode validation, and blocking root-version validation. Pi's `requireWritableVault` and MCP write operations must delegate to it before mutation. Every mutating tool calls it before mutation, including observation, retro, lint, source/trajectory capture, ingestion, ensure-page, manual event logging, embedding reindex, and metadata rebuild. Background ingestion rechecks it immediately before commit so a config change during synthesis cannot bypass fail-closed behavior. `wiki_rebuild_meta` reports `ProjectionResult`; remove `appendEvent(paths, { kind: "rebuild_meta" })`.

`wiki_log_event` must call `inspectWritableVault` before appending its user-requested event, then call `rebuildMetadata` so both meta and OKF log projections refresh from the same event source. `wiki_reindex_embeddings` must perform the same validation before any embedding-store write or event append.

- [ ] **Step 5: Protect OKF reserved projections only in OKF mode**

Extend `isProtectedPath` or add `isGeneratedOkfPath`:

```ts
export function isGeneratedOkfPath(path: string, paths: VaultPaths): boolean {
  const state = inspectVaultFormat(paths);
  if (state.knowledgeFormat !== "okf-0.2") return false;
  const relative = relativePathInside(paths.wiki, path);
  if (relative === undefined) return false;
  const parts = relative.split("/");
  const name = parts.at(-1)?.toLowerCase();
  return name === "index.md" || (parts.length === 1 && name === "log.md");
}
```

Block both write and edit paths with: `Generated OKF indexes and log are read-only. Use wiki_rebuild_meta or the page-producing tool that owns the source mutation.` Existing raw/meta protections remain unchanged.

- [ ] **Step 6: Preserve manual-edit and background behavior**

A successful manual wiki edit sets the dirty flag and rebuilds at turn end; it never fabricates an event. A failed projection returns diagnostics and skips embeddings. Keep background coalescing and one-pass behavior intact.

- [ ] **Step 7: Run operation tests**

```bash
pnpm vitest run test/guardrails.test.ts test/background-tools.test.ts test/indexing.test.ts test/okf-integration.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit mode-aware operations**

```bash
git add extensions/llm-wiki/index.ts extensions/llm-wiki/lib/tools.ts extensions/llm-wiki/lib/guardrails.ts extensions/llm-wiki/lib/indexing.ts extensions/llm-wiki/lib/observation.ts extensions/llm-wiki/lib/retro.ts extensions/llm-wiki/lib/trajectory.ts test/guardrails.test.ts test/background-tools.test.ts test/indexing.test.ts test/okf-integration.test.ts
git commit -m "feat: enforce OKF mode across wiki operations"
```

---

### Task 9: Map the Exact Five MCP Operations to Shared Services

**Files:**
- Create: `mcp/operations.ts`
- Modify: `mcp/index.ts`
- Modify: `tsconfig.json`
- Create: `test/mcp-parity.test.ts`

- [ ] **Step 1: Include MCP code in type checking**

Change `tsconfig.json`:

```json
{
  "include": ["extensions/**/*.ts", "mcp/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Write thin parity tests**

Create `test/mcp-parity.test.ts`. Build one temp vault, rebuild it, and compare MCP operation data with direct shared service data:

```ts
const piSearch = searchRegistry(paths, "nested");
const mcpSearch = await searchOperation(paths, "nested");
expect(mcpSearch).toEqual(piSearch);

const piStatus = getWikiStatus(paths);
const mcpStatus = await statusOperation(paths);
expect(mcpStatus).toEqual(piStatus);

const piRecall = searchWiki(paths, "nested", 5);
const mcpRecall = await recallOperation(paths, "nested", 5);
expect(mcpRecall.results).toEqual(piRecall);
expect(mcpRecall.diagnostics.map((d) => d.code)).toEqual(
  inspectVaultFormat(paths).diagnostics.map((d) => d.code),
);
```

Also call `retroOperation` and text `captureSourceOperation`, parse their created pages, and assert canonical semantic equality with `saveInsight` and `captureText` outputs in separate equivalent vaults.

Add a source-text assertion over `mcp/index.ts` that exactly these names are registered and no MCP read operation exists:

```ts
expect([...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((m) => m[1])).toEqual([
  "wiki_recall",
  "wiki_search",
  "wiki_status",
  "wiki_retro",
  "wiki_capture_source",
]);
```

- [ ] **Step 3: Run parity tests and verify failure**

```bash
pnpm vitest run test/mcp-parity.test.ts
```

Expected: FAIL because MCP duplicates search/status/recall and has no importable operation layer.

- [ ] **Step 4: Create testable MCP operation adapters**

Create `mcp/operations.ts` exporting:

```ts
export async function recallOperation(paths: VaultPaths, query: string, maxResults = 5);
export async function searchOperation(paths: VaultPaths, query: string, type?: string);
export async function statusOperation(paths: VaultPaths);
export async function retroOperation(
  paths: VaultPaths,
  slug: string,
  title: string,
  body: string,
  category?: string,
);
export async function captureSourceOperation(
  paths: VaultPaths,
  input: { text?: string; url?: string; filePath?: string; title?: string },
  execApi: Pick<ExtensionAPI, "exec">,
);
```

`recallOperation` calls shared `searchWiki` and appends `inspectVaultFormat` diagnostics. Search and status delegate directly to `wiki-service.ts`. Before writes, retro and capture call `inspectWritableVault` and return its stable diagnostics on failure; after that check, retro delegates to `saveInsight` and capture delegates to the same `captureText`/`captureUrl`/`captureFile` functions used by Pi. No operation may parse YAML, scan files, score registry entries, or build page strings itself.

- [ ] **Step 5: Reduce MCP index to transport and rendering**

Delete local `VaultPaths`, format detection, parser regex, registry scoring, status aggregation, and page write assumptions from `mcp/index.ts`. Reuse `resolveVaultPaths`/`getVaultPaths` for `WIKI_ROOT` selection. Keep only Zod schemas, vault-existence errors, operation calls, and interface-specific JSON/text rendering.

Fix the current retro result rendering to use `slug/sourcePagePath`, not nonexistent `sourceId/packetPath` fields.

Do not add an MCP read operation.

- [ ] **Step 6: Run MCP and full type checks**

```bash
pnpm vitest run test/mcp-parity.test.ts
pnpm typecheck
```

Expected: PASS, including `mcp/**/*.ts`.

- [ ] **Step 7: Commit MCP parity**

```bash
git add mcp/operations.ts mcp/index.ts tsconfig.json test/mcp-parity.test.ts
git commit -m "feat: share OKF services with MCP"
```

---

### Task 10: Complete Foundation Conformance and Release Gates

**Files:**
- Modify: `test/okf-integration.test.ts`
- Modify: `test/package-structure.test.ts`
- Modify: any existing test whose fixture intentionally represents legacy input

- [ ] **Step 1: Add one end-to-end Foundation acceptance test**

Extend `test/okf-integration.test.ts` with this flow:

1. Bootstrap a new vault through the Pi tool registration seam.
2. Assert config persists `okf-0.2`.
3. Capture text, ingest deterministic synthesis, create an observation, create a retro, and create a requirement through `wiki_ensure_page`.
4. Parse every resulting concept file with `parseKnowledgeDocument`.
5. Assert all known-source pages use canonical mapping-sequence `sources`; pages without known provenance omit `sources`.
6. Assert generated bodies use standard Markdown links while an added legacy `[[wikilink]]` remains readable and participates in backlinks.
7. Rebuild twice and assert every OKF index/log byte is identical between runs.
8. Corrupt one concept, rebuild, and assert the last known-good projections remain byte-identical.
9. Restore the concept and assert rebuild recovers.
10. Assert no import/export/migration/trust-scoring tools are registered by Foundation.

- [ ] **Step 2: Run the complete test suite**

```bash
pnpm test
```

Expected: all existing and new tests PASS.

- [ ] **Step 3: Run static and coverage gates**

```bash
pnpm typecheck
pnpm lint
pnpm test:coverage
```

Expected: all commands exit 0. Coverage must meet existing configured thresholds.

- [ ] **Step 4: Check exact scope and generated-file behavior manually**

Run:

```bash
git diff --name-only HEAD~10..HEAD
grep -R "wiki_okf_import\|wiki_okf_export\|wiki_okf_migrate\|transaction journal\|trust factor" extensions mcp test || true
```

Expected: no Foundation implementation of import, export, migration, transaction journals, or trust scoring. Mentions inside spec/plan files are acceptable; production directories must have no matching feature surface.

- [ ] **Step 5: Verify no serializer bypass remains in page producers**

Run:

```bash
grep -R "^---\\n\|\[\[" extensions/llm-wiki/lib/{source-packet,ingest-worker,observation,retro,tools}.ts
```

Expected: no generated frontmatter template literals remain. Any remaining `[[` occurrence is compatibility text or user-input guidance explicitly identified by its test; generated page bodies use Markdown links.

- [ ] **Step 6: Commit final conformance coverage**

```bash
git add test/okf-integration.test.ts test/package-structure.test.ts test
git commit -m "test: cover OKF Foundation acceptance criteria"
```

- [ ] **Step 7: Record final verification evidence**

Run:

```bash
git status --short
git log --oneline -10
```

Expected: clean working tree; commits correspond to Tasks 1–10. Report exact test, typecheck, lint, and coverage outcomes. Do not claim completion from stale output.

---

## Acceptance-Criteria Traceability

| Foundation acceptance criterion | Plan coverage |
|---|---|
| Every page producer uses shared API | Task 7, Task 10 |
| Existing vaults remain legacy without reserved wiki projections | Tasks 2, 5, 8 |
| New vaults use OKF 0.2 deterministic reserved files | Tasks 4, 5, 8, 10 |
| Nested metadata and unknown fields round-trip | Task 1 |
| Markdown and wikilinks both produce backlinks | Tasks 3, 5 |
| Projection bytes match golden fixtures | Tasks 4, 5 |
| Invalid mode/version/malformed concepts preserve known-good metadata | Tasks 2, 5, 8 |
| Pi and MCP return equivalent shared-model results | Tasks 6, 9 |
| Tests, typecheck, lint, coverage pass | Task 10 |

## Deliberate Non-Goals

No task creates import staging, export output, a migration command, transaction journals, trust weighting, graph UI, git snapshots, extraction adapters, or computation execution. Legacy documents remain in place and retain existing source shapes during ordinary service updates; conversion belongs to a later Interchange plan.
