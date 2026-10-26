# OKF Foundation Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Repair the reviewed OKF Foundation implementation so strict document handling, vault-mode enforcement, authoritative writes, projections, Pi, and the exact five MCP operations conform to the Foundation specification without adding later-phase features.

**Architecture:** Keep the existing shared `KnowledgeDocument`, vault-format, projection, and service modules, but make them the only trusted boundaries. Parsing becomes strict before conversion; vault validation becomes a shared precondition inside authoritative writers; existing pages are patched rather than reconstructed; Pi and MCP remain thin adapters over the same services. Acceptance tests exercise real extension/MCP seams instead of constructing equivalent state directly.

**Tech Stack:** TypeScript ES2022, Node.js filesystem/path/child-process APIs, `yaml` 2.9, `mdast-util-from-markdown` 2.0, Vitest 3, Biome, pnpm.

**Roadmap:** `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md` (sequencing only; non-normative)

**Phase:** Phase 1: Foundation remediation

---

## Normative Inputs and Scope

The only normative behavior source is `docs/superpowers/specs/2026-08-02-okf-foundation-design.md`. The original plan at `docs/superpowers/plans/2026-08-02-okf-foundation.md` is implementation history, not authority. Review findings are defects to verify with failing tests before changing production code.

This remediation fixes Foundation behavior only. It does not add import, export, migration, transaction journals, trust/freshness scoring, graph UI, git snapshots, expanded extraction adapters, or Attested Computation execution. Per-file atomic projection replacement remains the Foundation ceiling; cross-file transactions remain out of scope.

Baseline before remediation:

```text
pnpm test:          35 files, 459 tests pass
pnpm typecheck:     pass
pnpm lint:          pass
pnpm test:coverage: pass without thresholds
coverage:           69.02% statements; extensions/llm-wiki/index.ts 0%
```

## Reviewed Defect Disposition

| Reviewed finding | Classification | Planned fix |
|---|---|---|
| Malformed YAML, nested duplicates, non-string `type`, null coercion, inexact fence | Implementation defect | Task 1 |
| Unknown `__proto__` field loss and creation-time `sources` drop | Implementation defect | Task 1 |
| NFC-equivalent physical paths evade collision detection | Implementation defect | Task 2 |
| Symlink traversal and swallowed scan errors | Implementation defect | Task 2 |
| Malformed percent encoding throws; root links without `.md` accepted | Implementation defect | Task 2 |
| Silent bootstrap omits `okf-0.2`, event, and projections | Implementation defect | Task 3 |
| Missing/malformed config and malformed/versionless OKF root fail open | Implementation defect | Task 3 |
| Bootstrap writes before validating existing state | Implementation defect | Task 3 |
| OKF generated-path guard is not containment-safe or fail-closed | Implementation defect | Task 3 |
| Capture, ingest, trajectory, event, observation, retro, lint, ensure-page, rebuild, and embeddings do not share one write precondition | Implementation defect | Tasks 3–5 |
| Existing source page is reconstructed and loses metadata | Implementation defect | Task 4 |
| Retro slug permits path traversal | Implementation defect | Task 4 |
| Background ingestion does not revalidate before commit | Implementation defect | Task 5 |
| Embeddings run after failed metadata rebuild | Implementation defect | Task 5 |
| Lint uses obsolete parser/scanner; old helpers remain | Implementation defect | Task 6 |
| Pi recall omits format diagnostics and may expose malformed stale pages | Implementation defect | Task 6 |
| Event diagnostics are discarded, timestamps sort lexically, details override reserved fields | Implementation defect | Task 6 |
| MCP writes are not discoverable and production exec is a no-op | Implementation defect | Task 7 |
| Task 10 acceptance test bypasses production seams | Test defect | Task 8 |
| Temporary-file assertion checks the wrong filename pattern | Test defect | Task 8 |
| Coverage plan assumed thresholds that did not exist | Original-plan defect | Task 8 |
| Original plan did not specify a real MCP command runner | Original-plan defect | Task 7 |

## File Responsibility Map

### New files

- `extensions/llm-wiki/lib/bootstrap.ts` — one validated bootstrap service used by silent and explicit Pi paths.
- `mcp/exec.ts` — Node-backed implementation of the narrow `ExecApi` used by MCP capture.
- `test/bootstrap.test.ts` — shared bootstrap behavior plus actual extension `session_start` seam.
- `test/mutation-guards.test.ts` — fail-closed regression matrix for authoritative writers.
- `test/indexing-fail-closed.test.ts` — background rebuild/embedding failure checks.
- `test/ingest-concurrency.test.ts` — configuration race between synthesis and commit.
- `test/mcp-exec.test.ts` — subprocess success, failure, cancellation, timeout, and real capture behavior.

### Existing production files to modify

- `extensions/llm-wiki/lib/knowledge-document.ts` — strict YAML validation and semantic conversion.
- `extensions/llm-wiki/lib/vault-format.ts` — strict config/root inspection, physical identity tracking, safe scanning, shared write assertion.
- `extensions/llm-wiki/lib/knowledge-links.ts` — non-throwing URI decoding and consistent `.md` target rules.
- `extensions/llm-wiki/lib/metadata.ts` — event integrity, chronological sorting, diagnostic propagation.
- `extensions/llm-wiki/lib/source-packet.ts` — shared write assertion before packet creation.
- `extensions/llm-wiki/lib/ingest-worker.ts` — immediate pre-commit validation and legacy-preserving patch.
- `extensions/llm-wiki/lib/observation.ts` — shared write assertion in the service.
- `extensions/llm-wiki/lib/retro.ts` — shared write assertion and safe slug/path handling.
- `extensions/llm-wiki/lib/trajectory.ts` — shared write assertion before trajectory packet creation.
- `extensions/llm-wiki/lib/embeddings.ts` — shared write assertion before embedding-store replacement.
- `extensions/llm-wiki/lib/indexing.ts` — skip embeddings after a blocked rebuild.
- `extensions/llm-wiki/lib/recall.ts` — format diagnostics and malformed-page exclusion.
- `extensions/llm-wiki/lib/tools.ts` — shared bootstrap, strict mutation checks, shared lint/link services, safe event input.
- `extensions/llm-wiki/lib/guardrails.ts` — fail closed for invalid vault state and protect only contained OKF generated paths.
- `extensions/llm-wiki/lib/utils.ts` — remove obsolete YAML/page/link helpers; retain path, JSON, slug, and exec utilities.
- `extensions/llm-wiki/index.ts` — use shared bootstrap during `session_start`.
- `mcp/operations.ts` — rebuild after writes and propagate diagnostics.
- `mcp/index.ts` — use the real MCP exec adapter.
- `vitest.config.ts` — enforce global and trusted-boundary coverage thresholds.

### Existing tests to extend

- `test/knowledge-document.test.ts`
- `test/vault-format.test.ts`
- `test/knowledge-links.test.ts`
- `test/okf-projections.test.ts`
- `test/ingest-worker.test.ts`
- `test/indexing.test.ts`
- `test/guardrails.test.ts`
- `test/background-tools.test.ts`
- `test/ingest-tool.test.ts`
- `test/trajectory.test.ts`
- `test/recall.test.ts`
- `test/mcp-parity.test.ts`
- `test/okf-integration.test.ts`
- `test/package-structure.test.ts`

---

### Task 1: Make the Knowledge Document Boundary Strict and Semantic

**Files:**
- Modify: `extensions/llm-wiki/lib/knowledge-document.ts:150-633`
- Modify: `test/knowledge-document.test.ts`

- [x] **Step 1: Add adversarial parser and semantic round-trip tests**

Append these cases to `test/knowledge-document.test.ts`:

```ts
it.each([
  ["frontmatter_parse_error", "---\ntype: concept\nx: [1,\n---\n"],
  ["frontmatter_duplicate_key", "---\ntype: concept\nx:\n  a: 1\n  a: 2\n---\n"],
  ["frontmatter_missing", "---oops\ntype: concept\n---\n"],
  ["concept_missing_type", "---\ntype: 42\n---\n"],
  ["concept_missing_type", "---\ntype: []\n---\n"],
])("rejects adversarial input with %s", (code, input) => {
  const result = parseKnowledgeDocument(input, "concepts/adversarial.md");
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
});

it("preserves null and prototype-named unknown fields semantically", () => {
  const input = [
    "---",
    "type: concept",
    "nullable: null",
    "__proto__:",
    "  enabled: true",
    "constructor:",
    "  nested: value",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
  const first = parsed(input);
  expect(first.extensions.nullable).toBeNull();
  expect(Object.hasOwn(first.extensions, "__proto__")).toBe(true);
  expect(first.extensions.__proto__).toEqual({ enabled: true });
  const second = parsed(serializeKnowledgeDocument(first));
  expect(second.extensions).toEqual(first.extensions);
});

it("preserves explicit null sources as an unknown shape", () => {
  const doc = parsed("---\ntype: concept\nsources: null\n---\n");
  expect(doc.sources).toEqual({ kind: "unknown-shape", value: null });
  expect(parsed(serializeKnowledgeDocument(doc)).sources).toEqual(doc.sources);
});

it("rejects sources passed through creation fields instead of the canonical argument", () => {
  expect(() =>
    createKnowledgeDocument(
      "concepts/bad.md",
      { type: "concept", sources: [] } as never,
      "Body.",
    ),
  ).toThrow("Pass canonical sources as the fourth argument");
});
```

- [x] **Step 2: Run the focused test and verify the reviewed failures**

Run:

```bash
pnpm vitest run test/knowledge-document.test.ts
```

Expected: FAIL because malformed YAML and nested duplicates parse successfully, numeric `type` is accepted, null is stringified, `__proto__` is lost, and creation-time `sources` is silently ignored.

- [x] **Step 3: Enforce exact fences and YAML document errors before conversion**

In `knowledge-document.ts`, replace the opening-fence check and parser options/error handling with:

```ts
if (!normalized.startsWith("---\n")) {
  return {
    ok: false,
    diagnostics: [
      diag("error", "frontmatter_missing", path, "Missing frontmatter opening delimiter"),
    ],
  };
}

let docs: Document[];
try {
  docs = parseAllDocuments(yamlText, {
    schema: "core",
    merge: false,
    uniqueKeys: true,
  });
} catch (error: unknown) {
  const parsed = error as {
    code?: string;
    message: string;
    linePos?: Array<{ line: number; col: number }>;
  };
  const position = parsed.linePos?.[0];
  return {
    ok: false,
    diagnostics: [
      diag(
        "error",
        parsed.code === "DUPLICATE_KEY"
          ? "frontmatter_duplicate_key"
          : "frontmatter_parse_error",
        path,
        `YAML parse error: ${parsed.message}`,
        position?.line,
        position?.col,
      ),
    ],
  };
}

if (docs.length !== 1) {
  return {
    ok: false,
    diagnostics: [
      diag(
        "error",
        "frontmatter_multiple_documents",
        path,
        "Multiple YAML documents in frontmatter",
      ),
    ],
  };
}

const yamlError = docs.flatMap((document) => document.errors)[0] as
  | {
      code?: string;
      message: string;
      linePos?: Array<{ line: number; col: number }>;
    }
  | undefined;
if (yamlError) {
  const position = yamlError.linePos?.[0];
  return {
    ok: false,
    diagnostics: [
      diag(
        "error",
        yamlError.code === "DUPLICATE_KEY"
          ? "frontmatter_duplicate_key"
          : "frontmatter_parse_error",
        path,
        `YAML parse error: ${yamlError.message}`,
        position?.line,
        position?.col,
      ),
    ],
  };
}
```

Delete the manual root-only `seenKeys` loop. Keep alias, custom-tag, byte-limit, depth-limit, and multiple-document checks; existing tests prove those restrictions and must remain green.

- [x] **Step 4: Preserve all JSON-compatible YAML scalar and mapping values**

Replace `classifySources` and `toKnowledgeValue` with:

```ts
function classifySources(raw: KnowledgeValue | undefined): KnowledgeSources {
  if (raw === undefined) return { kind: "absent" };
  if (typeof raw === "string") return { kind: "legacy-scalar", value: raw };
  if (Array.isArray(raw)) {
    if (raw.every((value) => typeof value === "string")) {
      return { kind: "legacy-list", value: raw };
    }
    if (raw.every((value) => value !== null && typeof value === "object" && !Array.isArray(value))) {
      return { kind: "canonical", value: raw as Array<Record<string, KnowledgeValue>> };
    }
  }
  return { kind: "unknown-shape", value: raw };
}

function toKnowledgeValue(node: unknown): KnowledgeValue {
  if (node === null) return null;
  if (isScalar(node)) {
    const value = node.value;
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      return value;
    }
    return String(value);
  }
  if (isSeq(node)) return node.items.map(toKnowledgeValue);
  if (isMap(node)) {
    return Object.fromEntries(
      node.items.map((item) => [
        String(isScalar(item.key) ? item.key.value : item.key),
        toKnowledgeValue(item.value),
      ]),
    ) as Record<string, KnowledgeValue>;
  }
  return null;
}
```

