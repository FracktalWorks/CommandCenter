"use client";

import { useState } from "react";
import {
  type ProviderInfo,
  PROVIDER_COLOURS,
  PROVIDER_ICONS,
  PROVIDER_GUIDES,
} from "@/lib/model-types";

// ---------------------------------------------------------------------------
// ProviderCard — API key management + setup guide
// ---------------------------------------------------------------------------

export default function ProviderCard({
  provider,
  onKeySet,
  onKeyDiscard,
  copilotScopeOk,
}: {
  provider: ProviderInfo;
  onKeySet: (key: string) => Promise<void>;
  onKeyDiscard: (providerId: string) => Promise<void>;
  copilotScopeOk?: boolean | null;
}) {
  const [editing, setEditing] = useState(false);
  const [keyVal, setKeyVal] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // GitHub device flow state
  const [deviceFlow, setDeviceFlow] = useState<{
    deviceCode: string; userCode: string; verificationUri: string; interval: number;
  } | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<string>("");

  const isLocal = provider.id === "ollama" || provider.id === "vllm";
  const colour = PROVIDER_COLOURS[provider.id] ?? PROVIDER_COLOURS.unknown;
  const guide = PROVIDER_GUIDES[provider.id];

  const handleSave = async () => {
    if (!keyVal.trim()) return;
    setSaving(true);
    setKeyError(null);
    try {
      await onKeySet(keyVal.trim());
      setEditing(false);
      setKeyVal("");
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      await onKeyDiscard(provider.id);
      setConfirmDiscard(false);
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setDiscarding(false);
    }
  };

  // ── GitHub OAuth device flow ──────────────────────────────────────────
  const pollDeviceFlow = async (deviceCode: string, interval: number) => {
    try {
      const res = await fetch("/api/integrations/github/device/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      const data = await res.json();
      if (data.status === "authorized") {
        setDeviceStatus(`Connected as ${data.login ?? "GitHub user"}!`);
        setDeviceFlow(null);
        setTimeout(() => window.location.reload(), 1500);
      } else if (data.status === "pending") {
        setDeviceStatus("Waiting for authorization…");
        setTimeout(() => pollDeviceFlow(deviceCode, interval), interval);
      } else if (data.status === "slow_down") {
        const next = (data.interval ?? 10) * 1000;
        setDeviceStatus("Please wait…");
        setTimeout(() => pollDeviceFlow(deviceCode, next), next);
      } else {
        setDeviceStatus(`Failed: ${data.status}`);
        setDeviceFlow(null);
      }
    } catch (err) {
      setDeviceStatus(`Error: ${String(err)}`);
      setDeviceFlow(null);
    }
  };

  const startDeviceFlow = async () => {
    setDeviceStatus("Starting device flow…");
    try {
      const res = await fetch("/api/integrations/github/device/start", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDeviceStatus(String(err.error ?? err.detail ?? "Failed to start"));
        return;
      }
      const data = await res.json();
      setDeviceFlow({
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        interval: (data.interval ?? 5) * 1000,
      });
      setDeviceStatus("Waiting for authorization…");
      pollDeviceFlow(data.device_code, (data.interval ?? 5) * 1000);
    } catch (err) {
      setDeviceStatus(String(err));
    }
  };

  return (
    <div className={`rounded-xl border px-4 py-3 ${colour} tech-transition`}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">{PROVIDER_ICONS[provider.id] ?? "?"}</span>
          <div>
            <div className="text-sm font-medium">{provider.label}</div>
            {provider.env_var && (
              <div className="text-[10px] font-mono opacity-70">{provider.env_var}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {provider.configured ? (
            <>
              <span className="text-xs font-medium text-success">● Configured</span>
              {!isLocal && (
                <>
                  <button
                    onClick={() => { setEditing((e) => !e); setConfirmDiscard(false); }}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 tech-transition"
                  >
                    {editing ? "cancel" : "update key"}
                  </button>
                  {confirmDiscard ? (
                    <span className="flex items-center gap-1">
                      <button
                        onClick={handleDiscard}
                        disabled={discarding}
                        className="rounded border border-destructive/20 bg-destructive/5 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 tech-transition disabled:opacity-40"
                      >
                        {discarding ? "Discarding…" : "Confirm discard"}
                      </button>
                      <button
                        onClick={() => setConfirmDiscard(false)}
                        disabled={discarding}
                        className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 tech-transition"
                      >
                        cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => { setConfirmDiscard(true); setEditing(false); }}
                      className="text-[10px] text-destructive/70 hover:text-destructive underline underline-offset-2 tech-transition"
                      title="Remove key and disconnect this provider"
                    >
                      discard key
                    </button>
                  )}
                </>
              )}
            </>
          ) : provider.id === "ollama" ? (
            <span className="text-xs text-muted-foreground">● Pull model to use</span>
          ) : provider.id === "vllm" ? (
            <span className="text-xs text-muted-foreground">● Set base URL in tier</span>
          ) : (
            <button
              onClick={() => setEditing((e) => !e)}
              className="rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning hover:bg-warning/15 tech-transition"
            >
              {editing ? "Cancel" : "Set key →"}
            </button>
          )}
        </div>
      </div>

      {/* Copilot scope warning */}
      {provider.id === "github" && provider.configured && copilotScopeOk === false && !editing && (
        <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <span className="text-warning text-sm shrink-0 mt-0.5">⚠</span>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-warning">Verify your token has the Copilot scope</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                A GitHub token is set, but Copilot models will fail with a 403 if the token lacks the
                {" "}<code className="font-mono bg-secondary px-1 rounded">copilot</code> (read) permission.
                This is the most common cause of &quot;Not authenticated&quot; errors.
              </p>
              <details className="group">
                <summary className="text-[11px] text-primary cursor-pointer hover:underline select-none list-none flex items-center gap-1">
                  <span className="transition-transform group-open:rotate-90">▶</span>
                  How to fix — step by step
                </summary>
                <ol className="mt-2 space-y-1.5 pl-4">
                  {[
                    <>Go to <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80">github.com/settings/tokens → Fine-grained tokens</a>.</>,
                    <>Click <strong>Generate new token</strong>.</>,
                    <>Under <strong>Permissions → Account permissions</strong>, find <strong>Copilot</strong> and set it to <strong>Read-only</strong>.</>,
                    <>Set <strong>Expiration</strong> to your preference (90 days recommended).</>,
                    <>Click <strong>Generate token</strong> and copy the token starting with <code className="font-mono bg-secondary px-1 rounded">github_pat_…</code></>,
                    <>Click <strong>update key</strong> above and paste the new token.</>,
                    <>Requires an active GitHub Copilot Individual or Business subscription.</>,
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                      <span className="shrink-0 w-4 h-4 rounded-full bg-secondary flex items-center justify-center text-[9px] font-semibold mt-0.5">{i + 1}</span>
                      <span className="leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-[11px] text-muted-foreground pl-6">
                  Alternatively, use <strong>Connect with GitHub OAuth</strong> — click <em>update key</em> above. This grants the correct scope automatically.
                </p>
              </details>
            </div>
          </div>
        </div>
      )}

      {/* Guide description */}
      {guide && !isLocal && (
        <p className="mt-1.5 text-xs opacity-70 leading-relaxed">{guide.description}</p>
      )}

      {/* Setup panel — shown only when editing */}
      {editing && guide && (
        <div className="mt-3 rounded-lg border border-border/50 bg-card/60 p-3 space-y-3">
          {/* Quick-start links */}
          <div className="flex items-center gap-3">
            <a
              href={guide.setup_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 tech-transition"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Get API key
            </a>
            <a
              href={guide.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 tech-transition"
            >
              View docs ↗
            </a>
          </div>

          {/* Step-by-step instructions */}
          <ol className="space-y-1">
            {guide.instructions.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                <span className="shrink-0 w-4 h-4 rounded-full bg-secondary text-muted-foreground flex items-center justify-center text-[9px] font-semibold mt-0.5">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>

          {/* GitHub Copilot: OAuth device flow */}
          {provider.id === "github" && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm">✦</span>
                <span className="text-xs font-medium text-primary/80">
                  GitHub OAuth Device Flow
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                No token copying needed — enter a short code on GitHub and this
                server authenticates automatically.
              </p>

              {!deviceFlow ? (
                <button
                  onClick={startDeviceFlow}
                  disabled={!!deviceStatus && !deviceStatus.includes("Error")}
                  className="w-full rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary/80 hover:bg-primary/20 tech-transition disabled:opacity-40"
                >
                  {deviceStatus || "Connect with GitHub →"}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-md bg-background/60 p-3 text-center">
                    <div className="text-2xl font-bold tracking-[0.3em] text-primary/80 font-mono">
                      {deviceFlow.userCode}
                    </div>
                    <a
                      href={deviceFlow.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-[10px] text-primary/80 underline hover:text-primary/70"
                    >
                      Open {deviceFlow.verificationUri} →
                    </a>
                  </div>
                  <p className="text-[10px] text-muted-foreground text-center">
                    {deviceStatus}
                  </p>
                </div>
              )}

              <div className="text-[10px] text-muted-foreground border-t border-border pt-2">
                Or paste a{" "}
                <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="underline hover:text-muted-foreground">
                  Personal Access Token
                </a>{" "}
                below:
              </div>
            </div>
          )}

          {/* Key input */}
          <div className="relative">
            <input
              type={show ? "text" : "password"}
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              placeholder={`Paste ${provider.env_var}…`}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 pr-14 text-xs text-foreground placeholder-muted-foreground font-mono focus:border-primary focus:outline-none"
              autoFocus
            />
            <button
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {show ? "hide" : "show"}
            </button>
          </div>
          {keyError && <p className="text-xs text-destructive">{keyError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !keyVal.trim()}
              className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 tech-transition"
            >
              {saving ? "Saving & restarting LiteLLM…" : "Save & apply"}
            </button>
            <button
              onClick={() => { setEditing(false); setKeyVal(""); setKeyError(null); }}
              disabled={saving}
              className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 tech-transition"
            >
              Cancel
            </button>
          </div>
          {saving && (
            <p className="text-[10px] text-muted-foreground">
              Writing key to <code className="font-mono">infra/.env</code> and restarting LiteLLM (~25s)…
            </p>
          )}
        </div>
      )}

      {/* Confirm discard panel */}
      {confirmDiscard && (
        <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 space-y-2">
          <p className="text-xs text-destructive">
            This will remove <code className="font-mono text-destructive">{provider.env_var}</code> from{" "}
            <code className="font-mono">infra/.env</code> and disconnect the provider.
            Any tier currently using this provider will fall back to the next available.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDiscard}
              disabled={discarding}
              className="rounded-lg bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-40 tech-transition"
            >
              {discarding ? "Discarding & restarting LiteLLM…" : "Yes, discard key"}
            </button>
            <button
              onClick={() => { setConfirmDiscard(false); setKeyError(null); }}
              disabled={discarding}
              className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 tech-transition"
            >
              Cancel
            </button>
          </div>
          {discarding && (
            <p className="text-[10px] text-muted-foreground">
              Removing key from <code className="font-mono">infra/.env</code> and restarting LiteLLM (~25s)…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
