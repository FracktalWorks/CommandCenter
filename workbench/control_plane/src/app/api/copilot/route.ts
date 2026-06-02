import { NextRequest } from "next/server";
import {
  CopilotRuntime,
  BuiltInAgent,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { createOpenAI } from "@ai-sdk/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const litellm = createOpenAI({
  baseURL: process.env.COPILOT_LLM_BASE_URL ?? "http://localhost:4000/v1",
  apiKey:
    process.env.COPILOT_LLM_API_KEY ??
    process.env.LITELLM_MASTER_KEY ??
    "sk-local-dev-change-me",
});

const SYSTEM_PROMPT =
  process.env.COPILOT_SYSTEM_PROMPT ??
  "You are Jannet, a helpful AI assistant for Fracktal Works. " +
  "You have access to real-time company data through the queryCompanyData tool. " +
  "ALWAYS call queryCompanyData whenever the user asks about tasks, projects, " +
  "ClickUp, Zoho, CRM, deals, contacts, clients, team members, work status, " +
  "open items, progress, or anything related to the company's operations. " +
  "Never refuse to look up company information — always call the tool first.";

const builtInAgent = new BuiltInAgent({
  // Use .chat() to force Chat Completions path (/v1/chat/completions).
  // @ai-sdk/openai v3's default provider() uses the Responses API (/v1/responses)
  // which LiteLLM doesn't implement — causing "text part X not found" crashes.
  model: litellm.chat(process.env.COPILOT_MODEL ?? "tier2-sonnet"),
  prompt: SYSTEM_PROMPT,
});

const runtimeInst = new CopilotRuntime({ agents: { default: builtInAgent } });

const handler = createCopilotRuntimeHandler({
  runtime: runtimeInst,
  cors: true,
});

// Root-level handler — v2 client calls sub-paths (/info, /agent/:id/run) via
// the [...slug] catch-all route. This handles any direct GET/POST to /api/copilot.
export async function GET(request: NextRequest) {
  return handler(request);
}

export async function POST(request: NextRequest) {
  return handler(request);
}