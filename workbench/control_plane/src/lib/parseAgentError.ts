/**
 * Parse raw LLM / agent error strings into user-friendly messages with
 * actionable suggestions.  The raw string is always preserved for copying.
 *
 * Matching strategy (ordered — first match wins):
 *   1. BYOK / Copilot session / specific known patterns
 *   2. HTTP status codes via structured patterns (status_code, HTTP NNN)
 *   3. Provider-specific error codes (insufficient_quota, invalid_api_key, etc.)
 *   4. Keyword heuristics for connection / token / context issues
 *   5. Generic fallback that always shows the raw error first line
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

/** Extract an HTTP status code from a structured JSON error or "HTTP NNN" prefix. */
function extractHttpCode(r: string): number | null {
  // Structured: "status_code": 429  or  "status": 402  or  "code": 401
  const sm = r.match(/"(?:status_code|status|code)"\s*:\s*(\d{3})/i);
  if (sm) return parseInt(sm[1], 10);
  // HTTP prefix: "HTTP 429" or "Error 402: ..."
  const hm = r.match(/\bHTTP\s*(\d{3})\b/i) || r.match(/\bError\s*(\d{3})\b/i);
  if (hm) return parseInt(hm[1], 10);
  // Gateway-surfaced upstream form: "upstream completion failed (429): ..."
  const gm = r.match(/completion failed \((\d{3})\)/i);
  if (gm) return parseInt(gm[1], 10);
  return null;
}

/**
 * Whether a GitHub Copilot session error is genuinely an AUTHENTICATION
 * problem (expired/missing token, sign-in required) rather than a downstream
 * model/provider completion failure surfaced through the Copilot CLI.
 *
 * A `CAPIError: upstream completion …` is a model-provider error (rate limit,
 * bad provider key, context length) — telling the user to `copilot auth login`
 * for it sends them down the wrong path, so those must NOT be treated as auth.
 */
function isCopilotAuthError(r: string): boolean {
  const lc = r.toLowerCase();
  // A completion/provider failure is never a Copilot auth problem.
  if (lc.includes("upstream completion") || lc.includes("capierror")) return false;
  return (
    lc.includes("/login") ||
    lc.includes("auth login") ||
    lc.includes("not authenticated") ||
    lc.includes("unauthenticated") ||
    lc.includes("sign in") ||
    lc.includes("signed out") ||
    lc.includes("unauthorized") ||
    lc.includes("401") ||
    (lc.includes("token") && (lc.includes("expired") || lc.includes("invalid") || lc.includes("scope")))
  );
}

/** Check if the error is specifically about billing/payment/credits depletion. */
function isBillingError(r: string): boolean {
  const lc = r.toLowerCase();
  // Specific billing indicators (NOT the generic word "credit" alone)
  return (
    lc.includes("insufficient_quota") ||
    lc.includes("payment required") ||
    lc.includes("insufficient balance") ||
    lc.includes("out of credits") ||
    lc.includes("credits exhausted") ||
    lc.includes("add credits") ||
    lc.includes("purchase credits") ||
    lc.includes("billing account") ||
    lc.includes("quota exceeded") && lc.includes("billing") ||
    lc.includes("top.up your account") ||
    lc.includes("upgrade your plan") ||
    lc.includes("free quota") && lc.includes("exceeded")
  );
}

/** Check if the error is specifically a model-not-found / invalid-model error. */
function isModelError(r: string): boolean {
  const lc = r.toLowerCase();
  return (
    lc.includes("invalid model") ||
    lc.includes("model not found") ||
    lc.includes("model_not_found") ||
    lc.includes("no such model") ||
    lc.includes("unknown model") ||
    lc.includes("model does not exist") ||
    lc.includes("could not find model") ||
    lc.includes("invalid_model")
  );
}

