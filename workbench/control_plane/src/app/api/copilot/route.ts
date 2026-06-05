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
// IMPORTANT — three distinct systems; do not conflate:
//   - GitHub Copilot SDK  = python `github-copilot-sdk` package; wraps `gh copilot` CLI;
//                           autonomous execution orchestrator with native tool-calling;
//                           used by /api/agent/chat?mode=copilot (NOT this file)
//   - CopilotKit           = THIS file's library (@copilotkit/react-*, @copilotkit/runtime);
//                           a React UI rendering layer; NOT an orchestrator; NOT GitHub Copilot
//   - LangGraph            = Python workflow library (StateGraph + PostgresSaver);
//                           event-driven background agents; future chat upgrade path
//
// THIS FILE uses CopilotKit's CopilotRuntime with BuiltInAgent (text-only, no tool calling).
// The unified AgentChat.tsx component does NOT use this route for model dispatch; it calls
// /api/agent/chat directly and routes to the GitHub Copilot SDK or LiteLLM from there.
//
//  "builtin" (default)
//    CopilotKit BuiltInAgent → LiteLLM (OpenAI-compat) → LLM
//    Text-only. No tool calling. No orchestration. Fallback path only.
//
//  "langgraph" (upgrade path — set COPILOT_BACKEND=langgraph)
//    CopilotKit LangGraphAgent → FastAPI gateway /agent/langgraph → LangGraph StateGraph
//    Full tool calling via Python nodes; tier-routed models via acb_llm.complete(tier=...);
//    No GitHub Copilot SDK involved in this path either.
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
  prompt: `You are the CommandCenter AI assistant — a helpful, knowledgeable agent for the AI Company Brain platform.
You help users manage their business operations, including tasks, deals, communications, and workflows.
You have access to context about the user's agents, integrations, and data that is injected as readable context.
Answer questions conversationally, help analyse data, draft content, and assist with any task the user describes.
Be concise but thorough. If you lack information to answer, say so clearly.`,
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