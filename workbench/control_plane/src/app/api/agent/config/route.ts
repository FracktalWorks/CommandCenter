/**
 * GET /api/agent/config?repo=owner/repo
 *
 * Proxies to GET /agent/config?repo=... on the FastAPI gateway.
 * Returns the parsed config.json from the agent's GitHub repository.
 * Used by the Add Agent modal to auto-fill form fields.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  if (!repo.trim()) {
    return NextResponse.json({ error: "repo parameter is required" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${GATEWAY_URL}/agent/config?repo=${encodeURIComponent(repo)}`,
      {
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