Require `type` to be a trimmed non-empty string:

```ts
const rawType = mapping.type;
if (typeof rawType !== "string" || !rawType.trim()) {
  return {
    ok: false,
    diagnostics: [diag("error", "concept_missing_type", path, "Missing or empty string type field")],
  };
}
const frontmatter: KnowledgeFrontmatter = { type: rawType };
```

- [x] **Step 5: Prevent creation-time provenance bypasses**

Add and use this creation type and runtime guard:

```ts
export type KnowledgeCreationFields = {
  type: string;
  sources?: never;
} & Record<string, KnowledgeValue | undefined>;

export function createKnowledgeDocument(
  path: string,
  fields: KnowledgeCreationFields,
  body: string,
  sources?: Array<Record<string, KnowledgeValue>>,
): KnowledgeDocument {
  if (Object.hasOwn(fields, "sources")) {
    throw new Error("Pass canonical sources as the fourth argument");
  }
  // Keep the existing field split, body normalization, and return value.
}
```

The implementation body must retain the current canonical source union and standard/extension split; only the signature and guard change.

- [x] **Step 6: Run parser, type, and producer tests**

Run:

```bash
pnpm vitest run test/knowledge-document.test.ts test/source-capture.test.ts test/ingest-worker.test.ts test/observation.test.ts test/retro.test.ts
pnpm typecheck
```

Expected: all pass. No YAML-library exception reaches a caller, and all producer call sites satisfy `KnowledgeCreationFields`.

- [x] **Step 7: Commit the strict document boundary**

```bash
git add extensions/llm-wiki/lib/knowledge-document.ts test/knowledge-document.test.ts
git commit -m "fix: enforce strict OKF document parsing"
```

---

### Task 2: Make Discovery and Link Resolution Deterministic and Contained

**Files:**
- Modify: `extensions/llm-wiki/lib/vault-format.ts:165-289`
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts:109-227`
- Modify: `test/vault-format.test.ts`
- Modify: `test/knowledge-links.test.ts`

- [x] **Step 1: Add physical-collision, symlink, scan-error, and URI tests**

Add to `test/vault-format.test.ts`:

```ts
it("blocks physically distinct NFC-equivalent paths", () => {
  const paths = vault({ knowledge_format: "okf-0.2" });
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  writeFileSync(join(paths.wiki, "concepts", "café.md"), "---\ntype: concept\n---\n");
  writeFileSync(join(paths.wiki, "concepts", "café.md"), "---\ntype: concept\n---\n");
  const result = discoverKnowledgeDocuments(paths);
  expect(result.blocking).toBe(true);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "concept_identity_collision",
  );
});

it("does not follow directory symlinks outside the wiki", () => {
  const paths = vault({ knowledge_format: "legacy" });
  const external = join(paths.root, "external");
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, "outside.md"), "---\ntype: concept\n---\n");
  symlinkSync(external, join(paths.wiki, "linked"), "dir");
  expect(discoverKnowledgeDocuments(paths).documents).toEqual([]);
});

it("blocks publication when a knowledge directory cannot be scanned", () => {
  const paths = vault({ knowledge_format: "legacy" });
  const unreadable = join(paths.wiki, "concepts");
  mkdirSync(unreadable, { recursive: true });
  chmodSync(unreadable, 0o000);
  try {
    const result = discoverKnowledgeDocuments(paths);
    if (process.getuid?.() !== 0) {
      expect(result.blocking).toBe(true);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "frontmatter_parse_error",
      );
    }
  } finally {
    chmodSync(unreadable, 0o700);
  }
});
```

Add `chmodSync` and `symlinkSync` to the test's `node:fs` imports.

Add to `test/knowledge-links.test.ts`:

```ts
it("turns malformed percent encoding into a diagnostic instead of throwing", () => {
  expect(() =>
    buildResolvedBacklinks("concepts/source", "[bad](bad%ZZ.md)", known),
  ).not.toThrow();
  const result = buildResolvedBacklinks(
    "concepts/source",
    "[bad](bad%ZZ.md)",
    known,
  );
  expect(result.targets).toEqual([]);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "link_unresolved",
  ]);
});

it("requires md suffix for root-relative Markdown links", () => {
  const result = buildResolvedBacklinks(
    "concepts/source",
    "[missing suffix](/shared/root)",
    known,
  );
  expect(result.targets).toEqual([]);
});
```

- [x] **Step 2: Run focused tests and verify failure**

```bash
pnpm vitest run test/vault-format.test.ts test/knowledge-links.test.ts
```

Expected: NFC-equivalent paths are not reported as collisions, symlinked content is scanned, and malformed URI encoding throws `URIError`.

- [x] **Step 3: Return scan diagnostics instead of swallowing directory errors**

Replace `collectMarkdownFiles` with a result-bearing recursive scanner:

```ts
interface MarkdownScan {
  files: string[];
  diagnostics: KnowledgeDiagnostic[];
}

function collectMarkdownFiles(dir: string, wikiRoot: string): MarkdownScan {
  const files: string[] = [];
  const diagnostics: KnowledgeDiagnostic[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort(compareCodePoint);
  } catch (error: unknown) {
    diagnostics.push(
      diag(
        "error",
        "frontmatter_parse_error",
        relative(wikiRoot, dir).replace(/\\/g, "/") || ".",
        `Failed to scan knowledge directory: ${(error as Error).message}`,
      ),
    );
    return { files, diagnostics };
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const child = collectMarkdownFiles(fullPath, wikiRoot);
        files.push(...child.files);
        diagnostics.push(...child.diagnostics);
      } else if (stat.isFile() && entry.toLowerCase().endsWith(".md") && !isReservedName(entry)) {
        files.push(fullPath);
      }
    } catch (error: unknown) {
      diagnostics.push(
        diag(
          "error",
          "frontmatter_parse_error",
          relative(wikiRoot, fullPath).replace(/\\/g, "/"),
          `Failed to inspect knowledge path: ${(error as Error).message}`,
        ),
      );
    }
  }
  return { files, diagnostics };
}
```

Change imports from `statSync`/`normalize` to `join`, `lstatSync`, and `relative`. In `discoverKnowledgeDocuments`, initialize from the scan and make scan errors blocking:

```ts
const scan = collectMarkdownFiles(paths.wiki, paths.wiki);
diagnostics.push(...scan.diagnostics);
if (scan.diagnostics.length > 0) blocking = true;

for (const file of scan.files) {
  const physicalPath = relative(paths.wiki, file).replace(/\\/g, "/");
  const normalizedPath = physicalPath.normalize("NFC");
  const id = normalizedPath.replace(/\.md$/, "");
  const collisionKey = id.toLowerCase();
  const existing = seenIds.get(collisionKey);
  if (existing && existing.physicalPath !== physicalPath) {
    diagnostics.push(
      diag(
        "error",
        "concept_identity_collision",
        physicalPath,
        `Identity collision between ${existing.physicalPath} and ${physicalPath}`,
      ),
    );
    blocking = true;
    continue;
  }
  seenIds.set(collisionKey, { id, physicalPath });
  // Keep the existing reserved-name, parsing, and document construction logic.
}
```

Declare `seenIds` as:

```ts
const seenIds = new Map<string, { id: string; physicalPath: string }>();
```

- [x] **Step 4: Make malformed URI segments non-throwing and require `.md` consistently**

Extend `resolveMarkdownTarget`'s return union with `{ kind: "invalid" }`, then replace decoding and root-relative suffix handling:

```ts
let decoded: string[];
try {
  decoded = clean.split("/").map((segment) => decodeURIComponent(segment));
} catch {
  return { kind: "invalid" };
}

// After resolving root-relative stack:
const resolved = stack.join("/");
if (!resolved.endsWith(".md")) return { kind: "empty" };
return { kind: "concept", id: resolved.slice(0, -3) };
```

Handle the new result in `buildResolvedBacklinks`:

```ts
if (resolved.kind === "invalid") {
  diagnostics.push(
    diag(
      "warning",
      "link_unresolved",
      `${sourceId}.md`,
      `Malformed percent-encoded link: ${link.target}`,
    ),
  );
  continue;
}
```

- [x] **Step 5: Run discovery, link, projection, and type checks**

```bash
pnpm vitest run test/vault-format.test.ts test/knowledge-links.test.ts test/okf-projections.test.ts
pnpm typecheck
```

Expected: all pass. Symlinks are excluded, physical NFC/case collisions block, unreadable scans cannot publish partial metadata, and malformed links produce diagnostics without throwing.

- [x] **Step 6: Commit discovery and link containment**

```bash
git add extensions/llm-wiki/lib/vault-format.ts extensions/llm-wiki/lib/knowledge-links.ts test/vault-format.test.ts test/knowledge-links.test.ts
git commit -m "fix: contain OKF discovery and link resolution"
```

---

### Task 3: Centralize Strict Vault Inspection and Bootstrap

**Files:**
- Create: `extensions/llm-wiki/lib/bootstrap.ts`
- Create: `test/bootstrap.test.ts`
- Modify: `extensions/llm-wiki/lib/vault-format.ts:52-217`
- Modify: `extensions/llm-wiki/lib/tools.ts:96-244`
- Modify: `extensions/llm-wiki/index.ts:1-180`
- Modify: `extensions/llm-wiki/lib/guardrails.ts:185-258`
- Modify: `test/vault-format.test.ts`
- Modify: `test/guardrails.test.ts`

- [x] **Step 1: Add strict config/root inspection tests**

Add to `test/vault-format.test.ts`:

```ts
it.each([
  ["missing", undefined],
  ["malformed", "{not-json"],
  ["array", "[]"],
])("fails closed for %s config", (_label, configText) => {
  const paths = vault({ knowledge_format: "legacy" });
  const configPath = join(paths.dotWiki, "config.json");
  if (configText === undefined) rmSync(configPath);
  else writeFileSync(configPath, configText);
  const state = inspectVaultFormat(paths);
  expect(state.blocking).toBe(true);
  expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "config_invalid_knowledge_format",
  );
  expect(inspectWritableVault(paths).ok).toBe(false);
});

it.each([
  ["frontmatter-less", "# user index\n"],
  ["malformed", "---\nokf_version: [\n---\n"],
  ["versionless", "---\ntitle: Root\n---\n"],
])("blocks an existing %s OKF root index", (_label, content) => {
  const paths = vault({ knowledge_format: "okf-0.2" });
  writeFileSync(join(paths.wiki, "index.md"), content);
  const state = inspectVaultFormat(paths);
  expect(state.blocking).toBe(true);
  expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "okf_version_mismatch",
  );
});

it("turns an unreadable OKF root into a blocking diagnostic", () => {
  const paths = vault({ knowledge_format: "okf-0.2" });
  mkdirSync(join(paths.wiki, "index.md"));
  expect(() => inspectVaultFormat(paths)).not.toThrow();
  const state = inspectVaultFormat(paths);
  expect(state.blocking).toBe(true);
  expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "okf_version_mismatch",
  );
});
```

- [x] **Step 2: Add bootstrap service and actual extension-seam tests**

Create `test/bootstrap.test.ts` with a minimal extension harness:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../extensions/llm-wiki/index.js";
import { bootstrapVault } from "../extensions/llm-wiki/lib/bootstrap.js";
import {
  getVaultPaths,
  resolveVaultPaths,
} from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const originalWikiHome = process.env.WIKI_HOME;
afterEach(() => {
  process.chdir(originalCwd);
  // biome-ignore lint/performance/noDelete: restore an originally absent variable
  if (originalWikiHome === undefined) delete process.env.WIKI_HOME;
  else process.env.WIKI_HOME = originalWikiHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = join(import.meta.dirname, "..", "tmp", `bootstrap-${Date.now()}-${Math.random()}`);
  roots.push(value);
  return value;
}

function extensionHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return { handlers, tools };
}

it("silent session bootstrap persists OKF mode and creates current projections", async () => {
  const cwd = root();
  mkdirSync(cwd, { recursive: true });
  process.chdir(cwd);
  process.env.WIKI_HOME = cwd;
  expect(resolveVaultPaths(cwd).root).toBe(cwd);
  const { handlers } = extensionHarness();
  const sessionStart = handlers.get("session_start")?.at(-1);
  expect(sessionStart).toBeDefined();
  await sessionStart?.({}, {
    hasUI: true,
    ui: { setStatus: () => {} },
    model: { id: "test" },
  });
  const paths = getVaultPaths(cwd);
  expect(resolveVaultPaths(cwd).root).toBe(cwd);
  const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
  expect(config.knowledge_format).toBe("okf-0.2");
  expect(readFileSync(join(paths.wiki, "index.md"), "utf8")).toContain('okf_version: "0.2"');
  expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toContain("bootstrap");
});

it("blocks an existing invalid vault during real session startup", async () => {
  const cwd = root();
  const paths = getVaultPaths(cwd);
  mkdirSync(paths.dotWiki, { recursive: true });
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({ knowledge_format: "future" }),
  );
  process.chdir(cwd);
  process.env.WIKI_HOME = cwd;
  expect(resolveVaultPaths(cwd).root).toBe(cwd);
  const { handlers } = extensionHarness();
  const statuses: string[] = [];
  const sessionStart = handlers.get("session_start")?.at(-1);
  await sessionStart?.({}, {
    hasUI: true,
    ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
    model: { id: "test" },
  });
  expect(statuses.some((status) => status.includes("setup blocked"))).toBe(true);
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
});

it("explicit bootstrap preserves an old vault's missing mode field", () => {
  const cwd = root();
  const paths = getVaultPaths(cwd);
  mkdirSync(paths.dotWiki, { recursive: true });
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Old" }));
  const result = bootstrapVault(paths, { topic: "Updated", mode: "personal" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.projection.ok).toBe(true);
  const config = JSON.parse(readFileSync(join(paths.dotWiki, "config.json"), "utf8"));
  expect(Object.hasOwn(config, "knowledge_format")).toBe(false);
  expect(existsSync(join(paths.wiki, "index.md"))).toBe(false);
  expect(existsSync(join(paths.wiki, "log.md"))).toBe(false);
});

it("does not mutate an existing malformed vault during bootstrap", () => {
  const cwd = root();
  const paths = getVaultPaths(cwd);
  mkdirSync(paths.dotWiki, { recursive: true });
  const configPath = join(paths.dotWiki, "config.json");
  writeFileSync(configPath, "{broken");
  const before = readFileSync(configPath, "utf8");
  const result = bootstrapVault(paths, { topic: "Do not write", mode: "personal" });
  expect(result.ok).toBe(false);
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(existsSync(join(paths.dotWiki, "WIKI_SCHEMA.md"))).toBe(false);
  expect(existsSync(paths.meta)).toBe(false);
});
```

