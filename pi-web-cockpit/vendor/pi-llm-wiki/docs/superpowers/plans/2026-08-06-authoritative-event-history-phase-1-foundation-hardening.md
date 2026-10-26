# Authoritative Event History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `meta/events.jsonl` an explicitly durable, locally authoritative event source, prevent metadata rebuilds from erasing logs when that source is unavailable, and keep host-local file paths out of the public OKF log projection.

**Architecture:** Preserve the existing one-way model: extension operations append authoritative local events, while `meta/log.md` and `wiki/log.md` remain projections. Replace the current missing-file-to-empty coercion with a shared event-source read result; unavailable source data produces a warning and suppresses only log publication, while an explicitly empty file remains a valid empty history. Keep OKF import/export and cross-bundle history continuity out of Foundation: this phase documents that `wiki/log.md` is a portable snapshot, not a recovery format, and leaves Interchange to define imported-history composition.

**Tech Stack:** TypeScript ES2022, Node.js filesystem APIs, Vitest, Markdown documentation, Biome

**Roadmap:** `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md`

**Phase:** Phase 1 follow-up: OKF Foundation event-history hardening

---

## Scope and decisions

This plan resolves issue #123 inside the already-shipped Foundation boundary.

1. `.llm-wiki/meta/events.jsonl` is durable extension-owned state and the authoritative source for recorded activity. It is not a rebuildable metadata projection.
2. Full-vault backup or Git synchronization must retain `events.jsonl` to continue activity history.
3. `.llm-wiki/wiki/log.md` remains a generated, portable OKF snapshot. It cannot reconstruct `events.jsonl` and does not by itself continue local history after import.
4. A missing or unreadable event source is different from a present, zero-byte event source. Rebuild warns and leaves existing logs byte-identical when the source is unavailable; a present empty stream intentionally generates empty logs.
5. Registry, backlinks, and indexes continue rebuilding when event history is unavailable. Event-source loss must not stop unrelated projections.
6. Local file capture keeps the exact input path in the extension-owned raw manifest, where it is already required for provenance, but no longer duplicates that host-specific path into the event stream or public `wiki/log.md`.
7. Event scope remains selected extension operations, not a complete file-revision audit. Manual page edits still trigger projection rebuilds without fabricated events.

### Explicitly out of scope

- `wiki_okf_import`, `wiki_okf_export`, `wiki_okf_migrate`, review staging, or transaction journals
- reconstructing JSONL events from Markdown prose
- merging imported `log.md` history with new local events
- moving `events.jsonl` to a new directory
- adding event hashes, signatures, sequence IDs, rotation, or retention policy
- logging manual file edits without actor and intent information
- changing malformed-line behavior; malformed individual lines remain non-blocking diagnostics and are omitted from projections
- hand-editing localized README translations without a reviewed localization workflow

Interchange must receive its own child spec and detailed phase plan before implementing portable history continuity.

## File responsibility map

### Created planning file

- `docs/superpowers/plans/2026-08-06-authoritative-event-history-phase-1-foundation-hardening.md` — executable plan, scope boundary, and acceptance checklist for issue #123.

### Modified production files

- `extensions/llm-wiki/lib/knowledge-document.ts` — add stable diagnostics for missing and unreadable authoritative event sources.
- `extensions/llm-wiki/lib/metadata.ts` — read the event source once, distinguish unavailable from explicitly empty, and suppress only log writes when unavailable.
- `extensions/llm-wiki/lib/tools.ts` — surface non-blocking rebuild diagnostics instead of reporting unconditional success.
- `extensions/llm-wiki/lib/source-packet.ts` — stop copying local `file_path` into capture events while retaining it in raw manifests.
- `extensions/llm-wiki/lib/utils.ts` — give `events.jsonl` a guardrail message describing append-only authoritative state instead of auto-generated metadata.
- `extensions/llm-wiki/lib/bootstrap.ts` — generate accurate in-vault ownership rules.

### Modified tests

- `test/okf-projections.test.ts` — cover missing, unreadable, and explicitly empty event-source semantics.
- `test/background-tools.test.ts` — prove `wiki_rebuild_meta` reports non-blocking event-source warnings to users.
- `test/source-capture.test.ts` — prove raw manifests retain local paths while event and OKF log projections do not.
- `test/e2e-guardrails.test.ts` — distinguish authoritative event-state protection from generated metadata protection.
- `test/bootstrap.test.ts` — verify new vault schemas classify event state correctly.

