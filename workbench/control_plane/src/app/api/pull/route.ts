import { NextRequest, NextResponse } from "next/server";

const GATEWAY_URL =
  process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${GATEWAY_URL}/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `gateway unreachable: ${message}` },
      { status: 502 }
    );
  }

  const data: unknown = await upstreamRes.json();
  return NextResponse.json(data, { status: upstreamRes.status });
}