- [x] **Step 3: Run mode/bootstrap tests and verify failure**

```bash
pnpm vitest run test/vault-format.test.ts test/bootstrap.test.ts
```

Expected: strict config/root cases fail, silent bootstrap leaves legacy config, and `bootstrap.ts` does not exist.

- [x] **Step 4: Make config and root-index inspection fail closed**

Export a strict config reader from `vault-format.ts`:

```ts
export type VaultConfigRead =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; diagnostic: KnowledgeDiagnostic };

export function readVaultConfig(paths: VaultPaths): VaultConfigRead {
  const path = join(paths.dotWiki, "config.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json must contain an object");
    }
    return { ok: true, config: parsed as Record<string, unknown> };
  } catch (error: unknown) {
    return {
      ok: false,
      diagnostic: diag(
        "error",
        "config_invalid_knowledge_format",
        "config.json",
        `Cannot read valid wiki config: ${(error as Error).message}`,
      ),
    };
  }
}
```

`inspectVaultFormat` must return `{ knowledgeFormat: "legacy", blocking: true }` with that diagnostic when `readVaultConfig` fails. A successfully parsed config lacking `knowledge_format` remains valid legacy behavior.

In OKF mode, distinguish a missing root from every other failure without an `existsSync`/read race:

```ts
const rootIndexPath = join(paths.wiki, "index.md");
let rootContent: string | undefined;
try {
  rootContent = readFileSync(rootIndexPath, "utf8");
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    diagnostics.push(
      diag(
        "error",
        "okf_version_mismatch",
        "wiki/index.md",
        `Cannot read OKF root index: ${(error as Error).message}`,
      ),
    );
    blocking = true;
  }
}
if (rootContent !== undefined) {
  const frontmatter = parseMarkdownFrontmatter(rootContent, "index.md");
  if (!frontmatter.ok || frontmatter.mapping.okf_version !== "0.2") {
    diagnostics.push(
      diag(
        "error",
        "okf_version_mismatch",
        "wiki/index.md",
        frontmatter.ok
          ? 'OKF root index must declare okf_version "0.2"'
          : `Malformed OKF root index: ${frontmatter.diagnostics[0].message}`,
      ),
    );
    blocking = true;
  }
}
```

Keep legacy root files user-owned: only a successfully parsed explicit unsupported `okf_version` blocks; malformed or versionless legacy root files remain untouched.

- [x] **Step 5: Create one bootstrap service**

Create `extensions/llm-wiki/lib/bootstrap.ts`:

```ts
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import { appendEvent, type ProjectionResult, rebuildMetadata } from "./metadata.js";
import {
  type VaultPaths,
  ensureVaultStructure,
  fmtDate,
  writeJson,
} from "./utils.js";
import { inspectWritableVault, readVaultConfig } from "./vault-format.js";

export const WIKI_SCHEMA = [
  "# LLM Wiki Schema",
  "",
  "## Ownership Rules",
  "",
  "| Path | Owner | Rule |",
  "|------|-------|------|",
  "| raw/** | extension | immutable after capture |",
  "| wiki/** | model + user | editable knowledge pages |",
  "| meta/* | extension | auto-generated |",
  "| . | human + explicit request | operating rules |",
  "",
  "## Source Packet Format",
  "",
  "```",
  "raw/sources/SRC-YYYY-MM-DD-NNN/",
  "  manifest.json",
  "  original/",
  "  extracted.md",
  "  attachments/",
  "```",
  "",
  "## Page Types",
  "",
  "- **source** — what this specific source says",
  "- **entity** — people, orgs, tools, products",
  "- **concept** — ideas, patterns, frameworks",
  "- **synthesis** — cross-source theses and tensions",
  "- **analysis** — durable filed answers from queries",
  "- **requirement** — atomic requirements with status, priority, and traceability",
  "",
  "## Linking Style",
  "",
  "- New internal links: [label](/folder/page.md)",
  "- Legacy readable links: [[folder/page]]",
  "- Source citation: [source](/sources/SRC-YYYY-MM-DD-NNN.md)",
  "",
].join("\n");

export interface BootstrapInput {
  topic: string;
  mode: string;
}

export type BootstrapResult =
  | { ok: true; created: boolean; projection: ProjectionResult }
  | { ok: false; created: false; diagnostics: KnowledgeDiagnostic[] };

