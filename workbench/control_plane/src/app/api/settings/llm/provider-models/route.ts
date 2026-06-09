/**
 * GET /api/settings/llm/provider-models?provider=deepseek
 *
 * Proxies to the gateway's live model discovery endpoint.
 * Returns [{ id, label }] — falls back to the static list if the provider
 * doesn't support live discovery or if the API call fails.
 */
import { NextRequest, NextResponse } from "next/server";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  if (!provider) {
    return NextResponse.json({ detail: "provider param required" }, { status: 400 });
  }
  try {
    const r = await fetch(
      `${GATEWAY}/settings/llm/provider-models?provider=${encodeURIComponent(provider)}`,
      {
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data = await r.json().catch(() => []);
    return NextResponse.json(data, { status: r.status });
  } catch (_e) {
    return NextResponse.json([], { status: 200 }); // graceful fallback
  }
}
