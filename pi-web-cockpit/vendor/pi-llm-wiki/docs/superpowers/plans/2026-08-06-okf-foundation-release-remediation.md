# OKF Foundation Release Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the verified OKF Foundation release blockers by making the legacy layout migration safe and publishable, eliminating first-party unresolved source-page links, stabilizing the MCP output-cap test, and raising a reviewed PR.

**Architecture:** Keep this as a narrow Foundation release-remediation change. The existing layout migration remains a standalone Node script, but it will resolve paths consistently, reject destination conflicts before mutation, move files and directories through one rollback-capable executor, and ship in the npm tarball. Source pages will represent extension-owned raw artifacts as code paths rather than OKF knowledge links, while valid entity/concept links remain Markdown links.

**Tech Stack:** Node.js filesystem/path APIs, TypeScript ES2022, Vitest, npm package manifests, Biome, GitHub CLI

**Roadmap:** `docs/superpowers/specs/2026-08-02-okf-v0.2-interoperability-design.md`

**Phase:** Phase 1 remediation: OKF Foundation release gate

---

## Scope and release boundary

This plan fixes only findings reproduced during the Foundation release gate:

1. `scripts/migrate-llm-wiki.js` mishandles absolute legacy-vault paths.
2. Its legacy apply path creates `.llm-wiki/config.json` as a directory and then fails with `EISDIR`.
3. Existing destination entries can cause a split vault because the script skips them instead of aborting before mutation.
4. The advertised migration script is omitted from the npm package.
5. Generated source pages emit invalid raw-artifact Markdown links and unresolved skeleton placeholder links.
6. The MCP 16 MiB output-cap test uses a load-sensitive five-second deadline.

This phase intentionally does **not** add `wiki_okf_migrate`, OKF content conversion, import, export, review staging, or transaction journals. Existing old-layout vaults already remain readable and writable without migration; this plan repairs the separately advertised optional layout migration. No package version is edited manually.

## File responsibility map

### New files

- `test/migration-script.test.ts` — black-box CLI coverage for dry-run, absolute/relative paths, paths with spaces, successful apply, byte preservation, conflict preflight, idempotency, doubled-layout recovery, and npm-package inclusion.

### Modified files

- `scripts/migrate-llm-wiki.js` — common positional-path resolution, correct destination-parent creation, conflict preflight, rollback of synchronous move failures, and clearer failure output.
- `package.json` — include only the user-facing migration script in published files.
- `.github/workflows/ci.yml` — execute the packed migration script with the minimum supported Node 18 runtime.
- `extensions/llm-wiki/lib/source-packet.ts` — emit plain placeholders and code-form raw packet paths in skeleton pages.
- `extensions/llm-wiki/lib/ingest-worker.ts` — emit code-form raw packet paths in ingested pages while retaining valid entity/concept Markdown links.
- `test/source-capture.test.ts` — assert captured skeleton pages create no first-party unresolved-link diagnostics.
- `test/ingest-worker.test.ts` — assert ingested source/entity/concept output creates no first-party unresolved-link diagnostics.
- `test/mcp-exec.test.ts` — give the real 16 MiB stress case enough time under parallel coverage without weakening its byte and UTF-8 assertions.
- `CHANGELOG.md` — record the migration safety/packaging and generated-link fixes under `Unreleased`.

No README localization changes are needed because no README currently documents this script or generated source-page rendering.

---

### Task 1: Make the legacy layout migration correct and fail before known conflicts

**Files:**
- Create: `test/migration-script.test.ts`
- Modify: `scripts/migrate-llm-wiki.js:28-57`
- Modify: `scripts/migrate-llm-wiki.js:62-69`
- Modify: `scripts/migrate-llm-wiki.js:151-310`

- [ ] **Step 1: Create a branch from current `main`**

Run:

```bash
git fetch origin
git switch -c fix/okf-foundation-release-gate origin/main
git add docs/superpowers/plans/2026-08-06-okf-foundation-release-remediation.md
git commit -m "docs: plan OKF Foundation release remediation"
```

Expected: branch `fix/okf-foundation-release-gate` starts at current `origin/main`, the reviewed plan is its first commit, and `git status --short` is empty.

- [ ] **Step 2: Write black-box migration regression tests**

Create `test/migration-script.test.ts`:

