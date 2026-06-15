/**
 * DELETE /api/agent/[name]
 * PATCH  /api/agent/[name]
 *
 * Proxies to the corresponding FastAPI gateway endpoints.
 * Name validation is handled by the backend — the proxy just
 * encodes and forwards.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

/** Reject names that are empty or contain path separators (safety only). */
function validateName(name: string): boolean {
  if (!name || name.trim().length === 0) return false;
  // Reject path traversal / separators
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return true;
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await params;

  if (!validateName(name)) {
    return NextResponse.json({ error: "Invalid agent name" }, { status: 400 });
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/agent/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await params;

  if (!validateName(name)) {
    return NextResponse.json({ error: "Invalid agent name" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (_e) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/agent/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
