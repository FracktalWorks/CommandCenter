"use client";

/**
 * GitHubAccountBadge
 *
 * Shows the currently connected GitHub account details and provides:
 *  - One-click "Import from GitHub CLI" when gh CLI is authenticated
 *  - A scope warning + command to copy when the `copilot` scope is missing
 *  - A "Reconnect" button that opens the device-flow wizard
 *
 * Used inside IntegrationCard for the "github" service, for both
 * the configured and unconfigured states.
 */

import React, { useCallback, useEffect, useState } from "react";
import type { GitHubAccountInfo } from "@/app/api/integrations/github/account/route";
import GitHubDeviceConnect from "@/components/GitHubDeviceConnect";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// ScopePill
// ---------------------------------------------------------------------------

function ScopePill({ scope, active }: { scope: string; active: boolean }) {
  return (
    <span
      className={`inline-flex text-[10px] px-1.5 py-0.5 rounded font-mono border ${
        active
          ? scope === "copilot"
            ? "bg-violet-500/10 text-violet-400 border-violet-500/25"
            : "bg-zinc-800 text-zinc-400 border-zinc-700"
          : "bg-zinc-900 text-zinc-700 border-zinc-800 line-through"
      }`}
    >
      {scope}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GitHubAccountBadgeProps {
  integration: IntegrationStatus;
  onRefresh: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GitHubAccountBadge({
  integration,
  onRefresh,
}: GitHubAccountBadgeProps) {
  const [info, setInfo] = useState<GitHubAccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    ok: boolean;
    login?: string;
    has_copilot?: boolean;
    refresh_command?: string | null;
    message?: string;
    error?: string;
  } | null>(null);
  const [showDeviceFlow, setShowDeviceFlow] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/github/account");
      if (res.ok) setInfo(await res.json());
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInfo();
  }, [fetchInfo]);

  const handleConnectCli = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/integrations/github/connect-cli", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.ok) {
        setImportResult({ ok: true, ...data });
        await fetchInfo();
        onRefresh();
      } else {
        setImportResult({ ok: false, error: data.error ?? data.detail ?? "Unknown error" });
      }
    } catch (err) {
      setImportResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setImporting(false);
    }
  };

  const handleCopyCmd = async (cmd: string) => {
    await copyToClipboard(cmd);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-600 py-2">
        <div className="w-3 h-3 border border-zinc-700 border-t-zinc-500 rounded-full animate-spin" />
        Checking GitHub…
      </div>
    );
  }

  const isConfigured = integration.configured;

  return (
    <div className="space-y-3">
      {/* ----------------------------------------------------------------- */}
      {/* Connected account card (shown when GITHUB_TOKEN is set)           */}
      {/* ----------------------------------------------------------------- */}
      {isConfigured && info?.token_login && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* GitHub mark */}
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-zinc-300 shrink-0">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span className="text-sm font-medium text-zinc-100">@{info.token_login}</span>
              <span className="text-[10px] text-zinc-500">connected</span>
            </div>
            {/* Scopes */}
            {info.token_scopes.length > 0 && (
              <div className="flex gap-1 flex-wrap mt-2 items-center">
                <span className="text-[10px] text-zinc-600 mr-1">scopes:</span>
                {["copilot", "repo"].map((s) => (
                  <ScopePill key={s} scope={s} active={info.token_scopes.includes(s)} />
                ))}
                {info.token_scopes
                  .filter((s) => s !== "copilot" && s !== "repo")
                  .map((s) => (
                    <ScopePill key={s} scope={s} active />
                  ))}
              </div>
            )}
            {/* Copilot scope warning */}
            {!info.token_has_copilot && (
              <div className="mt-2 flex items-start gap-2 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
                <span className="shrink-0 mt-0.5">⚠</span>
                <span>
                  Token lacks <code className="font-mono">copilot</code> scope — Copilot models
                  (GPT-4o, Claude Sonnet, o3-mini) are unavailable.
                </span>
              </div>
            )}
          </div>
          {/* Reconnect button */}
          <button
            onClick={() => setShowDeviceFlow((v) => !v)}
            className="shrink-0 text-[11px] px-2.5 py-1 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800 transition-colors"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Refresh-scopes hint (copilot scope missing on configured token)   */}
      {/* ----------------------------------------------------------------- */}
      {isConfigured && info?.token_configured && !info.token_has_copilot && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 space-y-2">
          <p className="text-xs text-zinc-400 font-medium">Add Copilot scope</p>
          <p className="text-[11px] text-zinc-500">
            Run this in your terminal, then click{" "}
            <span className="text-zinc-300">"Import from GitHub CLI"</span> below to update the stored token:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono text-violet-300 bg-zinc-800 px-2 py-1 rounded">
              gh auth refresh --scopes copilot,repo
            </code>
            <button
              onClick={() => void handleCopyCmd("gh auth refresh --scopes copilot,repo")}
              className="shrink-0 text-[10px] px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              {copiedCmd ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* GitHub CLI import option                                           */}
      {/* ----------------------------------------------------------------- */}
      {info?.gh_cli_available && (
        <div
          className={`rounded-lg border px-4 py-3 ${
            info.gh_cli_authenticated
              ? "border-zinc-700 bg-zinc-800/40"
              : "border-zinc-800 bg-zinc-900/40"
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-zinc-200">
                {info.gh_cli_authenticated
                  ? `Import from GitHub CLI ${info.gh_cli_login ? `(@${info.gh_cli_login})` : ""}`
                  : "GitHub CLI detected (not logged in)"}
              </p>
              {info.gh_cli_authenticated ? (
                <div className="flex gap-1 flex-wrap mt-1.5 items-center">
                  <span className="text-[10px] text-zinc-600 mr-1">CLI scopes:</span>
                  {["copilot", "repo"].map((s) => (
                    <ScopePill key={s} scope={s} active={info.gh_cli_scopes.includes(s)} />
                  ))}
                  {!info.gh_cli_has_copilot && (
                    <span className="text-[10px] text-amber-500 ml-1">
                      (copilot scope missing)
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-zinc-600 mt-0.5">
                  Run <code className="font-mono text-zinc-500">gh auth login</code> first.
                </p>
              )}
            </div>
            {info.gh_cli_authenticated && (
              <button
                onClick={() => void handleConnectCli()}
                disabled={importing}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-zinc-100 font-medium transition-colors"
              >
                {importing ? "Importing…" : isConfigured ? "Re-import" : "Import token"}
              </button>
            )}
          </div>

          {/* CLI import result */}
          {importResult && (
            <div
              className={`mt-3 text-[11px] rounded px-3 py-2 ${
                importResult.ok
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : "bg-red-500/10 text-red-400 border border-red-500/20"
              }`}
            >
              {importResult.ok ? "✓ " : "✗ "}
              {importResult.ok ? importResult.message : importResult.error}
              {importResult.ok && importResult.refresh_command && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-amber-400">
                    ⚠ Add copilot scope:
                  </span>
                  <code className="font-mono text-violet-300 bg-zinc-800 px-1.5 py-0.5 rounded">
                    {importResult.refresh_command}
                  </code>
                  <button
                    onClick={() => void handleCopyCmd(importResult.refresh_command!)}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  >
                    {copiedCmd ? "Copied!" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Device-flow fallback / "Reconnect" wizard                         */}
      {/* ----------------------------------------------------------------- */}
      {(!isConfigured || showDeviceFlow) && (
        <div className={isConfigured ? "border-t border-zinc-800 pt-3 mt-1" : ""}>
          {isConfigured && (
            <p className="text-[10px] text-zinc-600 mb-2 uppercase tracking-wider">
              Or reconnect via OAuth device flow
            </p>
          )}
          <GitHubDeviceConnect
            integration={integration}
            onConfigured={() => {
              setShowDeviceFlow(false);
              void fetchInfo();
              onRefresh();
            }}
          />
        </div>
      )}
    </div>
  );
}
