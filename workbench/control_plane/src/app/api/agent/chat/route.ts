/**
 * POST /api/agent/chat
 *
 * Returns a Server-Sent Events stream so the UI can render tokens and
 * tool-call events in real time (mirroring the VS Code Copilot experience).
 *
 * IMPORTANT — Three distinct runtimes; do not conflate:
 *
 *   mode="copilot"   → GitHub Copilot SDK runtime (apps/gateway/routes/copilot_chat.py)
 *                       - CopilotClient wraps `gh copilot` CLI as a subprocess
 *                       - autopilot mode: native tool-calling (shell, file r/w, Python)
 *                       - reads AGENTS.md / .mcp.json from agent workspace
 *                       - on_pre_tool_use / on_post_tool_use hooks emit tool_start/tool_end SSE
 *                       - Auth: GITHUB_TOKEN (direct to api.githubcopilot.com)
 *                              OR BYOK via LiteLLM (session_kwargs["provider"])
 *                       - NOT the same as CopilotKit (the React UI library)
 *
 *   mode="litellm"   → Direct LiteLLM streaming (no orchestration, no tool calling)
 *                       - Raw OpenAI-compatible /chat/completions call
 *                       - Model = tier1/2/3 alias in infra/litellm/config.yaml
 *                       - Used for fast text-only responses
 *
 *   mode="langgraph" → Legacy LangGraph agent runner (batch, no streaming)
 *                       - POST /agent/run on FastAPI gateway
 *                       - Returns single delta+done pair (not streamed)
 *                       - Future: replace with /agent/langgraph streaming endpoint
 *
 * SSE event types:
 *   {"type":"delta",      "content":"…"}
 *   {"type":"reasoning",  "content":"…"}              — model chain-of-thought (reasoning models only)
 *   {"type":"progress",   "name":"…"}                  — tool about to run (live status)
 *   {"type":"tool_start", "id":"…","name":"…","args":{}}
 *   {"type":"tool_end",   "id":"…","name":"…","result":"…","success":bool}
 *   {"type":"done",       "run_id":"…"}
 *   {"type":"error",      "content":"…"}
 */

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  agentName: string;
  message: string;
  messages: ChatMessage[];
  threadId: string;
  mode?: "langgraph" | "copilot" | "litellm";
  /** Copilot SDK model override forwarded to gateway (e.g. "claude-sonnet-4.5"). */
  model?: string;
  /** System-level context (persistent memory / persona) injected as context. */
  context?: string;
}

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const LITELLM_BASE_URL =
  process.env.COPILOT_LLM_BASE_URL ?? process.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
