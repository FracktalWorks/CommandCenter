/**
 * GET  /api/settings/llm/enabled-models   — list enabled model entries
 * POST /api/settings/llm/enabled-models   — enable a model
 */
import { NextRequest, NextResponse } from "next/server";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${INTERNAL_TOKEN}`,
};

export async function GET(): Promise<NextResponse> {
  try {
    const r = await fetch(`${GATEWAY}/settings/llm/enabled-models`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(4_000),
    });
    const data = await r.json().catch(() => []);
    return NextResponse.json(data, { status: r.status });
  } catch (_e) {
    return NextResponse.json([], { status: 200 }); // empty list on gateway down
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json();
  try {
    const r = await fetch(`${GATEWAY}/settings/llm/enabled-models`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
