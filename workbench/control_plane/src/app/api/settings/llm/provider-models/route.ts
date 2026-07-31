/**
 * GET /api/settings/llm/provider-models?provider=deepseek
 *
 * Proxies to the gateway's live model discovery endpoint.
 * Returns [{ id, label }] — falls back to the static list if the provider
 * doesn't support live discovery or if the API call fails.
 */
import { NextRequest, NextResponse } from "next/server";
import { gatewayHeaders, requireIdentity } from "@/lib/gateway";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  if (!provider) {
    return NextResponse.json({ detail: "provider param required" }, { status: 400 });
  }
  try {
    const r = await fetch(
      `${GATEWAY}/settings/llm/provider-models?provider=${encodeURIComponent(provider)}`,
      {
        headers: await gatewayHeaders(),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data = await r.json().catch(() => []);
    return NextResponse.json(data, { status: r.status });
  } catch (_e) {
    return NextResponse.json([], { status: 200 }); // graceful fallback
  }
}
