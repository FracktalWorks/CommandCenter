/**
 * GET /api/actions/pending
 *
 * Proxies GET /actions/pending from the FastAPI gateway — the Action Broker
 * approval queue (outward writes an agent proposed under ACTION_BROKER_ENFORCE).
 * Keeps the internal bearer server-side. Returns an empty queue when the
 * gateway is unavailable so the inbox UI never breaks.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export interface PendingAction {
  id: string;
  actor: string;
  action: string;
  target: string;
  payload?: Record<string, unknown>;
  authority: string;
  destructive?: boolean;
  disposition: string;
  status: string;
  created_at?: string;
}

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/actions/pending`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { pending?: PendingAction[] };
      return NextResponse.json(body.pending ?? []);
    }
  } catch {
    // Gateway unavailable — return an empty queue.
  }
  return NextResponse.json([]);
}