```ts
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rootDir } from "./helpers.js";

const script = join(rootDir, "scripts", "migrate-llm-wiki.js");
const roots: string[] = [];
const migratedPaths: Record<string, string> = {
  ".wiki/config.json": ".llm-wiki/config.json",
  ".wiki/templates/concept.md": ".llm-wiki/templates/concept.md",
  "raw/sources/SRC-OLD/extracted.md": ".llm-wiki/raw/sources/SRC-OLD/extracted.md",
  "raw/sources/SRC-OLD/original/input.txt":
    ".llm-wiki/raw/sources/SRC-OLD/original/input.txt",
  "wiki/concepts/legacy.md": ".llm-wiki/wiki/concepts/legacy.md",
  "meta/registry.json": ".llm-wiki/meta/registry.json",
  "outputs/report.md": ".llm-wiki/outputs/report.md",
  ".discoveries/state.json": ".llm-wiki/.discoveries/state.json",
  "WIKI_SCHEMA.md": ".llm-wiki/WIKI_SCHEMA.md",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "pi llm wiki migration "): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runMigration(
  args: string[],
  cwd = rootDir,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function seedLegacy(root: string): void {
  mkdirSync(join(root, ".wiki", "templates"), { recursive: true });
  mkdirSync(join(root, "raw", "sources", "SRC-OLD", "original"), { recursive: true });
  mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(root, "meta"), { recursive: true });
  mkdirSync(join(root, "outputs"), { recursive: true });
  mkdirSync(join(root, ".discoveries"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), '{"name":"Legacy"}\n');
  writeFileSync(join(root, ".wiki", "templates", "concept.md"), "template bytes\n");
  writeFileSync(join(root, ".wiki", "extra.txt"), "leave in old marker directory\n");
  writeFileSync(join(root, "raw", "sources", "SRC-OLD", "extracted.md"), "raw bytes\n");
  writeFileSync(
    join(root, "raw", "sources", "SRC-OLD", "original", "input.txt"),
    "original bytes\n",
  );
  writeFileSync(
    join(root, "wiki", "concepts", "legacy.md"),
    "---\ntype: concept\nsources: sources/SRC-OLD\nunknown: keep\n---\n\nLegacy body.\n",
  );
  writeFileSync(join(root, "meta", "registry.json"), '{"pages":{}}\n');
  writeFileSync(join(root, "outputs", "report.md"), "report bytes\n");
  writeFileSync(join(root, ".discoveries", "state.json"), "discovery bytes\n");
  writeFileSync(join(root, "WIKI_SCHEMA.md"), "schema bytes\n");
}

function snapshot(root: string, directory = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else if (entry.isFile()) {
      files[relative(root, path).replace(/\\/g, "/")] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    }
  }
  return files;
}

function assertMigrated(root: string, before: Record<string, string>): void {
  expect(statSync(join(root, ".llm-wiki", "config.json")).isFile()).toBe(true);
  expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe(
    '{"name":"Legacy"}\n',
  );
  expect(readFileSync(join(root, ".llm-wiki", "templates", "concept.md"), "utf8")).toBe(
    "template bytes\n",
  );
  expect(
    readFileSync(join(root, ".llm-wiki", "raw", "sources", "SRC-OLD", "extracted.md"), "utf8"),
  ).toBe("raw bytes\n");
  expect(readFileSync(join(root, ".llm-wiki", "wiki", "concepts", "legacy.md"), "utf8")).toContain(
    "unknown: keep",
  );
  expect(readFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "utf8")).toBe(
    '{"pages":{}}\n',
  );
  expect(readFileSync(join(root, ".llm-wiki", "outputs", "report.md"), "utf8")).toBe(
    "report bytes\n",
  );
  expect(readFileSync(join(root, ".llm-wiki", ".discoveries", "state.json"), "utf8")).toBe(
    "discovery bytes\n",
  );
  expect(readFileSync(join(root, ".llm-wiki", "WIKI_SCHEMA.md"), "utf8")).toBe(
    "schema bytes\n",
  );
  expect(readFileSync(join(root, ".wiki", "extra.txt"), "utf8")).toBe(
    "leave in old marker directory\n",
  );
  expect(readFileSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"), "utf8")).toContain(
    "# Migration Complete",
  );
  const after = snapshot(root);
  for (const [source, destination] of Object.entries(migratedPaths)) {
    expect(after[destination], `${source} → ${destination}`).toBe(before[source]);
    expect(after[source], `${source} should be moved`).toBeUndefined();
  }
  expect(after[".wiki/extra.txt"]).toBe(before[".wiki/extra.txt"]);
  expect(existsSync(join(root, "raw"))).toBe(false);
  expect(existsSync(join(root, "wiki"))).toBe(false);
  expect(existsSync(join(root, "meta"))).toBe(false);
}

describe("migrate-llm-wiki CLI", () => {
  it.each(["absolute", "relative"] as const)(
    "dry-runs and applies a legacy migration through a %s path containing spaces",
    (pathMode) => {
      const root = tempRoot();
      seedLegacy(root);
      const cwd = pathMode === "relative" ? dirname(root) : rootDir;
      const rootArg = pathMode === "relative" ? basename(root) : root;
      const before = snapshot(root);

      const dryRun = runMigration([rootArg, "--dry-run"], cwd);
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(dryRun.stdout).toContain(`Scanning for legacy wiki at: ${root}`);
      expect(snapshot(root)).toEqual(before);

      const apply = runMigration(["--force", rootArg], cwd);
      expect(apply.status, apply.stderr).toBe(0);
      expect(apply.stdout).toContain("Migration complete");
      assertMigrated(root, before);

      const migrated = snapshot(root);
      const rerun = runMigration([rootArg, "--force"], cwd);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(rerun.stdout).toContain("New-format wiki already exists");
      expect(snapshot(root)).toEqual(migrated);
    },
  );

  it("rejects any destination collision before moving legacy files", () => {
    const root = tempRoot();
    seedLegacy(root);
    mkdirSync(join(root, ".llm-wiki", "wiki"), { recursive: true });
    writeFileSync(join(root, ".llm-wiki", "wiki", "existing.md"), "destination bytes\n");
    const before = snapshot(root);

    const result = runMigration([root, "--force"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Migration blocked by destination conflicts");
    expect(result.stdout).toContain(".llm-wiki/wiki");
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".llm-wiki", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"))).toBe(false);
  });

  it("never overwrites an existing forwarding marker", () => {
    const root = tempRoot();
    seedLegacy(root);
    writeFileSync(
      join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"),
      "user-owned marker bytes\n",
    );
    const before = snapshot(root);

    const result = runMigration([root, "--force"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Migration blocked by destination conflicts");
    expect(snapshot(root)).toEqual(before);
    expect(readFileSync(join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md"), "utf8")).toBe(
      "user-owned marker bytes\n",
    );
    expect(existsSync(join(root, ".llm-wiki", "config.json"))).toBe(false);
  });

  it.each([
    ["config", ".llm-wiki/config.json"],
    ["schema", ".llm-wiki/WIKI_SCHEMA.md"],
    ["forwarding marker", ".wiki/MIGRATED_TO_LLM_WIKI.md"],
  ] as const)("does not overwrite a raced %s destination", async (_label, racedPath) => {
    const root = tempRoot();
    seedLegacy(root);
    const before = snapshot(root);
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script, root], {
      cwd: rootDir,
      stdio: "pipe",
    });
    let stdout = "";
    const confirmation = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("Proceed with migration?")) resolve();
      });
    });

    await confirmation;
    const racedDestination = join(root, racedPath);
    mkdirSync(dirname(racedDestination), { recursive: true });
    writeFileSync(racedDestination, "race winner\n");
    child.stdin.end("y\n");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(1);
    expect(readFileSync(racedDestination, "utf8")).toBe("race winner\n");
    const after = snapshot(root);
    for (const [source, destination] of Object.entries(migratedPaths)) {
      expect(after[source], `${source} should be restored`).toBe(before[source]);
      if (destination !== racedPath) {
        expect(after[destination], `${destination} should be rolled back`).toBeUndefined();
      }
    }
    if (racedPath !== ".wiki/MIGRATED_TO_LLM_WIKI.md") {
      expect(after[".wiki/MIGRATED_TO_LLM_WIKI.md"]).toBeUndefined();
    }
  });

  it("does not overwrite a doubled-layout entry raced in after confirmation", async () => {
    const root = tempRoot("pi doubled race ");
    const inner = join(root, ".llm-wiki", ".llm-wiki");
    mkdirSync(join(inner, "meta"), { recursive: true });
    writeFileSync(join(inner, "config.json"), '{"inner":true}\n');
    writeFileSync(join(inner, "meta", "registry.json"), "inner registry\n");
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [script, "--fix-doubled", root],
      { cwd: rootDir, stdio: "pipe" },
    );
    let stdout = "";
    const confirmation = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("Proceed with flatten?")) resolve();
      });
    });

    await confirmation;
    writeFileSync(join(root, ".llm-wiki", "config.json"), "race winner\n");
    child.stdin.end("y\n");
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

    expect(code).toBe(0);
    expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe(
      "race winner\n",
    );
    expect(readFileSync(join(inner, "config.json"), "utf8")).toBe('{"inner":true}\n');
    expect(readFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "utf8")).toBe(
      "inner registry\n",
    );
  });

  it("dry-runs and applies doubled-layout recovery without overwriting collisions", () => {
    const root = tempRoot("pi doubled migration ");
    const inner = join(root, ".llm-wiki", ".llm-wiki");
    mkdirSync(join(inner, "wiki", "sources"), { recursive: true });
    mkdirSync(join(inner, "meta"), { recursive: true });
    writeFileSync(join(inner, "config.json"), '{"inner":true}\n');
    writeFileSync(join(inner, "wiki", "sources", "note.md"), "inner page\n");
    writeFileSync(join(inner, "meta", "registry.json"), "inner registry\n");
    writeFileSync(join(root, ".llm-wiki", "config.json"), '{"outer":true}\n');
    const before = snapshot(root);

    const dryRun = runMigration(["--fix-doubled", root, "--dry-run"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);

    const apply = runMigration(["--fix-doubled", root, "--force"]);
    expect(apply.status, apply.stderr).toBe(0);
    expect(readFileSync(join(root, ".llm-wiki", "config.json"), "utf8")).toBe(
      '{"outer":true}\n',
    );
    expect(readFileSync(join(inner, "config.json"), "utf8")).toBe('{"inner":true}\n');
    expect(readFileSync(join(root, ".llm-wiki", "wiki", "sources", "note.md"), "utf8")).toBe(
      "inner page\n",
    );
    expect(readFileSync(join(root, ".llm-wiki", "meta", "registry.json"), "utf8")).toBe(
      "inner registry\n",
    );
  });
});
```

