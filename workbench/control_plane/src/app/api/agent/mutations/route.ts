/**
 * GET /api/agent/mutations
 *
 * Proxies GET /agent/mutations from the FastAPI gateway — the self-mutation
 * HITL queue (auto-fix PRs opened by Self_Mutation_Node). Returns [] when the
 * gateway is unavailable so the inbox UI never breaks.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me";

export interface MutationEntry {
  action: string;
  agent: string;
  at: string;
  run_id?: string;
  pr_url?: string;
  branch?: string;
  error_type?: string;
  test_summary?: string;
  status: "pr_open" | "failed" | "started";
}

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/agent/mutations`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const rows = (await res.json()) as MutationEntry[];
      return NextResponse.json(rows);
    }
  } catch {
    // Gateway unavailable — return empty queue
  }
  return NextResponse.json([]);
}