export function bootstrapVault(paths: VaultPaths, input: BootstrapInput): BootstrapResult {
  const configPath = join(paths.dotWiki, "config.json");
  const created = !existsSync(configPath);
  let existing: Record<string, unknown> = {};

  if (!created) {
    const writable = inspectWritableVault(paths);
    if (!writable.ok) return { ok: false, created: false, diagnostics: writable.diagnostics };
    const config = readVaultConfig(paths);
    if (!config.ok) return { ok: false, created: false, diagnostics: [config.diagnostic] };
    existing = config.config;
  }

  const config: Record<string, unknown> = {
    ...existing,
    name: input.topic,
    mode: input.mode,
    topic: input.topic,
    created: existing.created ?? fmtDate(),
    version: existing.version ?? "1.0",
    ...(created ? { knowledge_format: "okf-0.2" } : {}),
  };

  ensureVaultStructure(paths);
  writeJson(configPath, config);
  writeFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), WIKI_SCHEMA, "utf8");
  appendEvent(paths, { kind: "bootstrap", topic: input.topic, mode: input.mode });
  return { ok: true, created, projection: rebuildMetadata(paths) };
}
```

- [x] **Step 6: Route silent and explicit Pi bootstrap through the service**

In `tools.ts`, replace manual bootstrap config/schema/event/rebuild code with:

```ts
const result = bootstrapVault(paths, { topic: params.topic, mode });
if (!result.ok) {
  return {
    content: [{ type: "text", text: `Wiki vault error: ${result.diagnostics[0].message}` }],
    details: { error: result.diagnostics[0].code, diagnostics: result.diagnostics },
    isError: true,
  };
}
const projection = result.projection;
```

Keep existing interface-specific success rendering. Remove now-unused `ensureVaultStructure`, schema construction, and direct config/event writes from this handler.

In `index.ts`, replace silent bootstrap writes with:

```ts
const result = bootstrapVault(paths, { topic: "pending", mode: "personal" });
if (!result.ok || !result.projection.ok) {
  ctx.ui.setStatus(
    "llm-wiki",
    `🧠 Wiki setup blocked: ${
      result.ok ? result.projection.diagnostics[0].message : result.diagnostics[0].message
    }`,
  );
  return;
}
needsTopicInference = true;
ctx.ui.setStatus("llm-wiki", "🧠 Wiki created (inferring topic from first prompt…)");
return;
```

After the no-config branch in `session_start`, validate the existing vault before status, notices, or recall setup:

```ts
const writable = inspectWritableVault(paths);
if (!writable.ok) {
  ctx.ui.setStatus(
    "llm-wiki",
    `🧠 Wiki setup blocked: ${writable.diagnostics[0].message}`,
  );
  return;
}
```

Import `bootstrapVault` and `inspectWritableVault`; delete unused bootstrap filesystem/config imports.

- [x] **Step 7: Make generated-path guardrails contained and invalid-state aware**

Replace `isGeneratedOkfPath` with a containment-safe implementation:

```ts
export function isGeneratedOkfPath(path: string, paths: VaultPaths): boolean {
  const state = inspectVaultFormat(paths);
  if (state.blocking || state.knowledgeFormat !== "okf-0.2") return false;
  const rel = relative(paths.wiki, resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  const name = parts.at(-1)?.toLowerCase();
  return name === "index.md" || (parts.length === 1 && name === "log.md");
}
```

In `guardrails.ts`, centralize per-path decisions in a pure helper and call it from both write and edit handlers:

```ts
export function mutationBlockReason(path: string, paths: VaultPaths): string | undefined {
  const protectedPath = isProtectedPath(path, paths);
  if (protectedPath.protected) return protectedPath.reason;

  const relativeToVault = relative(resolve(paths.dotWiki), resolve(path));
  const insideVault =
    relativeToVault === "" ||
    (!isAbsolute(relativeToVault) &&
      relativeToVault !== ".." &&
      !relativeToVault.startsWith(`..${sep}`));
  if (insideVault) {
    const state = inspectVaultFormat(paths);
    if (state.blocking) {
      return `Wiki vault configuration is invalid: ${state.diagnostics[0].message}`;
    }
  }

  if (isGeneratedOkfPath(path, paths)) {
    return "Generated OKF indexes and log are read-only. Use wiki_rebuild_meta or the page-producing tool that owns the source mutation.";
  }
  return undefined;
}
```

For a write target or every recovered edit target, return `{ block: true, reason }` when `mutationBlockReason` returns a string. Import `VaultPaths`, `inspectVaultFormat`, `isAbsolute`, and `relative`. This leaves outside files alone and preserves existing raw/meta reasons.

- [x] **Step 8: Add guardrail regressions**

Extend `test/guardrails.test.ts` using the pure helper, while existing handler tests continue proving integration:

```ts
import { rmSync, writeFileSync } from "node:fs";
import { mutationBlockReason } from "../extensions/llm-wiki/lib/guardrails.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

it("blocks contained wiki writes when config is malformed", () => {
  const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), "{broken");
  try {
    expect(mutationBlockReason(join(paths.wiki, "concepts", "x.md"), paths)).toContain(
      "configuration is invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("allows an outside index file and blocks only contained OKF indexes", () => {
  const root = join(import.meta.dirname, "..", "tmp", `guardrail-${Date.now()}`);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({ knowledge_format: "okf-0.2" }),
  );
  try {
    expect(mutationBlockReason(join(root, "outside", "index.md"), paths)).toBeUndefined();
    expect(mutationBlockReason(join(paths.wiki, "nested", "INDEX.md"), paths)).toContain(
      "Generated OKF",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Merge these imports into the existing import blocks.

- [x] **Step 9: Run bootstrap, mode, guardrail, projection, and type checks**

```bash
pnpm vitest run test/bootstrap.test.ts test/vault-format.test.ts test/guardrails.test.ts test/okf-projections.test.ts
pnpm typecheck
```

Expected: all pass. New silent vaults are immediately valid OKF bundles; old mode-less configs remain legacy; malformed existing state causes no bootstrap or guardrail write.

- [x] **Step 10: Commit strict bootstrap and mode enforcement**

```bash
git add extensions/llm-wiki/lib/bootstrap.ts extensions/llm-wiki/lib/vault-format.ts extensions/llm-wiki/lib/tools.ts extensions/llm-wiki/lib/guardrails.ts extensions/llm-wiki/index.ts test/bootstrap.test.ts test/vault-format.test.ts test/guardrails.test.ts
git commit -m "fix: bootstrap and validate OKF vaults fail closed"
```

---

### Task 4: Guard Every Authoritative Writer and Preserve Existing Documents

**Files:**
- Create: `test/mutation-guards.test.ts`
- Modify: `extensions/llm-wiki/lib/vault-format.ts`
- Modify: `extensions/llm-wiki/lib/source-packet.ts`
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts`
- Modify: `extensions/llm-wiki/lib/observation.ts`
- Modify: `extensions/llm-wiki/lib/retro.ts`
- Modify: `extensions/llm-wiki/lib/trajectory.ts`
- Modify: `extensions/llm-wiki/lib/metadata.ts`
- Modify: `extensions/llm-wiki/lib/embeddings.ts`
- Modify: `extensions/llm-wiki/lib/tools.ts`
- Modify: `mcp/operations.ts`
- Modify: `test/ingest-worker.test.ts`
- Modify: `test/retro.test.ts`
- Modify: `test/trajectory.test.ts`
- Modify: `test/background-tools.test.ts`
- Modify: `test/source-capture.test.ts`
- Modify: `test/e2e-binary-detection.test.ts`
- Modify: `test/e2e-docx.test.ts`
- Modify: `test/e2e-html-normalization.test.ts`
- Modify: `test/embeddings.test.ts`

- [x] **Step 1: Add a fail-closed mutation matrix**

Create `test/mutation-guards.test.ts`:

```ts
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  embedPages,
  launchEmbedPages,
  reindexEmbeddings,
  writeEmbeddingStore,
} from "../extensions/llm-wiki/lib/embeddings.js";
import { commitSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { appendEvent } from "../extensions/llm-wiki/lib/metadata.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import {
  registerWikiObserve,
  saveObservation,
} from "../extensions/llm-wiki/lib/observation.js";
import { registerWikiRetro, saveInsight } from "../extensions/llm-wiki/lib/retro.js";
import { captureText } from "../extensions/llm-wiki/lib/source-packet.js";
import {
  captureTrajectory,
  registerWikiCaptureTrajectory,
} from "../extensions/llm-wiki/lib/trajectory.js";
import {
  registerWikiCaptureSource,
  registerWikiEnsurePage,
  registerWikiIngest,
  registerWikiLint,
  registerWikiLogEvent,
  registerWikiRebuildMeta,
  registerWikiReindexEmbeddings,
} from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { VaultWriteError } from "../extensions/llm-wiki/lib/vault-format.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invalidVault(config = "{broken") {
  const root = join(import.meta.dirname, "..", "tmp", `mutation-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), config);
  return paths;
}

function tree(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true }).map(String).sort();
}

it("blocks every shared authoritative writer before changing the vault", async () => {
  const operations: Array<[string, (paths: ReturnType<typeof invalidVault>) => unknown]> = [
    ["capture", (paths) => captureText(paths, "body", "title")],
    ["observe", (paths) => saveObservation(paths, { title: "x", content: "y", relevance: "low" })],
    ["retro", (paths) => saveInsight(paths, "safe-slug", "title", "body")],
    ["trajectory", (paths) => captureTrajectory(paths, { steps: [{ role: "user", text: "x" }] })],
    ["event", (paths) => appendEvent(paths, { kind: "manual" })],
  ];

  for (const [name, operation] of operations) {
    const paths = invalidVault();
    const before = tree(paths.dotWiki);
    expect(() => operation(paths), name).toThrow(VaultWriteError);
    expect(tree(paths.dotWiki), name).toEqual(before);
  }

  const ingestPaths = invalidVault();
  const ingestBefore = tree(ingestPaths.dotWiki);
  const ingest = commitSynthesis(
    ingestPaths,
    "SRC-1",
    { id: "SRC-1", title: "Source" },
    { summary: "s", key_takeaways: [], entities: [], concepts: [] },
  );
  expect(ingest.ok).toBe(false);
  expect(tree(ingestPaths.dotWiki)).toEqual(ingestBefore);

  const paths = invalidVault();
  const before = tree(paths.dotWiki);
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
  const embedder = { model: "test", embed };
  await expect(embedPages(paths, ["concepts/x"], embedder)).rejects.toBeInstanceOf(
    VaultWriteError,
  );
  await expect(reindexEmbeddings(paths, embedder)).rejects.toBeInstanceOf(VaultWriteError);
  expect(() =>
    writeEmbeddingStore(paths, { version: "1.0", entries: {} }),
  ).toThrow(VaultWriteError);
  expect(embed).not.toHaveBeenCalled();
  expect(tree(paths.dotWiki)).toEqual(before);
});

it("rechecks vault mode after embedding and immediately before sidecar write", async () => {
  const paths = invalidVault(JSON.stringify({ knowledge_format: "legacy" }));
  writeFileSync(
    join(paths.wiki, "concepts", "x.md"),
    "---\ntype: concept\ntitle: X\n---\n\nBody\n",
  );
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = embedPages(paths, ["concepts/x"], {
    model: "test",
    embed: async (texts) => {
      markStarted();
      await gate;
      return texts.map(() => [1, 0, 0]);
    },
  });
  await started;
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "future" }));
  release();
  await expect(pending).rejects.toBeInstanceOf(VaultWriteError);
  expect(existsSync(join(paths.meta, "embeddings.json"))).toBe(false);
});

it.each(["invalid-mode", "unsupported-root-version"])(
  "rechecks the embedding guard inside a launched background task: %s",
  async (state) => {
    const paths = invalidVault(
      JSON.stringify({ knowledge_format: state === "invalid-mode" ? "future" : "okf-0.2" }),
    );
    if (state === "unsupported-root-version") {
      writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');
    }
    const runtime = new Runtime();
    runtime.ensureConfig = () => {};
    runtime.config = { embeddingProvider: "openai", embeddingApiKey: "test" };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network should not run"));
    expect(launchEmbedPages(runtime, { hasUI: false }, paths, ["concepts/x"], "test")).toBe(
      true,
    );
    await runtime.awaitAll();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(paths.meta, "embeddings.json"))).toBe(false);
    fetchSpy.mockRestore();
  },
);

it("blocks every mutating Pi tool adapter before dispatch or write", async () => {
  const cases: Array<[
    string,
    (pi: ExtensionAPI) => void,
    Record<string, unknown>,
  ]> = [
    ["capture", (pi) => registerWikiCaptureSource(pi), { text: "body", title: "title" }],
    ["ingest", (pi) => registerWikiIngest(pi), { background: false }],
    ["ensure", (pi) => registerWikiEnsurePage(pi), { type: "concept", title: "Title" }],
    ["lint", (pi) => registerWikiLint(pi), { auto_fix: false }],
    ["rebuild", (pi) => registerWikiRebuildMeta(pi), {}],
    ["embeddings", (pi) => registerWikiReindexEmbeddings(pi), { force: false }],
    ["event", (pi) => registerWikiLogEvent(pi), { kind: "manual" }],
    ["observe", (pi) => registerWikiObserve(pi), { title: "x", content: "y", relevance: "low" }],
    ["retro", (pi) => registerWikiRetro(pi), { slug: "safe", title: "x", body: "y" }],
    [
      "trajectory",
      (pi) => registerWikiCaptureTrajectory(pi),
      { steps: [{ role: "user", text: "x" }] },
    ],
  ];

  for (const [name, register, params] of cases) {
    const paths = invalidVault();
    let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
    register({
      registerTool: (definition: unknown) => {
        tool = definition as { execute: (...args: any[]) => Promise<any> };
      },
    } as unknown as ExtensionAPI);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const before = tree(paths.dotWiki);
    const result = await tool.execute(
      "test",
      params,
      undefined,
      undefined,
      { cwd: paths.root, hasUI: false, ui: { notify: () => {} } },
    );
    expect(result.isError, name).toBe(true);
    expect(tree(paths.dotWiki), name).toEqual(before);
  }
});
```

For existing direct-writer fixtures in `test/source-capture.test.ts`, `test/e2e-binary-detection.test.ts`, `test/e2e-docx.test.ts`, `test/e2e-html-normalization.test.ts`, `test/embeddings.test.ts`, and `test/ingest-worker.test.ts`, add this immediately after `ensureVaultStructure(paths)`:

```ts
writeFileSync(
  join(paths.dotWiki, "config.json"),
  JSON.stringify({ name: "Test legacy vault" }),
);
```

A config file with a missing `knowledge_format` intentionally exercises valid legacy fallback; a missing or malformed config is reserved for fail-closed tests.

- [x] **Step 2: Add legacy-preserving ingestion tests**

Append to `test/ingest-worker.test.ts`:

```ts
it.each([
  ["scalar", "sources: sources/SRC-legacy"],
  ["list", "sources: [sources/SRC-a, sources/SRC-b]"],
])("patches an existing %s-source page without migration or field loss", (_label, sources) => {
  const paths = getVaultPaths(wikiDir);
  const page = join(paths.wiki, "sources", "SRC-001.md");
  mkdirSync(join(paths.wiki, "sources"), { recursive: true });
  writeFileSync(
    page,
    [
      "---",
      "type: source",
      "title: Original title",
      sources,
      "producer_data:",
      "  nested:",
      "    keep: true",
      "status: skeleton",
      "---",
      "",
      "Old body.",
      "",
    ].join("\n"),
  );

  const before = parseKnowledgeDocument(readFileSync(page, "utf8"), "sources/SRC-001.md");
  expect(before.ok).toBe(true);
  const result = commitSynthesis(paths, "SRC-001", MANIFEST, DATA, "2026-06-06");
  expect(result.ok).toBe(true);
  const after = parseKnowledgeDocument(readFileSync(page, "utf8"), "sources/SRC-001.md");
  expect(after.ok).toBe(true);
  if (!before.ok || !after.ok) return;
  expect(after.document.sources).toEqual(before.document.sources);
  expect(after.document.extensions.producer_data).toEqual(
    before.document.extensions.producer_data,
  );
  expect(after.document.frontmatter.title).toBe("Original title");
  expect(after.document.frontmatter.status).toBe("ingested");
  expect(after.document.frontmatter.updated).toBe("2026-06-06");
});
```

Import `parseKnowledgeDocument` in the test.

- [x] **Step 3: Add retro path-containment tests**

Append to `test/retro.test.ts`:

```ts
it.each(["../../../outside", "../../meta/pwn", "with/slash", ".", "Index", "LOG"])(
  "rejects unsafe slug %s without writing",
  (slug) => {
    const paths = getVaultPaths(wikiDir);
    expect(() => saveInsight(paths, slug, "Title", "Body")).toThrow("Invalid insight slug");
    expect(existsSync(join(paths.root, "outside.md"))).toBe(false);
    expect(existsSync(join(paths.meta, "pwn.md"))).toBe(false);
  },
);

it("maps unsafe retro slugs to structured Pi and MCP errors", async () => {
  const paths = getVaultPaths(wikiDir);
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  registerWikiRetro({
    registerTool: (definition: unknown) => {
      tool = definition as { execute: (...args: any[]) => Promise<any> };
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_retro was not registered");

  const piResult = await tool.execute(
    "test",
    { slug: "../../escape", title: "Title", body: "Body" },
    undefined,
    undefined,
    { cwd: paths.root, hasUI: false },
  );
  expect(piResult.isError).toBe(true);
  expect(piResult.details.error).toBe("invalid_insight_slug");

  const mcpResult = await retroOperation(paths, "../../escape", "Title", "Body");
  expect(mcpResult).toEqual({
    ok: false,
    diagnostics: [{ code: "invalid_insight_slug", message: "Invalid insight slug: ../../escape" }],
  });
  expect(existsSync(join(paths.root, "escape.md"))).toBe(false);
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
});
```

Import `ExtensionAPI`, `registerWikiRetro`, and `retroOperation` in `test/retro.test.ts`.

- [x] **Step 4: Run mutation tests and verify failure**

```bash
pnpm vitest run test/mutation-guards.test.ts test/ingest-worker.test.ts test/retro.test.ts test/trajectory.test.ts
```

Expected: shared writers proceed in malformed vaults, ingestion loses fields, unsafe retro slugs escape the source directory, and Pi/MCP retro adapters reject by throwing across their boundary rather than returning structured errors.

- [x] **Step 5: Add one shared write assertion**

In `vault-format.ts`, add:

```ts
export class VaultWriteError extends Error {
  constructor(readonly diagnostics: KnowledgeDiagnostic[]) {
    super(diagnostics[0]?.message ?? "Wiki vault is not writable");
    this.name = "VaultWriteError";
  }
}

export function assertWritableVault(paths: VaultPaths): KnowledgeFormat {
  const result = inspectWritableVault(paths);
  if (!result.ok) throw new VaultWriteError(result.diagnostics);
  return result.format;
}
```

Call `assertWritableVault(paths)` immediately before the first authoritative or metadata write inside:

- `captureSource` and `captureSourceSync` in `source-packet.ts`
- `commitSynthesis` in `ingest-worker.ts`, catching `VaultWriteError` and returning its diagnostics through the existing `CommitSynthesisOutcome` union
- `saveObservation` in `observation.ts`
- `saveInsight` in `retro.ts`
- `captureTrajectory` in `trajectory.ts`
- `appendEvent` in `metadata.ts`
- `embedPages` and `reindexEmbeddings` in `embeddings.ts`, before any network call
- `writeEmbeddingStore` in `embeddings.ts`, the unavoidable exported sidecar write boundary
- background lint work in `tools.ts`

Tool adapters still use `inspectWritableVault` to return stable tool errors. The service assertion is defense in depth and closes direct-call and asynchronous-check gaps.

- [x] **Step 6: Patch existing source documents instead of rebuilding them**

Replace the existing-source and source-write portion of `commitSynthesis` with:

```ts
try {
  assertWritableVault(paths);
} catch (error: unknown) {
  if (error instanceof VaultWriteError) {
    return { ok: false, sourceId, diagnostics: error.diagnostics };
  }
  throw error;
}
let sourceDocument: KnowledgeDocument | undefined;
if (existsSync(result.sourcePage)) {
  const parsed = parseKnowledgeDocument(
    readFileSync(result.sourcePage, "utf8"),
    `sources/${sourceId}.md`,
  );
  if (!parsed.ok) return { ok: false, sourceId, diagnostics: parsed.diagnostics };
  sourceDocument = patchKnowledgeDocument(parsed.document, {
    fields: { status: "ingested", updated: date },
    body: buildIngestedSourcePageBody(manifest, data, date),
  });
} else {
  sourceDocument = createKnowledgeDocument(
    `sources/${sourceId}.md`,
    {
      type: "source",
      title: String(manifest.title || sourceId),
      format: String(manifest.format || "unknown"),
      source_id: sourceId,
      raw_path: `raw/sources/${sourceId}/extracted.md`,
      captured: String(manifest.captured || date),
      status: "ingested",
      updated: date,
    },
    buildIngestedSourcePageBody(manifest, data, date),
  );
}
mkdirSync(join(paths.wiki, "sources"), { recursive: true });
writeKnowledgeDocumentFile(result.sourcePage, sourceDocument);
```

Import `KnowledgeDocument` and `assertWritableVault`. Do not patch title, format, source identifiers, `sources`, or extensions on an existing page.

- [x] **Step 7: Validate retro slugs and resolved containment inside the shared service**

In `retro.ts`, add:

```ts
function insightPath(paths: VaultPaths, slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug === "index" || slug === "log") {
    throw new Error(`Invalid insight slug: ${slug}`);
  }
  const directory = resolve(paths.wiki, "sources");
  const target = resolve(directory, `${slug}.md`);
  if (dirname(target) !== directory) throw new Error(`Invalid insight slug: ${slug}`);
  return target;
}
```

Use `insightPath` after `assertWritableVault(paths)`. Import `dirname` and `resolve`. Wrap the Pi call in `retro.ts`:

```ts
let result: RetroResult;
try {
  result = saveInsight(paths, params.slug, params.title, params.body, params.category, {
    rebuild: !runtime,
  });
} catch (error: unknown) {
  if ((error as Error).message.startsWith("Invalid insight slug:")) {
    return {
      content: [{ type: "text", text: (error as Error).message }],
      details: { error: "invalid_insight_slug" },
      isError: true,
    };
  }
  throw error;
}
```

In `mcp/operations.ts`, wrap `saveInsight` with the same predicate and return:

```ts
return {
  ok: false,
  diagnostics: [{ code: "invalid_insight_slug", message: (error as Error).message }],
};
```

Do not catch unrelated exceptions.

- [x] **Step 8: Replace weak tool preconditions**

In `tools.ts`, replace `requireVault` with `inspectWritableVault` for `wiki_capture_source` and `wiki_ingest`. In `trajectory.ts`, replace config-existence checks with `inspectWritableVault`. Keep read-only trajectory recall behavior available; apply write checks to capture/distillation mutations only.

Inside deferred/background work for lint and embedding reindex, call `assertWritableVault(paths)` again immediately before work. Keep assertions at the start of `embedPages`/`reindexEmbeddings` and inside `writeEmbeddingStore`, so `launchEmbedPages`, direct callers, pruning, and future callers cannot bypass mode/version validation. `wiki_rebuild_meta` relies on `rebuildMetadata`'s strict inspection and must report `ProjectionResult` diagnostics.

- [x] **Step 9: Run all authoritative mutation tests**

```bash
pnpm vitest run test/mutation-guards.test.ts test/source-capture.test.ts test/ingest-worker.test.ts test/observation.test.ts test/retro.test.ts test/trajectory.test.ts test/background-tools.test.ts test/ingest-tool.test.ts
pnpm typecheck
```

Expected: all pass. Every writer rejects malformed mode/version before writes; existing source metadata survives semantically; retro cannot escape its directory.

- [x] **Step 10: Commit guarded, preserving writers**

```bash
git add extensions/llm-wiki/lib/vault-format.ts extensions/llm-wiki/lib/source-packet.ts extensions/llm-wiki/lib/ingest-worker.ts extensions/llm-wiki/lib/observation.ts extensions/llm-wiki/lib/retro.ts extensions/llm-wiki/lib/trajectory.ts extensions/llm-wiki/lib/metadata.ts extensions/llm-wiki/lib/embeddings.ts extensions/llm-wiki/lib/tools.ts mcp/operations.ts test/mutation-guards.test.ts test/ingest-worker.test.ts test/retro.test.ts test/trajectory.test.ts test/background-tools.test.ts test/ingest-tool.test.ts test/source-capture.test.ts test/e2e-binary-detection.test.ts test/e2e-docx.test.ts test/e2e-html-normalization.test.ts test/embeddings.test.ts
git commit -m "fix: guard and preserve OKF authoritative writes"
```

---

### Task 5: Fail Closed Across Background Ingestion and Indexing

**Files:**
- Create: `test/indexing-fail-closed.test.ts`
- Create: `test/ingest-concurrency.test.ts`
- Modify: `extensions/llm-wiki/lib/indexing.ts:55-78`
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts:340-410`
- Modify: `test/indexing.test.ts`
- Modify: `test/ingest-tool.test.ts`

- [x] **Step 1: Add an embedding-after-failed-rebuild regression**

Create `test/indexing-fail-closed.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reindexEmbeddings: vi.fn(async () => ({ embedded: 0, skipped: 0, pruned: 0 })),
  resolveEmbedder: vi.fn(() => ({
    model: "test",
    embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  })),
}));
vi.mock("../extensions/llm-wiki/lib/embeddings.js", () => mocks);

import {
  __resetIndexingState,
  scheduleReindex,
} from "../extensions/llm-wiki/lib/indexing.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];
afterEach(() => {
  __resetIndexingState();
  mocks.reindexEmbeddings.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("does not refresh embeddings after a blocking projection failure", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `index-fail-${Date.now()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
  writeFileSync(join(paths.wiki, "concepts", "bad.md"), "not frontmatter\n");
  const runtime = new Runtime();
  runtime.ensureConfig = () => {};
  runtime.config = { embeddingProvider: "openai" };
  await scheduleReindex(runtime, { hasUI: false }, paths);
  await runtime.awaitAll();
  expect(mocks.reindexEmbeddings).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Add background-ingestion configuration race regression evidence**

Create `test/ingest-concurrency.test.ts` with a module-level delayed subagent:

```ts
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return { gate, release: () => releaseGate() };
});

vi.mock("../extensions/llm-wiki/lib/subagent.js", () => ({
  runSubAgent: vi.fn(async (args: { tools: Array<{ execute: (...args: any[]) => Promise<unknown> }> }) => {
    await control.gate;
    await args.tools[0].execute("commit", {
      summary: "Summary",
      key_takeaways: [],
      entities: [],
      concepts: [],
    });
  }),
}));

import { runIngestSynthesis } from "../extensions/llm-wiki/lib/ingest-worker.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `ingest-race-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("rechecks vault mode after synthesis and before background commit", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  const pending = runIngestSynthesis({
    model: { provider: "test", id: "model" } as never,
    apiKey: "key",
    paths,
    sourceId: "SRC-001",
    manifest: { id: "SRC-001", title: "Some Paper" },
    extracted: "content",
  });

  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "invalid" }));
  control.release();
  const result = await pending;
  expect(result).toBeUndefined();
  expect(existsSync(join(paths.wiki, "sources", "SRC-001.md"))).toBe(false);
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
});
```

- [x] **Step 3: Run the new tests and isolate the remaining failure**

```bash
pnpm vitest run test/indexing-fail-closed.test.ts test/ingest-concurrency.test.ts test/ingest-tool.test.ts
```

Expected: `test/indexing-fail-closed.test.ts` fails because the embedding mock is called despite a blocked rebuild. `test/ingest-concurrency.test.ts` passes as regression evidence because Task 4 already placed the immediate `commitSynthesis` assertion at the authoritative write seam. Do not weaken or remove that passing race test.

- [x] **Step 4: Gate indexing on `ProjectionResult.ok`**

Change the drain loop in `indexing.ts`:

```ts
while (dirty.has(root)) {
  dirty.delete(root);
  const projection = rebuildMetadataLight(paths);
  if (!projection.ok) continue;

  runtime.ensureConfig(root);
  const embedder = resolveEmbedder(runtime.config);
  if (embedder) await reindexEmbeddings(paths, embedder);
}
```

`commitSynthesis` already catches `VaultWriteError` from its immediate Task 4 assertion and returns a failed `CommitSynthesisOutcome`; the subagent tool therefore leaves `committed` unset after a configuration race.

- [x] **Step 5: Run indexing, ingestion, and background tests**

```bash
pnpm vitest run test/indexing-fail-closed.test.ts test/ingest-concurrency.test.ts test/indexing.test.ts test/ingest-tool.test.ts test/background-tools.test.ts
pnpm typecheck
```

Expected: all pass. A blocked projection never starts embeddings, and config changes during synthesis prevent every commit write.

- [x] **Step 6: Commit background fail-closed behavior**

```bash
git add extensions/llm-wiki/lib/indexing.ts extensions/llm-wiki/lib/ingest-worker.ts test/indexing-fail-closed.test.ts test/ingest-concurrency.test.ts test/indexing.test.ts test/ingest-tool.test.ts
git commit -m "fix: stop background writes after OKF validation failure"
```

---

### Task 6: Unify Lint, Recall, and Event Projections on Shared Services

**Files:**
- Modify: `extensions/llm-wiki/lib/tools.ts:840-1010,1230-1267`
- Modify: `extensions/llm-wiki/lib/recall.ts:299-307,383-552,936-1045`
- Modify: `extensions/llm-wiki/lib/metadata.ts:90-120,340-360,560-650`
- Modify: `extensions/llm-wiki/lib/knowledge-links.ts`
- Modify: `extensions/llm-wiki/lib/utils.ts:274-369`
- Create: `test/lint-okf.test.ts`
- Modify: `test/recall.test.ts`
- Modify: `test/okf-projections.test.ts`
- Modify: `test/package-structure.test.ts`

- [x] **Step 1: Add malformed-page recall and diagnostic tests**

In `test/recall.test.ts`, make the main `beforeEach` vault explicit legacy immediately after `ensureVaultStructure(getVaultPaths(wikiDir))`:

```ts
writeFileSync(
  join(getVaultPaths(wikiDir).dotWiki, "config.json"),
  JSON.stringify({ name: "Recall test" }),
);
```

Add `registerWikiRecall` and `rebuildMetadata` imports, then append:

```ts
it("skips a now-malformed page retained in the known-good registry", () => {
  const id = createRegistryPage("good", "concept", "Good", "needle body");
  const paths = getVaultPaths(wikiDir);
  expect(rebuildMetadata(paths).ok).toBe(true);
  writeFileSync(join(paths.wiki, `${id}.md`), "broken\n");
  expect(searchWiki(paths, "needle", 5)).toEqual([]);
});

