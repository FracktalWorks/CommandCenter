"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import GitHubDeviceConnect from "@/components/GitHubDeviceConnect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  ok: boolean;
  detail: string;
}

interface ServiceCardState {
  values: Record<string, string>;
  saving: boolean;
  testing: boolean;
  testResult: TestResult | null;
  saved: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Single integration card
// ---------------------------------------------------------------------------

function IntegrationCard({
  integration,
  cardState,
  onValuesChange,
  onSave,
  onTest,
}: {
  integration: IntegrationStatus;
  cardState: ServiceCardState;
  onValuesChange: (key: string, value: string) => void;
  onSave: () => void;
  onTest: () => void;
}) {
  const { values, saving, testing, testResult, saved, error } = cardState;
  const allFilled = integration.env_vars.every((v) => values[v.key]?.trim());

  return (
    <div
      className={`rounded-xl border p-6 space-y-4 transition-colors ${
        saved
          ? "border-emerald-500 bg-emerald-500/5"
          : "border-neutral-700 bg-neutral-900"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-100">
              {integration.label}
            </span>
            {saved && (
              <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                ✓ Configured
              </span>
            )}
          </div>
          <p className="text-sm text-neutral-400 mt-0.5">
            {integration.description}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {integration.setup_url && (
            <a
              href={integration.setup_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/40 text-blue-400 hover:opacity-90/10 transition-colors"
            >
              Get credentials →
            </a>
          )}
          {integration.docs_url && (
            <a
              href={integration.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded-lg border border-neutral-600 text-neutral-400 hover:bg-neutral-800 transition-colors"
            >
              Docs
            </a>
          )}
        </div>
      </div>

      {/* Instructions */}
      {integration.instructions && !saved && (
        <pre className="text-xs text-neutral-400 bg-neutral-800/60 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">
          {integration.instructions}
        </pre>
      )}

      {/* Input fields */}
      {!saved && (
        <div className="space-y-3">
          {integration.env_vars.map((envVar) => (
            <div key={envVar.key}>
              <label className="block text-xs text-neutral-400 mb-1">
                {envVar.label}
                <span className="ml-2 font-mono text-neutral-500 text-xs">
                  ({envVar.key})
                </span>
              </label>
              <input
                type={envVar.sensitive ? "password" : "text"}
                autoComplete={envVar.sensitive ? "off" : "on"}
                spellCheck={false}
                value={values[envVar.key] ?? ""}
                onChange={(e) => onValuesChange(envVar.key, e.target.value)}
                placeholder={`Enter ${envVar.label}…`}
                className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div
          className={`text-sm rounded-lg px-3 py-2 ${
            testResult.ok
              ? "text-emerald-400 bg-emerald-500/10"
              : "text-amber-400 bg-amber-500/10"
          }`}
        >
          {testResult.ok ? "✓" : "✗"} {testResult.detail}
        </div>
      )}

      {/* Action buttons */}
      {!saved && (
        <div className="flex gap-3 pt-1">
          <button
            onClick={onSave}
            disabled={!allFilled || saving}
            className="flex-1 py-2 rounded-lg bg-blue-600 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
          >
            {saving ? "Saving…" : "Save credentials"}
          </button>
          <button
            onClick={onTest}
            disabled={!saved && !allFilled || testing}
            className="px-4 py-2 rounded-lg border border-neutral-600 hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed text-sm text-neutral-300 transition-colors"
          >
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
      )}

      {/* Re-test after saved */}
      {saved && (
        <div className="flex gap-3 pt-1">
          <button
            onClick={onTest}
            disabled={testing}
            className="px-4 py-2 rounded-lg border border-neutral-600 hover:bg-neutral-800 disabled:opacity-40 text-sm text-neutral-300 transition-colors"
          >
            {testing ? "Testing…" : "Re-test connection"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

interface IntegrationSetupProps {
  agentName: string;
  onComplete: () => void;
}

export default function IntegrationSetup({
  agentName,
  onComplete,
}: IntegrationSetupProps) {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [cardStates, setCardStates] = useState<
    Record<string, ServiceCardState>
  >({});
  const hasFetched = useRef(false);

  // Fetch integration status
  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(
        `/api/integrations/status?agent=${encodeURIComponent(agentName)}`
      );
      const data: IntegrationStatus[] = await res.json();
      if (!res.ok) {
        setFetchError(String((data as any).error ?? `HTTP ${res.status}`));
        return;
      }
      const missing = data.filter((d) => !d.configured);
      setIntegrations(missing);
      // Initialise card state for each missing integration
      setCardStates((prev) => {
        const next = { ...prev };
        for (const intg of missing) {
          if (!next[intg.service]) {
            next[intg.service] = {
              values: Object.fromEntries(intg.env_vars.map((v) => [v.key, ""])),
              saving: false,
              testing: false,
              testResult: null,
              saved: false,
              error: null,
            };
          }
        }
        return next;
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      void fetchStatus();
    }
  }, [fetchStatus]);

  // Update a field value in a card
  const handleValueChange = (service: string, key: string, value: string) => {
    setCardStates((prev) => ({
      ...prev,
      [service]: {
        ...prev[service],
        values: { ...prev[service].values, [key]: value },
        error: null,
      },
    }));
  };

  // Save credentials for one integration
  const handleSave = async (service: string) => {
    const state = cardStates[service];
    if (!state) return;
    setCardStates((prev) => ({
      ...prev,
      [service]: { ...prev[service], saving: true, error: null },
    }));
    try {
      const payload = {
        vars: Object.entries(state.values)
          .filter(([, v]) => v.trim())
          .map(([key, value]) => ({ key, value })),
      };
      const res = await fetch("/api/integrations/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setCardStates((prev) => ({
          ...prev,
          [service]: { ...prev[service], saving: false, saved: true },
        }));
      } else {
        const data = await res.json().catch(() => ({}));
        setCardStates((prev) => ({
          ...prev,
          [service]: {
            ...prev[service],
            saving: false,
            error: String(data.error ?? `Save failed (${res.status})`),
          },
        }));
      }
    } catch (err) {
      setCardStates((prev) => ({
        ...prev,
        [service]: {
          ...prev[service],
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  // Test a connection
  const handleTest = async (service: string) => {
    setCardStates((prev) => ({
      ...prev,
      [service]: { ...prev[service], testing: true, testResult: null },
    }));
    try {
      const res = await fetch(
        `/api/integrations/test?service=${encodeURIComponent(service)}`
      );
      const data: { ok: boolean; detail: string } = await res.json();
      setCardStates((prev) => ({
        ...prev,
        [service]: {
          ...prev[service],
          testing: false,
          testResult: { ok: data.ok, detail: data.detail },
        },
      }));
    } catch (err) {
      setCardStates((prev) => ({
        ...prev,
        [service]: {
          ...prev[service],
          testing: false,
          testResult: {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        },
      }));
    }
  };

  // Mark a service as configured (used by special-case components like GitHubDeviceConnect)
  const handleServiceConfigured = (service: string) => {
    setCardStates((prev) => ({
      ...prev,
      [service]: {
        ...(prev[service] ?? {
          values: {},
          saving: false,
          testing: false,
          testResult: null,
          error: null,
        }),
        saved: true,
      },
    }));
  };

  // Check if all integrations are saved
  const allSaved =
    integrations.length > 0 && integrations.every((i) => cardStates[i.service]?.saved);

  // Once all are saved, allow proceeding
  const handleComplete = () => {
    onComplete();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-400">
        <div className="w-6 h-6 border-2 border-neutral-600 border-t-blue-500 rounded-full animate-spin" />
        <span className="text-sm">Checking integrations…</span>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
        <p className="text-red-400 text-sm text-center">{fetchError}</p>
        <button
          onClick={() => void fetchStatus()}
          className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (integrations.length === 0) {
    // Nothing missing — shouldn't normally land here but handle gracefully
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-emerald-400 text-sm">All integrations are configured.</p>
        <button
          onClick={onComplete}
          className="px-4 py-2 rounded-lg bg-primary hover:opacity-90 text-sm text-primary-foreground transition-colors"
        >
          Start chatting
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-5 border-b border-neutral-800">
        <h2 className="text-lg font-semibold text-neutral-100">
          Set up integrations for{" "}
          <span className="text-blue-400">{agentName}</span>
        </h2>
        <p className="text-sm text-neutral-400 mt-1">
          This agent needs access to{" "}
          {integrations.length === 1
            ? "1 external service"
            : `${integrations.length} external services`}{" "}
          to run. Configure each integration below, then start chatting.
        </p>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {integrations.map((intg) =>
          intg.service === "github" ? (
            // GitHub uses the OAuth Device Flow wizard instead of plain inputs
            <GitHubDeviceConnect
              key={intg.service}
              integration={intg}
              onConfigured={() => handleServiceConfigured("github")}
            />
          ) : (
            <IntegrationCard
              key={intg.service}
              integration={intg}
              cardState={
                cardStates[intg.service] ?? {
                  values: {},
                  saving: false,
                  testing: false,
                  testResult: null,
                  saved: false,
                  error: null,
                }
              }
              onValuesChange={(key, value) =>
                handleValueChange(intg.service, key, value)
              }
              onSave={() => void handleSave(intg.service)}
              onTest={() => void handleTest(intg.service)}
            />
          )
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-neutral-800 flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          Credentials are saved to .env on the server. Restart services for
          Docker deployments.
        </p>
        <button
          onClick={handleComplete}
          disabled={!allSaved}
          className="px-5 py-2 rounded-lg bg-success hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-success-foreground transition-colors"
        >
          {allSaved ? "Start chatting →" : "Configure all integrations to continue"}
        </button>
      </div>
    </div>
  );
}
