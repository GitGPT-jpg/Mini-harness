# Configurable Synthesis Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /skill:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow vault owners to configure the narrative language used by background ingest synthesis via `.pi/settings.json`.

**Architecture:** Add `synthesisLanguage` field to `TaskConfig`, parse it in `readNamespacedConfig`, pass it through `wiki_ingest` → `runIngestSynthesis`, and conditionally append a language instruction to the ingest worker's system prompt.

**Tech Stack:** TypeScript (ES2022, ESM), Vitest, Biome

**Roadmap:** None

**Phase:** Single-plan implementation

---

### Task 1: Add `synthesisLanguage` to TaskConfig

**Files:**
- Modify: `extensions/llm-wiki/lib/task-config.ts`

- [ ] Add `synthesisLanguage?: string` field to `TaskConfig` interface (after `trajectories`)
- [ ] In `readNamespacedConfig`, parse `section.synthesisLanguage` as a non-empty trimmed string:
  ```ts
  const lang = section.synthesisLanguage;
  if (typeof lang === "string" && lang.trim()) out.synthesisLanguage = lang.trim();
  ```
- [ ] Run `pnpm typecheck` — confirm no errors
- [ ] Commit: `feat: add synthesisLanguage config field`

### Task 2: Wire `synthesisLanguage` into ingest worker

**Files:**
- Modify: `extensions/llm-wiki/lib/ingest-worker.ts`

- [ ] Add `synthesisLanguage?: string` to `RunIngestSynthesisArgs` interface
- [ ] In `runIngestSynthesis`, after destructuring args, build the system prompt:
  ```ts
  const languageInstruction = synthesisLanguage
    ? `\n\nWrite all generated narrative content in ${synthesisLanguage}. Preserve product names, repository names, APIs, paths, commands, code, field names, and technical identifiers in their original form.`
    : "";
  const systemPrompt = INGEST_SYSTEM + languageInstruction;
  ```
- [ ] Pass `systemPrompt` (instead of `INGEST_SYSTEM`) to `runSubAgent`
- [ ] Run `pnpm typecheck` — confirm no errors
- [ ] Commit: `feat: inject synthesisLanguage into ingest system prompt`

### Task 3: Pass `synthesisLanguage` from wiki_ingest tool

**Files:**
- Modify: `extensions/llm-wiki/lib/tools.ts`

- [ ] In the `wiki_ingest` tool's background synthesis block (around line 409), pass `synthesisLanguage` to `runIngestSynthesis`:
  ```ts
  const committed = await runIngestSynthesis({
    model: resolved.model as Parameters<typeof runIngestSynthesis>[0]["model"],
    apiKey: resolved.apiKey,
    headers: resolved.headers,
    paths,
    sourceId: s.id,
    manifest: s.manifest,
    extracted: s.extracted,
    synthesisLanguage: runtime.config.synthesisLanguage,
  });
  ```
- [ ] Run `pnpm typecheck` — confirm no errors
- [ ] Run `pnpm test` — confirm existing tests pass
- [ ] Commit: `feat: wire synthesisLanguage through wiki_ingest tool`

### Task 4: Add unit test for synthesis language injection

**Files:**
- Create: `extensions/llm-wiki/test/ingest-worker-synthesis-language.test.ts`

- [ ] Write a focused test: verify that when `synthesisLanguage` is set, the language instruction is appended to the system prompt
  - Mock `runSubAgent` or inspect the constructed prompt
  - Assert the instruction contains the configured language tag and the preservation clause
- [ ] Run `pnpm test` — confirm test passes
- [ ] Commit: `test: verify synthesisLanguage injection`

### Task 5: Update documentation

**Files:**
- Modify: `docs/configuration.md`

- [ ] Add a section for `synthesisLanguage` under the `llm-wiki` config docs:
  - Description: language for background ingest synthesis narrative content
  - Type: BCP 47 language tag (string)
  - Default: undefined (English synthesis)
  - Example JSON snippet
- [ ] Commit: `docs: document synthesisLanguage config`

### Task 6: Final verification

- [ ] Run `pnpm lint` — confirm no Biome issues
- [ ] Run `pnpm test` — confirm all tests pass
- [ ] Run `pnpm typecheck` — confirm no TypeScript errors
- [ ] Commit: `ci: verify synthesisLanguage implementation`
