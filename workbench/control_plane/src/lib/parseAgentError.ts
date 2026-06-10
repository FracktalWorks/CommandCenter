/**
 * Parse raw LLM / agent error strings into user-friendly messages with
 * actionable suggestions.  The raw string is always preserved for copying.
 */

export interface ParsedAgentError {
  /** Short, human-readable title (one line). */
  title: string;
  /** Longer explanation shown below the title. */
  detail: string;
  /** What the user can do to fix this. */
  suggestion: string;
  /** HTTP status code if known (e.g. 429, 401, 400). */
  code: number | null;
  /** Full raw error string for the copy button. */
  raw: string;
}

export function parseAgentError(raw: string): ParsedAgentError {
  const r = raw;

  // ── 429 Rate Limit ────────────────────────────────────────────────────────
  if (r.includes("429") || r.toLowerCase().includes("ratelimit") || r.toLowerCase().includes("rate_limit") || r.toLowerCase().includes("rate-limit")) {
    const retryMatch = r.match(/retry_after_seconds['":\s]+(\d+)/i) || r.match(/"Retry-After":\s*"(\d+)"/i);
    const retryAfter = retryMatch ? parseInt(retryMatch[1], 10) : null;

    const providerMatch = r.match(/provider_name['": ]+([^'"}\s,]+)/i);
    const provider = providerMatch ? providerMatch[1] : null;

    const modelMatch = r.match(/model['"=: ]+([^\s'"}\],]+:free)/i) || r.match(/"([^"]+:free)\s+is\s+temporarily/i);
    const isFreeModel = modelMatch !== null || r.includes(":free");

    return {
      title: "Rate limit reached",
      detail: [
        provider ? `The upstream provider (${provider}) is rate-limiting this model.` : "The model provider is rate-limiting this request.",
        retryAfter ? `Retry window: ${retryAfter} seconds.` : null,
      ].filter(Boolean).join(" "),
      suggestion: isFreeModel
        ? "Free-tier models have very low shared rate limits. Try: (1) wait ~30s and retry, (2) add your own provider key at openrouter.ai/settings/integrations for dedicated limits, or (3) switch to a Groq model (groq/llama-3.3-70b-versatile) which has a generous free tier."
        : "Wait a moment and retry. If this persists, the provider may be under load. Consider switching to a different model or adding credits.",
      code: 429,
      raw,
    };
  }

  // ── 401 Unauthorized ──────────────────────────────────────────────────────
  if (r.includes("401") || r.toLowerCase().includes("authorization error") || r.toLowerCase().includes("unauthorized") || r.includes("No cookie auth credentials") || r.includes("api_key")) {
    const providerMatch = r.match(/provider['":\s]+([a-zA-Z]+)/i);
    return {
      title: "Authentication failed",
      detail: "The API key for this model provider is missing or invalid.",
      suggestion: "Go to Settings → Models and re-enter the API key for this provider. After saving, the key is injected into the gateway automatically.",
      code: 401,
      raw,
    };
  }

  // ── 402 Payment Required ──────────────────────────────────────────────────
  if (r.includes("402") || r.toLowerCase().includes("payment required") || r.toLowerCase().includes("credits") || r.toLowerCase().includes("depleted") || r.toLowerCase().includes("billing")) {
    return {
      title: "Insufficient credits",
      detail: "Your account balance or credits with this provider are depleted.",
      suggestion: "Top up credits on the provider's website (e.g. openrouter.ai/credits or aistudio.google.com), then retry. For free-tier models, consider switching to a model with more free capacity.",
      code: 402,
      raw,
    };
  }

  // ── 400 Bad Request / Invalid Model ──────────────────────────────────────
  if (r.includes("400") || r.toLowerCase().includes("invalid model") || r.toLowerCase().includes("not found") || r.includes("Invalid model name")) {
    const modelMatch = r.match(/model[='":\s]+([^\s'"}\],]+)/i);
    const model = modelMatch ? modelMatch[1] : null;
    return {
      title: "Invalid model",
      detail: model ? `Model "${model}" was not recognised by the provider.` : "The model ID sent to the provider was not recognised.",
      suggestion: "Check the model ID in your custom models list (Settings → Models). OpenRouter model IDs should match exactly what is shown at openrouter.ai/models (e.g. meta-llama/llama-3.3-70b-instruct:free).",
      code: 400,
      raw,
    };
  }

  // ── 404 Model Not Found ───────────────────────────────────────────────────
  if (r.includes("404") || r.toLowerCase().includes("not found")) {
    return {
      title: "Model not found",
      detail: "The requested model does not exist on the provider.",
      suggestion: "Verify the exact model ID at the provider's model list (e.g. openrouter.ai/models). Free-tier model IDs may have changed — check for the current :free slug.",
      code: 404,
      raw,
    };
  }

  // ── Context / token length ────────────────────────────────────────────────
  if (r.toLowerCase().includes("context") || r.toLowerCase().includes("token") || r.toLowerCase().includes("max_tokens") || r.toLowerCase().includes("length")) {
    return {
      title: "Context length exceeded",
      detail: "The conversation or request is too long for this model's context window.",
      suggestion: "Clear the chat history and start a fresh conversation. Consider using a model with a longer context window (e.g. Gemini 2.5 Flash with 1M context, or Kimi K2.6 with 128K).",
      code: null,
      raw,
    };
  }

  // ── Network / connection ──────────────────────────────────────────────────
  if (r.toLowerCase().includes("timeout") || r.toLowerCase().includes("connection") || r.toLowerCase().includes("unreachable") || r.toLowerCase().includes("ECONNREFUSED")) {
    return {
      title: "Connection failed",
      detail: "The request to the model provider timed out or was refused.",
      suggestion: "Check that the gateway is running (http://localhost:8080/health). If using a custom base URL, verify it is reachable.",
      code: null,
      raw,
    };
  }

  // ── Copilot session error ─────────────────────────────────────────────────
  if (r.toLowerCase().includes("github copilot session error") || r.toLowerCase().includes("/login")) {
    return {
      title: "GitHub Copilot session error",
      detail: "The GitHub Copilot CLI session failed to authenticate.",
      suggestion: "Run `copilot auth login` in a terminal to re-authenticate the Copilot CLI, then retry.",
      code: null,
      raw,
    };
  }

  // ── BYOK agent build failed ───────────────────────────────────────────────
  if (r.toLowerCase().includes("byok agent build failed")) {
    return {
      title: "BYOK agent setup failed",
      detail: "Failed to build the LiteLLM-backed agent for this model.",
      suggestion: "Check that agent-framework and agent-framework-openai packages are installed in the venv. Restart the gateway.",
      code: null,
      raw,
    };
  }

  // ── Generic fallback ─────────────────────────────────────────────────────
  // Extract a short first line to use as title
  const firstLine = raw.split("\n")[0].slice(0, 120);
  return {
    title: "Agent error",
    detail: firstLine,
    suggestion: "Check the gateway logs for details. You can copy the full error below.",
    code: null,
    raw,
  };
}
