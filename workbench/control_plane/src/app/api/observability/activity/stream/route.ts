/**
 * GET /api/observability/activity/stream
 *
 * Proxies the gateway's Server-Sent Events activity feed
 * (GET /observability/activity/stream) to the browser. EventSource cannot send
 * custom headers, so auth rides the Next session cookie here; the internal
 * gateway token + resolved user role are attached server-side.
 *
 * The upstream fetch is bound to the request's abort signal so a client
 * disconnect tears down the gateway connection instead of leaking it.
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

export async function GET(req: NextRequest): Promise<Response> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return new Response("data: {\"error\":\"unauthorized\"}\n\n", {
      status: 401,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_URL}/observability/activity/stream`, {
      headers: await gatewayHeaders(),
      signal: req.signal, // client disconnect → cancel the gateway stream
    });
  } catch {
    return new Response(": upstream unavailable\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(": upstream error\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
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
