"use client";

/**
 * /integrations — Integration Management Page
 *
 * Shows all connected integrations and their status.
 * Allows re-testing and re-configuring any integration.
 * New integrations are added via the AddAgentWizard flow.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import type { AgentEntry } from "@/app/api/agent/list/route";
import GitHubAccountBadge from "@/components/GitHubAccountBadge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
      <span className="w-1.5 h-1.5 rounded-full bg-success" />
      Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-500 border border-neutral-700">
      <span className="w-1.5 h-1.5 rounded-full bg-neutral-600" />
      Not configured
    </span>
  );
}

// Which agents use a given service, split by mandatory vs optional
function AgentBadges({
  service,
  agents,
}: {
  service: string;
  agents: AgentEntry[];
}) {
  const mandatory = agents.filter((a) => a.integrations?.includes(service));
  const optional = agents.filter((a) => a.optional_integrations?.includes(service));
  if (mandatory.length === 0 && optional.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap items-center">
      {mandatory.map((a) => (
        <span
          key={a.name}
          className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-600/70 font-medium"
          title="Requires this integration"
        >
          {a.name}
        </span>
      ))}
      {optional.map((a) => (
        <span
          key={a.name}
          className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800/60 text-neutral-500 border border-dashed border-neutral-700/60"
          title="Optional for this agent"
        >
          {a.name}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline re-configure form
// ---------------------------------------------------------------------------

function ReconfigureForm({
  integration,
  onDone,
}: {
  integration: IntegrationStatus;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(integration.env_vars.map((v) => [v.key, ""]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vars: Object.entries(values)
            .filter(([, v]) => v.trim())
            .map(([key, value]) => ({ key, value })),
        }),
      });
      if (res.ok) {
        onDone();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(String(data.error ?? `Save failed (${res.status})`));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 border-t border-neutral-800 pt-4">
      {integration.env_vars.map((v) => (
        <div key={v.key}>
          <label className="block text-xs text-neutral-400 mb-1">
            {v.label}
            <span className="ml-2 font-mono text-neutral-600 text-xs">({v.key})</span>
          </label>
          <input
            type={v.sensitive ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[v.key] ?? ""}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [v.key]: e.target.value }))
            }
            placeholder={`Enter ${v.label}…`}
            className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-primary transition-colors"
          />
        </div>
      ))}
      {error && (
        <p className="text-sm text-destructive bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex-1 py-2 rounded-lg bg-primary hover:bg-blue-500 disabled:opacity-40 text-sm font-medium text-white transition-colors"
        >
          {saving ? "Saving…" : "Save credentials"}
        </button>
        <button
          onClick={onDone}
          className="px-4 py-2 rounded-lg border border-neutral-700 hover:bg-neutral-800 text-sm text-neutral-400 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration card (full detail view for the integrations page)
// ---------------------------------------------------------------------------

function IntegrationCard({
  integration,
  agents,
  onRefresh,
}: {
  integration: IntegrationStatus;
  agents: AgentEntry[];
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(!integration.configured);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    detail: string;
  } | null>(null);
  const [reconfiguring, setReconfiguring] = useState(false);

  // Agents that require this integration and are blocked by it being unconfigured
  const blockedAgents = !integration.configured
    ? agents.filter((a) => a.integrations?.includes(integration.service))
    : [];

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(
        `/api/integrations/test?service=${encodeURIComponent(integration.service)}`
      );
      const data: { ok: boolean; detail: string } = await res.json();
      setTestResult({ ok: data.ok, detail: data.detail });
    } catch (err) {
      setTestResult({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className={`rounded-xl border transition-colors ${
        integration.configured
          ? "border-neutral-700 bg-neutral-900"
          : "border-neutral-700/60 bg-neutral-900/60"
      }`}
    >
      {/* Header row */}
      <div
        className="flex items-center justify-between gap-4 p-5 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-neutral-100">{integration.label}</span>
              <StatusBadge configured={integration.configured} />
              {/* "Used for" pills — shown when the integration serves multiple purposes */}
              {(integration.uses ?? []).length > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-neutral-400">
                  <span className="text-neutral-600">Used for:</span>
                  {integration.uses!.map((u) => (
                    <span
                      key={u}
                      className={`px-1.5 py-0.5 rounded font-medium border ${
                        u === "Models"
                          ? "bg-violet-500/10 text-violet-400 border-violet-500/25"
                          : "bg-blue-500/10 text-primary border-blue-500/25"
                      }`}
                    >
                      {u}
                    </span>
                  ))}
                </span>
              )}
              {blockedAgents.length > 0 && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  ⚠ blocks {blockedAgents.length} agent{blockedAgents.length > 1 ? "s" : ""}
                </span>
              )}
            </div>
            <p className="text-xs text-neutral-500 mt-0.5">{integration.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {agents.some(
            (a) =>
              a.integrations?.includes(integration.service) ||
              a.optional_integrations?.includes(integration.service)
          ) && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Used by</span>
              <AgentBadges service={integration.service} agents={agents} />
            </div>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="text-neutral-600 hover:text-neutral-400 transition-colors text-xs"
          >
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-neutral-800">
          {/* Blocked agents callout */}
          {blockedAgents.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-800/40 bg-amber-950/30 px-3 py-2.5">
              <span className="text-xs text-amber-400 font-medium shrink-0">Blocked agents:</span>
              {blockedAgents.map((a) => (
                <span key={a.name} className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/40">
                  {a.name}
                </span>
              ))}
              <span className="text-xs text-warning/70 ml-auto">Configure below to unblock</span>
            </div>
          )}
          {/* GitHub: unified account badge + CLI import + device flow */}
          {integration.service === "github" && (
            <div className="pt-4">
              <GitHubAccountBadge
                integration={integration}
                onRefresh={() => {
                  setExpanded(false);
                  onRefresh();
                }}
              />
            </div>
          )}

          {/* Non-GitHub integrations */}
          {integration.service !== "github" && (
            <>
              {/* Setup instructions */}
              {integration.instructions && !reconfiguring && (
                <pre className="mt-4 text-xs text-neutral-500 bg-neutral-800/60 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">
                  {integration.instructions}
                </pre>
              )}

              {/* Links */}
              {!reconfiguring && (
                <div className="flex gap-2 flex-wrap mt-3">
                  {integration.setup_url && (
                    <a
                      href={integration.setup_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 text-primary hover:bg-blue-500/10 transition-colors"
                    >
                      Get credentials →
                    </a>
                  )}
                  {integration.docs_url && (
                    <a
                      href={integration.docs_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-500 hover:bg-neutral-800 transition-colors"
                    >
                      Docs
                    </a>
                  )}
                  <button
                    onClick={() => void handleTest()}
                    disabled={testing || !integration.configured}
                    className="text-xs px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-400 hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {testing ? "Testing…" : "Test connection"}
                  </button>
                  <button
                    onClick={() => setReconfiguring(true)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-400 hover:bg-neutral-800 transition-colors"
                  >
                    {integration.configured ? "Update credentials" : "Configure"}
                  </button>
                </div>
              )}

              {/* Test result for non-GitHub */}
              {testResult && !reconfiguring && (
                <div
                  className={`text-xs rounded-lg px-3 py-2 ${
                    testResult.ok
                      ? "text-emerald-400 bg-emerald-500/10"
                      : "text-amber-400 bg-amber-500/10"
                  }`}
                >
                  {testResult.ok ? "✓" : "✗"} {testResult.detail}
                </div>
              )}

              {/* Inline reconfigure form */}
              {reconfiguring && (
                <ReconfigureForm
                  integration={integration}
                  onDone={() => {
                    setReconfiguring(false);
                    onRefresh();
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const hasFetched = useRef(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [intgRes, agentRes] = await Promise.all([
        fetch("/api/integrations/status"),
        fetch("/api/agent/list"),
      ]);
      const [intgData, agentData] = await Promise.all([
        intgRes.json(),
        agentRes.json(),
      ]);
      setIntegrations(Array.isArray(intgData) ? intgData : []);
      setAgents(Array.isArray(agentData) ? agentData : []);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      void fetchAll();
    }
  }, [fetchAll]);

  const configured = integrations.filter((i) => i.configured);
  const unconfigured = integrations.filter((i) => !i.configured);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-neutral-100">Integrations</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Manage credentials for all external services used by your agents.
            Integrations labelled <span className="text-violet-400 font-medium">Models</span> also
            provide LLM access to the tier router.
            New integrations are configured when you add an agent.
          </p>
        </div>
        <button
          onClick={() => void fetchAll()}
          className="text-xs px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-400 hover:bg-neutral-800 transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-neutral-500 text-sm py-12 justify-center">
          <div className="w-4 h-4 border-2 border-neutral-700 border-t-blue-500 rounded-full animate-spin" />
          Loading integrations…
        </div>
      ) : (
        <>
          {/* Not configured */}
          {unconfigured.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-neutral-300">
                  Needs setup
                </h2>
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  {unconfigured.length}
                </span>
              </div>
              <div className="space-y-2">
                {unconfigured.map((intg) => (
                  <IntegrationCard
                    key={intg.service}
                    integration={intg}
                    agents={agents}
                    onRefresh={() => void fetchAll()}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Configured */}
          {configured.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-neutral-300">
                Connected ({configured.length})
              </h2>
              <div className="space-y-2">
                {configured.map((intg) => (
                  <IntegrationCard
                    key={intg.service}
                    integration={intg}
                    agents={agents}
                    onRefresh={() => void fetchAll()}
                  />
                ))}
              </div>
            </section>
          )}

          {integrations.length === 0 && (
            <div className="text-center text-neutral-600 text-sm py-16">
              No integrations found. Add an agent to get started.
            </div>
          )}
        </>
      )}
    </div>
  );
}