- [ ] **Step 3: Run the migration tests and verify the reproduced failures**

Run:

```bash
pnpm vitest run test/migration-script.test.ts
```

Expected: the absolute-path cases report the wrong scan root; relative apply exits non-zero with `EISDIR`; the conflict case either mutates state or does not emit the expected preflight message.

- [ ] **Step 4: Make the standalone script Node 18-compatible and resolve positional roots once**

Replace the script's ESM imports with CommonJS built-in imports so the published `.js` file runs under the declared minimum Node 18 runtime without requiring `package.json` to set `type: module`:

```js
const {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
```

Add this helper after the CLI flags:

```js
function resolvePositionalRoot(defaultRoot) {
  const positional = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  return positional ? resolve(process.cwd(), positional) : defaultRoot;
}
```

Replace doubled-mode root selection with:

```js
const parentRoot = resolvePositionalRoot(homedir());
```

Replace legacy-mode root selection with:

```js
const root = resolvePositionalRoot(process.cwd());
```

This permits flags before or after absolute or relative paths and removes the `MODULE_TYPELESS_PACKAGE_JSON` warning on newer Node versions.

- [ ] **Step 5: Replace `moveDir` with no-clobber file moves and a rollback-capable executor**

Replace the current `moveDir` function with:

```js
function moveNoClobber(item) {
  mkdirSync(dirname(item.dest), { recursive: true });
  if (item.type === "file") {
    // Hard-link creation is atomic and fails with EEXIST instead of replacing a raced file.
    linkSync(item.src, item.dest);
    try {
      unlinkSync(item.src);
    } catch (error) {
      unlinkSync(item.dest);
      throw error;
    }
    return;
  }
  if (existsSync(item.dest)) throw new Error(`Destination appeared: ${item.dest}`);
  renameSync(item.src, item.dest);
}

function restoreMove(item) {
  mkdirSync(dirname(item.src), { recursive: true });
  if (item.type === "file") {
    linkSync(item.dest, item.src);
    unlinkSync(item.dest);
    return;
  }
  if (existsSync(item.src)) throw new Error(`Rollback source exists: ${item.src}`);
  renameSync(item.dest, item.src);
}

function executeMovePlan(plan, newRoot, forwardingMarker, markerContent) {
  const rootExisted = existsSync(newRoot);
  const moved = [];
  let markerHandle;
  let ownsMarker = false;

  try {
    // Reserve the marker atomically before moving anything. A raced marker is never truncated.
    markerHandle = openSync(forwardingMarker, "wx");
    ownsMarker = true;
    for (const item of plan) {
      log(`MOVE ${item.name}: ${item.src} → ${item.dest}`);
      moveNoClobber(item);
      moved.push(item);
    }
    writeFileSync(markerHandle, markerContent, "utf8");
    closeSync(markerHandle);
    markerHandle = undefined;
    log("CREATE forwarding marker: .wiki/MIGRATED_TO_LLM_WIKI.md");
  } catch (error) {
    const rollbackErrors = [];
    if (markerHandle !== undefined) {
      try {
        closeSync(markerHandle);
      } catch (closeError) {
        rollbackErrors.push(`marker close: ${closeError.message}`);
      }
      markerHandle = undefined;
    }
    if (ownsMarker && existsSync(forwardingMarker)) {
      try {
        unlinkSync(forwardingMarker);
      } catch (unlinkError) {
        rollbackErrors.push(`marker cleanup: ${unlinkError.message}`);
      }
    }
    for (const item of moved.reverse()) {
      try {
        if (existsSync(item.dest) && !existsSync(item.src)) restoreMove(item);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.name}: ${rollbackError.message}`);
      }
    }
    if (!rootExisted) {
      try {
        rmdirSync(newRoot);
      } catch {
        // A non-empty directory is evidence preserved for manual recovery.
      }
    }
    const rollback = rollbackErrors.length
      ? ` Rollback errors: ${rollbackErrors.join("; ")}`
      : " All completed moves were rolled back.";
    throw new Error(`Migration move failed: ${error.message}.${rollback}`);
  }
}
```

Regular files (`config.json` and `WIKI_SCHEMA.md`) use atomic hard-link creation plus source unlink, so a raced file destination fails with `EEXIST` rather than being replaced. Directories retain same-filesystem `renameSync`, with a mutation-time destination check and reverse-order rollback. The marker is reserved with `wx`, written through the owned file descriptor, and removed only when this process created it and the migration fails.

In the existing `fixDoubled()` execution loop, replace the cached collision-only condition:

```js
if (p.collision) {
```

with a mutation-time recheck:

```js
if (p.collision || existsSync(p.dest)) {
```

This preserves an outer file or directory created while the confirmation prompt is open instead of passing it to overwrite-capable `renameSync`.

- [ ] **Step 6: Preflight the complete legacy move plan before confirmation or mutation**

After constructing `moves` and `schemas`, create one executable plan and reject collisions:

```js
const newRoot = join(root, ".llm-wiki");
const forwardingMarker = join(root, ".wiki", "MIGRATED_TO_LLM_WIKI.md");
const movePlan = [
  ...moves,
  ...schemas.map((schema) => ({ ...schema, type: "file", name: "WIKI_SCHEMA" })),
].filter((item) => existsSync(item.src));
const conflicts = [
  ...movePlan.filter((item) => existsSync(item.dest)),
  ...(existsSync(forwardingMarker)
    ? [{ dest: forwardingMarker, name: "forwarding marker" }]
    : []),
];

if (conflicts.length > 0) {
  console.log("\n❌ Migration blocked by destination conflicts:");
  for (const conflict of conflicts) console.log(`   ${conflict.dest}`);
  console.log("   No files were moved. Resolve these paths and rerun the migration.");
  process.exit(1);
}
```

Before execution, build the marker content without writing it:

```js
const markerContent = [
  "# Migration Complete",
  "",
  `This vault was migrated to the new layout at \`.llm-wiki/\` on ${new Date().toISOString().split("T")[0]}.`,
  "",
  "The old `.wiki/` directory is kept as a forwarding marker.",
  "Remove it once you've verified everything works.",
  "",
  `New location: \`${newRoot}\``,
  "",
].join("\n");
```

Delete the old `moveDir` loop, separate schema loop, and separate forwarding-marker `writeFileSync` block. Replace them with:

```js
if (!DRY_RUN) executeMovePlan(movePlan, newRoot, forwardingMarker, markerContent);
else {
  for (const item of movePlan) log(`MOVE ${item.name}: ${item.src} → ${item.dest}`);
}
```

Keep missing optional sources represented as `○` in the printed plan. The executor now owns marker creation and rolls moves back if marker reservation or writing fails.

- [ ] **Step 7: Run focused migration and existing doubled-layout tests**

Run:

```bash
pnpm vitest run test/migration-script.test.ts test/personal-wiki-paths.test.ts
```

Expected: all migration CLI tests and all 9 existing helper tests pass. No test touches the real home vault.

- [ ] **Step 8: Commit the migration safety fix**

Run:

```bash
git add scripts/migrate-llm-wiki.js test/migration-script.test.ts
git commit -m "fix: make vault layout migration fail safely"
```

Expected: one commit containing only the migration script and its black-box tests.

---

### Task 2: Publish the advertised migration script

**Files:**
- Modify: `package.json:36-47`
- Modify: `test/migration-script.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a failing packed-artifact assertion**

Append this test inside `describe("migrate-llm-wiki CLI", ...)`:

```ts
it("includes the advertised migration script in the npm package", () => {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: rootDir, encoding: "utf8" },
  );
  expect(packed.status, packed.stderr).toBe(0);
  const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
  expect(report[0].files.map((file) => file.path)).toContain("scripts/migrate-llm-wiki.js");
});
```

- [ ] **Step 2: Run the packed-artifact test and verify failure**

Run:

```bash
pnpm vitest run test/migration-script.test.ts -t "includes the advertised migration script"
```

Expected: FAIL because `package.json.files` excludes `scripts/migrate-llm-wiki.js`.

- [ ] **Step 3: Include only the user-facing migration script**

Add this exact entry to `package.json.files` after `prompts`:

```json
"scripts/migrate-llm-wiki.js",
```

Do not include the whole `scripts/` directory; `release.js` and build internals are not runtime package files.

- [ ] **Step 4: Verify the packed artifact**

Run:

```bash
pnpm vitest run test/migration-script.test.ts -t "includes the advertised migration script"
npm pack --dry-run --json | node -e '
let data="";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  const files = JSON.parse(data)[0].files.map(file => file.path);
  if (!files.includes("scripts/migrate-llm-wiki.js")) process.exit(1);
  console.log("migration script packaged");
});'
```

Expected: test passes and command prints `migration script packaged`.

- [ ] **Step 5: Execute the packed script on the minimum supported Node version in CI**

Append this job under `jobs:` in `.github/workflows/ci.yml`, alongside `quality`:

```yaml
  migration-node18:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Pack and execute migration on Node 18
        shell: bash
        run: |
          set -euo pipefail
          fixture="$RUNNER_TEMP/legacy vault"
          unpacked="$RUNNER_TEMP/unpacked"
          mkdir -p "$fixture/.wiki" "$fixture/wiki/concepts" "$unpacked"
          printf '{"name":"Node 18 fixture"}\n' > "$fixture/.wiki/config.json"
          printf '%s\n' '---' 'type: concept' '---' '' 'Node 18 body.' > "$fixture/wiki/concepts/node-18.md"
          config_hash=$(sha256sum "$fixture/.wiki/config.json" | cut -d' ' -f1)
          page_hash=$(sha256sum "$fixture/wiki/concepts/node-18.md" | cut -d' ' -f1)

          tarball=$(npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP" --silent)
          tar -xzf "$RUNNER_TEMP/$tarball" -C "$unpacked"
          node "$unpacked/package/scripts/migrate-llm-wiki.js" "$fixture" --force

          test -f "$fixture/.llm-wiki/config.json"
          test -f "$fixture/.llm-wiki/wiki/concepts/node-18.md"
          test "$(sha256sum "$fixture/.llm-wiki/config.json" | cut -d' ' -f1)" = "$config_hash"
          test "$(sha256sum "$fixture/.llm-wiki/wiki/concepts/node-18.md" | cut -d' ' -f1)" = "$page_hash"
```

This job uses no installed dependencies: the migration script must run from the real packed tarball using Node built-ins only.

- [ ] **Step 6: Validate the workflow and package tests**

Run:

```bash
pnpm lint
pnpm vitest run test/migration-script.test.ts
```

Expected: Biome accepts the workflow and all migration/package tests pass locally. The Node 18 packed execution is required to pass in PR CI.

- [ ] **Step 7: Commit the package contract**

Run:

```bash
git add package.json test/migration-script.test.ts .github/workflows/ci.yml
git commit -m "fix: publish the vault migration script"
```

---

### Task 3: Stop generating unresolved first-party source links

**Files:**
- Modify: `extensions/llm-wiki/lib/source-packet.ts:272-309`
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts:137-184`
- Modify: `test/source-capture.test.ts:1-70`
- Modify: `test/ingest-worker.test.ts:1-110`

- [ ] **Step 1: Add a skeleton-page regression test**

Add this import to `test/source-capture.test.ts`:

```ts
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
```

Add this test after the text-capture test:

```ts
it("emits no unresolved first-party links in a captured skeleton page", () => {
  const paths = makePaths();
  const result = captureText(paths, "Some text content", "My Note");
  const sourcePage = readFile(result.sourcePagePath);

  expect(sourcePage).toContain(`\`raw/sources/${result.sourceId}/extracted.md\``);
  expect(sourcePage).toContain(`\`raw/sources/${result.sourceId}/manifest.json\``);
  expect(sourcePage).not.toContain("](/entities/entity-name.md)");
  expect(sourcePage).not.toContain("](/concepts/concept-name.md)");

  const projection = rebuildMetadata(paths);
  expect(
    projection.diagnostics.filter((diagnostic) =>
      ["link_unresolved", "link_path_escape"].includes(diagnostic.code),
    ),
  ).toEqual([]);
});
```

- [ ] **Step 2: Add an ingested-page regression test**

Add this import to `test/ingest-worker.test.ts`:

```ts
import { rebuildMetadata } from "../extensions/llm-wiki/lib/metadata.js";
```

Extend `writes the source page (ingested) and creates entity/concept pages` with:

```ts
expect(sourcePage).toContain("`raw/sources/SRC-001/extracted.md`");
expect(sourcePage).toContain("`raw/sources/SRC-001/manifest.json`");
expect(sourcePage).not.toContain("](../raw/");

const projection = rebuildMetadata(paths);
expect(
  projection.diagnostics.filter((diagnostic) =>
    ["link_unresolved", "link_path_escape"].includes(diagnostic.code),
  ),
).toEqual([]);
```

The existing assertions for `/entities/*.md` and `/concepts/*.md` remain unchanged; those are valid knowledge links and must continue producing backlinks.

- [ ] **Step 3: Run both focused tests and verify failure**

Run:

```bash
pnpm vitest run test/source-capture.test.ts test/ingest-worker.test.ts
```

Expected: failures show `../raw/...` Markdown links and unresolved `entity-name`/`concept-name` placeholders.

- [ ] **Step 4: Render skeleton placeholders as text, not fake links**

In `buildSourcePageSkeleton()` within `extensions/llm-wiki/lib/source-packet.ts`, replace the entity/concept placeholder sections with:

```md
## Entities Mentioned

- [LLM: Add linked entities after review]

## Concepts Mentioned

- [LLM: Add linked concepts after review]
```

A bracketed placeholder without a destination is plain CommonMark text and does not create a backlink candidate.

- [ ] **Step 5: Render raw artifacts as extension paths, not OKF links**

In both `buildSourcePageSkeleton()` and `buildIngestedSourcePageBody()`, replace the Source Packet rows with:

```md
- **ID:** `sources/${id}`
- **Extracted:** `raw/sources/${id}/extracted.md`
- **Manifest:** `raw/sources/${id}/manifest.json`
```

Raw packets live outside the portable `wiki/` OKF bundle. Code paths preserve useful extension metadata without pretending they are resolvable concept links. Keep `raw_path` frontmatter unchanged.

- [ ] **Step 6: Run source, ingestion, backlink, and projection tests**

Run:

```bash
pnpm vitest run \
  test/source-capture.test.ts \
  test/ingest-worker.test.ts \
  test/knowledge-links.test.ts \
  test/okf-projections.test.ts \
  test/okf-integration.test.ts
```

Expected: all tests pass; captured and ingested source pages produce no unexpected link diagnostics; entity/concept backlinks remain present.

- [ ] **Step 7: Commit the generated-link fix**

Run:

```bash
git add \
  extensions/llm-wiki/lib/source-packet.ts \
  extensions/llm-wiki/lib/ingest-worker.ts \
  test/source-capture.test.ts \
  test/ingest-worker.test.ts
git commit -m "fix: stop emitting unresolved source page links"
```

---

### Task 4: Stabilize the MCP output-cap stress test without weakening coverage

**Files:**
- Modify: `test/mcp-exec.test.ts:45-112`
- Modify: `test/migration-script.test.ts:295-304`

- [ ] **Step 1: Keep the child alive until the cap fires and increase only this stress-case deadline**

Replace the current parameterized output-cap test with:

```ts
it.each(["stdout", "stderr"] as const)(
  "bounds captured %s at a complete UTF-8 code point",
  async (stream) => {
    const script =
      stream === "stdout"
        ? "process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(16*1024*1024-1)+'€',()=>setTimeout(()=>process.stdout.write('A'),10));setInterval(()=>{},1000)"
        : "process.on('SIGTERM',()=>{});process.stderr.write('x'.repeat(16*1024*1024-1)+'€',()=>setTimeout(()=>process.stderr.write('A'),10));setInterval(()=>{},1000)";
    const result = await createExecApi().exec(process.execPath, ["-e", script], {
      timeout: 15_000,
    });
    expect(result).toMatchObject({ killed: true, code: 1 });
    expect(Buffer.byteLength(result[stream])).toBe(16 * 1024 * 1024 - 1);
  },
  20_000,
);
```

The interval prevents the fixture process from exiting merely because a five-second keepalive elapsed under load; the parent still kills it as soon as the production cap is reached, with a 15-second fallback timeout. Do not lower the 16 MiB payload and do not remove the exact UTF-8 byte assertion. The production cap remains unchanged.

- [ ] **Step 2: Remove the other load-sensitive process and package-test deadlines**

Increase the descendant-process fixture command timeout in `test/mcp-exec.test.ts` from `100` to `1_000` milliseconds so Node can synchronously write `child.pid` before the process group is killed under parallel load. Keep the existing post-kill descendant assertion unchanged.

Give the real `npm pack --dry-run` test in `test/migration-script.test.ts` an explicit `30_000` millisecond Vitest timeout. Keep the package-content assertion unchanged.

- [ ] **Step 3: Exercise the stress tests repeatedly and under the full worker pool**

Run:

```bash
for run in 1 2 3; do
  pnpm vitest run test/mcp-exec.test.ts
done
pnpm test
```

Expected: all three focused runs pass, followed by all 542+ repository tests under normal parallel execution.

- [ ] **Step 4: Commit the test stabilization**

Run:

```bash
git add \
  docs/superpowers/plans/2026-08-06-okf-foundation-release-remediation.md \
  test/mcp-exec.test.ts \
  test/migration-script.test.ts
git commit -m "test: stabilize release gate process coverage"
```

---

### Task 5: Document the fixes and run the full release gate

**Files:**
- Modify: `CHANGELOG.md:3-10`

- [ ] **Step 1: Add exact `Unreleased` changelog entries**

Add these bullets under `## [Unreleased]` → `### Fixed`:

```markdown
- **Vault layout migration safety and packaging**: `scripts/migrate-llm-wiki.js` now runs on the minimum supported Node 18 runtime, accepts absolute or relative roots regardless of flag order, uses no-clobber file moves and an exclusively reserved forwarding marker, rejects destination collisions before moving data, rolls back completed moves after synchronous failures, and ships in the npm package. Black-box tests cover paths with spaces, dry-run immutability, hash-preserving apply, idempotency, preflight and raced config/schema/marker collisions, doubled-layout recovery, packed-artifact contents, and packed execution on Node 18.
- **Generated source pages emitted unresolved first-party links**: source skeletons no longer create fake entity/concept links, and raw packet artifacts are rendered as extension-owned code paths rather than Markdown links inside the OKF bundle. Captured and ingested pages now rebuild without unexpected `link_unresolved` or `link_path_escape` diagnostics while retaining valid entity/concept backlinks.
- **MCP output-cap stress test was load-sensitive**: the real 16 MiB stdout/stderr UTF-8 boundary test keeps its exact byte assertions but now allows enough time under parallel coverage load.
```

Do not claim that OKF content migration, import, or export exists.

- [ ] **Step 2: Run formatting, type, and whitespace checks**

Run:

```bash
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all commands exit 0 with no fixes or whitespace errors.

- [ ] **Step 3: Run focused Foundation and migration suites**

Run:

```bash
pnpm vitest run --maxWorkers=1 \
  test/migration-script.test.ts \
  test/personal-wiki-paths.test.ts \
  test/source-capture.test.ts \
  test/ingest-worker.test.ts \
  test/knowledge-document.test.ts \
  test/knowledge-links.test.ts \
  test/vault-format.test.ts \
  test/okf-projections.test.ts \
  test/okf-integration.test.ts \
  test/mcp-parity.test.ts \
  test/mcp-exec.test.ts \
  test/mcp-package.test.ts
```

Expected: every focused file passes.

- [ ] **Step 4: Run the full coverage release gate**

Run:

```bash
pnpm test:coverage
```

Expected: all test files and tests pass with configured global and trusted-boundary thresholds. No output-cap timeout is tolerated.

- [ ] **Step 5: Inspect the actual package contract**

Run:

```bash
pnpm build:mcp
npm pack --dry-run --json > /tmp/pi-llm-wiki-pack.json
node - <<'NODE'
const report = require("/tmp/pi-llm-wiki-pack.json")[0];
const files = new Set(report.files.map((file) => file.path));
for (const required of ["scripts/migrate-llm-wiki.js", "dist/mcp/index.js"]) {
  if (!files.has(required)) throw new Error(`missing packed file: ${required}`);
}
console.log(`package files: ${report.entryCount}; migration and MCP entries present`);
NODE
```

Expected: command prints package count and confirms both runtime entries.

- [ ] **Step 6: Commit release documentation**

Run:

```bash
git add CHANGELOG.md
git commit -m "docs: record OKF release gate fixes"
```

---

### Task 6: Review the final range and raise the PR

**Files:**
- Review only: all files changed since `origin/main`

- [ ] **Step 1: Verify the final branch range**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: clean working tree, six focused commits (plan, migration, packaging, generated links, MCP test, changelog), only planned files changed, and no whitespace errors.

- [ ] **Step 2: Run an independent bug review**

Invoke the repository `code_review` tool with:

```json
{
  "branch": "origin/main",
  "lenses": ["correctness", "security", "tests"]
}
```

Required review focus:

- migration never overwrites destination entries silently;
- absolute, relative, and space-containing paths resolve correctly;
- config and schema destinations remain files;
- normal apply is byte-preserving and rerunnable;
- raw packet paths are not interpreted as OKF concept links;
- valid entity/concept backlinks still exist;
- package contains the advertised script and its packed copy executes on Node 18;
- config, schema, marker, and doubled-layout race fixtures never overwrite competing bytes;
- no `wiki_okf_migrate` or other later-phase surface was added.

Expected: no Critical or Important findings. Fix any finding and rerun the relevant focused plus full gates before proceeding.

- [ ] **Step 3: Push the branch**

Run:

```bash
git push -u origin fix/okf-foundation-release-gate
```

Expected: remote branch created successfully.

- [ ] **Step 4: Open the pull request**

Run:

```bash
gh pr create \
  --base main \
  --head fix/okf-foundation-release-gate \
  --title "fix: clear OKF Foundation release blockers" \
  --body-file - <<'EOF'
## Summary

- make the legacy `.wiki` → `.llm-wiki` migration path-safe, conflict-safe, rollback-capable, and publishable
- stop generated source pages from emitting unresolved raw-artifact and placeholder links
- stabilize the MCP 16 MiB UTF-8 output-cap stress test under parallel coverage
- add black-box migration, packed-artifact, and generated-link regression coverage

## Scope

This PR remediates the OKF Foundation release gate. It does not add OKF content migration, import, export, or `wiki_okf_migrate`; those remain later Interchange work.

## Verification

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:coverage`
- `pnpm build:mcp`
- `npm pack --dry-run --json`
- real CLI fixtures for absolute/relative paths, spaces, dry-run, hash-preserving apply, idempotency, preflight/raced collisions, doubled-layout recovery, and packed Node 18 execution
EOF
```

Expected: GitHub returns a PR URL targeting `main`.

- [ ] **Step 5: Wait for and verify CI before merge recommendation**

Run:

```bash
gh pr checks --watch
```

Expected: every required Node, CodeQL, lint, and package check passes. Record the exact PR head SHA and do not recommend merge if the checked SHA differs from branch HEAD.

---

## Live-vault acceptance addendum

A guarded acceptance run against the real 634-file personal vault found two release gaps that fixture-only validation missed:

1. Process interruption after the first move leaves a partial layout with no restart protocol.
2. Fifteen historical pages are not accepted by the strict parser (seven missing frontmatter, two missing `type`, and six invalid YAML), so metadata rebuild blocks even though the existing registry still supports reads.

### Task 6: Make layout migration resumable

- [x] Persist a durable migration journal before the first move.
- [x] Reserve the destination root atomically after confirmation.
- [x] Hash each planned source and verify each resumed destination before trusting it.
- [x] Recover the hard-link-created/before-source-unlink crash state.
- [x] Flush journal, marker, and moved directory entries at durability boundaries.
- [x] Add a real subprocess `SIGKILL` test that resumes and verifies every original byte.

### Task 7: Repair malformed legacy pages through the existing lint surface

- [x] Keep `wiki_lint auto_fix=false` read-only and report projection blockers.
- [x] On explicit `auto_fix=true`, repair only recoverable legacy frontmatter failures.
- [x] Back up every original page under `outputs/legacy-repair-*/wiki/` before replacement.
- [x] Record old/new SHA-256 values and diagnostics in a repair manifest.
- [x] Preserve valid legacy metadata, archive unparseable raw frontmatter, and retain page bodies.
- [x] Rebuild projections only after every repaired page parses successfully.
- [x] Repeat the guarded live-vault migration, repair, OKF projection, real Pi tool, injection, MCP, restart, and interruption acceptance run.

---

## Acceptance criteria

The PR is ready for merge only when all statements below are true:

1. `node scripts/migrate-llm-wiki.js /absolute/path --force` and the equivalent relative path work, including paths containing spaces.
2. Dry-run leaves every fixture byte-identical.
3. Successful apply preserves config, templates, raw packets, wiki pages, metadata, outputs, discoveries, schema, and additional `.wiki/` files.
4. Any destination collision, including an existing forwarding marker, aborts before the first source move and preserves existing bytes.
5. Config, schema, or marker destinations introduced after preflight are never overwritten; any completed moves roll back, competing bytes remain untouched, and no migration-owned marker remains after failure.
6. `config.json` and `WIKI_SCHEMA.md` are regular files after migration.
7. A successful rerun is a no-op.
8. Doubled-layout automatic/helper behavior remains green, and both pre-existing and raced CLI collisions preserve outer entries.
9. `npm pack --dry-run --json` contains `scripts/migrate-llm-wiki.js` and `dist/mcp/index.js`, and the packed migration script completes on Node 18.
10. Captured skeleton and ingested source pages produce no unexpected `link_unresolved` or `link_path_escape` diagnostics.
11. Entity and concept Markdown links still resolve and generate backlinks.
12. MCP output-cap tests retain the 16 MiB limit and exact complete-code-point assertion and pass under normal parallel coverage.
13. Typecheck, lint, full tests, coverage thresholds, MCP build, package smoke, and independent review pass.
14. The PR contains no package-version edit and no later-phase OKF content-migration surface.
