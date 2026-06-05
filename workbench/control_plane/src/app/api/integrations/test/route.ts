/**
 * GET /api/integrations/test?service={name}
 *
 * Proxies to GET /integrations/test?service={name} on the FastAPI gateway.
 * Returns { service, ok, detail }.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const service = req.nextUrl.searchParams.get("service") ?? "";
  if (!service) {
    return NextResponse.json({ error: "service param required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${GATEWAY_URL}/integrations/test?service=${encodeURIComponent(service)}`,
      {
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Gateway ${res.status}: ${text}` },
      { status: res.status }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
