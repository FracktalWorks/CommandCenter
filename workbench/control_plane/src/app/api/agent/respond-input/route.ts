/**
 * POST /api/agent/respond-input
 *
 * Answers a native Copilot SDK `ask_user` prompt for a running agent.
 *
 * The agent's run is BLOCKED inside the SDK's `on_user_input_request`
 * handler (the gateway parked it on a Future after emitting a
 * `user_input_requested` SSE event).  Posting the answer here unblocks the
 * run so it continues in the SAME stream — the answer is never queued as a
 * separate chat message.
 */

import { NextRequest } from "next/server";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

interface RespondInputRequest {
  request_id: string;
  answer: string;
  was_freeform?: boolean;
  /** Thread the parked run belongs to — lets the gateway relay the answer to
   *  whichever worker owns the run (P1-2 cross-worker control bus). */
  thread_id?: string;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: RespondInputRequest;
  try {
    body = (await req.json()) as RespondInputRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.request_id || typeof body.answer !== "string") {
    return new Response(
      JSON.stringify({ error: "request_id and answer are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/agent/respond-input`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({
        request_id: body.request_id,
        answer: body.answer,
        was_freeform: body.was_freeform ?? true,
        thread_id: body.thread_id ?? null,
      }),
    });

    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Gateway unreachable: ${String(err)}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
