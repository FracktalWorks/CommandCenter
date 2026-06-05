/**
 * POST /api/integrations/github/connect-cli
 *
 * Proxies to POST /integrations/github/connect-cli on the gateway.
 * Reads the active `gh` CLI token, writes it to GITHUB_TOKEN in .env,
 * and returns account details.
 *
 * Response:
 *   {
 *     ok: boolean,
 *     login: string,
 *     scopes: string[],
 *     has_copilot: boolean,
 *     refresh_command: string | null,  // non-null when copilot scope is missing
 *     message: string,
 *   }
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function POST(_req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/integrations/github/connect-cli`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(
      { error: data.detail ?? `Gateway ${res.status}` },
      { status: res.status }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
