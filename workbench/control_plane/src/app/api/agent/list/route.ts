/**
 * GET /api/agent/list
 *
 * Proxies GET /agent from the FastAPI gateway to return the available agent
 * registry for the Control Plane picker. Returns a static fallback list if
 * the gateway is unavailable so the UI never breaks.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ?? process.env.LITELLM_MASTER_KEY ?? "sk-local-dev-change-me";

// Static fallback — mirrors _AGENT_REGISTRY in gateway/routes/agent.py.
// Shown when the gateway is down so the picker still renders.
const FALLBACK_AGENTS = [
  { name: "task-manager",  description: "ClickUp task management",              tags: ["tasks"],    status: "live", agent_runtime: "maf" },
  { name: "sales",         description: "Zoho CRM sales pipeline",              tags: ["sales"],    status: "live", agent_runtime: "maf" },
  { name: "triage",        description: "Email / WhatsApp triage + routing",    tags: ["triage"],   status: "live", agent_runtime: "maf" },
  { name: "delivery",      description: "Project delivery monitoring",          tags: ["delivery"], status: "live", agent_runtime: "maf" },
  { name: "reconciler",    description: "Nightly source-of-truth diff",         tags: ["ops"],      status: "live", agent_runtime: "maf" },
  { name: "strategy",      description: "Weekly digest + planning synthesis",   tags: ["strategy"], status: "live", agent_runtime: "maf" },
];

export interface AgentEntry {
  name: string;
  description: string;
  tags: string[];
  status: string;
  /** How the agent is executed: "github-copilot" | "maf" | "langgraph" */
  agent_runtime?: string;
  integrations?: string[];
  optional_integrations?: string[];
  repo_name?: string;
  repo_url?: string;
  local_path?: string;
  dynamic?: boolean;
}

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/agent`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const agents = (await res.json()) as AgentEntry[];
      return NextResponse.json(agents);
    }
  } catch {
    // Gateway unavailable — return fallback
  }
  return NextResponse.json(FALLBACK_AGENTS);
}