### Modified specifications and user documentation

- `docs/superpowers/specs/2026-08-02-okf-foundation-design.md` — make local authority, durability, missing-source behavior, event scope, and Foundation portability boundary normative.
- `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md` — record the Interchange requirement without implementing that phase.
- `README.md` — document backup/Git rules and distinguish authoritative state from projections.
- `docs/architecture.md` — update vault-layer ownership.
- `docs/api.md` — document event durability, arbitrary-detail privacy, and projection behavior.
- `skills/llm-wiki/SKILL.md` — stop teaching agents that every `meta/**` file is rebuildable.
- `CHANGELOG.md` — record event-history preservation and path-redaction behavior under `Unreleased`.

No new production file or dependency is needed.

---

### Task 1: Make the event-history contract normative

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-okf-foundation-design.md:40-47`
- Modify: `docs/superpowers/specs/2026-08-02-okf-foundation-design.md:349-401`
- Modify: `docs/superpowers/specs/2026-08-02-okf-foundation-design.md:477-490`
- Modify: `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md:91-117`
- Modify: `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md:248-337`

- [ ] **Step 1: Create the implementation branch and commit the plan**

Run:

```bash
git fetch origin
git switch -c fix/authoritative-event-history origin/main
git add docs/superpowers/plans/2026-08-06-authoritative-event-history-phase-1-foundation-hardening.md
git commit -m "docs: plan authoritative event history hardening"
```

Expected: branch starts from current `origin/main`, plan is its first commit, and `git status --short` is empty.

- [ ] **Step 2: Clarify the Foundation design principle**

Replace Foundation design principle 5 with:

```markdown
5. **Generated files are projections; authoritative extension state is not.** Registry, backlinks, indexes, and logs derive from authoritative pages and events. `meta/events.jsonl` is extension-written state, but it is not generated metadata because no rebuild can reconstruct it.
```

- [ ] **Step 3: Add the durable local-state contract to Deterministic Root Log**

Immediately after the opening paragraph under `## Deterministic Root Log`, add:

```markdown
`meta/events.jsonl` is durable extension-owned vault state. Users who need activity continuity must preserve it when backing up or synchronizing a complete pi-llm-wiki vault. It is not derivable from canonical pages, raw source packets, `meta/log.md`, or `wiki/log.md`.

Foundation does not make the JSONL event source part of the distributable OKF bundle. `wiki/log.md` is a portable snapshot of recorded activity at projection time, not a recovery format and not a promise that an imported bundle can continue the originating vault's event stream. Import, export, and imported-history composition belong to the later Interchange child specification.

The event stream records selected extension operations. It is not a complete revision history: manual file edits do not fabricate events, while extension-owned operational actions may emit events. Documentation and UI text must call it an activity history rather than a complete content audit trail.
```

- [ ] **Step 4: Specify event-detail portability and privacy**

After the paragraph ending `because the extension cannot infer actor or intent safely.`, add:

```markdown
Fields projected into `wiki/log.md` must be safe for a distributable bundle. A local file capture event records its stable `source_id` and format but not the caller-supplied `file_path`; the exact path remains in the extension-owned raw source manifest. Manual event details are user-controlled and documentation must warn callers not to include secrets or machine-local paths intended to remain private.
```

- [ ] **Step 5: Specify unavailable-source rebuild behavior**

Replace the event-diagnostic paragraph under `## Projection Rebuild Semantics` with:

```markdown
Unresolved links and malformed event lines are non-blocking projection diagnostics: valid concepts may still be indexed, and valid event lines may still be projected. A missing or unreadable `meta/events.jsonl` is different from a present empty stream. Rebuild reports `event_source_missing` or `event_source_unreadable`, continues publishing registry, backlink, and index projections, and leaves existing `meta/log.md` and `wiki/log.md` byte-identical. A present zero-byte event file is an explicitly empty authoritative stream and generates the normal empty log projections.
```

Add these codes to the diagnostics list:

```markdown
- `event_source_missing`
- `event_source_unreadable`
```

- [ ] **Step 6: Clarify the umbrella architecture and Interchange handoff**

Change the `meta/` tree comment to:

```text
├── meta/                       # durable local events + generated internal projections
```