/** Check if the error is an authentication / API key error. */
function isAuthError(r: string): boolean {
  const lc = r.toLowerCase();
  return (
    lc.includes("invalid api key") ||
    lc.includes("invalid_api_key") ||
    lc.includes("incorrect api key") ||
    lc.includes("api key not valid") ||
    lc.includes("no api key") ||
    lc.includes("authentication failed") ||
    lc.includes("unauthorized") ||
    lc.includes("no cookie auth") ||
    lc.includes("authorization error") && !lc.includes("rate")
  );
}

export function parseAgentError(raw: string): ParsedAgentError {
  const r = raw;
  const lc = r.toLowerCase();
  const httpCode = extractHttpCode(r);

  // ── 1. Known specific patterns (BYOK, Copilot session) ───────────────────

  if (lc.includes("byok agent build failed") || lc.includes("byok agent setup failed")) {
    return {
      title: "BYOK agent setup failed",
      detail: "Failed to build the LiteLLM-backed agent for this model.",
      suggestion: "Check the model ID is correct and the provider key is configured in Settings → Models. Restart the gateway if the issue persists.",
      code: null,
      raw,
    };
  }

  // Only claim an AUTH problem when the Copilot session error genuinely is one.
  // A session error that merely wraps a model/provider completion failure
  // (`CAPIError: upstream completion …`) falls through to the HTTP/keyword
  // matchers below so the real cause (rate limit, bad key, context length) is
  // shown — otherwise every provider hiccup was mislabeled "run copilot auth login".
  if (
    (lc.includes("github copilot session error") || (lc.includes("/login") && lc.includes("copilot"))) &&
    isCopilotAuthError(r)
  ) {
    return {
      title: "GitHub Copilot session error",
      detail: "The GitHub Copilot CLI session failed to authenticate or was rejected.",
      suggestion: "Run `copilot auth login` on the VPS to re-authenticate. Check that GITHUB_TOKEN has the `copilot` scope and hasn't expired.",
      code: null,
      raw,
    };
  }

  // ── 2. Rate limit (HTTP 429 or provider-specific rate-limit codes) ───────

  if (httpCode === 429 || lc.includes("rate_limit") || lc.includes("rate-limit") || lc.includes("ratelimit")) {
    const retryMatch = r.match(/retry_after_seconds['":\s]+(\d+)/i) || r.match(/"Retry-After":\s*"(\d+)"/i);
    const retryAfter = retryMatch ? parseInt(retryMatch[1], 10) : null;

    const providerMatch = r.match(/provider_name['": ]+([^'"}\s,]+)/i);
    const provider = providerMatch ? providerMatch[1] : null;

    const isFreeModel = lc.includes(":free");

    return {
      title: "Rate limit reached",
      detail: [
        provider ? `The upstream provider (${provider}) is rate-limiting this model.` : "The model provider is rate-limiting this request.",
        retryAfter ? `Retry window: ~${retryAfter} seconds.` : null,
      ].filter(Boolean).join(" "),
      suggestion: isFreeModel
        ? "Free-tier models have very low shared rate limits. Try: (1) wait ~30s and retry, (2) add your own provider key (Settings → Models), or (3) switch to a Groq model (groq/llama-3.3-70b-versatile) which has a generous free tier."
        : "Wait a moment and retry. If this persists, consider switching to a different model or adding your own provider key.",
      code: 429,
      raw,
    };
  }

  // ── 3. Billing / payment (HTTP 402 or specific billing phrases) ──────────

  if (httpCode === 402 || isBillingError(r)) {
    return {
      title: "Insufficient credits or quota",
      detail: "Your account with this model provider has run out of credits or hit a billing limit.",
      suggestion: "Top up credits on the provider's website (e.g. openrouter.ai/credits or aistudio.google.com). For free models, switch to a different provider or add a paid API key.",
      code: 402,
      raw,
    };
  }

  // ── 4. Authentication (HTTP 401 or specific auth phrases) ─────────────────

  if (httpCode === 401 || isAuthError(r)) {
    return {
      title: "Authentication failed",
      detail: "The API key for this model provider is missing, invalid, or expired.",
      suggestion: "Go to Settings → Models and re-enter the API key for this provider. After saving, the key is injected into the gateway automatically.",
      code: 401,
      raw,
    };
  }

  // ── 5. Invalid / missing model (HTTP 400/404 + model-specific phrases) ───

  if ((httpCode === 400 || httpCode === 404) && isModelError(r)) {
    const modelMatch = r.match(/model[='":\s]+([^\s'"}\],]+)/i);
    const model = modelMatch ? modelMatch[1] : null;
    return {
      title: "Model not found",
      detail: model ? `Model "${model}" was not recognised by the provider.` : "The model ID sent to the provider was not recognised.",
      suggestion: "Check the model ID in your custom models list (Settings → Models). OpenRouter model IDs should match exactly what is shown at openrouter.ai/models.",
      code: httpCode,
      raw,
    };
  }

  // ── 6. Generic HTTP 400 / 404 fallback ───────────────────────────────────

  if (httpCode === 400) {
    return {
      title: "Bad request (400)",
      detail: "The model provider rejected the request. This may be a model compatibility issue or malformed request.",
      suggestion: "Check the model ID and try a different model. If using a custom model, verify its exact ID at the provider's model list.",
      code: 400,
      raw,
    };
  }

  if (httpCode === 404) {
    return {
      title: "Not found (404)",
      detail: "The requested model or endpoint was not found on the provider.",
      suggestion: "Verify the model ID is correct and still available. Some models are retired or renamed by providers.",
      code: 404,
      raw,
    };
  }

  // ── 7. Generic HTTP errors ───────────────────────────────────────────────

  if (httpCode === 500 || httpCode === 502 || httpCode === 503) {
    return {
      title: `Provider error (${httpCode})`,
      detail: "The model provider's servers returned an internal error.",
      suggestion: "This is usually temporary. Wait a minute and retry. If it persists, the provider may be experiencing an outage.",
      code: httpCode,
      raw,
    };
  }

  if (httpCode === 403) {
    return {
      title: "Access denied (403)",
      detail: "The model provider rejected the request. Your account may not have access to this model or endpoint.",
      suggestion: "Check that your account/API key has access to this model. Some models require explicit opt-in or a paid tier.",
      code: 403,
      raw,
    };
  }

  if (httpCode !== null) {
    return {
      title: `HTTP error ${httpCode}`,
      detail: `The model provider returned HTTP status ${httpCode}.`,
      suggestion: "Check the raw error for details. If this persists, try a different model or provider.",
      code: httpCode,
      raw,
    };
  }

  // ── 8. Context / token length ────────────────────────────────────────────

  if (lc.includes("context length") || lc.includes("max_tokens") || lc.includes("token limit") || lc.includes("too many tokens") || lc.includes("context_window")) {
    return {
      title: "Context length exceeded",
      detail: "The conversation or request is too long for this model's context window.",
      suggestion: "Clear the chat history and start a fresh conversation. Consider using a model with a longer context window (e.g. Gemini 2.5 Flash with 1M context).",
      code: null,
      raw,
    };
  }

  // ── 9. Network / connection ──────────────────────────────────────────────

  if (lc.includes("timeout") || lc.includes("econnrefused") || lc.includes("connection refused") || lc.includes("network") && lc.includes("unreachable")) {
    return {
      title: "Connection failed",
      detail: "The request to the model provider timed out or was refused.",
      suggestion: "Check that the gateway is running (http://localhost:8080/health). If using a custom base URL, verify it is reachable.",
      code: null,
      raw,
    };
  }

  // ── 10. Generic fallback — always show the real error ────────────────────

  const firstLine = raw.split("\n")[0].slice(0, 200);
  return {
    title: "Agent run failed",
    detail: firstLine || "(no error details)",
    suggestion: "The raw error is shown above. Check gateway logs for more context: `sudo journalctl -u acb-gateway -n 50`.",
    code: null,
    raw,
  };
}
