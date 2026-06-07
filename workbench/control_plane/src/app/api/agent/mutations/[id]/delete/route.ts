/**
 * DELETE /api/agent/mutations/[id]/delete
 *
 * Proxies DELETE /agent/mutations/pending/{id} to the gateway.
 * Removes a pending_commit row (any status) from the DB.
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL =
  process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const res = await fetch(
      `${GATEWAY_URL}/agent/mutations/pending/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 502 }
    );
  }
}
