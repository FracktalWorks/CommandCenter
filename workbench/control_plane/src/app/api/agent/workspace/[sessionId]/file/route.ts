/**
 * GET /api/agent/workspace/[sessionId]/file?path=<rel_path>
 * Proxy raw file bytes from the gateway workspace API.
 * The Content-Type and Content-Disposition headers from the gateway are passed through.
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  try {
    const { sessionId } = await params;
    const filePath = req.nextUrl.searchParams.get("path");
    if (!filePath) {
      return NextResponse.json({ error: "Missing ?path= query parameter" }, { status: 400 });
    }

    const upstream = new URL(`${GATEWAY_URL}/agent/workspace/${sessionId}/file`);
    upstream.searchParams.set("path", filePath);

    const res = await fetch(upstream.toString(), {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      // No timeout here — large files can take a moment to stream
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    // Stream the response body through, preserving Content-Type + Content-Disposition
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const contentDisposition = res.headers.get("content-disposition") ?? "";
    const contentLength = res.headers.get("content-length");

    const headers: Record<string, string> = {
      "Content-Type": contentType,
    };
    if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
    if (contentLength) headers["Content-Length"] = contentLength;

    return new NextResponse(res.body, { status: 200, headers });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
