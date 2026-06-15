/**
 * GET /api/agent/artifacts/file?agent=<name>&path=<rel_path>
 * PUT /api/agent/artifacts/file?agent=<name>&path=<rel_path>
 * Proxy for the global artifact browser — read and write individual files.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

const EXECUTIVE_EMAILS = new Set(
  (process.env.EXECUTIVE_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

async function buildGatewayHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
  };
  try {
    const session = await auth();
    if (session?.user?.email) {
      headers["X-User-Email"] = session.user.email;
      headers["X-User-Role"] = EXECUTIVE_EMAILS.has(
        session.user.email.toLowerCase()
      )
        ? "executive"
        : "employee";
    }
  } catch {
    // auth() may throw outside request context
  }
  return headers;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const agent = req.nextUrl.searchParams.get("agent");
    const filePath = req.nextUrl.searchParams.get("path");
    if (!agent || !filePath) {
      return NextResponse.json(
        { error: "Missing ?agent= and ?path= query parameters" },
        { status: 400 }
      );
    }

    const upstream = new URL(`${GATEWAY_URL}/agent/artifacts/file`);
    upstream.searchParams.set("agent", agent);
    upstream.searchParams.set("path", filePath);

    const res = await fetch(upstream.toString(), {
      headers: await buildGatewayHeaders(),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const contentDisposition = res.headers.get("content-disposition") ?? "";
    const contentLength = res.headers.get("content-length");

    const headers: Record<string, string> = { "Content-Type": contentType };
    if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
    if (contentLength) headers["Content-Length"] = contentLength;

    return new NextResponse(res.body, { status: 200, headers });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const agent = req.nextUrl.searchParams.get("agent");
    const filePath = req.nextUrl.searchParams.get("path");
    if (!agent || !filePath) {
      return NextResponse.json(
        { error: "Missing ?agent= and ?path= query parameters" },
        { status: 400 }
      );
    }

    const body = await req.json();

    const upstream = new URL(`${GATEWAY_URL}/agent/artifacts/file`);
    upstream.searchParams.set("agent", agent);
    upstream.searchParams.set("path", filePath);

    const res = await fetch(upstream.toString(), {
      method: "PUT",
      headers: {
        ...(await buildGatewayHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