After “`.llm-wiki/wiki/` is the distributable OKF bundle...”, add:

```markdown
`meta/events.jsonl` is durable local pi-llm-wiki state but is not part of the base OKF bundle. A full-vault backup preserves it; an OKF-only export does not. The exported `wiki/log.md` is therefore a readable history snapshot, not a lossless or resumable event source.
```

Replace the final sentence of the Generated Indexes and Logs section with:

```markdown
Foreign concept paths and document-level metadata are preserved; arbitrary foreign index prose is not merged into the live generated index. Before Interchange implementation, its normative child spec must define whether an imported `log.md` is archived, retained as a separate historical baseline, or replaced when a new local event stream begins. It must not imply that Markdown prose can reconstruct the originating JSONL stream.
```

After the Export Design paragraph that excludes `meta/**`, add:

```markdown
Because `meta/events.jsonl` is excluded, exported `log.md` is a deterministic snapshot rather than a resumable event ledger. Export must use only bundle-safe projected fields. Portable event continuity or a machine-readable event sidecar requires a separately reviewed Interchange decision and is not implied by Foundation.
```

- [ ] **Step 7: Review scope language**

Run:

```bash
grep -nE "events.jsonl|event_source_|portable snapshot|complete revision" \
  docs/superpowers/specs/2026-08-02-okf-foundation-design.md \
  docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md
```

Expected: output shows local authority and unavailable-source semantics in Foundation, plus explicit Interchange handoff; no text claims import/export is implemented.

- [ ] **Step 8: Commit the contract**

```bash
git add \
  docs/superpowers/specs/2026-08-02-okf-foundation-design.md \
  docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md
git commit -m "docs: define authoritative event history contract"
```

---

### Task 2: Preserve logs when the authoritative event source is unavailable

**Files:**
- Modify: `test/okf-projections.test.ts:1-45`
- Modify: `test/okf-projections.test.ts:180-230`
- Modify: `test/background-tools.test.ts:34-100`
- Modify: `extensions/llm-wiki/lib/knowledge-document.ts:5-27`
- Modify: `extensions/llm-wiki/lib/metadata.ts:66-145`
- Modify: `extensions/llm-wiki/lib/metadata.ts:306-377`
- Modify: `extensions/llm-wiki/lib/tools.ts:1080-1130`

- [ ] **Step 1: Make integration fixtures distinguish known-empty from missing**

In `createVault()` inside `test/okf-projections.test.ts`, add an explicit empty event source after writing `config.json`:

```ts
  writeFileSync(join(paths.dotWiki, "config.json"), `${JSON.stringify(config)}\n`);
  writeFileSync(join(paths.meta, "events.jsonl"), "");
  return paths;
```

This preserves existing fixture intent: ordinary projection tests start from a known-empty stream, not a missing authoritative source.

- [ ] **Step 2: Write the missing-source regression test**

Add under `describe("OKF rebuild integration", ...)`:

```ts
  it("preserves existing logs and warns when the authoritative event source is missing", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeFileSync(
      join(paths.meta, "events.jsonl"),
      '{"timestamp":"2026-08-06T10:00:00.000Z","kind":"before-loss"}\n',
    );
    expect(rebuildMetadata(paths).ok).toBe(true);

    const metaLog = readFileSync(join(paths.meta, "log.md"), "utf8");
    const wikiLog = readFileSync(join(paths.wiki, "log.md"), "utf8");
    rmSync(join(paths.meta, "events.jsonl"));

    const result = rebuildMetadata(paths);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "event_source_missing",
    );
    expect(readFileSync(join(paths.meta, "log.md"), "utf8")).toBe(metaLog);
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe(wikiLog);
    expect(existsSync(join(paths.meta, "registry.json"))).toBe(true);
    expect(existsSync(join(paths.meta, "backlinks.json"))).toBe(true);
  });
```

- [ ] **Step 3: Write the unreadable-source regression test**

Add immediately after the missing-source test:

```ts
  it("preserves existing logs and warns when the authoritative event source is unreadable", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });
    writeFileSync(
      join(paths.meta, "events.jsonl"),
      '{"timestamp":"2026-08-06T10:00:00.000Z","kind":"before-read-error"}\n',
    );
    expect(rebuildMetadata(paths).ok).toBe(true);

    const metaLog = readFileSync(join(paths.meta, "log.md"), "utf8");
    const wikiLog = readFileSync(join(paths.wiki, "log.md"), "utf8");
    rmSync(join(paths.meta, "events.jsonl"));
    mkdirSync(join(paths.meta, "events.jsonl"));

    const result = rebuildMetadata(paths);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "event_source_unreadable",
    );
    expect(readFileSync(join(paths.meta, "log.md"), "utf8")).toBe(metaLog);
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe(wikiLog);
  });
```

Using a directory at the event-file path deterministically produces a read failure on supported CI platforms without permission-dependent tests.

- [ ] **Step 4: Write the explicit-empty regression test**

Add:

```ts
  it("treats a present zero-byte event source as intentionally empty", () => {
    const paths = createVault({ knowledge_format: "okf-0.2" });

    const result = rebuildMetadata(paths);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "event_source_missing",
    );
    expect(readFileSync(join(paths.meta, "log.md"), "utf8")).toContain(
      "_No events recorded yet._",
    );
    expect(readFileSync(join(paths.wiki, "log.md"), "utf8")).toBe("# Wiki Update Log\n");
  });
```

- [ ] **Step 5: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run test/okf-projections.test.ts
```

Expected: new missing/unreadable tests fail because rebuild currently replaces logs and reports no source diagnostic. Existing tests may remain green.

- [ ] **Step 6: Add stable diagnostic codes**

Extend `DiagnosticCode` in `extensions/llm-wiki/lib/knowledge-document.ts`:

```ts
  | "event_source_missing"
  | "event_source_unreadable"
  | "event_invalid_json"
```

Keep existing event diagnostic members after these entries.

- [ ] **Step 7: Replace silent event reads with one discriminated source read**

In `extensions/llm-wiki/lib/metadata.ts`, replace the existing `readText()` helper with:

```ts
type EventSourceRead =
  | { available: true; content: string }
  | { available: false; diagnostic: KnowledgeDiagnostic };

function readEventSource(
  filePath: string,
  diagnosticPath = "meta/events.jsonl",
): EventSourceRead {
  if (!existsSync(filePath)) {
    return {
      available: false,
      diagnostic: okfDiag(
        "warning",
        "event_source_missing",
        diagnosticPath,
        "Authoritative event source is missing; existing log projections were preserved",
      ),
    };
  }

  try {
    return { available: true, content: readFileSync(filePath, "utf8") };
  } catch {
    return {
      available: false,
      diagnostic: okfDiag(
        "warning",
        "event_source_unreadable",
        diagnosticPath,
        "Authoritative event source is unreadable; existing log projections were preserved",
      ),
    };
  }
}
```

Function declarations are hoisted, so this helper may call the existing `okfDiag()` declaration later in the module without moving rendering helpers.

- [ ] **Step 8: Parse the event source once during rebuild**

Replace the direct `buildOkfLog(readText(...))` call with:

```ts
  const eventSource = readEventSource(join(paths.meta, "events.jsonl"));
  const eventLogResult = eventSource.available ? buildOkfLog(eventSource.content) : undefined;
  if (eventLogResult) allDiagnostics.push(...eventLogResult.diagnostics);
  else allDiagnostics.push(eventSource.diagnostic);
```

Replace meta-log construction with:

```ts
  const metaLog = eventSource.available ? buildLogMarkdown(eventSource.content) : undefined;
```

Replace OKF-log construction with:

```ts
  const okfLog: string | undefined =
    vaultState.knowledgeFormat === "okf-0.2" ? eventLogResult?.markdown : undefined;
```

- [ ] **Step 9: Suppress only unavailable log writes**

Keep registry, backlinks, and index writes unconditional. Replace the meta-log write with:

```ts
  if (metaLog !== undefined) atomicWriteFile(join(paths.meta, "log.md"), metaLog);
```

Replace the OKF-log write block with:

```ts
  if (okfLog !== undefined) {
    mkdirSync(paths.wiki, { recursive: true });
    atomicWriteFile(join(paths.wiki, "log.md"), okfLog);
  }