it("surfaces version diagnostics in Pi recall including no-match responses", async () => {
  const paths = getVaultPaths(wikiDir);
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({ knowledge_format: "okf-0.2" }),
  );
  expect(rebuildMetadata(paths).ok).toBe(true);
  writeFileSync(join(paths.wiki, "index.md"), '---\nokf_version: "0.3"\n---\n');

  let captured:
    | { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }>; details: any }> }
    | undefined;
  const pi = {
    registerTool: (tool: typeof captured) => {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  registerWikiRecall(pi);
  if (!captured) throw new Error("wiki_recall was not registered");
  const response = await captured.execute(
    "id",
    { query: "absent" },
    undefined,
    undefined,
    { cwd: paths.root, hasUI: false },
  );
  expect(
    response.details.diagnostics.map((diagnostic: { code: string }) => diagnostic.code),
  ).toContain("okf_version_mismatch");
  expect(response.content[0].text).toContain("okf_version_mismatch");
});
```

Import `ExtensionAPI` from `@mariozechner/pi-coding-agent`. Keep the existing separate no-vault case unchanged; it uses its own directory without `config.json` and calls the read-only `searchWiki` API.

- [x] **Step 2: Add event integrity, chronology, and diagnostic propagation tests**

Append to `test/okf-projections.test.ts`:

```ts
it("sorts valid offset timestamps by instant and returns malformed-event diagnostics", () => {
  const result = buildOkfLog(
    [
      '{"timestamp":"2026-08-02T13:30:00Z","kind":"earlier"}',
      '{"timestamp":"2026-08-02T09:00:00-05:00","kind":"later"}',
      "not-json",
    ].join("\n"),
  );
  expect(result.markdown.indexOf("later")).toBeLessThan(result.markdown.indexOf("earlier"));
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("event_invalid_json");
});

