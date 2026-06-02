import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

/** Proxy: POST /api/act/clickup/update-task -> gateway /act/clickup/update-task.
 *  Injects the signed-in user's email as `X-User-Email` so the audit log
 *  attributes the mutation correctly. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const session = await auth().catch(() => null);
  const email = session?.user?.email ?? "";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (email) {
    headers["X-User-Email"] = email;
    headers["X-User-Role"] = "employee"; // role gating not yet implemented
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_URL}/act/clickup/update-task`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `gateway unreachable: ${message}` }, { status: 502 });
  }

  const data: unknown = await upstream.json();
  return NextResponse.json(data, { status: upstream.status });
}