const LITELLM_KEY =
  process.env.LITELLM_MASTER_KEY ?? process.env.GATEWAY_INTERNAL_TOKEN ?? "sk-local-dev-change-me";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me";

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function sseEvent(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Parse an accumulated AG-UI tool-args JSON string into an object for the UI. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    // Streamed args may be incomplete/non-JSON — surface the raw text.
    return { _raw: raw };
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response(
      `data: ${JSON.stringify({ type: "error", content: "Invalid JSON body" })}\n\n`,
      { status: 400, headers: sseHeaders() }
    );
  }

  const { agentName, message, messages, threadId, mode, model, context } = body;
  if (!agentName || !message) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", content: "agentName and message are required" })}\n\n`,
      { status: 400, headers: sseHeaders() }
    );
  }

  // ── LiteLLM path: stream directly from the LiteLLM proxy ──────────────────
  // Routes to LiteLLM tier aliases (tier1/2/3 are cost-optimized tiers).
  // Backend can optionally route tiers through Copilot, Claude, GPT-4, or Gemini
  // (see infra/litellm/config.yaml for current routing).
  if (mode === "litellm") {
    return streamLiteLLM({ message, messages, model, context });
  }

  // ── Copilot/AG-UI path — ORCHESTRATOR ONLY ────────────────────────────────
  // The /copilot/chat endpoint is hardwired at gateway startup to the single
  // built-in orchestrator agent. Named agents (task-manager, sales-assistant,
  // any GitHub-registered agent) must go through /agent/run so the executor
  // can clone the repo, import agents.py, resolve integrations, and run via MAF.
  const ORCHESTRATOR_NAMES = new Set(["orchestrator", "default", "commandcenter", ""]);
  const isOrchestrator = ORCHESTRATOR_NAMES.has(agentName.toLowerCase().trim());

  if (mode === "copilot" && isOrchestrator) {
    let gatewayRes: Response;
    try {
      // AG-UI protocol: the current message must be part of the messages array.
      // Append it after the history so the agent sees the full conversation.
      const agUiMessages = [
        ...(messages ?? []).map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: message },
      ];
      gatewayRes = await fetch(`${GATEWAY_URL}/copilot/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          thread_id: threadId ?? "",
          messages: agUiMessages,
        }),
        signal: AbortSignal.timeout(310_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        `data: ${JSON.stringify({ type: "error", content: `Gateway unreachable: ${msg}` })}\n\n`,
        { status: 502, headers: sseHeaders() }
      );
    }
    if (!gatewayRes.ok || !gatewayRes.body) {
      const text = await gatewayRes.text().catch(() => `status ${gatewayRes.status}`);
      return new Response(
        `data: ${JSON.stringify({ type: "error", content: text })}\n\n`,
        { status: gatewayRes.status, headers: sseHeaders() }
      );
    }
    // Translate AG-UI protocol → {type:"delta"|"tool_start"|"tool_end"|"done"|"error"}
    // so the useAgentChat hook can render tokens and tool-call blocks in real time.
    const agUiBody = gatewayRes.body;
    const translated = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = agUiBody.getReader();
        const decoder = new TextDecoder();
        // tool name lookup: toolCallId → name (needed for tool_end)
        const toolNames: Record<string, string> = {};
        // tool args accumulator: toolCallId → streamed argument JSON string
        const toolArgs: Record<string, string> = {};
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw) continue;
              let ev: Record<string, unknown>;
              try { ev = JSON.parse(raw); } catch { continue; }
              const t = ev.type as string;
              let out: Record<string, unknown> | null = null;
              if (t === "TEXT_MESSAGE_CONTENT") {
                out = { type: "delta", content: ev.delta ?? "" };
              } else if (
                t === "REASONING_MESSAGE_CONTENT" ||
                t === "THINKING_TEXT_MESSAGE_CONTENT"
              ) {
                // Model reasoning / chain-of-thought stream (only emitted by
                // reasoning-capable models — o-series, Claude extended-thinking,
                // Gemini 2.5 thinking). Surfaced live inside the ThinkingContainer.
                out = { type: "reasoning", content: ev.delta ?? "" };
              } else if (t === "TOOL_CALL_START") {
                const name = String(ev.toolCallName ?? ev.tool_call_name ?? "tool");
                toolNames[String(ev.toolCallId ?? "")] = name;
                toolArgs[String(ev.toolCallId ?? "")] = "";
                // Emit a live progress line first so the ThinkingContainer shows
                // activity immediately (before the tool result arrives).
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: "progress", name })}\n\n`
                  )
                );
                out = { type: "tool_start", id: ev.toolCallId, name, args: {} };
              } else if (t === "TOOL_CALL_ARGS") {
                // Accumulate the streamed argument deltas so the tool input is
                // visible in the UI (previously dropped — args showed as empty).
                const id = String(ev.toolCallId ?? "");
                toolArgs[id] = (toolArgs[id] ?? "") + String(ev.delta ?? "");
              } else if (t === "TOOL_CALL_END") {
                out = {
                  type: "tool_end",
                  id: ev.toolCallId,
                  name: toolNames[String(ev.toolCallId ?? "")] ?? "tool",
                  args: parseToolArgs(toolArgs[String(ev.toolCallId ?? "")]),
                  result: ev.result ?? "",
                  success: true,
                };
              } else if (t === "TOOL_CALL_RESULT") {
                out = {
                  type: "tool_end",
                  id: ev.toolCallId,
                  name: toolNames[String(ev.toolCallId ?? "")] ?? "tool",
                  args: parseToolArgs(toolArgs[String(ev.toolCallId ?? "")]),
                  result: ev.content ?? "",
                  success: true,
                };
              } else if (t === "STATE_SNAPSHOT") {
                // AG-UI generative UI: full agent-state object (M2.6).
                out = { type: "state", snapshot: ev.snapshot ?? {} };
              } else if (t === "STATE_DELTA") {
                out = { type: "state_delta", delta: ev.delta ?? [] };
              } else if (t === "CUSTOM") {
                out = { type: "custom", name: ev.name ?? "", value: ev.value ?? null };
              } else if (t === "RUN_FINISHED") {
                out = { type: "done", run_id: ev.runId };

              } else if (t === "RUN_ERROR") {
                out = { type: "error", content: String(ev.message ?? "Agent run error") };
              }
              if (out) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(out)}\n\n`)
                );
              }
            }
          }
        } catch {
          // stream ended early
        } finally {
          controller.close();
        }
      },
    });
    return new Response(translated, { headers: sseHeaders() });
  }

  // ── Executor path: named agents (copilot mode) + langgraph mode ──────────
  // Named agents (copilot mode): route through /agent/run/stream which returns
  // a real AG-UI SSE stream so the UI sees tool events live.
  // Legacy langgraph mode: falls back to batch /agent/run (no streaming).
  if (mode === "copilot" && !isOrchestrator) {
    // /agent/run/stream returns the same AG-UI event format as /copilot/chat.
    // Re-use the exact same translation block already implemented above.
    let streamRes: Response;
    try {
      streamRes = await fetch(`${GATEWAY_URL}/agent/run/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          agent: agentName,
          payload: { mode: "chat", message, messages: messages ?? [] },
          thread_id: threadId ?? undefined,
        }),
        signal: AbortSignal.timeout(310_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        `data: ${JSON.stringify({ type: "error", content: `Gateway unreachable: ${msg}` })}\n\n`,
        { status: 502, headers: sseHeaders() }
      );
    }
    if (!streamRes.ok || !streamRes.body) {
      const text = await streamRes.text().catch(() => `status ${streamRes.status}`);
      return new Response(
        `data: ${JSON.stringify({ type: "error", content: text })}\n\n`,
        { status: streamRes.status, headers: sseHeaders() }
      );
    }
    // Translate AG-UI → frontend SSE (same logic as /copilot/chat above).
    const agUiBody2 = streamRes.body;
    const translated2 = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = agUiBody2.getReader();
        const decoder = new TextDecoder();
        const toolNames2: Record<string, string> = {};
        const toolArgs2: Record<string, string> = {};
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw) continue;
              let ev: Record<string, unknown>;
              try { ev = JSON.parse(raw); } catch { continue; }
              const t = ev.type as string;
              let out: Record<string, unknown> | null = null;
              if (t === "TEXT_MESSAGE_CONTENT") {
                out = { type: "delta", content: ev.delta ?? "" };
              } else if (t === "REASONING_MESSAGE_CONTENT" || t === "THINKING_TEXT_MESSAGE_CONTENT") {
                out = { type: "reasoning", content: ev.delta ?? "" };
              } else if (t === "TOOL_CALL_START") {
                const name = String(ev.toolCallName ?? ev.tool_call_name ?? "tool");
                toolNames2[String(ev.toolCallId ?? "")] = name;
                toolArgs2[String(ev.toolCallId ?? "")] = "";
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: "progress", name })}\n\n`
                  )
                );
                out = { type: "tool_start", id: ev.toolCallId, name, args: {} };
              } else if (t === "TOOL_CALL_ARGS") {
                const id2 = String(ev.toolCallId ?? "");
                toolArgs2[id2] = (toolArgs2[id2] ?? "") + String(ev.delta ?? "");
              } else if (t === "TOOL_CALL_END" || t === "TOOL_CALL_RESULT") {
                const id2 = String(ev.toolCallId ?? "");
                out = {
                  type: "tool_end",
                  id: ev.toolCallId,
                  name: toolNames2[id2] ?? "tool",
                  args: parseToolArgs(toolArgs2[id2]),
                  result: ev.result ?? ev.content ?? "",
                  success: true,
                };
              } else if (t === "STATE_SNAPSHOT") {
                // AG-UI generative UI: full agent-state object (M2.6).
                out = { type: "state", snapshot: ev.snapshot ?? {} };
              } else if (t === "STATE_DELTA") {
                // JSON Patch (RFC 6902) incremental state update.
                out = { type: "state_delta", delta: ev.delta ?? [] };
              } else if (t === "CUSTOM") {
                // Application-defined rich widget event (name + value payload).
                out = { type: "custom", name: ev.name ?? "", value: ev.value ?? null };
              } else if (t === "RUN_FINISHED") {

                out = { type: "done", run_id: ev.runId };
              } else if (t === "RUN_ERROR") {
                out = { type: "error", content: String(ev.message ?? "Agent run error") };
              }
              if (out) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(out)}\n\n`)
                );
              }
            }
          }
        } catch {
          // stream ended early
        } finally {
          controller.close();
        }
      },
    });
    return new Response(translated2, { headers: sseHeaders() });
  }

  // ── Legacy executor path: batch /agent/run (langgraph mode + fallback) ─
  // Used for langgraph mode. Returns a single delta+done SSE pair.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const gatewayRes = await fetch(`${GATEWAY_URL}/agent/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${INTERNAL_TOKEN}`,
          },
          body: JSON.stringify({
            agent: agentName,
            payload: { mode: "chat", message, messages: messages ?? [] },
            thread_id: threadId ?? undefined,
          }),
          signal: AbortSignal.timeout(310_000),
        });

        if (!gatewayRes.ok) {
          const text = await gatewayRes.text().catch(() => `status ${gatewayRes.status}`);
          controller.enqueue(sseEvent({ type: "error", content: `Gateway error: ${text}` }));
          controller.close();
          return;
        }

        const data = (await gatewayRes.json()) as {
          run_id: string;
          agent: string;
          status: string;
          result?: unknown;
          error?: string;
          mutation_pr?: string;
        };

        // Normalise to string
        let content: string;
        if (data.status === "failed") {
          content = data.error
            ? `Agent run failed: ${data.error}${data.mutation_pr ? `\n\nA fix PR has been opened: ${data.mutation_pr}` : ""}`
            : "Agent run failed with an unknown error.";
        } else if (typeof data.result === "string") {
          content = data.result;
        } else if (data.result && typeof data.result === "object" && "content" in (data.result as object)) {
          content = String((data.result as { content: unknown }).content);
        } else {
          content = JSON.stringify(data.result, null, 2);
        }

        // Strip integration setup tokens before emitting
        const setupTokenRegex = /<<<SETUP:([^:]+):([A-Z0-9_]+)=([^>]+)>>>/g;
        const rawMatches: Array<{ service: string; key: string; value: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = setupTokenRegex.exec(content)) !== null) {
          rawMatches.push({ service: m[1], key: m[2], value: m[3].trim() });
        }
        if (rawMatches.length > 0) {
          content = content.replace(/<<<SETUP:[^>]+>>>/g, "").trim();
          const vars = rawMatches.filter((x) => x.value).map((x) => ({ key: x.key, value: x.value }));
          if (vars.length > 0) {
            fetch(`${GATEWAY_URL}/integrations/configure`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${INTERNAL_TOKEN}` },
              body: JSON.stringify({ vars }),
            }).catch(() => {});
          }
        }

        controller.enqueue(sseEvent({ type: "delta", content }));
        controller.enqueue(sseEvent({ type: "done", run_id: data.run_id }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseEvent({ type: "error", content: msg }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

// ─── LiteLLM streaming proxy ──────────────────────────────────────────────────
// Streams an OpenAI-compatible chat completion from the LiteLLM proxy and
// re-emits it in our SSE format (delta / done / error). Enables the unified
// chat window to use any LiteLLM model alias (tier1/2/3, copilot/*).

function streamLiteLLM({
  message,
  messages,
  model,
  context,
}: {
  message: string;
  messages: ChatMessage[];
  model?: string;
  context?: string;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const history = (messages ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content }));

        const chatMessages: { role: string; content: string }[] = [];
        if (context?.trim()) {
          chatMessages.push({
            role: "system",
            content: context.trim(),
          });
        }
        // history already includes the current user turn (appended client-side),
        // but guard against the last entry not being the current message.
        const hasCurrent =
          history.length > 0 &&
          history[history.length - 1].role === "user" &&
          history[history.length - 1].content === message;
        chatMessages.push(...history);
        if (!hasCurrent) chatMessages.push({ role: "user", content: message });

        const upstream = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${LITELLM_KEY}`,
          },
          body: JSON.stringify({
            model: model ?? "tier2-sonnet",
            messages: chatMessages,
            stream: true,
          }),
          signal: AbortSignal.timeout(310_000),
        });

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => `status ${upstream.status}`);
          controller.enqueue(sseEvent({ type: "error", content: `LiteLLM error: ${text}` }));
          controller.close();
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const json = JSON.parse(raw) as {
                choices?: {
                  delta?: {
                    content?: string;
                    // Reasoning / chain-of-thought fields used by thinking models:
                    //   • Gemini 2.5 thinking — "reasoning_content"
                    //   • Claude extended thinking (via LiteLLM) — "thinking_content"
                    //   • Some providers use "thinking"
                    reasoning_content?: string;
                    thinking_content?: string;
                    thinking?: string;
                  };
                }[];
              };
              const delta = json.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) {
                controller.enqueue(sseEvent({ type: "delta", content: delta.content }));
              }
              // Emit reasoning tokens so ThinkingContainer can show chain-of-thought.
              const reasoningDelta =
                delta.reasoning_content ?? delta.thinking_content ?? delta.thinking;
              if (reasoningDelta) {
                controller.enqueue(sseEvent({ type: "reasoning", content: reasoningDelta }));
              }
            } catch {
              // ignore non-JSON keep-alive lines
            }
          }
        }

        controller.enqueue(sseEvent({ type: "done" }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseEvent({ type: "error", content: `LiteLLM unreachable: ${msg}` }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
