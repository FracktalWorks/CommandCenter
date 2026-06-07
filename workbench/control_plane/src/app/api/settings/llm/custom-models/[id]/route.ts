/**
 * DELETE /api/settings/llm/custom-models/[id] — remove a custom model entry
 */
import { NextRequest, NextResponse } from "next/server";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const modelId = decodeURIComponent(id);
  try {
    const r = await fetch(
      `${GATEWAY}/settings/llm/custom-models/${encodeURIComponent(modelId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(6_000),
      },
    );
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
