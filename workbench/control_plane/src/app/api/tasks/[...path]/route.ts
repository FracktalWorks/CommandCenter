/**
 * GET/POST/PATCH/DELETE /api/tasks/[…path]
 *
 * Proxies all task-manager requests to the FastAPI gateway /tasks/* path —
 * the browser talks to the Next.js server, which forwards authenticated
 * requests (internal bearer + X-User-Email) to the gateway. Mirrors the
 * email app's proxy at /api/email/[...path].
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

function buildUpstreamUrl(path: string[], req: NextRequest): string {
  const base = `${GATEWAY_URL}/tasks/${path.join("/")}`;
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
    const reqType = req.headers.get("content-type") ?? "";
    const isMultipart = reqType.startsWith("multipart/form-data");
    const init: RequestInit = {
      method,
      headers: {
        ...(await buildGatewayHeaders()),
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
      // Binary passthrough (attachment downloads): keep type + disposition.
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
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  return forward("GET", req, ctx.params);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  return forward("POST", req, ctx.params);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  return forward("PUT", req, ctx.params);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  return forward("PATCH", req, ctx.params);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  return forward("DELETE", req, ctx.params);
}
