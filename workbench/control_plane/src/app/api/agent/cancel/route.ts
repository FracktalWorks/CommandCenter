/**
 * POST /api/agent/cancel
 *
 * Actually stops a running agent (vs. just dropping the SSE connection, which
 * leaves the agent running detached in the background).  Proxies to the gateway
 * `POST /agent/run/{threadId}/cancel`, which cancels the background task,
 * marks the thread inactive, and pushes a terminal RUN_FINISHED event.
 *
 * Body: { threadId: string }
 */

import { NextRequest } from "next/server";
import { auth, isAuthEnabled } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

const EXECUTIVE_EMAILS = new Set(
  (process.env.EXECUTIVE_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export async function POST(req: NextRequest) {
  const session = await auth();
  // Gate only when auth is enabled (no-op in dev, where auth() returns null).
  if (isAuthEnabled && !session?.user?.email) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let threadId = "";
  try {
    const body = (await req.json()) as { threadId?: string };
    threadId = (body.threadId ?? "").trim();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!threadId) {
    return new Response(JSON.stringify({ error: "threadId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
  };
  const email = session?.user?.email;
  if (email) {
    headers["X-User-Email"] = email;
    headers["X-User-Role"] = EXECUTIVE_EMAILS.has(email.toLowerCase())
      ? "executive"
      : "employee";
  }

  try {
    const res = await fetch(
      `${GATEWAY_URL}/agent/run/${encodeURIComponent(threadId)}/cancel`,
      { method: "POST", headers, signal: AbortSignal.timeout(8_000) },
    );
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
