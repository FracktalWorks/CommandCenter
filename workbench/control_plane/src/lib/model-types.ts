// Shared types and constants for the Models settings page.
// Extracted from settings/models/page.tsx to keep components focused.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TierInfo {
  tier_name: string;
  tier_id: string;
  label: string;
  description: string;
  model: string;
  provider: string;
  provider_configured: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  env_var: string;
  models: string[];
}

export interface LLMConfig {
  tiers: TierInfo[];
  providers: ProviderInfo[];
  litellm_ui_url: string;
}

export interface TestResult {
  success: boolean;
  response: string;
  latency_ms: number;
}

/** A model that has been enabled by the user via Settings → Models. */
export interface EnabledModel {
  id: string;
  label: string;
  provider: string;
  group: string;
}

/** @deprecated Use EnabledModel */
export type CustomModel = EnabledModel;

export interface VisibleModel {
  id: string;
  label: string;
  group: string;
}

/** Model with capability metadata returned by /api/settings/llm/provider-models */
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  vision: boolean;
  audio: boolean;
  reasoning: boolean;
  context_window: number;
  max_output: number;
  desc: string;
}

// ---------------------------------------------------------------------------
// Provider colour map
// ---------------------------------------------------------------------------

export const PROVIDER_COLOURS: Record<string, string> = {
  gemini:     "bg-blue-500/10 text-blue-600 border-blue-500/30",
  openai:     "bg-green-500/10 text-green-600 border-green-500/30",
  anthropic:  "bg-orange-500/10 text-orange-600 border-orange-500/30",
  openrouter: "bg-rose-500/10 text-rose-600 border-rose-500/30",
  github:     "bg-sky-500/10 text-sky-600 border-sky-500/30",
  deepseek:   "bg-cyan-500/10 text-cyan-600 border-cyan-500/30",
  groq:       "bg-yellow-500/10 text-yellow-600 border-yellow-500/30",
  mistral:    "bg-indigo-500/10 text-indigo-600 border-indigo-500/30",
  together:   "bg-teal-500/10 text-teal-600 border-teal-500/30",
  ollama:     "bg-violet-500/10 text-violet-600 border-violet-500/30",
  vllm:       "bg-violet-500/10 text-violet-600 border-violet-500/30",
  unknown:    "bg-secondary text-muted-foreground border-border",
};

export const PROVIDER_ICONS: Record<string, string> = {
  gemini:     "G",
  openai:     "⬡",
  anthropic:  "◆",
  openrouter: "⊕",
  github:     "✦",
  deepseek:   "🐋",
  groq:       "⚡",
  mistral:    "🌪",
  together:   "🤝",
  ollama:     "🦙",
  vllm:       "⚡",
};

// ---------------------------------------------------------------------------
// Provider setup guides
// ---------------------------------------------------------------------------

export interface ProviderGuide {
  description: string;
  setup_url: string;
  docs_url: string;
  instructions: string[];
}

export const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  gemini: {
    description: "Google's Gemini model family — powers all three tiers by default.",
    setup_url: "https://aistudio.google.com/apikey",
    docs_url: "https://ai.google.dev/gemini-api/docs/models",
    instructions: [
      "Go to Google AI Studio → Get API key.",
      "Create a new key (free tier available, no credit card required).",
      "Copy the key — it starts with 'AIza…'.",
    ],
  },
  anthropic: {
    description: "Direct access to Claude models (Sonnet, Haiku, Opus).",
    setup_url: "https://console.anthropic.com/settings/keys",
    docs_url: "https://docs.anthropic.com/en/api/getting-started",
    instructions: [
      "Log in to console.anthropic.com.",
      "Navigate to API Keys → Create Key.",
      "Copy the key — it starts with 'sk-ant-…'.",
    ],
  },
  openrouter: {
    description: "200+ models via one key — Claude, GPT, Gemini, Llama, DeepSeek and more.",
    setup_url: "https://openrouter.ai/settings/keys",
    docs_url: "https://openrouter.ai/docs",
    instructions: [
      "Create a free account at openrouter.ai.",
      "Go to Settings → Keys → Create Key.",
      "Copy the key — it starts with 'sk-or-…'.",
      "Add credits if you want to use paid models (free tier covers some).",
    ],
  },
  openai: {
    description: "OpenAI GPT-4o, o3-mini, and other models.",
    setup_url: "https://platform.openai.com/api-keys",
    docs_url: "https://platform.openai.com/docs/models",
    instructions: [
      "Log in to platform.openai.com.",
      "Navigate to API Keys → Create new secret key.",
      "Copy the key — it starts with 'sk-…'.",
      "Ensure billing is set up in Settings → Billing.",
    ],
  },
  github: {
    description: "GitHub Copilot models — GPT-4o, Claude Sonnet, o3-mini at no extra cost.",
    setup_url: "https://github.com/settings/tokens",
    docs_url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    instructions: [
      "Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens.",
      "Create a new token with no specific repository access.",
      "Under 'Permissions', enable 'Copilot' (read).",
      "Copy the token — it starts with 'github_pat_…'.",
      "Requires an active GitHub Copilot subscription.",
    ],
  },
  groq: {
    description: "Ultra-fast inference for Llama, Mixtral, and Gemma models.",
    setup_url: "https://console.groq.com/keys",
    docs_url: "https://console.groq.com/docs/openai",
    instructions: [
      "Create a free account at console.groq.com.",
      "Navigate to API Keys → Create API Key.",
      "Copy the key — it starts with 'gsk_…'.",
    ],
  },
  mistral: {
    description: "Mistral AI models — Mistral Small, Medium, Large, and Codestral.",
    setup_url: "https://console.mistral.ai/api-keys/",
    docs_url: "https://docs.mistral.ai/api/",
    instructions: [
      "Log in to console.mistral.ai.",
      "Go to API Keys → Create new key.",
      "Copy the key.",
    ],
  },
  deepseek: {
    description: "DeepSeek direct API — DeepSeek-V3 (chat) and DeepSeek-R1 (reasoner) at very competitive pricing.",
    setup_url: "https://platform.deepseek.com/api-keys",
    docs_url: "https://platform.deepseek.com/docs",
    instructions: [
      "Log in to platform.deepseek.com.",
      "Go to API Keys → Create new API key.",
      "Copy the key — it starts with 'sk-…'.",
      "Add balance in the Billing section to enable API access.",
    ],
  },
  together: {
    description: "Together AI — open models at scale (Llama, Qwen, DeepSeek).",
    setup_url: "https://api.together.ai/settings/api-keys",
    docs_url: "https://docs.together.ai/docs/introduction",
    instructions: [
      "Create an account at api.together.ai.",
      "Go to Settings → API Keys.",
      "Copy your key.",
    ],
  },
};
