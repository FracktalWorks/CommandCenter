/**
 * tokenCount.ts — lightweight token estimation for context-window tracking.
 *
 * Uses a 4-chars-per-token heuristic (standard BPE approximation).
 * No WASM/tiktoken dependency — runs purely in the browser.
 */

export interface ContextUsage {
  /** Estimated tokens used by the current conversation */
  usedTokens: number;
  /** Model's total context window in tokens */
  totalTokens: number;
  /** Percentage used (0–100, capped) */
  pct: number;
}

/**
 * Known context window sizes by model ID substring.
 * Keys are matched with String.includes() so partial names work
 * (e.g. "claude-sonnet" matches "claude-sonnet-4.6").
 */
const CONTEXT_LIMITS: [string, number][] = [
  // Claude
  ["claude-opus-4",           200_000],
  ["claude-sonnet-4",         200_000],
  ["claude-haiku",            200_000],
  ["claude-3-5-sonnet",       200_000],
  ["claude-3-7-sonnet",       200_000],
  ["claude",                  200_000],
  // GPT-4 / OpenAI
  ["gpt-4.1",               1_000_000],
  ["gpt-4o",                  128_000],
  ["gpt-4-turbo",             128_000],
  ["gpt-4",                     8_192],
  ["o3",                      200_000],
  ["o1",                      200_000],
  ["gpt-3.5",                  16_385],
  // Gemini
  ["gemini-2.5-pro",        1_000_000],
  ["gemini-2.5-flash",      1_000_000],
  ["gemini-2.0-flash",      1_000_000],
  ["gemini",                  128_000],
  // DeepSeek
  ["deepseek-r1",             128_000],
  ["deepseek-v3",             128_000],
  ["deepseek-chat",            64_000],
  ["deepseek",                 64_000],
  // LiteLLM tiers (conservative)
  ["tier-fast",                32_000],
  ["tier-balanced",           128_000],
  ["tier-powerful",           200_000],
  // Default / auto
  ["auto",                    128_000],
];

export function getContextLimit(modelId: string): number {
  const lower = modelId.toLowerCase();
  for (const [key, limit] of CONTEXT_LIMITS) {
    if (lower.includes(key)) return limit;
  }
  return 32_000; // safe fallback
}

/**
 * Estimate token usage from the conversation messages and optional system
 * context.  Returns {usedTokens, totalTokens, pct}.
 */
export function computeContextUsage(
  messages: { role: string; content: string }[],
  modelId: string,
  systemContext?: string,
): ContextUsage {
  const totalTokens = getContextLimit(modelId);

  // Count characters across all messages (4 chars ≈ 1 token)
  let usedChars = 0;
  for (const m of messages) {
    usedChars += (m.content?.length ?? 0) + 20; // ~20-char overhead per message turn
  }
  if (systemContext) usedChars += systemContext.length;

  // Add a base overhead for the agent's system prompt / instructions (~2k tokens)
  const baseOverheadTokens = 2_000;
  const usedTokens = Math.min(
    Math.ceil(usedChars / 4) + baseOverheadTokens,
    totalTokens,
  );

  return {
    usedTokens,
    totalTokens,
    pct: Math.min(100, Math.round((usedTokens / totalTokens) * 100)),
  };
}

/** Format a token count for tooltip display (e.g. "18.4k / 128k tokens") */
export function formatTokenCount(used: number, total: number): string {
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `${fmt(used)} / ${fmt(total)} tokens`;
}