```

- [ ] **Step 10: Make the rich log renderer consume the same bytes**

Replace `buildLogMarkdown(paths: VaultPaths)` and its filesystem read with:

```ts
function buildLogMarkdown(eventsJsonl: string): string {
  const events: WikiEvent[] = [];
  const raw = eventsJsonl.trim();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const candidate: unknown = JSON.parse(line);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        events.push(candidate as WikiEvent);
      }
    } catch {
      // Keep backward-compatible rich-log behavior: malformed lines are omitted.
    }
  }

  const lines: string[] = [];
  lines.push("# Activity Log\n\n> Auto-generated from meta/events.jsonl. Do not edit manually.\n");

  for (const ev of events) {
    const ts = ev.timestamp || "unknown";
    const kind = ev.kind || "event";
    const details = Object.entries(ev)
      .filter(([k]) => k !== "timestamp" && k !== "kind")
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");

    lines.push(`## [${ts}] ${kind}`);
    if (details) lines.push(`- ${details}`);
    lines.push("");
  }

  if (events.length === 0) lines.push("_No events recorded yet._\n");
  return `${lines.join("\n")}\n`;
}
```

Delete the now-unused `readText()` helper.

- [ ] **Step 11: Give existing background-tool fixtures an explicit empty stream**

In `test/background-tools.test.ts` `beforeEach()`, add after writing `config.json`:

```ts
    writeFileSync(join(paths.meta, "events.jsonl"), "");
```

This keeps existing success-message tests focused on background dispatch rather than missing-history behavior.

- [ ] **Step 12: Add a user-visible warning test**

Add to `test/background-tools.test.ts`:

```ts
  it("reports a missing authoritative event source without failing unrelated projections", async () => {
    const paths = getVaultPaths(wikiDir);
    rmSync(join(paths.meta, "events.jsonl"));
    const tool = captureRebuildTool();

    const res = await tool.execute("id", {}, undefined, undefined, {
      cwd: wikiDir,
      hasUI: false,
    } as unknown);

    expect(res.details.background).toBe(false);
    expect(res.content[0].text).toContain("metadata rebuilt with warnings");
    expect(res.content[0].text).toContain("event_source_missing");
    expect(existsSync(join(paths.meta, "registry.json"))).toBe(true);
  });
```

Add `existsSync` to that test file's `node:fs` import.

- [ ] **Step 13: Surface successful rebuild warnings**

In `registerWikiRebuildMeta()` after the existing `if (!result.ok)` block, add:

```ts
          const warnings = result.diagnostics.filter(
            (diagnostic) => diagnostic.severity === "warning",
          );
          if (warnings.length > 0) {
            return `⚠️ LLM Wiki: metadata rebuilt with warnings — ${warnings
              .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
              .join("; ")}`;
          }
```

Keep the existing successful page-count message after this block. This surfaces missing/unreadable sources and existing non-blocking malformed-event/link diagnostics without marking successfully rebuilt registry/index projections as failed.

- [ ] **Step 14: Run focused tests**

```bash
pnpm vitest run test/okf-projections.test.ts test/background-tools.test.ts
```

Expected: both test files pass, including missing, unreadable, explicit-empty, and user-visible warning cases.

- [ ] **Step 15: Type-check and commit**

```bash
pnpm typecheck
git add \
  extensions/llm-wiki/lib/knowledge-document.ts \
  extensions/llm-wiki/lib/metadata.ts \
  extensions/llm-wiki/lib/tools.ts \
  test/okf-projections.test.ts \
  test/background-tools.test.ts
git commit -m "fix: preserve logs without authoritative events"
```

Expected: typecheck passes and commit contains only event-source read/rebuild behavior, warning propagation, and tests.

---

### Task 3: Keep machine-local capture paths out of portable logs

**Files:**
- Modify: `test/source-capture.test.ts:17-34`
- Modify: `test/source-capture.test.ts:140-190`
- Modify: `extensions/llm-wiki/lib/source-packet.ts:145-151`

- [ ] **Step 1: Let source-capture tests choose vault mode**

Replace the local `makePaths()` helper with:

```ts
  function makePaths(config: Record<string, unknown> = { name: "Capture test" }) {
    const p = getVaultPaths(join(tmpDir, `wiki-${Math.random().toString(36).slice(2)}`));
    ensureVaultStructure(p);
    writeFileSync(join(p.dotWiki, "config.json"), JSON.stringify(config));
    return p;
  }
