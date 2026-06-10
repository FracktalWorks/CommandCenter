"use client";

/**
 * GitHubDeviceConnect
 *
 * Guides the user through connecting a GitHub account.
 * Two paths are offered side-by-side in the setup phase:
 *   Option A (recommended) — paste a classic PAT with repo + copilot scopes
 *   Option B — OAuth Device Flow (needs a Client ID first)
 *
 * Phases:
 *  "setup"        → Instructions + PAT field + Client ID field
 *  "saving"       → Saving credentials to .env
 *  "ready"        → Client ID saved (no PAT); show "Connect GitHub Account" button
 *  "starting"     → Calling device/start
 *  "flow"         → Showing user_code + polling for approval
 *  "authorized"   → Token saved; shows GitHub login + success
 *  "expired"      → Code expired; offer restart
 *  "denied"       → User cancelled
 *  "error"        → Unexpected failure
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | "setup"
  | "saving"
  | "ready"
  | "starting"
  | "flow"
  | "authorized"
  | "expired"
  | "denied"
  | "error";

interface DeviceFlowInfo {
  user_code: string;
  verification_uri: string;
  device_code: string;
  expires_in: number;
  interval: number;
}

interface GitHubDeviceConnectProps {
  /** Full integration status item for the "github" service. */
  integration: IntegrationStatus;
  /** Called when the token has been saved and the account is connected. */
  onConfigured: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Copy text to clipboard; falls back to noop when API unavailable. */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore — user can copy manually */
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GitHubDeviceConnect({
  integration,
  onConfigured,
}: GitHubDeviceConnectProps) {
  // Detect initial phase:
  // - If GITHUB_TOKEN is already set → "authorized" (PAT path is done)
  // - If only GITHUB_CLIENT_ID is set → "ready" (can start device flow)
  // - If neither is set → "setup" (show both fields)
  const hasToken = !integration.missing_keys?.includes("GITHUB_TOKEN");
  const hasClientId = !integration.missing_keys?.includes("GITHUB_CLIENT_ID");

  const initialPhase: Phase = hasToken
    ? "authorized"
    : hasClientId
    ? "ready"
    : "setup";

  const [phase, setPhase] = useState<Phase>(initialPhase);

  const [tokenInput, setTokenInput] = useState("");
  const [clientIdInput, setClientIdInput] = useState("");
  const [deviceInfo, setDeviceInfo] = useState<DeviceFlowInfo | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Polling
  const pollInterval = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalSeconds = useRef(5);

  const stopPolling = useCallback(() => {
    if (pollInterval.current) {
      clearTimeout(pollInterval.current);
      pollInterval.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ---------------------------------------------------------------------------
  // Step 1: Save credentials (PAT and/or Client ID)
  // ---------------------------------------------------------------------------

  const handleSaveCredentials = async () => {
    const hasPat = tokenInput.trim();
    const hasCid = clientIdInput.trim();
    if (!hasPat && !hasCid) return;
    setPhase("saving");
    try {
      const vars: { key: string; value: string }[] = [];
      if (hasPat) vars.push({ key: "GITHUB_TOKEN", value: tokenInput.trim() });
      if (hasCid) vars.push({ key: "GITHUB_CLIENT_ID", value: clientIdInput.trim() });

      const res = await fetch("/api/integrations/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars }),
      });
      if (res.ok) {
        // If PAT was provided, skip device flow — go straight to authorized.
        if (hasPat) {
          setPhase("authorized");
          setTimeout(onConfigured, 1200);
        } else {
          // Only Client ID saved — proceed to device flow.
          setPhase("ready");
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(String(data.error ?? `Save failed (${res.status})`));
        setPhase("error");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  // ---------------------------------------------------------------------------
  // Step 2: Start Device Flow
  // ---------------------------------------------------------------------------

  const handleStartDeviceFlow = async () => {
    setPhase("starting");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/integrations/github/device/start", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(String(data.error ?? `Start failed (${res.status})`));
        setPhase("error");
        return;
      }
      setDeviceInfo(data as DeviceFlowInfo);
      pollIntervalSeconds.current = data.interval ?? 5;
      setPhase("flow");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  // ---------------------------------------------------------------------------
  // Step 3: Poll for approval
  // ---------------------------------------------------------------------------

  const pollOnce = useCallback(async () => {
    if (!deviceInfo) return;
    try {
      const res = await fetch("/api/integrations/github/device/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceInfo.device_code }),
      });
      const data = await res.json();

      if (data.status === "authorized") {
        stopPolling();
        setLogin(data.login ?? null);
        setPhase("authorized");
        // Brief pause so the user sees the success state, then notify parent
        setTimeout(onConfigured, 1800);
        return;
      }
      if (data.status === "slow_down") {
        pollIntervalSeconds.current = data.interval ?? pollIntervalSeconds.current + 5;
      }
      if (data.status === "expired") {
        stopPolling();
        setPhase("expired");
        return;
      }
      if (data.status === "denied") {
        stopPolling();
        setPhase("denied");
        return;
      }
      // "pending" or "slow_down" — schedule next poll
      pollInterval.current = setTimeout(pollOnce, pollIntervalSeconds.current * 1000);
    } catch {
      // Network blip — retry after a longer wait
      pollInterval.current = setTimeout(pollOnce, 10_000);
    }
  }, [deviceInfo, stopPolling, onConfigured]);

  // Start polling when we enter the "flow" phase
  useEffect(() => {
    if (phase === "flow" && deviceInfo) {
      stopPolling();
      pollInterval.current = setTimeout(pollOnce, pollIntervalSeconds.current * 1000);
    }
  }, [phase, deviceInfo, pollOnce, stopPolling]);

  // ---------------------------------------------------------------------------
  // Copy helper
  // ---------------------------------------------------------------------------

  const handleCopy = async (text: string) => {
    await copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const cardClass = `rounded-xl border p-6 space-y-4 transition-colors ${
    phase === "authorized"
      ? "border-emerald-500 bg-emerald-500/5"
      : "border-neutral-700 bg-neutral-900"
  }`;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={cardClass}>
      {/* Header — always shown */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <GitHubIcon className="w-4 h-4 text-neutral-300" />
            <span className="font-semibold text-neutral-100">GitHub</span>
            {phase === "authorized" && (
              <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                ✓ Connected{login ? ` as ${login}` : ""}
              </span>
            )}
          </div>
          <p className="text-sm text-neutral-400 mt-0.5">
            {integration.description}
          </p>
        </div>
        <a
          href="https://github.com/settings/tokens/new?scopes=copilot,repo"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
        >
          Create PAT →
        </a>
      </div>

      {/* Phase: setup — collect PAT (recommended) and/or Client ID */}
      {(phase === "setup" || phase === "saving") && (
        <div className="space-y-4">
          <pre className="text-xs text-neutral-400 bg-neutral-800/60 rounded-lg p-4 whitespace-pre-wrap leading-relaxed">
            {integration.instructions}
          </pre>

          {/* Option A: PAT (recommended) */}
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                RECOMMENDED
              </span>
              <span className="text-sm font-medium text-neutral-200">Option A — Personal Access Token</span>
            </div>
            <p className="text-xs text-neutral-500">
              Paste a classic PAT with <code className="text-neutral-400">repo</code> +{" "}
              <code className="text-neutral-400">copilot</code> scopes. Covers both
              private repo cloning and Copilot model access.
            </p>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                Personal Access Token
                <span className="ml-2 font-mono text-neutral-500 text-xs">(GITHUB_TOKEN)</span>
              </label>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="ghp_… or github_pat_…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveCredentials()}
                className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-emerald-500 transition-colors font-mono"
              />
            </div>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-neutral-700" />
            <span className="text-xs text-neutral-600">or use device flow</span>
            <div className="h-px flex-1 bg-neutral-700" />
          </div>

          {/* Option B: OAuth Client ID */}
          <div className="rounded-lg border border-neutral-700 bg-neutral-900/50 p-4 space-y-3">
            <span className="text-sm font-medium text-neutral-400">Option B — OAuth Device Flow</span>
            <p className="text-xs text-neutral-500">
              Create an OAuth App first, then paste its Client ID below. No
              token entry needed — you'll authenticate in the browser.
            </p>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">
                OAuth App Client ID
                <span className="ml-2 font-mono text-neutral-500 text-xs">(GITHUB_CLIENT_ID)</span>
              </label>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Ov23li…"
                value={clientIdInput}
                onChange={(e) => setClientIdInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveCredentials()}
                className="w-full px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-blue-500 transition-colors font-mono"
              />
            </div>
          </div>

          <button
            onClick={() => void handleSaveCredentials()}
            disabled={(!tokenInput.trim() && !clientIdInput.trim()) || phase === "saving"}
            className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
          >
            {phase === "saving" ? "Saving…" : tokenInput.trim() ? "Save & Connect →" : "Save & Continue →"}
          </button>
        </div>
      )}

      {/* Phase: ready — offer to start device flow */}
      {phase === "ready" && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-400">
            Click below to authenticate a GitHub account via Device Flow. You'll
            be shown a short code to enter at{" "}
            <span className="text-blue-400 font-mono">github.com/login/device</span>.
          </p>
          <button
            onClick={() => void handleStartDeviceFlow()}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-neutral-100 hover:bg-white text-neutral-900 text-sm font-semibold transition-colors"
          >
            <GitHubIcon className="w-4 h-4" />
            Connect GitHub Account
          </button>
        </div>
      )}

      {/* Phase: starting */}
      {phase === "starting" && (
        <div className="flex items-center gap-3 text-neutral-400 text-sm">
          <div className="w-4 h-4 border-2 border-neutral-600 border-t-blue-500 rounded-full animate-spin shrink-0" />
          Requesting code from GitHub…
        </div>
      )}

      {/* Phase: flow — show user code + poll */}
      {phase === "flow" && deviceInfo && (
        <div className="space-y-4">
          {/* Step instructions */}
          <div className="space-y-1">
            <p className="text-sm text-neutral-300 font-medium">
              1. Open{" "}
              <a
                href={deviceInfo.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                {deviceInfo.verification_uri}
              </a>
            </p>
            <p className="text-sm text-neutral-300 font-medium">
              2. Enter this code:
            </p>
          </div>

          {/* User code display */}
          <div className="flex items-center gap-3">
            <div className="flex-1 text-center text-3xl font-mono font-bold tracking-[0.3em] text-neutral-100 bg-neutral-800 border border-neutral-600 rounded-xl py-4 select-all">
              {deviceInfo.user_code}
            </div>
            <button
              onClick={() => void handleCopy(deviceInfo.user_code)}
              className="px-3 py-2 rounded-lg border border-neutral-600 hover:bg-neutral-800 text-sm text-neutral-300 transition-colors shrink-0"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          {/* Open GitHub button */}
          <a
            href={deviceInfo.verification_uri}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-neutral-100 hover:bg-white text-neutral-900 text-sm font-semibold transition-colors"
          >
            <GitHubIcon className="w-4 h-4" />
            Open GitHub Device Activation →
          </a>

          {/* Polling indicator */}
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <div className="w-3 h-3 border border-neutral-600 border-t-blue-500 rounded-full animate-spin shrink-0" />
            Waiting for you to approve on GitHub…
            <span className="ml-auto">
              Code expires in ~{Math.round(deviceInfo.expires_in / 60)} min
            </span>
          </div>
        </div>
      )}

      {/* Phase: authorized */}
      {phase === "authorized" && (
        <div className="flex items-center gap-3 text-emerald-400 text-sm">
          <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span>
            GitHub {login ? <span>account <strong className="text-emerald-300">{login}</strong></span> : "token"} connected.
            Ready to clone private repos.
          </span>
        </div>
      )}

      {/* Phase: expired */}
      {phase === "expired" && (
        <div className="space-y-3">
          <p className="text-sm text-amber-400">
            The code expired before you approved it. That's OK — just try again.
          </p>
          <button
            onClick={() => void handleStartDeviceFlow()}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200 transition-colors"
          >
            Restart Device Flow
          </button>
        </div>
      )}

      {/* Phase: denied */}
      {phase === "denied" && (
        <div className="space-y-3">
          <p className="text-sm text-red-400">
            Access was denied on GitHub. You can try again and approve the
            request this time.
          </p>
          <button
            onClick={() => void handleStartDeviceFlow()}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200 transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Phase: error */}
      {phase === "error" && (
        <div className="space-y-3">
          <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            {errorMsg ?? "An unexpected error occurred."}
          </div>
          <button
            onClick={() => {
              setErrorMsg(null);
              setPhase(initialPhase);
            }}
            className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200 transition-colors"
          >
            ← Back
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub icon (inline SVG — avoids extra dependencies)
// ---------------------------------------------------------------------------

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.73.084-.73 1.205.086 1.838 1.238 1.838 1.238 1.07 1.834 2.807 1.304 3.492.997.108-.775.418-1.305.762-1.605-2.665-.3-5.467-1.332-5.467-5.93 0-1.31.468-2.38 1.235-3.22-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23a11.5 11.5 0 0 1 3.003-.404c1.02.005 2.046.138 3.003.404 2.29-1.552 3.296-1.23 3.296-1.23.654 1.652.243 2.873.12 3.176.77.84 1.233 1.91 1.233 3.22 0 4.61-2.807 5.625-5.48 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .32.216.694.825.576C20.565 21.796 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
