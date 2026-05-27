import { NextRequest } from "next/server";
import {
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { createOpenAI } from "@ai-sdk/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Point at the LiteLLM gateway (OpenAI-compatible) using the Vercel AI SDK.
// The old OpenAIAdapter breaks with LiteLLM in v1.57+; BuiltInAgent + createOpenAI
// routes through the AI SDK which handles the streaming format correctly.
const litellm = createOpenAI({
  baseURL: process.env.COPILOT_LLM_BASE_URL ?? "http://localhost:4000/v1",
  apiKey: process.env.COPILOT_LLM_API_KEY ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me",
});

const builtInAgent = new BuiltInAgent({
  model: litellm(process.env.COPILOT_MODEL ?? "tier2-sonnet"),
});

const runtimeInst = new CopilotRuntime({
  agents: { default: builtInAgent },
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime: runtimeInst,
    endpoint: "/api/copilot",
  });
  return handleRequest(req);
};