it.each([
  ["legacy", false],
  ["okf-0.2", true],
] as const)(
  "includes non-blocking event diagnostics in %s projection results",
  (knowledgeFormat, publishesOkfLog) => {
    const paths = createVault({ knowledge_format: knowledgeFormat });
    writeFileSync(join(paths.meta, "events.jsonl"), "not-json\n");
    const result = rebuildMetadata(paths);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "event_invalid_json",
    );
    expect(existsSync(join(paths.wiki, "log.md"))).toBe(publishesOkfLog);
  },
);

it("does not allow event details to override trusted timestamp or kind", () => {
  const paths = createVault({ knowledge_format: "legacy" });
  appendEvent(paths, { kind: "trusted", timestamp: "forged", extra: 1 } as never);
  const event = JSON.parse(readFileSync(join(paths.meta, "events.jsonl"), "utf8"));
  expect(event.kind).toBe("trusted");
  expect(event.timestamp).not.toBe("forged");
  expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
});

it("rejects empty or reserved manual-event input at the Pi tool boundary", async () => {
  const paths = createVault({ knowledge_format: "legacy" });
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  registerWikiLogEvent({
    registerTool: (definition: unknown) => {
      tool = definition as { execute: (...args: any[]) => Promise<any> };
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_log_event was not registered");
  for (const params of [
    { kind: "   " },
    { kind: "safe", details: { timestamp: "forged" } },
    { kind: "safe", details: { kind: "forged" } },
  ]) {
    const result = await tool.execute(
      "test",
      params,
      undefined,
      undefined,
      { cwd: paths.root, hasUI: false },
    );
    expect(result.isError).toBe(true);
  }
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
});
```

Import `ExtensionAPI`, `registerWikiLogEvent`, and `appendEvent`.

Create `test/lint-okf.test.ts`:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { registerWikiLint } from "../extensions/llm-wiki/lib/tools.js";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

const root = join(import.meta.dirname, "..", "tmp", `lint-okf-${Date.now()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("reports and auto-fixes one target referenced by Markdown and a legacy wikilink", async () => {
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ name: "Lint test" }));
  writeFileSync(
    join(paths.wiki, "concepts", "markdown-source.md"),
    "---\ntype: concept\ntitle: Markdown source\n---\n\n[missing](/concepts/missing.md)\n",
  );
  writeFileSync(
    join(paths.wiki, "concepts", "wikilink-source.md"),
    "---\ntype: concept\ntitle: Wikilink source\n---\n\n[[concepts/missing]]\n",
  );

  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  registerWikiLint({
    registerTool: (definition: unknown) => {
      tool = definition as { execute: (...args: any[]) => Promise<any> };
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("wiki_lint was not registered");
  const result = await tool.execute(
    "test",
    { auto_fix: true },
    undefined,
    undefined,
    { cwd: root, hasUI: false },
  );

  expect(result.isError).not.toBe(true);
  expect(result.content[0].text).toContain("Missing: 2");
  expect(existsSync(join(paths.wiki, "concepts", "missing.md"))).toBe(true);
  const gaps = JSON.parse(readFileSync(join(paths.discoveries, "gaps.json"), "utf8"));
  expect(gaps.gaps).toEqual([
    {
      topic: "concepts/missing",
      mentionedBy: ["concepts/markdown-source", "concepts/wikilink-source"],
    },
  ]);
});
```

- [x] **Step 3: Run reader/projection/lint tests and verify failure**

```bash
pnpm vitest run test/recall.test.ts test/okf-projections.test.ts test/lint-okf.test.ts
```

Expected: stale malformed page remains a recall result, Pi recall omits diagnostics, offset timestamps are misordered, rebuild drops event diagnostics, a supplied timestamp overrides the trusted one, and old lint ignores the Markdown edge so it reports only one missing edge and does not create the stub.

- [x] **Step 4: Skip malformed current files while retaining raw fallback entries**

In `searchWiki`, change the registry loop prelude:

```ts
const pagePath = join(paths.wiki, `${id}.md`);
const pageExists = existsSync(pagePath);
const parsed = parsePage(pagePath, id);
if (pageExists && !parsed) continue;
const frontmatter = parsed?.frontmatter ?? {};
const body = parsed?.body ?? "";
```

This excludes corrupted concept pages but retains registry-only raw source/trajectory fallback entries whose page never existed.

In `registerWikiRecall`, compute:

```ts
const vaultDiagnostics = inspectVaultFormat(paths).diagnostics;
const diagnosticText = vaultDiagnostics.length
  ? `\n\nDiagnostics: ${vaultDiagnostics.map((diagnostic) => diagnostic.code).join(", ")}`
  : "";
```

Append `diagnosticText` to no-match, links-first, and preview text. Include `diagnostics: vaultDiagnostics` in every result's `details`.

- [x] **Step 5: Build lint from shared discovery and link resolution**

First extend the shared resolver result in `knowledge-links.ts` so callers never parse diagnostic prose:

```ts
export interface UnresolvedKnowledgeLink {
  target: string;
  syntax: "markdown" | "wikilink";
}

export interface ResolvedBacklinks {
  targets: string[];
  unresolved: UnresolvedKnowledgeLink[];
  diagnostics: KnowledgeDiagnostic[];
}
```

Initialize `const unresolved: UnresolvedKnowledgeLink[] = []`; whenever either Markdown or wikilink resolution emits `link_unresolved`, also push its normalized ID with the corresponding syntax. Return `{ targets: sorted, unresolved, diagnostics }`. Path escapes, malformed percent encodings, external links, and empty links must not enter `unresolved`.

Then replace `runWikiLint` with this shared-service implementation:

```ts
function runWikiLint(paths: VaultPaths, autoFix: boolean): string {
  assertWritableVault(paths);
  const projection = rebuildMetadata(paths);
  if (!projection.ok) {
    return [
      "# Wiki Lint Report",
      "",
      "Projection-blocking diagnostics:",
      ...projection.diagnostics.map(
        (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
      ),
    ].join("\n");
  }

  const discovery = discoverKnowledgeDocuments(paths);
  const pages = discovery.documents;
  const knownIds = new Set(pages.map((page) => page.id));
  const inbound = Object.fromEntries(pages.map((page) => [page.id, 0]));
  const gapSources = new Map<string, Set<string>>();
  const findings: string[] = [];
  let missingPages = 0;
  let contradictions = 0;

  for (const page of pages) {
    const resolved = buildResolvedBacklinks(page.id, page.body, knownIds);
    for (const target of resolved.targets) inbound[target]++;
    for (const unresolved of resolved.unresolved) {
      const sources = gapSources.get(unresolved.target) ?? new Set<string>();
      sources.add(page.id);
      gapSources.set(unresolved.target, sources);
      missingPages++;
      findings.push(`Missing page: ${unresolved.target} (in ${page.id})`);
    }
  }

  let orphans = 0;
  for (const page of pages) {
    if (inbound[page.id] === 0) {
      orphans++;
      findings.push(`Orphan: ${page.id} has no inbound links`);
    }
    if (page.body.includes("⚠️ **Contradiction")) {
      contradictions++;
      findings.push(`Contradiction flagged in ${page.id}`);
    }
  }

  const gaps = [...gapSources.entries()]
    .map(([topic, sources]) => ({ topic, mentionedBy: [...sources].sort(compareCodePoint) }))
    .sort((left, right) => compareCodePoint(left.topic, right.topic));
  let fixesApplied = 0;
  if (autoFix) {
    for (const gap of gaps) {
      if (gap.mentionedBy.length < 2) continue;
      const parts = gap.topic.split("/");
      const name = parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === "concepts" ? parts[1] : "";
      if (!name || slugify(name) !== name) continue;
      const pagePath = join(paths.wiki, "concepts", `${name}.md`);
      mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
      const document = createKnowledgeDocument(
        `concepts/${name}.md`,
        {
          type: "concept",
          title: name.replace(/-/g, " "),
          created: fmtDate(),
          updated: fmtDate(),
          status: "stub",
        },
        `_Stub auto-created by lint. Expand with content from: ${gap.mentionedBy
          .map((source) => `[${source}](/${source}.md)`)
          .join(", ")}_`,
      );
      try {
        writeFileSync(pagePath, serializeKnowledgeDocument(document), {
          encoding: "utf8",
          flag: "wx",
        });
        fixesApplied++;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });
  const reportLines = [
    "# Wiki Lint Report",
    `Generated: ${fmtDate()}`,
    "",
    "## Summary",
    `- Total pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing pages: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    autoFix ? `- Fixes applied: ${fixesApplied}` : "",
    "",
    "## Findings",
    findings.length ? findings.map((finding) => `- ${finding}`).join("\n") : "✅ No issues found!",
    "",
  ].filter(Boolean);
  const reportPath = join(paths.outputs, `lint-${fmtDate()}.md`);
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(reportPath, `${reportLines.join("\n")}\n`, "utf8");
  appendEvent(paths, {
    kind: "lint",
    orphans,
    missing_pages: missingPages,
    contradictions,
    auto_fix: autoFix,
  });
  rebuildMetadataLight(paths);

  return [
    "🧹 **LLM Wiki lint complete**",
    "",
    `- Pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    autoFix ? `- Auto-fixes: ${fixesApplied}` : "",
    "",
    `📄 Report: \`${reportPath}\``,
    gaps.length ? `💡 ${gaps.length} knowledge gap(s) tracked` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
```

Import `assertWritableVault`, `compareCodePoint`, `discoverKnowledgeDocuments`, and `buildResolvedBacklinks`. Generated indexes/logs remain excluded by discovery; malformed percent links remain diagnostics but are not auto-fixed. The lint regression must prove both syntaxes contribute to the same structured gap and auto-fix threshold.

- [x] **Step 6: Remove obsolete parser/scanner exports**

Delete these functions from `utils.ts`:

```text
parseFrontmatterValue
parseFrontmatter
findWikiPages
extractWikilinks
```

Remove their imports from `tools.ts` and any remaining callers. Add this source-structure assertion to `test/package-structure.test.ts`:

```ts
it("has no obsolete YAML or wikilink scanners", () => {
  const utils = readFile(join(rootDir, "extensions/llm-wiki/lib/utils.ts"));
  expect(utils).not.toContain("parseFrontmatter(");
  expect(utils).not.toContain("findWikiPages(");
  expect(utils).not.toContain("extractWikilinks(");
});
```

- [x] **Step 7: Protect event fields, sort by epoch, and propagate diagnostics**

Change `appendEvent`:

```ts
export function appendEvent(paths: VaultPaths, event: Omit<WikiEvent, "timestamp">): void {
  assertWritableVault(paths);
  const { timestamp: _ignored, kind: rawKind, ...details } = event as WikiEvent;
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!kind) throw new Error("Event kind must be a non-empty string");
  mkdirSync(paths.meta, { recursive: true });
  const line = JSON.stringify({ ...details, timestamp: new Date().toISOString(), kind });
  writeFileSync(join(paths.meta, "events.jsonl"), `${line}\n`, {
    flag: "a",
    encoding: "utf8",
  });
}
```

In `buildOkfLog`, add `epoch: number` to the internal event type, set `epoch: ts.getTime()` in `events.push`, and sort:

```ts
dayEvents.sort((left, right) => right.epoch - left.epoch || right.seq - left.seq);
```

In `rebuildMetadata`, always parse events once so malformed-line diagnostics survive in both modes, but publish the root OKF log only in OKF mode:

```ts
const eventLogResult = buildOkfLog(readText(join(paths.meta, "events.jsonl")));
allDiagnostics.push(...eventLogResult.diagnostics);
const okfLog =
  vaultState.knowledgeFormat === "okf-0.2" ? eventLogResult.markdown : null;
```

In `wiki_log_event`, reject empty `kind` and own `kind`/`timestamp` keys in `details` before calling `appendEvent`.

- [x] **Step 8: Run shared-reader and event tests**

```bash
pnpm vitest run test/recall.test.ts test/okf-projections.test.ts test/lint-okf.test.ts test/package-structure.test.ts test/wiki-structure.test.ts
pnpm typecheck
pnpm lint
```

Expected: all pass. Lint, recall, backlinks, projections, and event rendering use shared semantic data and stable diagnostics.

- [x] **Step 9: Commit shared reader and event fixes**

```bash
git add extensions/llm-wiki/lib/tools.ts extensions/llm-wiki/lib/recall.ts extensions/llm-wiki/lib/metadata.ts extensions/llm-wiki/lib/knowledge-links.ts extensions/llm-wiki/lib/utils.ts test/lint-okf.test.ts test/recall.test.ts test/okf-projections.test.ts test/package-structure.test.ts
git commit -m "fix: unify OKF readers lint and event diagnostics"
```

---

### Task 7: Make MCP Capture Real and Writes Immediately Discoverable

**Files:**
- Create: `mcp/exec.ts`
- Create: `test/mcp-exec.test.ts`
- Modify: `mcp/operations.ts`
- Modify: `mcp/index.ts:1-280`
- Modify: `test/mcp-parity.test.ts`

- [x] **Step 1: Add subprocess and real-capture tests**

Create `test/mcp-exec.test.ts`:

```ts
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureVaultStructure, getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";
import { captureSourceOperation } from "../mcp/operations.js";
import { createExecApi } from "../mcp/exec.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("returns stdout, stderr, exit code, timeout, and abort state", async () => {
  const api = createExecApi();
  const success = await api.exec(process.execPath, ["-e", "console.log('ok')"]);
  expect(success).toMatchObject({ stdout: "ok\n", code: 0, killed: false });
  const failure = await api.exec(process.execPath, ["-e", "process.stderr.write('bad');process.exit(7)"]);
  expect(failure).toMatchObject({ stderr: "bad", code: 7, killed: false });
  const timedOut = await api.exec(process.execPath, ["-e", "setTimeout(()=>{}, 1000)"], {
    timeout: 10,
  });
  expect(timedOut.killed).toBe(true);

  const controller = new AbortController();
  const aborted = api.exec(process.execPath, ["-e", "setTimeout(()=>{}, 1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await expect(aborted).resolves.toMatchObject({ killed: true });
});

it("captures local files with a preserved original and current registry", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `mcp-file-${Date.now()}`);
  roots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
  const input = join(root, "input.txt");
  writeFileSync(input, "MCP file body");
  const result = await captureSourceOperation(paths, { filePath: input }, createExecApi());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    existsSync(join(paths.rawSources, result.sourceId, "original", "input.txt")),
  ).toBe(true);
  const registry = JSON.parse(readFileSync(join(paths.meta, "registry.json"), "utf8"));
  expect(registry.pages[`sources/${result.sourceId}`]).toBeDefined();
});

it("captures a local HTTP page through the production MCP runner", async () => {
  const server = createServer((_request, response) => {
    response.end("<html><title>Local</title><body><h1>Captured</h1><p>HTTP body</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const root = join(import.meta.dirname, "..", "tmp", `mcp-url-${Date.now()}`);
    roots.push(root);
    const paths = getVaultPaths(root);
    ensureVaultStructure(paths);
    writeFileSync(join(paths.dotWiki, "config.json"), JSON.stringify({ knowledge_format: "legacy" }));
    const result = await captureSourceOperation(
      paths,
      { url: `http://127.0.0.1:${address.port}/source` },
      createExecApi(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(paths.rawSources, result.sourceId, "extracted.md"), "utf8")).toContain(
      "HTTP body",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
```

Remove unused `mkdirSync` from the final imports if Biome reports it.

- [x] **Step 2: Extend MCP parity tests to require post-write discoverability and failure propagation**

Add to `test/mcp-parity.test.ts`:

```ts
it("makes MCP retro immediately searchable", async () => {
  const result = await retroOperation(paths, "mcp-visible", "Visible Insight", "searchable needle");
  expect(result.ok).toBe(true);
  expect(searchRegistry(paths, "Visible Insight").matches.map((match) => match.id)).toContain(
    "sources/mcp-visible",
  );
});

it("makes MCP text capture immediately recallable", async () => {
  const result = await captureSourceOperation(
    paths,
    { text: "capture needle", title: "Visible Capture" },
    createExecApi(),
  );
  expect(result.ok).toBe(true);
  expect(searchRegistry(paths, "Visible Capture").matches).toHaveLength(1);
});

it("returns blocking projection diagnostics after a successful authoritative write", async () => {
  writeFileSync(join(paths.wiki, "concepts", "bad.md"), "malformed\n");
  const result = await retroOperation(paths, "written-but-blocked", "Written", "Body");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("frontmatter_missing");
});
```

Import `createExecApi`.

- [x] **Step 3: Run MCP tests and verify failure**

```bash
pnpm vitest run test/mcp-exec.test.ts test/mcp-parity.test.ts
```

Expected: `mcp/exec.ts` is missing, production operations do not rebuild, and current MCP capture uses a no-op executor.

- [x] **Step 4: Implement the narrow Node command runner**

Create `mcp/exec.ts`:

```ts
import { execFile } from "node:child_process";
import type { ExecApi } from "../extensions/llm-wiki/lib/utils.js";

export function createExecApi(): ExecApi {
  return {
    exec(command, args, options = {}) {
      return new Promise((resolve) => {
        let killed = false;
        const child = execFile(
          command,
          args,
          {
            cwd: options.cwd,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            cleanup();
            resolve({
              stdout: String(stdout),
              stderr: String(stderr),
              code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
              killed,
            });
          },
        );

        const stop = () => {
          killed = true;
          child.kill("SIGTERM");
        };
        const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined;
        const abort = () => stop();
        options.signal?.addEventListener("abort", abort, { once: true });

        function cleanup() {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
        }

        if (options.signal?.aborted) stop();
      });
    },
  };
}
```

The runner never invokes a shell, so command arguments remain separate. It returns Pi-compatible result objects for nonzero exits, timeout, abort, and spawn errors.

- [x] **Step 5: Rebuild after successful MCP writes**

In `mcp/operations.ts`, after `saveInsight` and every capture variant, call `rebuildMetadata(paths)`. Return blocking diagnostics if projection publication fails:

```ts
function projectionOutcome(
  projection: ProjectionResult,
): { ok: true } | { ok: false; diagnostics: Array<{ code: string; message: string }> } {
  return projection.ok
    ? { ok: true }
    : {
        ok: false,
        diagnostics: projection.diagnostics.map(({ code, message }) => ({ code, message })),
      };
}
```

For retro, call `saveInsight(..., { rebuild: false })`, then `projectionOutcome(rebuildMetadata(paths))`. For capture, retain the `CaptureResult`, rebuild, and return its `sourceId` only after checking the projection. Catch `VaultWriteError` and invalid-slug errors and render them as operation diagnostics.

- [x] **Step 6: Use the real runner in MCP transport**

In `mcp/index.ts`, import and create the adapter once:

```ts
import { createExecApi } from "./exec.js";
const execApi = createExecApi();
```

Replace the hard-coded successful no-op object with `execApi`. Keep exactly the existing five registered MCP names and no read/import/export/migration operation.

- [x] **Step 7: Run MCP, type, and lint checks**

```bash
pnpm vitest run test/mcp-exec.test.ts test/mcp-parity.test.ts test/source-capture.test.ts
pnpm typecheck
pnpm lint
```

Expected: all pass. File and local-URL capture perform real subprocess work; successful MCP writes are immediately visible through shared registry/recall services.

- [x] **Step 8: Commit MCP production parity**

```bash
git add mcp/exec.ts mcp/operations.ts mcp/index.ts test/mcp-exec.test.ts test/mcp-parity.test.ts
git commit -m "fix: make MCP writes real and discoverable"
```

---

### Task 8: Replace Helper-Level Acceptance with Real Foundation Gates

**Files:**
- Modify: `test/okf-integration.test.ts`
- Modify: `test/okf-projections.test.ts`
- Modify: `test/package-structure.test.ts`
- Modify: `vitest.config.ts`

- [x] **Step 1: Replace the weak Foundation acceptance test with a real seam flow**

Import the real extension, `ExtensionAPI`, and `relative`, then add these complete helpers above the integration `describe`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../extensions/llm-wiki/index.js";

type RegisteredTool = {
  execute: (...args: any[]) => Promise<any>;
};
type ExtensionHandler = (...args: any[]) => unknown;

function registerFullExtensionHarness(root: string) {
  const handlers = new Map<string, ExtensionHandler[]>();
  const tools = new Map<string, RegisteredTool>();
  const messages: unknown[] = [];
  const pi = {
    on: (name: string, handler: ExtensionHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;

  const registerCwd = process.cwd();
  const registerHome = process.env.WIKI_HOME;
  process.chdir(root);
  process.env.WIKI_HOME = root;
  try {
    extension(pi);
  } finally {
    process.chdir(registerCwd);
    // biome-ignore lint/performance/noDelete: restore an actually absent environment variable
    if (registerHome === undefined) delete process.env.WIKI_HOME;
    else process.env.WIKI_HOME = registerHome;
  }

  async function atRoot<T>(work: () => Promise<T>): Promise<T> {
    const priorCwd = process.cwd();
    const priorHome = process.env.WIKI_HOME;
    process.chdir(root);
    process.env.WIKI_HOME = root;
    try {
      return await work();
    } finally {
      process.chdir(priorCwd);
      // biome-ignore lint/performance/noDelete: restore an actually absent environment variable
      if (priorHome === undefined) delete process.env.WIKI_HOME;
      else process.env.WIKI_HOME = priorHome;
    }
  }

  return {
    messages,
    emit: (name: string, event: unknown = {}, ctx: unknown = {}) =>
      atRoot(async () => {
        const results: unknown[] = [];
        for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
        return results;
      }),
    execute: (name: string, params: Record<string, unknown>) =>
      atRoot(async () => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Tool not registered: ${name}`);
        return tool.execute("test", params, undefined, undefined, {
          cwd: root,
          hasUI: false,
          ui: { setStatus: () => {}, notify: () => {} },
          model: { provider: "test", id: "model" },
          modelRegistry: {
            find: () => undefined,
            getApiKeyAndHeaders: async () => ({ ok: false }),
          },
        });
      }),
  };
}

function collectConceptFiles(wiki: string, directory = wiki): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectConceptFiles(wiki, fullPath));
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.toLowerCase();
    if (name === "index.md" || name === "log.md") continue;
    files.push(relative(wiki, fullPath).replace(/\\/g, "/"));
  }
  return files.sort();
}

function collectProjectionFiles(paths: ReturnType<typeof getVaultPaths>): string[] {
  const files = [
    "meta/registry.json",
    "meta/backlinks.json",
    "meta/index.md",
    "meta/log.md",
    "wiki/log.md",
  ];
  function indexes(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) indexes(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase() === "index.md") {
        files.push(relative(paths.dotWiki, fullPath).replace(/\\/g, "/"));
      }
    }
  }
  indexes(paths.wiki);
  return [...new Set(files)].sort();
}

