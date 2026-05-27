import { NextRequest } from "next/server";
import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Point at the LiteLLM gateway (OpenAI-compatible). One key, many models.
const openai = new OpenAI({
  baseURL: process.env.COPILOT_LLM_BASE_URL ?? "http://localhost:4000/v1",
  apiKey: process.env.COPILOT_LLM_API_KEY ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me",
});

const serviceAdapter = new OpenAIAdapter({
  openai,
  model: process.env.COPILOT_MODEL ?? "tier2-sonnet",
});

const runtimeInst = new CopilotRuntime();

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime: runtimeInst,
    serviceAdapter,
    endpoint: "/api/copilot",
  });
  return handleRequest(req);
};