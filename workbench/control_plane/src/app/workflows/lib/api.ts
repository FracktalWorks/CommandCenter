// Thin client over /api/workflows/* (the Next proxy to the gateway /workflows
// API). Same shape as notes/lib/api.ts: one error helper, typed functions.

import type {
  Catalog,
  CopilotResponse,
  GeneratedModule,
  GraphIssue,
  ModuleDetail,
  ModuleSummary,
  RunDetail,
  RunSummary,
  SearchResponse,
  TriggerSpec,
  WorkflowDetail,
  WorkflowGraph,
  WorkflowSummary,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = `${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? body?.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(detail: unknown, status: number) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
  /** Validation issues when the gateway refused a publish/run (422). */
  issues(): GraphIssue[] {
    const d = this.detail as { issues?: GraphIssue[] } | undefined;
    return Array.isArray(d?.issues) ? d.issues : [];
  }
}

const BASE = "/api/workflows";
const OPTS: RequestInit = { cache: "no-store" };

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return json(await fetch(BASE, OPTS));
}

export async function createWorkflow(
  name: string, description = "",
): Promise<WorkflowDetail> {
  return json(await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  }));
}

export async function getWorkflow(id: string): Promise<WorkflowDetail> {
  return json(await fetch(`${BASE}/${id}`, OPTS));
}

export async function updateWorkflow(
  id: string,
  patch: {
    name?: string;
    description?: string;
    graph?: WorkflowGraph;
    variables?: Record<string, unknown>;
    triggers?: TriggerSpec[];
  },
): Promise<WorkflowDetail> {
  return json(await fetch(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteWorkflow(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new ApiError(`${res.status}`, res.status);
}

export async function validateWorkflow(
  id: string,
): Promise<{ ok: boolean; issues: GraphIssue[] }> {
  return json(await fetch(`${BASE}/${id}/validate`, { method: "POST" }));
}

export async function publishWorkflow(
  id: string,
): Promise<{ version: number; status: string }> {
  return json(await fetch(`${BASE}/${id}/publish`, { method: "POST" }));
}

export async function disableWorkflow(id: string): Promise<{ status: string }> {
  return json(await fetch(`${BASE}/${id}/disable`, { method: "POST" }));
}

export async function runWorkflow(
  id: string, payload: Record<string, unknown>, draft: boolean,
): Promise<{ run_id: string; status: string; version: number }> {
  return json(await fetch(`${BASE}/${id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, draft }),
  }));
}

export async function listRuns(id: string, limit = 25): Promise<RunSummary[]> {
  return json(await fetch(`${BASE}/${id}/runs?limit=${limit}`, OPTS));
}

export async function getRun(runId: string): Promise<RunDetail> {
  return json(await fetch(`${BASE}/runs/${runId}`, OPTS));
}

export async function getCatalog(): Promise<Catalog> {
  return json(await fetch(`${BASE}/catalog`, OPTS));
}

// ── Module Studio ────────────────────────────────────────────────────────────

export async function listModules(): Promise<ModuleSummary[]> {
  return json(await fetch(`${BASE}/modules`, OPTS));
}

export async function getModule(id: string): Promise<ModuleDetail> {
  return json(await fetch(`${BASE}/modules/${id}`, OPTS));
}

export async function createModule(module: {
  name: string;
  description?: string;
  code: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  status?: string;
}): Promise<ModuleDetail> {
  return json(await fetch(`${BASE}/modules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(module),
  }));
}

export async function updateModule(
  id: string,
  patch: Partial<{
    name: string; description: string; code: string;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    status: string;
  }>,
): Promise<ModuleDetail> {
  return json(await fetch(`${BASE}/modules/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function deleteModule(id: string): Promise<void> {
  const res = await fetch(`${BASE}/modules/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new ApiError(`${res.status}`, res.status);
}

export async function testModuleCode(
  code: string, inputs: Record<string, unknown>,
): Promise<{ ok: boolean; output?: unknown; error?: string; violations?: unknown[] }> {
  return json(await fetch(`${BASE}/modules/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, inputs }),
  }));
}

export async function generateModule(body: {
  prompt: string;
  current_code?: string;
  history?: { role: string; content: string }[];
}): Promise<{ ok: boolean; module: GeneratedModule; violations: unknown[] }> {
  return json(await fetch(`${BASE}/modules/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

// ── Semantic catalog search + Workflow Copilot ──────────────────────────────

export async function searchCatalog(
  q: string, kinds?: string[],
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  if (kinds?.length) params.set("kinds", kinds.join(","));
  return json(await fetch(`${BASE}/catalog/search?${params}`, OPTS));
}

export async function askCopilot(
  workflowId: string,
  message: string,
  history: { role: string; content: string }[],
): Promise<CopilotResponse> {
  return json(await fetch(`${BASE}/${workflowId}/copilot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  }));
}
