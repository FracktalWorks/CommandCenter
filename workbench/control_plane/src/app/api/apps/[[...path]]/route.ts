/**
 * GET/POST/PATCH/DELETE /api/apps and /api/apps/[…path]
 *
 * Proxies all Custom Apps requests to the FastAPI gateway /apps/* path —
 * the browser talks to the Next.js server, which forwards authenticated
 * requests (internal bearer + X-User-Email) to the gateway. Mirrors the
 * task app's proxy at /api/tasks/[...path].
 */
import { NextRequest, NextResponse } from "next/server";
import { GATEWAY_URL, gatewayHeaders, requireIdentity } from "@/lib/gateway";

export const dynamic = "force-dynamic";

function buildUpstreamUrl(path: string[], req: NextRequest): string {
  const base =
    path.length > 0
      ? `${GATEWAY_URL}/apps/${path.join("/")}`
      : `${GATEWAY_URL}/apps`;
  const qs = req.nextUrl.searchParams.toString();
  return qs ? `${base}?${qs}` : base;
}

async function forward(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  req: NextRequest,
  params: Promise<{ path?: string[] }>
): Promise<NextResponse> {
  const { path = [] } = await params;
  const upstream = buildUpstreamUrl(path, req);
  try {
    const reqType = req.headers.get("content-type") ?? "";
    const isMultipart = reqType.startsWith("multipart/form-data");
    const init: RequestInit = {
      method,
      headers: {
        ...(await gatewayHeaders()),
        ...(method === "GET" || method === "DELETE"
          ? {}
          : // Multipart (attachment uploads) must pass through byte-exact
            // with its boundary; everything else is JSON as before.
            { "Content-Type": isMultipart ? reqType : "application/json" }),
      },
      signal: AbortSignal.timeout(30_000),
    };
    if (method !== "GET" && method !== "DELETE") {
      if (isMultipart) {
        init.body = Buffer.from(await req.arrayBuffer());
      } else {
        const body = await req.json().catch(() => ({}));
        init.body = JSON.stringify(body);
      }
    }
    // A pooled keep-alive socket can be closed by the gateway just as we
    // reuse it, failing the fetch spuriously (undici vs uvicorn's short
    // keep-alive). GETs are idempotent — retry once on network failure.
    let res: Response;
    try {
      res = await fetch(upstream, init);
    } catch (err) {
      if (method !== "GET") throw err;
      res = await fetch(upstream, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
    }
    if (res.status === 204) {
      return new NextResponse(null, { status: 204 });
    }
    const resType = res.headers.get("content-type") ?? "";
    if (!resType.includes("application/json")) {
      // Binary/text passthrough (app bundles, file contents): keep type + disposition.
      const buf = Buffer.from(await res.arrayBuffer());
      return new NextResponse(buf, {
        status: res.status,
        headers: {
          "Content-Type": resType || "application/octet-stream",
          ...(res.headers.get("content-disposition")
            ? { "Content-Disposition": res.headers.get("content-disposition")! }
            : {}),
        },
      });
    }
    const resBody = await res.json().catch(() => ({}));
    return NextResponse.json(resBody, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("GET", req, ctx.params);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("POST", req, ctx.params);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("PUT", req, ctx.params);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("PATCH", req, ctx.params);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("DELETE", req, ctx.params);
}