function collectDeterministicProjectionFiles(
  paths: ReturnType<typeof getVaultPaths>,
): string[] {
  return collectProjectionFiles(paths).filter(
    (file) => file !== "meta/registry.json" && file !== "meta/index.md",
  );
}

function projectionSnapshot(
  paths: ReturnType<typeof getVaultPaths>,
  files: string[],
): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [file, readFileSync(join(paths.dotWiki, file), "utf8")]),
  );
}
```

Merge `relative` into the existing `node:path` import. Rewrite `foundation acceptance: end-to-end OKF lifecycle` to perform this exact flow:

```ts
it("foundation acceptance: production seams preserve a conformant OKF vault", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `okf-acceptance-${Date.now()}`);
  vaultRoots.push(root);
  mkdirSync(root, { recursive: true });
  const harness = registerFullExtensionHarness(root);

  await harness.emit("session_start", {}, {
    cwd: root,
    hasUI: true,
    ui: { setStatus: () => {}, notify: () => {} },
    model: { id: "test" },
  });
  const paths = getVaultPaths(root);
  const config = readJson<Record<string, unknown>>(join(paths.dotWiki, "config.json"), {});
  expect(config.knowledge_format).toBe("okf-0.2");
  const agentStartResults = await harness.emit(
    "before_agent_start",
    { prompt: "Build the Foundation feature", systemPrompt: "base" },
    { cwd: root, hasUI: false, model: { id: "test" } },
  );
  expect(JSON.stringify(agentStartResults)).toContain("Wiki Setup Required");

  await harness.execute("wiki_capture_source", {
    text: "Foundation source content.",
    title: "Foundation Source",
  });
  await harness.emit("session_shutdown");
  const sourceId = readdirSync(paths.rawSources).find((name) => name.startsWith("SRC-"));
  expect(sourceId).toBeDefined();
  if (!sourceId) return;
  const manifest = readJson<Record<string, unknown>>(
    join(paths.rawSources, sourceId, "manifest.json"),
    {},
  );
  const ingest = commitSynthesis(
    paths,
    sourceId,
    manifest,
    {
      summary: "Foundation summary.",
      key_takeaways: ["Foundation takeaway"],
      entities: [{ title: "Foundation Entity", description: "Entity description" }],
      concepts: [{ title: "Foundation Concept", definition: "Concept definition" }],
    },
    "2026-08-03",
  );
  expect(ingest.ok).toBe(true);

  await harness.execute("wiki_observe", {
    title: "Foundation observation",
    content: "Observation body.",
    relevance: "medium",
  });
  await harness.execute("wiki_retro", {
    slug: "foundation-insight",
    title: "Foundation Insight",
    body: "Insight body.",
  });
  await harness.execute("wiki_ensure_page", {
    type: "requirement",
    title: "Foundation Requirement",
    content: "Requirement body.",
  });
  await harness.emit("session_shutdown");

  const manualPage = join(paths.wiki, "concepts", "legacy-link.md");
  const eventPath = join(paths.meta, "events.jsonl");
  const eventsBeforeManual = readFileSync(eventPath, "utf8");
  writeFileSync(
    manualPage,
    "---\ntype: concept\ntitle: Legacy Link\n---\n\n[[sources/foundation-insight]]\n",
  );
  await harness.emit("tool_result", { toolName: "write", input: { path: manualPage } });
  await harness.emit("turn_end", {}, { cwd: root, hasUI: false });
  await harness.emit("session_shutdown");
  const registryAfterManual = readJson<{ pages: Record<string, unknown> }>(
    join(paths.meta, "registry.json"),
    { pages: {} },
  );
  expect(registryAfterManual.pages["concepts/legacy-link"]).toBeDefined();
  expect(readFileSync(eventPath, "utf8")).toBe(eventsBeforeManual);

  const conceptFiles = collectConceptFiles(paths.wiki);
  for (const file of conceptFiles) {
    const parsed = parseKnowledgeDocument(
      readFileSync(join(paths.wiki, file), "utf8"),
      file,
    );
    expect(parsed.ok, file).toBe(true);
  }

  for (const file of [
    "entities/foundation-entity.md",
    "concepts/foundation-concept.md",
  ]) {
    const parsed = parseKnowledgeDocument(readFileSync(join(paths.wiki, file), "utf8"), file);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.sources.kind).toBe("canonical");
  }
  const source = parseKnowledgeDocument(
    readFileSync(join(paths.wiki, "sources", `${sourceId}.md`), "utf8"),
    `sources/${sourceId}.md`,
  );
  expect(source.ok).toBe(true);
  if (source.ok) expect(source.document.sources.kind).toBe("absent");

  const backlinks = readJson<Record<string, string[]>>(join(paths.meta, "backlinks.json"), {});
  expect(backlinks["sources/foundation-insight"]).toContain("concepts/legacy-link");

  const projectionFiles = collectProjectionFiles(paths);
  const deterministicFiles = collectDeterministicProjectionFiles(paths);
  const deterministic = projectionSnapshot(paths, deterministicFiles);
  expect(rebuildMetadata(paths).ok).toBe(true);
  expect(projectionSnapshot(paths, deterministicFiles)).toEqual(deterministic);
  const knownGood = projectionSnapshot(paths, projectionFiles);

  const corrupt = join(paths.wiki, "concepts", "foundation-concept.md");
  const original = readFileSync(corrupt, "utf8");
  writeFileSync(corrupt, "malformed\n");
  await harness.emit("tool_result", { toolName: "edit", input: { path: corrupt } });
  await harness.emit("turn_end", {}, { cwd: root, hasUI: false });
  await harness.emit("session_shutdown");
  expect(projectionSnapshot(paths, projectionFiles)).toEqual(knownGood);
  expect(readFileSync(eventPath, "utf8")).toBe(eventsBeforeManual);

  writeFileSync(corrupt, original);
  await harness.emit("tool_result", { toolName: "write", input: { path: corrupt } });
  await harness.emit("turn_end", {}, { cwd: root, hasUI: false });
  await harness.emit("session_shutdown");
  expect(readJson<{ pages: Record<string, unknown> }>(join(paths.meta, "registry.json"), {
    pages: {},
  }).pages["concepts/foundation-concept"]).toBeDefined();
});

