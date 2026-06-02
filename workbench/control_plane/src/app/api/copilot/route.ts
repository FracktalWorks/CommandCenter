import { NextRequest } from "next/server";
import {
  CopilotRuntime,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { createOpenAI } from "@ai-sdk/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Backend architecture (two modes, toggled by COPILOT_BACKEND env var):
//
//  "builtin" (default)
//    BuiltInAgent → LiteLLM (OpenAI-compat) → LLM
//    Fast to set up; no orchestrator dependency.
//    Memory context is injected by the frontend via useCopilotReadable.
//
//  "langgraph" (upgrade path — set COPILOT_BACKEND=langgraph)
//    LangGraphAgent → FastAPI gateway /agent/run → LangGraph orchestrator
//    → LangGraph StateGraph → OpenHands worker sandboxes (skill execution)
//    Full agentic execution; memory injected into initial LangGraph state.
//    Requires GATEWAY_URL (e.g. http://localhost:8000) to be set.
//
// Memory flow:
//  Chat page fetches Mem0 memories via /api/chat/memories and injects them
//  via useCopilotReadable → CopilotKit forwards as readable context to the
//  active agent (both BuiltInAgent and LangGraphAgent see this context).
//  After each session, the chat page POSTs to /api/chat/memories so Mem0
//  can extract and persist semantic facts from the conversation.
// ---------------------------------------------------------------------------

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

// TODO(langgraph-upgrade): Replace builtInAgent with LangGraphAgent once the
// FastAPI gateway exposes a LangGraph-compatible streaming endpoint:
//
//   import { LangGraphAgent } from "@copilotkit/runtime";
//   const langGraphAgent = new LangGraphAgent({
//     name: "orchestrator",
//     deploymentUrl: process.env.GATEWAY_URL + "/agent/langgraph",
//     // threadId is forwarded from CopilotKitProvider.threadId in the request
//   });
//   const runtimeInst = new CopilotRuntime({ agents: { default: langGraphAgent } });

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