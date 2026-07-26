/**
 * POST /api/email/compose-assist/stream
 *
 * Dedicated SSE proxy for the composer's "Draft with AI" progress stream. The
 * generic /api/email/[...path] proxy buffers POST bodies as JSON and would
 * break streaming, so this more-specific route passes the gateway's
 * text/event-stream body straight through (mirrors the note-taker events
 * proxy). Auth rides the Next session cookie; the internal token is attached
 * server-side.
 */
import { NextRequest } from "next/server";
import { auth, isAuthEnabled } from "@/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

const EXECUTIVE_EMAILS = new Set(
  (process.env.EXECUTIVE_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

async function gatewayHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
  };
  try {
    const session = await auth();
    if (session?.user?.email) {
      h["X-User-Email"] = session.user.email;
      h["X-User-Role"] = EXECUTIVE_EMAILS.has(session.user.email.toLowerCase())
        ? "executive"
        : "employee";
    }
  } catch {
    /* not a request context */
  }
  return h;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return new Response('data: {"type":"error","error":"unauthorized"}\n\n', {
      status: 401,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_URL}/email/compose-assist/stream`, {
      method: "POST",
      headers: await gatewayHeaders(),
      body,
      // Abort the upstream draft when the composer goes away — no orphaned
      // LLM spend for a closed tab.
      signal: req.signal,
    });
  } catch {
    return new Response(
      'data: {"type":"error","error":"upstream unavailable"}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(
      `data: {"type":"error","error":"upstream error ${upstream.status}"}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