it("opens an existing valid vault without bootstrapping it again", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `okf-existing-${Date.now()}`);
  vaultRoots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  const config = JSON.stringify({ name: "Existing", knowledge_format: "legacy" });
  writeFileSync(join(paths.dotWiki, "config.json"), config);
  const statuses: string[] = [];
  const harness = registerFullExtensionHarness(root);
  await harness.emit("session_start", {}, {
    cwd: root,
    hasUI: true,
    ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
    model: { id: "test" },
  });
  expect(readFileSync(join(paths.dotWiki, "config.json"), "utf8")).toBe(config);
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
  expect(statuses.some((status) => status.includes("setup blocked"))).toBe(false);
  expect(harness.messages.length).toBeGreaterThan(0);
});

it("blocks an existing invalid vault before status notices or lifecycle writes", async () => {
  const root = join(import.meta.dirname, "..", "tmp", `okf-blocked-${Date.now()}`);
  vaultRoots.push(root);
  const paths = getVaultPaths(root);
  ensureVaultStructure(paths);
  const config = JSON.stringify({ knowledge_format: "future" });
  writeFileSync(join(paths.dotWiki, "config.json"), config);
  const statuses: string[] = [];
  const harness = registerFullExtensionHarness(root);
  await harness.emit("session_start", {}, {
    cwd: root,
    hasUI: true,
    ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
    model: { id: "test" },
  });
  expect(statuses.some((status) => status.includes("setup blocked"))).toBe(true);
  expect(harness.messages).toEqual([]);
  expect(readFileSync(join(paths.dotWiki, "config.json"), "utf8")).toBe(config);
  expect(existsSync(join(paths.meta, "events.jsonl"))).toBe(false);
});
```

Do not substitute direct calls for silent bootstrap, capture, observation, retro, or ensure-page. Deterministic ingestion remains a direct call to the shared `commitSynthesis` service because the production subagent itself is nondeterministic; Task 5 separately tests its delayed commit seam.

- [x] **Step 2: Correct the temporary-file assertion**

In `test/okf-projections.test.ts`, change:

```ts
if (entry.startsWith("tmp-")) results.push(fullPath);
```

To:

```ts
if (entry.includes(".tmp-")) results.push(fullPath);
```

- [x] **Step 3: Add mutation-bypass and scope source gates**

Add `readdirSync` to the existing `node:fs` import and define this helper above the package-structure `describe`:

```ts
function readProductionFiles(directory: string): string[] {
  const contents: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...readProductionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) contents.push(readFile(path));
  }
  return contents;
}
```

Then add:

```ts
it("routes every authoritative writer through strict vault validation", () => {
  const files = [
    "source-packet.ts",
    "ingest-worker.ts",
    "observation.ts",
    "retro.ts",
    "trajectory.ts",
    "metadata.ts",
    "embeddings.ts",
  ];
  for (const file of files) {
    const source = readFile(join(rootDir, "extensions/llm-wiki/lib", file));
    expect(source, file).toContain("assertWritableVault");
  }
});

it("keeps Foundation free of later-phase operation surfaces", () => {
  const roots = [
    join(rootDir, "extensions"),
    join(rootDir, "mcp"),
  ];
  const source = roots.flatMap(readProductionFiles).join("\n");
  for (const forbidden of [
    "wiki_okf_import",
    "wiki_okf_export",
    "wiki_okf_migrate",
    "transaction journal",
    "trust factor",
  ]) {
    expect(source).not.toContain(forbidden);
  }
});
```

- [x] **Step 4: Run acceptance tests and verify they expose any remaining seam gaps**

```bash
pnpm vitest run test/okf-integration.test.ts test/okf-projections.test.ts test/package-structure.test.ts
```

Expected: PASS after Tasks 1–7. If a test fails, stop and identify which earlier task's stated contract was not completed; add the missing regression and minimal fix to that task's commit before continuing. Do not weaken assertions or add later-phase behavior.

- [x] **Step 5: Verify the named entrypoint branches, then add enforceable coverage thresholds**

Before changing configuration, run:

```bash
pnpm vitest run --coverage test/bootstrap.test.ts test/okf-integration.test.ts test/background-tools.test.ts
```

The concrete tests now exercise new-vault startup, one-time `before_agent_start` topic inference, existing-valid startup and notice dispatch, blocked-existing startup, mutating Pi tools, `tool_result`/`turn_end` scheduling, and `session_shutdown` background drainage. Confirm the HTML/text report marks those `index.ts` branches executed; do not satisfy entrypoint coverage with helper-only tests.

Then update `vitest.config.ts` coverage configuration:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "lcov", "html"],
  include: ["extensions/**/*.ts", "skills/**/*.md"],
  thresholds: {
    statements: 70,
    branches: 80,
    functions: 85,
    lines: 70,
    "extensions/llm-wiki/index.ts": {
      statements: 55,
      branches: 50,
      functions: 50,
      lines: 55,
    },
    "extensions/llm-wiki/lib/knowledge-document.ts": {
      statements: 90,
      branches: 85,
      functions: 85,
      lines: 90,
    },
    "extensions/llm-wiki/lib/vault-format.ts": {
      statements: 85,
      branches: 80,
      functions: 90,
      lines: 85,
    },
  },
},
```

These thresholds exceed the reviewed baseline and are release requirements. The concrete startup/lifecycle tests above plus Tasks 1–7 must satisfy them. A failure is a blocked remediation—not permission to lower a threshold or add assertion-free coverage calls.

- [x] **Step 6: Run complete release gates**

Run in this order:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm test:coverage
```

Expected: every command exits 0; coverage reports satisfy global and trusted-boundary thresholds.

- [x] **Step 7: Run exact scope and bypass gates**

```bash
grep -RInE 'wiki_okf_import|wiki_okf_export|wiki_okf_migrate|transaction journal|trust factor' extensions mcp || true
grep -RInE 'parseFrontmatter\(|findWikiPages\(|extractWikilinks\(' extensions mcp || true
grep -RInE 'exec: async \(\) => \(\{ stdout: "", stderr: "", code: 0' mcp test || true
grep -RInE '^---\\n|\[\[' extensions/llm-wiki/lib/{source-packet,ingest-worker,observation,retro,tools}.ts || true
find .llm-wiki -type f -name '*.tmp-*' -print 2>/dev/null
```

Expected:

- no later-phase production surface
- no obsolete YAML/page/wikilink scanner
- no fake MCP executor
- no generated frontmatter template; remaining `[[` occurrences are compatibility/guidance text identified by tests
- no projection temporary files

- [x] **Step 8: Inspect final diff and operation-table evidence**

```bash
git status --short
git diff --check
git diff --stat fd3c46f9942b6c434383177086c8f3254333704b...HEAD
git log --oneline --decorate -10
```

Then run targeted operation evidence:

```bash
pnpm vitest run test/bootstrap.test.ts test/mutation-guards.test.ts test/indexing-fail-closed.test.ts test/mcp-exec.test.ts test/okf-integration.test.ts
```

Expected: clean diff checks, only Foundation remediation files changed, and all trusted-seam tests pass.

- [x] **Step 9: Commit final acceptance and release gates**

```bash
git add test/okf-integration.test.ts test/okf-projections.test.ts test/package-structure.test.ts vitest.config.ts
git commit -m "test: enforce OKF Foundation release gates"
```

---

## Final Acceptance Traceability

| Foundation criterion | Remediation evidence |
|---|---|
| Every page producer uses shared API | Tasks 1, 4, package-structure gate |
| Existing vaults remain legacy without reserved projections | Task 3 bootstrap tests |
| New vaults persist OKF 0.2 and generated files | Task 3 real `session_start` test; Task 8 acceptance |
| Nested/unknown metadata round-trips semantically | Task 1 adversarial round-trip tests |
| Markdown and wikilinks produce backlinks | Task 2 link tests; Task 8 exact backlink assertion |
| Projection bytes deterministic | Existing goldens plus Task 8 deterministic OKF index/log/backlink snapshot (volatile registry timestamps excluded) |
| Invalid mode/version/malformed concepts preserve known-good projections | Tasks 3–6 and Task 8 full blocked-rebuild snapshot through `tool_result`/`turn_end` |
| Pi and MCP share parsed identity/metadata behavior | Tasks 6–7 parity and diagnostic tests |
| Every mutation fails closed | Task 4 service/adapter/embedding-boundary matrix; Task 5 ingestion/indexing races; Task 8 manual-edit hooks |
| Tests, typecheck, lint, coverage gates pass | Task 8 release commands and thresholds |

## Completion Report Requirements

After execution, report exact command results, test count, coverage percentages, and commit SHAs. Explicitly list any deliberate deviation from this plan and tie it to the normative Foundation spec. Do not claim Foundation completion from helper tests alone; cite the bootstrap, mutation, concurrency, MCP, and acceptance seam tests.
