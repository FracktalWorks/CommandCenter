/**
 * GET/POST/PATCH/DELETE /api/crm/[…path]
 *
 * Proxies every CRM request to the FastAPI gateway's /crm/* API. The browser
 * talks to the Next server, which holds the session and forwards an
 * authenticated request (internal bearer + X-User-Email) upstream — the same
 * shape as the tasks proxy at /api/tasks/[...path].
 *
 * ⚠️ This is not a convenience layer. `/crm` is gated by
 * `require_feature_router("crm")` and the gateway takes the acting identity
 * from `X-User-Email` only, so a page that fetched the gateway directly would
 * carry neither and 401 — the failure that took out every email-account
 * connection for six days (workbench/AGENTS.md, "Identity"). Nothing in this
 * app may point the browser at api.* .
 */
import { NextRequest, NextResponse } from "next/server";
import { GATEWAY_URL, gatewayHeaders, requireIdentity } from "@/lib/gateway";

export const dynamic = "force-dynamic";

function buildUpstreamUrl(path: string[], req: NextRequest): string {
  const base = `${GATEWAY_URL}/crm/${path.join("/")}`;
  const qs = req.nextUrl.searchParams.toString();
  return qs ? `${base}?${qs}` : base;
}

async function forward(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  req: NextRequest,
  params: Promise<{ path: string[] }>
): Promise<NextResponse> {
  const { path } = await params;
  const upstream = buildUpstreamUrl(path, req);
  try {
    const init: RequestInit = {
      method,
      headers: {
        ...(await gatewayHeaders()),
        ...(method === "GET" || method === "DELETE"
          ? {}
          : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(30_000),
    };
    if (method !== "GET" && method !== "DELETE") {
      const body = await req.json().catch(() => ({}));
      init.body = JSON.stringify(body);
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
    const resBody = await res.json().catch(() => ({}));
    // The status is passed through verbatim: the CRM says a great deal with
    // its codes (422 for a bad sort key or a lost status with no reason, 409
    // for a re-convert or a status still in use), and a proxy that flattened
    // them would leave the UI unable to explain a refusal.
    return NextResponse.json(resBody, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("GET", req, ctx.params);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("POST", req, ctx.params);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("PUT", req, ctx.params);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("PATCH", req, ctx.params);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  return forward("DELETE", req, ctx.params);
}
