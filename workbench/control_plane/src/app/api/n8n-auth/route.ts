import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/n8n-auth
 *
 * Server-side endpoint that logs into n8n using owner credentials,
 * then mirrors the n8n-auth JWT cookie back to the browser.
 *
 * Because cookies are domain-scoped (not port-scoped), the browser will
 * automatically include n8n-auth in all requests to localhost:5678,
 * allowing the n8n iframe to load without showing a login prompt.
 */
export async function GET() {
  const n8nUrl = process.env.N8N_BASE_URL ?? "http://localhost:5678";
  const email = process.env.N8N_OWNER_EMAIL ?? "admin@localhost.dev";
  const password = process.env.N8N_OWNER_PASSWORD ?? "";

  try {
    const loginRes = await fetch(`${n8nUrl}/rest/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emailOrLdapLoginId: email, password }),
      cache: "no-store",
    });

    if (!loginRes.ok) {
      return NextResponse.json(
        { ok: false, reason: `n8n returned ${loginRes.status}` },
        { status: 502 },
      );
    }

    // Extract the n8n-auth token from the Set-Cookie header
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    const match = setCookieHeader.match(/n8n-auth=([^;]+)/);
    if (!match) {
      return NextResponse.json(
        { ok: false, reason: "no n8n-auth cookie in response" },
        { status: 502 },
      );
    }

    // Mirror the token as a browser cookie scoped to localhost (all ports)
    const response = NextResponse.json({ ok: true });
    response.cookies.set("n8n-auth", match[1], {
      path: "/",
      httpOnly: false, // n8n reads it via HTTP header; false lets the page JS also see it
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365, // 1 year, matching N8N_USER_MANAGEMENT_JWT_DURATION_HOURS
    });
    return response;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "fetch error" },
      { status: 502 },
    );
  }
}
