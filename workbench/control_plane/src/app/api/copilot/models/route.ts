import { NextRequest, NextResponse } from "next/server";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

/**
 * GET /api/copilot/models
 *
 * Proxies GET /copilot/models from the gateway which returns the live Copilot
 * SDK model list.  On any error, returns an empty models array so the UI falls
 * back to its static list.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/copilot/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ models: [], source: "gateway_error" });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ models: [], source: "unreachable" });
  }
}
