/**
 * GET /api/people/[…path]
 *
 * Proxies People Center reads to the FastAPI gateway's /people/* API. The
 * browser talks to the Next server, which holds the session and forwards an
 * authenticated request (internal bearer + X-User-Email) upstream — the same
 * shape as the Projects and CRM proxies.
 *
 * ⚠️ This is not a convenience layer. `/people` is gated by
 * `require_feature_router("people")` and the gateway takes the acting identity
 * from `X-User-Email` only, so a page that fetched the gateway directly would
 * carry neither and 401. Nothing in this app may point the browser at api.* .
 *
 * **GET only, deliberately.** The People Center's directory is a read surface;
 * its writes (create/edit a person, upload a résumé) already exist on the
 * tasks API under `admin:members:manage` and go through `/api/tasks`. Adding
 * write verbs here that forward to endpoints the gateway does not serve would
 * mint a second, hollow write path — and the first person to find it would
 * reasonably assume it worked.
 */
import { NextRequest, NextResponse } from "next/server";
import { GATEWAY_URL, gatewayHeaders, requireIdentity } from "@/lib/gateway";

export const dynamic = "force-dynamic";

function buildUpstreamUrl(path: string[], req: NextRequest): string {
  const base = `${GATEWAY_URL}/people/${path.join("/")}`;
  const qs = req.nextUrl.searchParams.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  // Identity is resolved BEFORE forwarding. `gatewayHeaders()` throwing is what
  // makes an unguarded call fail closed, but that throw lands in the catch
  // below and answers 502 — telling a signed-out member the gateway is down
  // when what they need is a sign-in. Pinned by `src/lib/gateway.test.ts`.
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;

  const { path } = await ctx.params;
  const upstream = buildUpstreamUrl(path, req);
  try {
    const init: RequestInit = {
      method: "GET",
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(30_000),
    };
    // A pooled keep-alive socket can be closed by the gateway just as we reuse
    // it (undici vs uvicorn's short keep-alive). Reads are idempotent, so a
    // spurious network failure gets one retry.
    let res: Response;
    try {
      res = await fetch(upstream, init);
    } catch {
      res = await fetch(upstream, { ...init, signal: AbortSignal.timeout(30_000) });
    }
    const text = await res.text();
    if (!text) return new NextResponse(null, { status: res.status });
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      { detail: `People gateway unreachable: ${String(err)}` },
      { status: 502 }
    );
  }
}