```

- [ ] **Step 2: Write the local-path projection regression test**

Add after the local non-PDF capture test:

```ts
  it("keeps a local capture path in the raw manifest but out of events and the OKF log", async () => {
    const paths = makePaths({ name: "Portable log test", knowledge_format: "okf-0.2" });
    const localPath = join(tmpDir, "private", "notes.md");
    mkdirSync(join(localPath, ".."), { recursive: true });
    writeFileSync(localPath, "# Private notes\n", "utf8");

    const result = await captureFile(mockPi() as never, paths, localPath);
    const manifest = JSON.parse(readFile(join(result.packetPath, "manifest.json")));
    expect(manifest.file_path).toBe(localPath);

    const eventStream = readFile(join(paths.meta, "events.jsonl"));
    expect(eventStream).not.toContain(localPath);
    expect(eventStream).toContain(`"source_id":"${result.sourceId}"`);
    expect(eventStream).toContain('"format":"markdown"');

    expect(rebuildMetadata(paths).ok).toBe(true);
    expect(readFile(join(paths.wiki, "log.md"))).not.toContain(localPath);
  });
```

- [ ] **Step 3: Run the regression test and verify failure**

```bash
pnpm vitest run test/source-capture.test.ts -t "keeps a local capture path"
```

Expected: FAIL because current capture event contains `file_path`.

- [ ] **Step 4: Remove the duplicated local path from capture events**

In `fileCaptureSource()`, retain the manifest exactly and change only the event payload:

```ts
    manifest: () => ({
      title: fileName,
      file_path: filePath,
      format: extractor.format,
    }),
    event: () => ({ format: extractor.format }),
```

`finalizeCapture()` already adds stable `source_id`, so no replacement path field is needed.

- [ ] **Step 5: Run source capture and projection tests**

```bash
pnpm vitest run test/source-capture.test.ts test/okf-projections.test.ts
```

Expected: both files pass; raw manifest assertion proves provenance was retained, while event and public log assertions prove host path was removed.

- [ ] **Step 6: Commit the privacy boundary**

```bash
git add extensions/llm-wiki/lib/source-packet.ts test/source-capture.test.ts
git commit -m "fix: omit local paths from activity events"
```

---

### Task 4: Correct ownership guardrails and generated vault schema

**Files:**
- Modify: `test/e2e-guardrails.test.ts:82-110`
- Modify: `test/bootstrap.test.ts:42-75`
- Modify: `extensions/llm-wiki/lib/utils.ts:389-405`
- Modify: `extensions/llm-wiki/lib/bootstrap.ts:8-25`

- [ ] **Step 1: Tighten guardrail expectations**

Replace the `meta/events.jsonl` assertion in `test/e2e-guardrails.test.ts` with:

```ts
  it("blocks direct writes to authoritative event history", () => {
    const paths = makePaths();
    const target = join(paths.meta, "events.jsonl");

    const result = isProtectedPath(target, paths);

    expect(result.protected).toBe(true);
    expect(result.reason).toContain("append-only authoritative state");
    expect(result.reason).toContain("wiki_log_event");
    expect(result.reason).not.toContain("auto-generated");
  });
```

Leave registry/backlink expectations unchanged; they remain generated metadata.

- [ ] **Step 2: Assert generated schema ownership**

In the successful silent-bootstrap test, after reading config, add:

```ts
    const schema = readFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), "utf8");
    expect(schema).toContain("meta/events.jsonl | extension tools | append-only authoritative state");
    expect(schema).toContain("meta/* except events.jsonl | extension | generated projections");
    expect(schema).toContain("Back up events.jsonl to preserve activity history");
```

- [ ] **Step 3: Run tests and verify failure**

```bash
pnpm vitest run test/e2e-guardrails.test.ts test/bootstrap.test.ts
```

Expected: event guardrail and schema assertions fail against current “auto-generated” wording.

- [ ] **Step 4: Special-case event-state guardrail text**

In `isProtectedPath()` before the generic `paths.meta` branch, add:

```ts
    if (relativePhysicalPath(paths.meta, absPath) === "events.jsonl") {
      return {
        protected: true,
        reason:
          "Event history is append-only authoritative state. Use wiki_log_event or an owning wiki operation instead.",
      };
    }
