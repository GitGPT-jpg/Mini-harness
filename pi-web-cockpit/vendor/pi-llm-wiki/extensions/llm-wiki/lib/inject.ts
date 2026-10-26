/**
 * System-prompt context injection primitives (issues #87, #92).
 *
 * The `before_agent_start` hook augments the chained system prompt with a
 * visible wiki-status footer. This module isolates that append so it can be
 * unit-tested for idempotency — a turn that aborts (network error / ESC) and is
 * retried can carry the prior injection forward, and a naive append stacks the
 * footer 2x, 3x, ...
 *
 * It also owns the cache-safety split (issue #92): VOLATILE per-turn context
 * (recall results, one-time topic-inference directive) must never enter the
 * system prompt — that is the provider's primary cache prefix, so per-turn
 * variation there forces a full cache miss every turn. Volatile content is
 * routed into a tail conversation message instead. `buildAgentStartInjection`
 * is the single, pure decision point for that split.
 */

/** The always-injected wiki-status footer (sans surrounding whitespace). */
export const WIKI_STATUS_BLOCK =
  "<wiki_status>LLM Wiki active — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>";

/**
 * Append the wiki-status footer to a system prompt — idempotently (issue #87).
 *
 * Strips any already-present footer (with its leading blank line) before
 * appending exactly one. This makes the injection safe across aborted/retried
 * agent starts that carry the prior injection forward in the chained system
 * prompt, so the footer never stacks (2x, 3x, ...).
 * See test/inject-idempotent.test.ts.
 */
export function appendWikiStatus(systemPrompt: string): string {
  const base = systemPrompt.split(`\n\n${WIKI_STATUS_BLOCK}`).join("");
  return `${base}\n\n${WIKI_STATUS_BLOCK}`;
}

/** Normalize upstream Pi and OMP system-prompt representations. */
export function normalizeSystemPrompt(
  systemPrompt: string | readonly string[] | null | undefined,
): string {
  if (Array.isArray(systemPrompt)) return systemPrompt.join("\n\n");
  return typeof systemPrompt === "string" ? systemPrompt : "";
}

/** customType of the hidden tail message carrying volatile per-turn context. */
export const WIKI_RECALL_MESSAGE_TYPE = "wiki-recall-context";

/** A hidden, LLM-visible tail message carrying volatile per-turn wiki context. */
export interface WikiRecallMessage {
  customType: typeof WIKI_RECALL_MESSAGE_TYPE;
  content: string;
  display: false;
}

/** Result of the cache-safe split for one `before_agent_start` turn. */
export interface AgentStartInjection {
  /**
   * The system prompt to return. ONLY ever the base plus the static footer —
   * never any volatile content — so it is byte-identical turn over turn and
   * the provider's prompt cache stays warm (issue #92).
   */
  systemPrompt: string;
  /** Volatile blocks, delivered as a tail message. Omitted when empty. */
  message?: WikiRecallMessage;
}

/**
 * Split a turn's injection into a cache-stable system prompt and a volatile
 * tail message (issue #92).
 *
 * - `systemPrompt` is always `appendWikiStatus(baseSystemPrompt)` — the static
 *   footer only. It carries NONE of `dynamicBlocks`, so it does not vary with
 *   recall results and never breaks the provider cache prefix.
 * - `dynamicBlocks` (recall context, topic-inference directive, ...) are
 *   trimmed, emptied entries dropped, and joined with a blank line into the
 *   message body. When nothing survives, no message is emitted.
 *
 * Pure and side-effect free — see test/agent-start-injection.test.ts.
 */
export function buildAgentStartInjection(
  baseSystemPrompt: string | readonly string[] | null | undefined,
  dynamicBlocks: Array<string | undefined>,
): AgentStartInjection {
  const systemPrompt = appendWikiStatus(normalizeSystemPrompt(baseSystemPrompt));
  const content = dynamicBlocks
    .map((b) => b?.trim())
    .filter((b): b is string => Boolean(b))
    .join("\n\n");
  if (!content) return { systemPrompt };
  return {
    systemPrompt,
    message: { customType: WIKI_RECALL_MESSAGE_TYPE, content, display: false },
  };
}
