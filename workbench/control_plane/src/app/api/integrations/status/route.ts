/**
 * GET /api/integrations/status?agent={name}
 *
 * Proxies to GET /integrations/status?agent={name} on the FastAPI gateway.
 * Returns per-integration status with setup guides for the UI wizard.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export interface IntegrationEnvVar {
  key: string;
  label: string;
  sensitive: boolean;
}

export interface IntegrationStatus {
  service: string;
  label: string;
  configured: boolean;
  mandatory: boolean;
  description: string;
  /** Human-readable labels for what this integration is used for (e.g. ["Repo access", "Models"]). */
  uses?: string[];
  setup_url: string;
  docs_url: string;
  instructions: string;
  env_vars: IntegrationEnvVar[];
  missing_keys: string[];
  /** Which credential keys are stored in the encrypted Postgres DB (e.g. ["client_id", "client_secret"]). */
  db_keys?: string[];
  /** Storage source: "encrypted-db" | "env-file" | "none". */
  storage?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const agent = req.nextUrl.searchParams.get("agent") ?? "";
  const params = agent ? `?agent=${encodeURIComponent(agent)}` : "";

  try {
    const res = await fetch(`${GATEWAY_URL}/integrations/status${params}`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Gateway ${res.status}: ${text}` },
      { status: res.status }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
