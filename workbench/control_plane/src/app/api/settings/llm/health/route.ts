/**
 * GET /api/settings/llm/health  — LiteLLM health check
 */
import { NextResponse } from "next/server";
import { GATEWAY_URL, gatewayHeaders, requireIdentity } from "@/lib/gateway";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  try {
    const res = await fetch(`${GATEWAY_URL}/settings/llm/health`, {
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(6_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { healthy: false, detail: String(err), ui_url: "" },
      { status: 200 }
    );
  }
}
