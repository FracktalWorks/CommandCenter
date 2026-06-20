/**
 * GET /api/chat/active-sessions
 *
 * Returns the list of session IDs whose agents are currently executing
 * (queried from the gateway's Redis cc:active:* scan).
 *
 * Used by the conversations sidebar to show a pulsing green dot next
 * to sessions that are still running in the background, even after a
 * browser refresh.
 */
import { NextResponse } from "next/server";
import { auth, isAuthEnabled } from "@/auth";

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
    .filter(Boolean)
);

async function gatewayHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
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

export async function GET(): Promise<NextResponse> {
  // Gate when auth is enabled (no-op in dev).  Returns an empty list rather
  // than 401 so the sidebar degrades gracefully for unauthenticated polls.
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json([], { status: 200 });
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/chat/active-sessions`, {
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return NextResponse.json([], { status: 200 }); // degrade gracefully
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json([], { status: 200 }); // degrade gracefully
  }
}
