/**
 * DELETE /api/settings/llm/hidden-models/[id] — unhide a model
 */
import { NextRequest, NextResponse } from "next/server";
import { gatewayHeaders, requireIdentity } from "@/lib/gateway";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  const { id } = await params;
  const modelId = decodeURIComponent(id);
  try {
    const r = await fetch(
      `${GATEWAY}/settings/llm/hidden-models/${encodeURIComponent(modelId)}`,
      {
        method: "DELETE",
        headers: await gatewayHeaders(),
        signal: AbortSignal.timeout(6_000),
      },
    );
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
