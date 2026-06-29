/**
 * POST /api/feedback — record a 👍/👎 vote on an assistant message.
 *
 * Thin proxy to the gateway POST /chat/feedback, which persists the vote as an
 * audit event (acb_audit). Forwards the signed-in user's email so the audit
 * actor is the real user.
 */
import { NextRequest } from "next/server";
import { auth } from "@/auth";

export const runtime = "nodejs";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me";

interface FeedbackBody {
  message_id?: string;
  vote?: string;
  session_id?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: FeedbackBody;
  try {
    body = (await req.json()) as FeedbackBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!body.message_id || (body.vote !== "up" && body.vote !== "down")) {
    return new Response("message_id and vote ('up'|'down') are required", { status: 400 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
  };
  try {
    const session = await auth();
    if (session?.user?.email) headers["X-User-Email"] = session.user.email;
  } catch {
    /* non-request context — fall back to internal-only */
  }

  try {
    const r = await fetch(`${GATEWAY_URL}/chat/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return new Response(null, { status: r.ok ? 204 : 502 });
  } catch {
    return new Response(null, { status: 502 });
  }
}
