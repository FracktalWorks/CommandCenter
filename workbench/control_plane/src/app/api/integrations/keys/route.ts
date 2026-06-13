/**
 * GET /api/integrations/keys
 *
 * Proxies to GET /integrations/keys on the FastAPI gateway.
 * Returns which integration credentials are stored in the encrypted DB.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export interface IntegrationKeysResponse {
  services: Record<string, string[]>;  // service → [key_names]
  total_keys: number;
  storage: string;
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/integrations/keys`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
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
