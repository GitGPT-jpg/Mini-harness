# Auto-Bootstrap Plan

## Changes (3 files)

### 1. `extensions/llm-wiki/index.ts`

**session_start hook** — Show correct status based on vault existence:
```typescript
pi.on("session_start", async (_event, ctx) => {
  const paths = resolveVaultPaths(process.cwd());
  if (!existsSync(join(paths.dotWiki, "config.json"))) {
    ctx.ui.setStatus("llm-wiki", "📝 No wiki — call wiki_bootstrap to enable");
    return;
  }
  ctx.ui.setStatus("llm-wiki", "🧠 LLM Wiki (12 tools, auto-recall active)");
});
```

**before_agent_start hook** — When no wiki exists on first turn, inject a system prompt hint so the LLM knows to suggest bootstrapping:
```typescript
pi.on("before_agent_start", async (event, _ctx) => {
  const paths = resolveVaultPaths(process.cwd());
  if (!existsSync(join(paths.dotWiki, "config.json"))) {
    return {
      systemPrompt: `${event.systemPrompt}\n\n📝 No LLM Wiki found in this directory. On your first response, use ask_user to offer the user creating one via wiki_bootstrap. After suggesting once, do not repeat.`
    };
  }
  // ... existing recall logic unchanged
});
```

### 2. `extensions/llm-wiki/lib/recall.ts`

**wiki_recall tool** — Improve error message when no vault exists to hint at bootstrap:
```typescript
// Current: "No wiki vault found at this location. Initialize one with wiki_bootstrap first."
// Keep as-is but add isError flag for model to react
```

### 3. `skills/llm-wiki/SKILL.md`

Add a section about what to do when no wiki exists — tell the model to proactively suggest bootstrapping using `ask_user`.

## Not in scope (separate issue)

- Migration script shipping — bcdiaconu's feedback from #22, needs its own focused PR