```

Keep the existing generic metadata branch unchanged for registry, backlinks, indexes, logs, lint reports, and embeddings.

- [ ] **Step 5: Replace generated schema ownership rows**

In `WIKI_SCHEMA`, replace the single `meta/*` row with:

```ts
  "| meta/events.jsonl | extension tools | append-only authoritative state |",
  "| meta/* except events.jsonl | extension | generated projections |",
```

After the ownership table, add:

```ts
  "",
  "Back up `meta/events.jsonl` to preserve activity history. Generated logs cannot reconstruct it.",
```

- [ ] **Step 6: Run tests and commit**

```bash
pnpm vitest run test/e2e-guardrails.test.ts test/bootstrap.test.ts
pnpm typecheck
git add \
  extensions/llm-wiki/lib/utils.ts \
  extensions/llm-wiki/lib/bootstrap.ts \
  test/e2e-guardrails.test.ts \
  test/bootstrap.test.ts
git commit -m "docs: distinguish event state in vault guardrails"
```

Expected: focused tests and typecheck pass.

---

### Task 5: Align public docs, agent guidance, and release notes

**Files:**
- Modify: `README.md:240-313`
- Modify: `README.md:380-390`
- Modify: `docs/architecture.md:45-78`
- Modify: `docs/api.md:291-316`
- Modify: `skills/llm-wiki/SKILL.md:25-55`
- Modify: `skills/llm-wiki/SKILL.md:72-110`
- Modify: `CHANGELOG.md:1-12`

- [ ] **Step 1: Correct README ownership language**

Change the event ownership row to:

```markdown
| `.llm-wiki/meta/events.jsonl` | Extension / tool | Authoritative append-only state; back up for activity continuity |
```

Replace the Four-Layer Page Model meta comment with:

```text
.llm-wiki/meta/                   # Durable event source + generated internal projections
```

After the ownership table, add:

```markdown
### Activity history, backup, and portability

`meta/events.jsonl` is the authoritative source for recorded extension activity. Unlike registry, backlinks, indexes, logs, and embeddings, it cannot be rebuilt from wiki pages or raw packets. Preserve it when backing up or Git-synchronizing a complete pi-llm-wiki vault.

`meta/log.md` and OKF-mode `wiki/log.md` are generated views. `wiki/log.md` can travel with the OKF bundle as a readable snapshot, but it cannot reconstruct or resume the originating JSONL stream. Manual page edits are intentionally absent, so this is selected extension activity rather than a complete revision audit.

File-capture events omit machine-local paths from the public log projection. Callers of `wiki_log_event` still control arbitrary detail fields and must not record secrets or private host paths.
```

- [ ] **Step 2: Correct architecture ownership**

Replace the meta tree comment and ownership row with:

```markdown
    ├── meta/                  # Durable event source + generated internal projections
```

```markdown
| `.llm-wiki/meta/events.jsonl` | Extension tools | Authoritative, append-only; preserve in full-vault backups |
| `.llm-wiki/meta/**` except `events.jsonl` | Extension | Generated projections |
```

After the ownership table, add:

```markdown
`events.jsonl` records selected extension operations, not every filesystem edit. `meta/log.md` and OKF-mode `wiki/log.md` are one-way projections; neither can recover the event stream.
```

- [ ] **Step 3: Correct skill guidance**

Replace Golden Rule 2 with:

```markdown
2. **META IS EXTENSION-OWNED.** Never edit `meta/` directly. `events.jsonl` is append-only authoritative activity state; other metadata files are generated projections.
```

Under the vault tree, change the meta comment to:

```text
    ├── meta/                  # Durable events + generated projections (extension-owned)
```

Add beneath Golden Rules:

```markdown
> Preserve `meta/events.jsonl` in full-vault backups. `meta/log.md` and `wiki/log.md` cannot reconstruct it. Do not place secrets or private machine paths in manual event details.
```

- [ ] **Step 4: Document API semantics and privacy boundary**

Replace the opening `wiki_log_event` paragraph with:

```markdown
Append a structured event to the authoritative, append-only `meta/events.jsonl` stream and regenerate available log projections. Every event is timestamped automatically. The event stream must be preserved in full-vault backups; generated Markdown logs cannot reconstruct it.

`details` is user-controlled and may appear in OKF-mode `wiki/log.md`. Do not include secrets, credentials, or private machine-local paths. Built-in local-file capture records its stable source ID and format in events while retaining the exact input path only in the extension-owned raw manifest.
```

After the `wiki_rebuild_meta` paragraph, add:

```markdown
If `meta/events.jsonl` is missing or unreadable, rebuild reports a warning and preserves existing log projections while continuing to rebuild registry, backlinks, and indexes. A present zero-byte event file is an intentional empty history.
```

- [ ] **Step 5: Add changelog entries**

Under `Unreleased`, add:

```markdown
- **Authoritative activity history**: `meta/events.jsonl` is now documented as durable append-only extension state rather than rebuildable metadata. Missing or unreadable event sources warn and preserve existing Markdown logs while unrelated projections continue rebuilding.
- **Portable log privacy**: local-file capture events no longer duplicate caller-supplied filesystem paths into `events.jsonl` or OKF `wiki/log.md`; exact paths remain in extension-owned raw manifests.
```

- [ ] **Step 6: Scan for contradictory canonical guidance**

Run:

```bash
grep -InE "META IS AUTO-GENERATED|events.jsonl.*Auto-generated|events.jsonl.*Generated" \
  README.md \
  docs/architecture.md \
  docs/api.md \
  skills/llm-wiki/SKILL.md \
  extensions/llm-wiki/lib/bootstrap.ts
```

Expected: no output; current canonical English guidance no longer classifies `events.jsonl` as rebuildable or auto-generated. Historical plans and changelog entries continue describing behavior at their recorded time and must not be rewritten.

Also run:

```bash
grep -RIn "events.jsonl" README.md docs/architecture.md docs/api.md skills/llm-wiki/SKILL.md \
  extensions/llm-wiki/lib/bootstrap.ts
```

Expected: every current operating document consistently describes authoritative append-only state, one-way log projections, and backup requirements.

- [ ] **Step 7: Commit documentation**

```bash
git add \
  README.md \
  docs/architecture.md \
  docs/api.md \
  skills/llm-wiki/SKILL.md \
  CHANGELOG.md
git commit -m "docs: explain activity history backup and portability"
```

---

### Task 6: Run release gates and inspect the final diff

**Files:**
- Verify all files changed in Tasks 1-5

- [ ] **Step 1: Run focused behavior tests**

```bash
pnpm vitest run \
  test/okf-projections.test.ts \
  test/background-tools.test.ts \
  test/source-capture.test.ts \
  test/e2e-guardrails.test.ts \
  test/bootstrap.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run complete test suite**

```bash
pnpm test
```

Expected: all tests pass; no snapshot or fixture changes outside planned files.

- [ ] **Step 3: Run static gates**

```bash
pnpm typecheck
pnpm lint
```

Expected: TypeScript and Biome pass with no errors.

- [ ] **Step 4: Run coverage gate**

```bash
pnpm test:coverage
```

Expected: suite passes and repository coverage thresholds remain satisfied.

- [ ] **Step 5: Inspect behavioral diff and commit history**

```bash
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
git status --short
```

Expected:

- no whitespace errors;
- only files listed in the responsibility map changed;
- commits are plan, contract, missing-source preservation, path privacy, ownership/schema, and docs;
- working tree is clean.

- [ ] **Step 6: Verify issue #123 acceptance cases manually from tests and docs**

Confirm each statement with a direct file/test reference:

```text
[ ] events.jsonl is explicitly authoritative and non-reconstructible
[ ] full-vault backup/Git guidance names events.jsonl
[ ] wiki/log.md is documented as a snapshot, not event recovery
[ ] missing source preserves prior logs and warns
[ ] unreadable source preserves prior logs and warns
[ ] present empty source generates empty logs
[ ] registry/backlinks/indexes still rebuild without event source
[ ] file capture path remains in raw manifest
[ ] file capture path is absent from events and wiki/log.md
[ ] manual event details carry a privacy warning
[ ] import/export implementation remains out of scope
```

Expected: all boxes can be checked without relying on future code.

If release gates require corrections, return to the task that owns those files, apply its test-first sequence again, and amend that task with a concrete follow-up commit. Do not create an empty or catch-all verification commit.

---

## Phase boundary

Executing this plan leaves Foundation coherent and green:

- local event authority and backup semantics are explicit;
- unavailable authoritative history cannot silently erase existing logs;
- public OKF logs no longer receive built-in local file paths;
- existing event rendering and valid/malformed-line behavior remain intact;
- no import/export surface or partial Interchange implementation is introduced.

Next roadmap work requires a separate normative **OKF Interchange** child spec. That spec must choose imported-history composition before planning import/export implementation.
