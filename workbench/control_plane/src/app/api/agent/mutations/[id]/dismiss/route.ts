/**
 * DELETE /api/agent/mutations/[id]/dismiss
 *
 * Proxies DELETE /agent/mutations/audit/{run_id} to the gateway.
 * Removes failed/historical audit_event rows from the inbox.
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
      `${GATEWAY_URL}/agent/mutations/audit/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      }
    );
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
