/**
 * POST /api/agent/[name]/pull
 *
 * Proxies POST /agent/{name}/pull to the FastAPI gateway.
 * Pulls latest commits from origin into the agent's local clone.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL =
  process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await params;
  try {
    const res = await fetch(
      `${GATEWAY_URL}/agent/${encodeURIComponent(name)}/pull`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
