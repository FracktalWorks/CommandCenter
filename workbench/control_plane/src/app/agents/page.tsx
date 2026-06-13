"use client";

/**
 * /agents — Agent Management
 *
 * Lists all registered agents (built-in + user-added from GitHub repos).
 * Lets users add a new agent via GitHub repo URL and remove user-added ones.
 *
 * Flow for adding a new agent:
 *   1. Enter repo URL + metadata
 *   2. GitHub OAuth (device flow) — only shown if GitHub not yet connected
 *   3. Register → agent appears in picker on the Chat page
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentEntry } from "@/app/api/agent/list/route";
import type { MutationEntry } from "@/app/api/agent/mutations/route";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
import type { ModelsStatus, ProviderInfo } from "@/app/api/models/route";
import GitHubDeviceConnect from "@/components/GitHubDeviceConnect";

// ---------------------------------------------------------------------------
// Pending commits panel (GitHub Copilot agents only)
// ---------------------------------------------------------------------------

function PendingCommits({ agentName }: { agentName: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MutationEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [busy, setBusy] = useState<Record<string, "approve" | "reject" | "remutate" | "dismiss">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expandDiff, setExpandDiff] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  // Toast shown after a cascade-approve (e.g. "Approved — 3 earlier commits auto-approved")
  const [cascadeMsg, setCascadeMsg] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/mutations");
      const all: MutationEntry[] = res.ok ? await res.json() : [];
      // Show oldest first: when reviewing a commit chain (A→B→C) the earliest
      // commit in the chain should be reviewed first.
      const filtered = all.filter((r) => r.agent === agentName);
      filtered.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      setRows(filtered);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [agentName]);

  const toggle = () => {
    if (!open && !fetched) fetchRows();
    setOpen((v) => !v);
  };

  const act = async (id: string, action: "approve" | "reject") => {
    setBusy((b) => ({ ...b, [id]: action }));
    setErrors((e) => { const c = { ...e }; delete c[id]; return c; });
    setCascadeMsg(null);
    try {
      const res = await fetch(`/api/agent/mutations/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrors((e) => ({ ...e, [id]: body.detail ?? body.error ?? `HTTP ${res.status}` }));
      } else {
        const body = await res.json().catch(() => ({}));
        // Show cascade info when an approve auto-approved earlier commits in the chain
        if (action === "approve" && typeof body.cascade_approved === "number" && body.cascade_approved > 0) {
          setCascadeMsg(
            `Approved — ${body.cascade_approved} earlier commit${body.cascade_approved === 1 ? "" : "s"} in this chain were auto-approved.`
          );
          setTimeout(() => setCascadeMsg(null), 6000);
        }
        await fetchRows();
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
    } finally {
      setBusy((b) => { const c = { ...b }; delete c[id]; return c; });
    }
  };

  const remutate = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: "remutate" }));
    setErrors((e) => { const c = { ...e }; delete c[id]; return c; });
    try {
      const res = await fetch(`/api/agent/mutations/${encodeURIComponent(id)}/remutate`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors((e) => ({ ...e, [id]: body.detail ?? body.error ?? `HTTP ${res.status}` }));
      } else {
        setErrors((e) => ({ ...e, [id]: body.message ?? "Commit cleared. Trigger a fresh agent run to re-attempt." }));
        await fetchRows();
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: String(err) }));
    } finally {
      setBusy((b) => { const c = { ...b }; delete c[id]; return c; });
    }
  };

  // Dismiss = remove from view only (terminal state: approved / rejected / audit)
  const dismiss = async (runId: string) => {
    setBusy((b) => ({ ...b, [runId]: "dismiss" }));
    try {
      await fetch(`/api/agent/mutations/${encodeURIComponent(runId)}/dismiss`, { method: "DELETE" });
      await fetchRows();
    } finally {
      setBusy((b) => { const c = { ...b }; delete c[runId]; return c; });
    }
  };

  const deleteCommit = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: "dismiss" }));
    try {
      await fetch(`/api/agent/mutations/${encodeURIComponent(id)}/delete`, { method: "DELETE" });
      await fetchRows();
    } finally {
      setBusy((b) => { const c = { ...b }; delete c[id]; return c; });
    }
  };

  const loadDiff = async (id: string) => {
    if (diffs[id] !== undefined) { setExpandDiff((d) => ({ ...d, [id]: !d[id] })); return; }
    try {
      const res = await fetch(`/api/agent/mutations/${encodeURIComponent(id)}/diff`);
      const data = await res.json();
      setDiffs((d) => ({ ...d, [id]: typeof data.diff_text === "string" ? data.diff_text : JSON.stringify(data) }));
      setExpandDiff((d) => ({ ...d, [id]: true }));
    } catch {
      setDiffs((d) => ({ ...d, [id]: "Failed to load diff." }));
      setExpandDiff((d) => ({ ...d, [id]: true }));
    }
  };

  const pending = rows.filter((r) => r.type === "pending_commit" && r.status === "pending");
  const evalFailed = rows.filter((r) => r.type === "pending_commit" && r.status === "eval_failed");
  // Commits awaiting a decision (pending or eval_failed)
  const awaitingDecision = rows.filter(
    (r) => r.type === "pending_commit" && (r.status === "pending" || r.status === "eval_failed")
  );
  const pendingCount = awaitingDecision.length;

  // Separate display order:
  // 1. Commits awaiting a decision (oldest first — review in commit order A→B→C)
  // 2. Terminal/informational entries (approved, rejected, audit) shown below
  const decisionRows = rows.filter(
    (r) => r.type === "pending_commit" && (r.status === "pending" || r.status === "eval_failed")
  );
  const terminalRows = rows.filter(
    (r) => !(r.type === "pending_commit" && (r.status === "pending" || r.status === "eval_failed"))
  );

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        onClick={toggle}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      >
        <span className="font-medium">Self-mutation commits</span>
        {pendingCount > 0 && (
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {pendingCount}
          </span>
        )}
        {loading && <span className="text-[10px] text-muted-foreground">loading…</span>}
        <span className="ml-auto text-muted-foreground/70">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {/* Cascade toast */}
          {cascadeMsg && (
            <div className="rounded-md border border-success/20 bg-success/5 px-3 py-2 text-[11px] text-emerald-300">
              ✓ {cascadeMsg}
            </div>
          )}

          {fetched && rows.length === 0 && (
            <p className="text-xs text-muted-foreground/70 italic">No commits yet.</p>
          )}

          {/* Decision-required entries: approve/reject must happen before dismiss */}
          {decisionRows.map((m, i) => {
            const key = m.id ?? m.run_id ?? String(i);
            const isPending = m.status === "pending";
            const isEvalFailed = m.status === "eval_failed";
            // Is there a later commit in the same agent's chain still awaiting review?
            // If so, show a note that approving this will also unblock those.
            const laterCount = decisionRows.filter(
              (r) => r.id !== m.id && new Date(r.at).getTime() > new Date(m.at).getTime()
            ).length;

            return (
              <div
                key={key}
                className={`rounded-lg border p-3 text-xs ${
                  isEvalFailed
                    ? "border-warning/20 bg-warning/5"
                    : "border-primary/20 bg-primary/5"
                }`}
              >
                {/* Status badge + commit message — no X here, decision required */}
                <div className="flex items-start gap-2">
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                      isEvalFailed
                        ? "border-warning/20 bg-warning/10 text-warning"
                        : "border-primary/20 bg-primary/10 text-primary"
                    }`}
                  >
                    {isEvalFailed ? "⚠ Eval failed" : "Awaiting review"}
                  </span>
                  {m.commit_message && (
                    <span className="font-mono text-foreground line-clamp-1 flex-1">{m.commit_message}</span>
                  )}
                </div>

                {/* SHA + timestamp */}
                <div className="mt-1 flex items-center gap-3 text-muted-foreground">
                  {m.commit_sha && <span className="font-mono">{m.commit_sha.slice(0, 8)}</span>}
                  <span>{new Date(m.at).toLocaleString("en-IN")}</span>
                </div>

                {m.test_summary && (
                  <div className={`mt-1 ${isEvalFailed ? "text-warning/80" : "text-muted-foreground"}`}>
                    {m.test_summary}
                  </div>
                )}

                {/* Cascade hint */}
                {laterCount > 0 && isPending && (
                  <p className="mt-1 text-[10px] text-primary/60">
                    Approving will also push {laterCount} later commit{laterCount === 1 ? "" : "s"} in this chain.
                  </p>
                )}

                {/* Diff toggle */}
                {m.id && (
                  <button
                    onClick={() => loadDiff(m.id!)}
                    className="mt-1.5 text-muted-foreground hover:text-muted-foreground underline underline-offset-2"
                  >
                    {expandDiff[m.id] ? "Hide diff" : "Show diff"}
                  </button>
                )}
                {m.id && expandDiff[m.id] && diffs[m.id] !== undefined && (
                  <pre className="mt-2 overflow-x-auto max-h-48 rounded bg-background p-2 text-[10px] text-muted-foreground border border-border whitespace-pre-wrap">
                    {diffs[m.id] || "(empty diff)"}
                  </pre>
                )}

                {errors[key] && (
                  <p className="mt-1.5 text-destructive">{errors[key]}</p>
                )}

                {/* eval_failed actions */}
                {isEvalFailed && m.id && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <p className="text-[10px] text-warning/70 mb-0.5">
                      Tests failed — review the diff, then choose an action.
                    </p>
                    <div className="flex gap-1.5 flex-wrap">
                      <button
                        disabled={!!busy[m.id]}
                        onClick={() => act(m.id!, "approve")}
                        className="rounded bg-amber-800/50 px-2.5 py-1 text-warning hover:bg-amber-700/60 disabled:opacity-50 transition-colors"
                      >
                        {busy[m.id] === "approve" ? "Pushing…" : "Push Anyway"}
                      </button>
                      <button
                        disabled={!!busy[m.id]}
                        onClick={() => remutate(m.id!)}
                        className="rounded bg-primary/10 px-2.5 py-1 text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
                      >
                        {busy[m.id] === "remutate" ? "Resetting…" : "Re-mutate"}
                      </button>
                      <button
                        disabled={!!busy[m.id]}
                        onClick={() => act(m.id!, "reject")}
                        className="rounded bg-red-900/40 px-2.5 py-1 text-destructive hover:bg-red-800/50 disabled:opacity-50 transition-colors"
                      >
                        {busy[m.id] === "reject" ? "Rejecting…" : "Reject & Discard"}
                      </button>
                    </div>
                  </div>
                )}

                {/* pending actions */}
                {isPending && m.id && (
                  <div className="mt-2 flex gap-1.5">
                    <button
                      disabled={!!busy[m.id]}
                      onClick={() => act(m.id!, "approve")}
                      className="rounded bg-success/15 px-2.5 py-1 text-success hover:bg-success/25 disabled:opacity-50 transition-colors"
                    >
                      {busy[m.id] === "approve" ? "Pushing…" : "Approve & Push"}
                    </button>
                    <button
                      disabled={!!busy[m.id]}
                      onClick={() => act(m.id!, "reject")}
                      className="rounded bg-red-900/40 px-2.5 py-1 text-destructive hover:bg-red-800/50 disabled:opacity-50 transition-colors"
                    >
                      {busy[m.id] === "reject" ? "Rejecting…" : "Reject & Discard"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Terminal / informational entries — dismissable with X */}
          {terminalRows.length > 0 && (
            <>
              {decisionRows.length > 0 && (
                <div className="border-t border-border/60 pt-1 text-[10px] text-muted-foreground uppercase tracking-wide">
                  History
                </div>
              )}
              {terminalRows.map((m, i) => {
                const key = m.id ?? m.run_id ?? String(i);
                const isAudit = m.type === "audit_event";
                const isApproved = m.status === "approved";
                const isRejected = m.status === "rejected";
                return (
                  <div
                    key={key}
                    className="relative rounded-lg border border-border bg-card/40 p-3 text-xs"
                  >
                    {/* X = dismiss from view (only for terminal entries) */}
                    <button
                      onClick={() =>
                        isAudit && m.run_id
                          ? dismiss(m.run_id)
                          : m.id
                          ? deleteCommit(m.id)
                          : undefined
                      }
                      disabled={!!busy[key]}
                      className="absolute top-2 right-2 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-muted-foreground transition-colors disabled:opacity-30"
                      title="Dismiss"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>

                    <div className="flex items-start gap-2 pr-5">
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                          isApproved
                            ? "border-success/20 bg-success/10 text-success"
                            : isRejected
                            ? "border-border/50 bg-secondary text-muted-foreground"
                            : m.status === "failed"
                            ? "border-red-700/50 bg-red-900/30 text-destructive"
                            : "border-border/50 bg-secondary text-muted-foreground"
                        }`}
                      >
                        {isApproved
                          ? "✓ Approved"
                          : isRejected
                          ? "✗ Rejected"
                          : m.status === "failed"
                          ? "Failed"
                          : m.status}
                      </span>
                      {m.commit_message && (
                        <span className="font-mono text-muted-foreground line-clamp-1">{m.commit_message}</span>
                      )}
                    </div>

                    <div className="mt-1 flex items-center gap-3 text-muted-foreground/70">
                      {m.commit_sha && <span className="font-mono">{m.commit_sha.slice(0, 8)}</span>}
                      <span>{new Date(m.at).toLocaleString("en-IN")}</span>
                      {m.reviewed_by && (
                        <span className="text-muted-foreground">
                          · {m.reviewed_by.startsWith("cascade:") ? "auto-approved" : m.reviewed_by}
                        </span>
                      )}
                    </div>

                    {m.id && (
                      <button
                        onClick={() => loadDiff(m.id!)}
                        className="mt-1.5 text-muted-foreground/70 hover:text-muted-foreground underline underline-offset-2"
                      >
                        {expandDiff[m.id] ? "Hide diff" : "Show diff"}
                      </button>
                    )}
                    {m.id && expandDiff[m.id] && diffs[m.id] !== undefined && (
                      <pre className="mt-2 overflow-x-auto max-h-48 rounded bg-background p-2 text-[10px] text-muted-foreground border border-border whitespace-pre-wrap">
                        {diffs[m.id] || "(empty diff)"}
                      </pre>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ModalStep = "form" | "github" | "registering" | "done" | "error";

interface AgentConfig {
  name?: string;
  description?: string;
  tags?: string[];
  integrations?: string[];
  optional_integrations?: string[];
}

interface FormValues {
  repoUrl: string;
  name: string;
  description: string;
  tags: string;
  integrations: string;
  optionalIntegrations: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugFromRepo(url: string): string {
  const raw = url.trim().replace(/\/$/, "");
  // Local path: use the last folder segment
  if (/^([A-Za-z]:[\\/]|\/)/.test(raw)) {
    const segments = raw.replace(/\\/g, "/").split("/").filter(Boolean);
    const folder = segments[segments.length - 1] ?? "";
    return folder.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }
  // Extract the repo name part from "owner/repo" or full URL
  const parts = raw.replace("https://github.com/", "").replace("http://github.com/", "").split("/");
  const repo = parts[parts.length - 1] ?? "";
  return repo.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function parseCsv(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Add-Agent Modal
// ---------------------------------------------------------------------------

function AddAgentModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (agent: AgentEntry) => void;
}) {
  const [step, setStep] = useState<ModalStep>("form");
  const [githubStatus, setGithubStatus] = useState<IntegrationStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addedAgent, setAddedAgent] = useState<AgentEntry | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [registerPhase, setRegisterPhase] = useState<"saving" | "cloning">("saving");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [form, setForm] = useState<FormValues>({
    repoUrl: "",
    name: "",
    description: "",
    tags: "",
    integrations: "",
    optionalIntegrations: "",
  });

  // ---------------------------------------------------------------------------
  // Fetch config.json from GitHub and auto-fill form
  // ---------------------------------------------------------------------------

  const fetchConfig = useCallback(async (repoUrl: string) => {
    const raw = repoUrl.trim().replace(/\/$/, "");
    if (!raw) return;

    // Local path: pass raw path directly as repo= param (no GitHub slug extraction)
    const isLocal = /^([A-Za-z]:[\\/]|\/)/.test(raw);
    const paramValue = isLocal
      ? raw
      : raw.replace("https://github.com/", "").replace("http://github.com/", "");

    // For GitHub slugs, need at least owner/repo (two slash-separated parts)
    if (!isLocal && paramValue.split("/").filter(Boolean).length < 2) return;

    setConfigLoading(true);
    setConfigLoaded(false);
    try {
      const res = await fetch(`/api/agent/config?repo=${encodeURIComponent(paramValue)}`);
      if (!res.ok) return; // 404 = no config.json, just leave fields editable
      const cfg: AgentConfig = await res.json();
      setForm((f) => ({
        ...f,
        // Only fill name if user hasn't manually changed it from the slug default
        name:
          f.name === "" || f.name === slugFromRepo(f.repoUrl)
            ? (cfg.name ? slugFromRepo(cfg.name) : slugFromRepo(repoUrl))
            : f.name,
        description: cfg.description ?? f.description,
        tags: cfg.tags?.join(", ") ?? f.tags,
        integrations: cfg.integrations?.join(", ") ?? f.integrations,
        optionalIntegrations: cfg.optional_integrations?.join(", ") ?? f.optionalIntegrations,
      }));
      setConfigLoaded(true);
    } catch {
      // Silent — user can fill manually
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // Debounced repo URL handler: update name immediately, fetch config after 600ms pause
  const handleRepoUrlChange = (val: string) => {
    const slug = slugFromRepo(val);
    setForm((f) => ({
      ...f,
      repoUrl: val,
      name: f.name === "" || f.name === slugFromRepo(f.repoUrl) ? slug : f.name,
    }));
    setConfigLoaded(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchConfig(val), 600);
  };

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleField = (key: keyof FormValues, val: string) =>
    setForm((f) => ({ ...f, [key]: val }));

  // ---------------------------------------------------------------------------
  // Step 1 → submit: check GitHub, then register
  // ---------------------------------------------------------------------------

  const handleFormSubmit = async () => {
    if (!form.repoUrl.trim() || !form.name.trim()) return;

    // Check GitHub connection status
    try {
      const res = await fetch("/api/integrations/status");
      if (res.ok) {
        const statuses: IntegrationStatus[] = await res.json();
        const gh = statuses.find((s) => s.service === "github");
        if (gh && !gh.configured) {
          setGithubStatus(gh);
          setStep("github");
          return;
        }
      }
    } catch {
      // If status check fails, proceed to register without blocking
    }

    await doRegister();
  };

  // ---------------------------------------------------------------------------
  // Register the agent
  // ---------------------------------------------------------------------------

  const doRegister = useCallback(async () => {
    setStep("registering");
    setRegisterPhase("saving");
    const cloneTimer = setTimeout(() => setRegisterPhase("cloning"), 800);
    try {
      const rawInput = form.repoUrl.trim();
      const isLocal = /^([A-Za-z]:[\\/]|\/)/.test(rawInput);
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim(),
        tags: parseCsv(form.tags),
        integrations: parseCsv(form.integrations),
        optional_integrations: parseCsv(form.optionalIntegrations),
      };
      if (isLocal) {
        body.local_path = rawInput;
      } else {
        body.repo_url = rawInput;
      }
      const res = await fetch("/api/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      clearTimeout(cloneTimer);
      const data = await res.json();
      if (res.ok) {
        setAddedAgent(data as AgentEntry);
        setStep("done");
      } else {
        setErrorMsg(String(data?.detail ?? data?.error ?? `Error ${res.status}`));
        setStep("error");
      }
    } catch (err) {
      clearTimeout(cloneTimer);
      setErrorMsg(err instanceof Error ? err.message : "Network error");
      setStep("error");
    }
  }, [form]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-foreground">Add Agent</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {step === "form" && "Enter a GitHub repo or a local directory path"}
              {step === "github" && "Connect GitHub to access private repos"}
              {step === "registering" && "Registering agent…"}
              {step === "done" && "Agent registered successfully"}
              {step === "error" && "Registration failed"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {/* ── Step: Form ── */}
          {step === "form" && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  GitHub Repo or Local Path <span className="text-destructive">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="owner/repo  ·  https://github.com/owner/repo  ·  C:\path\to\agent"
                    value={form.repoUrl}
                    onChange={(e) => handleRepoUrlChange(e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none pr-8"
                  />
                  {configLoading && (
                    <div className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  )}
                  {configLoaded && !configLoading && (
                    <div className="absolute right-2.5 top-2 text-green-400 text-xs" title="config.json loaded">✓</div>
                  )}
                </div>
                {configLoaded && (
                  <p className="mt-1 text-xs text-green-500">config.json found — fields auto-filled</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Agent name <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="my-agent"
                    value={form.name}
                    onChange={(e) => handleField("name", e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">lowercase, hyphens only</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Tags</label>
                  <input
                    type="text"
                    placeholder="sales, outbound"
                    value={form.tags}
                    onChange={(e) => handleField("tags", e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">comma-separated</p>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
                <input
                  type="text"
                  placeholder="What does this agent do?"
                  value={form.description}
                  onChange={(e) => handleField("description", e.target.value)}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Mandatory integrations
                  </label>
                  <input
                    type="text"
                    placeholder="zoho-crm, apollo"
                    value={form.integrations}
                    onChange={(e) => handleField("integrations", e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Optional integrations
                  </label>
                  <input
                    type="text"
                    placeholder="instantly, smtp"
                    value={form.optionalIntegrations}
                    onChange={(e) => handleField("optionalIntegrations", e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:border-primary focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={onClose}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={!form.repoUrl.trim() || !form.name.trim() || configLoading}
                  onClick={handleFormSubmit}
                  title={configLoading ? "Fetching config.json…" : undefined}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
                >
                  {configLoading ? "Fetching…" : "Next →"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step: GitHub OAuth ── */}
          {step === "github" && githubStatus && (
            <div>
              <p className="mb-4 text-sm text-muted-foreground">
                Connect GitHub so CommandCenter can clone{" "}
                <span className="font-mono text-foreground">{form.repoUrl}</span> and access
                private repositories.
              </p>
              <GitHubDeviceConnect
                integration={githubStatus}
                onConfigured={() => doRegister()}
              />
              <button
                onClick={() => doRegister()}
                className="mt-3 text-xs text-muted-foreground hover:text-muted-foreground underline"
              >
                Skip — repository is public
              </button>
            </div>
          )}

          {/* ── Step: Registering ── */}
          {step === "registering" && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <div className="text-center">
                <p className="text-sm text-foreground font-medium">
                  {registerPhase === "saving" ? "Saving agent…" : "Cloning repository…"}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {registerPhase === "saving"
                    ? "Writing to the agent registry"
                    : /^([A-Za-z]:[\\/]|\/)/.test(form.repoUrl.trim())
                      ? "Verifying local path"
                      : `Pulling ${form.repoUrl.trim().split("/").slice(-2).join("/")} in the background`}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className={registerPhase === "saving" ? "text-primary" : "text-success"}>
                  {registerPhase === "saving" ? "● saving" : "✓ saved"}
                </span>
                <span className="text-muted-foreground/70">→</span>
                <span className={registerPhase === "cloning" ? "text-primary" : "text-muted-foreground"}>
                  {registerPhase === "cloning" ? "● cloning" : "○ clone"}
                </span>
              </div>
            </div>
          )}

          {/* ── Step: Done ── */}
          {step === "done" && addedAgent && (
            <div className="flex flex-col gap-4 py-2">
              {/* Mini agent card preview — same style as AgentCard */}
              <div className="rounded-xl border border-border bg-secondary/60 p-4">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">{addedAgent.name}</span>
                  <span className="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-primary">custom</span>
                  {addedAgent.local_path && (
                    <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-xs text-violet-400">local</span>
                  )}
                  {/* Runtime badges in the success preview */}
                  {addedAgent.agent_runtime === "github-copilot" ? (
                    <>
                      <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs text-accent">MAF</span>
                      <span className="shrink-0 rounded-full border border-sky-700/50 bg-sky-900/30 px-2 py-0.5 text-xs text-sky-300" title="GitHub Copilot SDK — shell, file r/w, MCP, native BYOK">Copilot SDK</span>
                    </>
                  ) : (
                    <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs text-accent">MAF</span>
                  )}
                  <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-400">live</span>
                </div>
                {addedAgent.description && (
                  <p className="text-xs text-muted-foreground mb-2">{addedAgent.description}</p>
                )}
                {(addedAgent.tags?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {addedAgent.tags!.map((t) => (
                      <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{t}</span>
                    ))}
                  </div>
                )}
                {((addedAgent.integrations?.length ?? 0) > 0 || (addedAgent.optional_integrations?.length ?? 0) > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {addedAgent.integrations?.map((i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                        · {i}
                      </span>
                    ))}
                    {addedAgent.optional_integrations?.map((i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
                        {i}
                      </span>
                    ))}
                  </div>
                )}
                {addedAgent.local_path ? (
                  <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground" title={addedAgent.local_path}>
                    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.257c.466 0 .917.18 1.25.503l.69.69A.5.5 0 008.05 3.5H13.5A1.5 1.5 0 0115 5v7.5A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5V3.5z"/>
                    </svg>
                    <span className="truncate">{addedAgent.local_path}</span>
                  </div>
                ) : addedAgent.repo_url ? (
                  <div className="mt-2">
                    <a href={addedAgent.repo_url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-muted-foreground">
                      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                      {addedAgent.repo_name ?? addedAgent.repo_url}
                    </a>
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {addedAgent.local_path
                  ? "Agent registered from local path — no cloning needed."
                  : "Repository is being cloned in the background — the agent will be ready shortly."}
              </p>
              <button
                onClick={() => {
                  onAdded(addedAgent);
                  onClose();
                }}
                className="w-full rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {/* ── Step: Error ── */}
          {step === "error" && (
            <div className="flex flex-col gap-4 py-4">
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {errorMsg}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setStep("form")}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelAccess panel
// ---------------------------------------------------------------------------

const PROVIDER_ICON: Record<string, string> = {
  gemini: "G",
  openai: "⊕",
  vllm: "⚡",
  "github-copilot": "",
};

function ProviderRow({ p }: { p: ProviderInfo }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      {/* Icon */}
      <span className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${
        p.available ? "bg-secondary text-foreground" : "bg-secondary/60 text-muted-foreground"
      }`}>
        {p.id === "github-copilot" ? (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        ) : (
          PROVIDER_ICON[p.id] ?? p.label[0]
        )}
      </span>

      {/* Label + note */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${
            p.available ? "text-foreground" : "text-muted-foreground"
          }`}>{p.label}</span>
          {p.available ? (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-success" />
              Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
              <span className="w-1.5 h-1.5 rounded-full bg-muted" />
              Not configured
            </span>
          )}
          {p.type === "copilot" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">
              via Copilot
            </span>
          )}
          {p.type === "local" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-primary border border-blue-500/20">
              local
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{p.note}</p>
      </div>

      {/* Tiers */}
      <div className="flex gap-1 shrink-0">
        {p.tiers.map((t) => (
          <span key={t} className={`text-[10px] px-1.5 py-0.5 rounded font-mono border ${
            p.available
              ? "bg-secondary text-muted-foreground border-border"
              : "bg-card text-muted-foreground/70 border-border"
          }`}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function ModelAccess({ models }: { models: ModelsStatus | null }) {
  const [open, setOpen] = useState(false);

  if (!models) return null;

  const copilot = models.providers.find((p) => p.id === "github-copilot");
  const direct = models.providers.filter((p) => p.id !== "github-copilot");
  const activeCount = models.providers.filter((p) => p.available).length;

  return (
    <div className="mb-6 rounded-xl border border-border bg-card/40">
      {/* Header — always visible */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">LLM Model Access</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
            activeCount > 0
              ? "bg-success/10 text-success border-success/20"
              : "bg-secondary text-muted-foreground border-border"
          }`}>
            {activeCount}/{models.providers.length} providers active
          </span>
          {copilot && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              copilot.available
                ? "bg-violet-500/10 text-violet-400 border-violet-500/20"
                : "bg-secondary text-muted-foreground border-border"
            }`}>
              Copilot models: {copilot.available ? "✓ active" : "⚠ needs GITHUB_TOKEN"}
            </span>
          )}
        </div>
        <span className="text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-border">
          {/* Direct providers */}
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-3 mb-1">Direct API keys (tier router)</p>
          <div>
            {direct.map((p) => <ProviderRow key={p.id} p={p} />)}
          </div>

          {/* Copilot section */}
          {copilot && (
            <>
              <div className="flex items-center justify-between mt-4 mb-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">GitHub Copilot models (included in Copilot subscription)</p>
                {!copilot.available && (
                  <Link href="/integrations" className="text-[10px] text-violet-400 hover:text-violet-300 underline shrink-0 ml-2">
                    Configure in Integrations →
                  </Link>
                )}
              </div>
              {/* Copilot provider row */}
              <ProviderRow p={copilot} />
              {/* Individual Copilot model rows */}
              <div className="mt-2 space-y-1">
                {models.copilot_models.map((m) => (
                  <div key={m.alias} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                    copilot.available ? "bg-secondary/50" : "bg-card/40"
                  }`}>
                    <span className={`font-mono text-xs ${
                      copilot.available ? "text-violet-300" : "text-muted-foreground"
                    }`}>
                      {m.alias}
                    </span>
                    <span className={`text-xs flex-1 ${
                      copilot.available ? "text-foreground" : "text-muted-foreground"
                    }`}>
                      {m.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{m.description}</span>
                    {m.suggested_tier && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono border ${
                        copilot.available
                          ? "bg-secondary text-muted-foreground border-border"
                          : "bg-card text-muted-foreground/70 border-border"
                      }`}>
                        → {m.suggested_tier}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {!copilot.available && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Set <code className="text-muted-foreground">GITHUB_TOKEN</code> (PAT with{" "}
                  <code className="text-muted-foreground">copilot</code> scope) in the{" "}
                  <Link href="/integrations" className="text-violet-400 hover:text-violet-300 underline">Integrations</Link>{" "}
                  panel to unlock GPT-4o, Claude Sonnet, and o3-mini at no extra per-token cost.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  onRemove,
  integrationStatuses,
}: {
  agent: AgentEntry;
  onRemove: (name: string) => void;
  integrationStatuses: IntegrationStatus[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(agent.name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onRemove(agent.name);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(String(data?.detail ?? data?.error ?? "Failed to remove agent"));
      }
    } catch {
      alert("Network error while removing agent");
    } finally {
      setRemoving(false);
      setConfirming(false);
    }
  };

  const repoUrl = agent.repo_url;
  const repoName = agent.repo_name;
  const localPath = agent.local_path;

  return (
    <div className="group relative rounded-xl border border-border bg-card/60 p-4 hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground truncate">{agent.name}</span>
            {agent.dynamic && (
              <span className="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-primary">
                custom
              </span>
            )}
            {localPath && (
              <span className="shrink-0 rounded-full bg-violet-500/15 px-2 py-0.5 text-xs text-violet-400" title={localPath}>
                local
              </span>
            )}
            {/* Agent runtime badges */}
            {agent.agent_runtime === "github-copilot" ? (
              <>
                <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs text-accent" title="Microsoft Agent Framework">MAF</span>
                <span className="shrink-0 rounded-full border border-sky-700/50 bg-sky-900/30 px-2 py-0.5 text-xs text-sky-300" title="GitHub Copilot SDK — shell, file r/w, MCP, native BYOK">Copilot SDK</span>
              </>
            ) : (
              <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs text-accent" title="Microsoft Agent Framework agent">MAF</span>
            )}
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                agent.status === "live"
                  ? "bg-green-500/15 text-green-400"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              {agent.status}
            </span>
          </div>

          {agent.description && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {agent.tags?.map((t) => (
              <span
                key={t}
                className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>

          {localPath ? (
            <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground" title={localPath}>
              <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.257c.466 0 .917.18 1.25.503l.69.69A.5.5 0 008.05 3.5H13.5A1.5 1.5 0 0115 5v7.5A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5V3.5z"/>
              </svg>
              <span className="truncate">{localPath}</span>
            </div>
          ) : (repoName || repoUrl) ? (
            <div className="mt-2">
              <a
                href={
                  repoUrl ??
                  (repoName?.includes("/")
                    ? `https://github.com/${repoName}`
                    : `https://github.com/FracktalWorks/${repoName}`)
                }
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
              >
                <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                {repoName ?? repoUrl}
              </a>
            </div>
          ) : null}

          {/* Integration badges with live status */}
          {((agent.integrations?.length ?? 0) > 0 || (agent.optional_integrations?.length ?? 0) > 0) && (
            <div className="mt-2.5 space-y-1">
              {/* Mandatory */}
              {(agent.integrations?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agent.integrations!.map((i) => {
                    const intg = integrationStatuses.find((s) => s.service === i);
                    const configured = intg?.configured;
                    // null = gateway unreachable / unknown
                    const state = configured === true ? "ok" : configured === false ? "missing" : "unknown";
                    return (
                      <Link
                        key={i}
                        href="/integrations"
                        title={
                          state === "ok"
                            ? `${intg?.label ?? i}: connected`
                            : state === "missing"
                            ? `${intg?.label ?? i}: not configured — click to set up`
                            : i
                        }
                      >
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium cursor-pointer transition-colors ${
                          state === "ok"
                            ? "border-success/20 text-success bg-success/10 hover:bg-success/20"
                            : state === "missing"
                            ? "border-red-700/50 text-destructive bg-red-500/10 hover:bg-red-500/20"
                            : "border-border text-muted-foreground hover:border-border"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            state === "ok" ? "bg-success" : state === "missing" ? "bg-destructive" : "bg-muted"
                          }`} />
                          {intg?.label ?? i}
                          {state === "ok" && <span className="text-emerald-600 text-[10px]">✓</span>}
                          {state === "missing" && <span className="text-destructive text-[10px]">!</span>}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
              {/* Optional */}
              {(agent.optional_integrations?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agent.optional_integrations!.map((i) => {
                    const intg = integrationStatuses.find((s) => s.service === i);
                    const configured = intg?.configured;
                    const state = configured === true ? "ok" : configured === false ? "missing" : "unknown";
                    return (
                      <Link
                        key={i}
                        href="/integrations"
                        title={`${intg?.label ?? i}: optional${state === "missing" ? " — not configured" : state === "ok" ? " — connected" : ""}`}
                      >
                        <span className={`inline-flex items-center gap-1.5 rounded-full border border-dashed px-2 py-0.5 text-xs cursor-pointer transition-colors ${
                          state === "ok"
                            ? "border-emerald-700/40 text-emerald-600 hover:bg-emerald-500/10"
                            : "border-border text-muted-foreground hover:border-border"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            state === "ok" ? "bg-emerald-600" : "bg-secondary"
                          }`} />
                          {intg?.label ?? i}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Blocked warning: any mandatory integration not configured */}
          {(() => {
            const missing = (agent.integrations ?? []).filter((i) => {
              const s = integrationStatuses.find((x) => x.service === i);
              return s !== undefined && !s.configured;
            });
            if (missing.length === 0) return null;
            const labels = missing.map((i) => integrationStatuses.find((s) => s.service === i)?.label ?? i);
            return (
              <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-800/40 bg-amber-950/30 px-2.5 py-1.5">
                <span className="text-amber-400 text-xs">⚠</span>
                <span className="text-xs text-amber-300">
                  Agent is blocked — needs:{" "}
                  <Link href="/integrations" className="underline hover:text-warning">
                    {labels.join(", ")}
                  </Link>
                </span>
              </div>
            );
          })()}

          {/* Pending self-mutation commits — GitHub Copilot agents only */}
          {agent.agent_runtime === "github-copilot" && (
            <PendingCommits agentName={agent.name} />
          )}
        </div>

        {/* Action buttons */}
        <div className="shrink-0 flex flex-col items-end gap-2">
          {/* Chat shortcut — navigate to chat page */}
          <Link
            href={`/chat?agent=${encodeURIComponent(agent.name)}`}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary px-2.5 py-1 text-xs text-foreground hover:border-primary/30 hover:bg-secondary transition-colors"
            title={`Open a chat with ${agent.name}`}
          >
            Chat →
          </Link>
        </div>

        {/* Remove button — only for user-added (dynamic) agents */}
        {agent.dynamic && (
          <div className="shrink-0">
            {confirming ? (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Remove?</span>
                <button
                  disabled={removing}
                  onClick={handleRemove}
                  className="rounded px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
                >
                  {removing ? "…" : "Yes"}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded px-2 py-1 text-xs border border-border text-muted-foreground hover:text-foreground transition-colors"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="rounded p-1.5 text-muted-foreground hover:bg-red-900/30 hover:text-destructive transition-colors mt-1"
                title="Remove agent"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [integrationStatuses, setIntegrationStatuses] = useState<IntegrationStatus[]>([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const [agentRes, intgRes, modelsRes] = await Promise.all([
        fetch("/api/agent/list"),
        fetch("/api/integrations/status"),
        fetch("/api/models"),
      ]);
      if (agentRes.ok) setAgents(await agentRes.json());
      if (intgRes.ok) {
        const data = await intgRes.json();
        if (Array.isArray(data)) setIntegrationStatuses(data);
      }
      if (modelsRes.ok) setModelsStatus(await modelsRes.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleRemove = (name: string) =>
    setAgents((prev) => prev.filter((a) => a.name !== name));

  const handleAdded = (agent: AgentEntry) =>
    setAgents((prev) => [...prev, { ...agent, dynamic: true }]);

  const builtIn = agents.filter((a) => !a.dynamic);
  const custom = agents.filter((a) => a.dynamic);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage MAF agents connected to this CommandCenter instance.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-colors"
        >
          <span className="text-base leading-none">+</span>
          Add Agent
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          Loading agents…
        </div>
      ) : (
        <>
          {/* Model access panel */}
          <ModelAccess models={modelsStatus} />
          {/* Built-in agents */}
          {builtIn.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Built-in ({builtIn.length})
              </h2>
              <div className="flex flex-col gap-3">
                {builtIn.map((a) => (
                  <AgentCard key={a.name} agent={a} onRemove={handleRemove} integrationStatuses={integrationStatuses} />
                ))}
              </div>
            </section>
          )}

          {/* Custom agents */}
          <section>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Custom — from GitHub {custom.length > 0 && `(${custom.length})`}
            </h2>
            {custom.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-8 text-center">
                <p className="text-sm text-muted-foreground">No custom agents yet.</p>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="mt-3 text-sm text-blue-500 hover:text-primary underline"
                >
                  Add your first agent →
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {custom.map((a) => (
                  <AgentCard key={a.name} agent={a} onRemove={handleRemove} integrationStatuses={integrationStatuses} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {showAddModal && (
        <AddAgentModal
          onClose={() => setShowAddModal(false)}
          onAdded={handleAdded}
        />
      )}
    </div>
  );
}
