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
  /** "pending_commit" (commit-gate HITL row) or "audit_event" (legacy sandbox event) */
  type?: "pending_commit" | "audit_event";
  /** UUID of the pending_commit row (only present for type === "pending_commit") */
  id?: string;
  agent: string;
  at: string;
  run_id?: string;
  /** Commit SHA (only for pending_commit rows) */
  commit_sha?: string;
  /** Commit message (only for pending_commit rows) */
  commit_message?: string;
  /** PR URL (only for audit_event rows that opened a PR) */
  pr_url?: string;
  /** Git branch name */
  branch?: string;
  error_type?: string;
  test_summary?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  /** Relative gateway URLs for HITL actions (pending_commit rows only) */
  approve_url?: string;
  reject_url?: string;
  diff_url?: string;
  status:
    | "pending"      // pending_commit awaiting review
    | "approved"     // pending_commit approved and pushed
    | "rejected"     // pending_commit rejected
    | "eval_failed"  // pending_commit: commit staged but tests failed — awaiting Push Anyway / Reject / Re-mutate
    | "pr_open"      // audit_event: PR was opened
    | "failed"       // audit_event: sandbox failed
    | "started"      // audit_event: mutation started
    | "commit_pending"; // audit_event: commit staged
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
