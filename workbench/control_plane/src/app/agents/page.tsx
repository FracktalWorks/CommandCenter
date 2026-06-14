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
import {
  AlertTriangle,
  Bot,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  Filter,
  FolderOpen,
  Lightbulb,
  Loader2,
  MessageCircle,
  Package,
  Plug,
  Plus,
  Receipt,
  RefreshCw,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import type { AgentEntry } from "@/app/api/agent/list/route";
import type { MutationEntry } from "@/app/api/agent/mutations/route";
import type { IntegrationStatus } from "@/app/api/integrations/status/route";
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
            <div className="rounded-md border border-success/20 bg-success/5 px-3 py-2 text-[11px] text-success">
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
                        className="rounded bg-warning/10 px-2.5 py-1 text-warning hover:bg-warning/15 disabled:opacity-50 transition-colors"
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
                        className="rounded bg-destructive/10 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
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
                      className="rounded bg-destructive/10 px-2.5 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
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
                            ? "border-destructive/20 bg-destructive/5 text-destructive"
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
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/70"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-xl sm:rounded-xl border-t sm:border border-border bg-card shadow-2xl max-h-[92vh] overflow-y-auto"
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
                    <div className="absolute right-2.5 top-2 text-success text-xs" title="config.json loaded">✓</div>
                  )}
                </div>
                {configLoaded && (
                  <p className="mt-1 text-xs text-success">config.json found — fields auto-filled</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">custom</span>
                  {addedAgent.local_path && (
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">local</span>
                  )}
                  {/* Runtime badges in the success preview */}
                  {addedAgent.agent_runtime === "github-copilot" ? (
                    <>
                      <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs text-accent">MAF</span>
                      <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary/80" title="GitHub Copilot SDK — shell, file r/w, MCP, native BYOK">Copilot SDK</span>
                    </>
                  ) : (
                    <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-xs text-accent">MAF</span>
                  )}
                  <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">live</span>
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
                className="w-full rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-colors"
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

function GithubIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Agent icons + colors by name
// ---------------------------------------------------------------------------

const AGENT_ICONS: Record<string, React.ElementType> = {
  "task-manager": CheckSquare,
  "sales":        TrendingUp,
  "delivery":     Package,
  "triage":       Filter,
  "reconciler":   RefreshCw,
  "billing":      Receipt,
  "strategy":     Lightbulb,
  "apis-config":  Plug,
};

const AGENT_COLORS: Record<string, string> = {
  "task-manager": "text-cyan-400",
  "sales":        "text-emerald-400",
  "delivery":     "text-blue-400",
  "triage":       "text-amber-400",
  "reconciler":   "text-violet-400",
  "billing":      "text-indigo-400",
  "strategy":     "text-orange-400",
  "apis-config":  "text-primary",
};

function getAgentIcon(agent: AgentEntry): React.ElementType {
  return AGENT_ICONS[agent.name] ?? Bot;
}

function getAgentColor(agent: AgentEntry): string {
  return AGENT_COLORS[agent.name] ?? "text-muted-foreground";
}

function agentReadiness(
  agent: AgentEntry,
  statuses: IntegrationStatus[]
): "ready" | "blocked" | "unknown" {
  const deps = agent.integrations ?? [];
  if (deps.length === 0) return "ready";
  if (statuses.length === 0) return "unknown";
  return deps.some((i) => {
    const s = statuses.find((x) => x.service === i);
    return s !== undefined && !s.configured;
  })
    ? "blocked"
    : "ready";
}

// ---------------------------------------------------------------------------
// AgentTile — compact grid card
// ---------------------------------------------------------------------------

function AgentTile({
  agent,
  selected,
  statuses,
  onClick,
}: {
  agent: AgentEntry;
  selected: boolean;
  statuses: IntegrationStatus[];
  onClick: () => void;
}) {
  const Icon      = getAgentIcon(agent);
  const color     = getAgentColor(agent);
  const readiness = agentReadiness(agent, statuses);

  return (
    <button
      onClick={onClick}
      className={`text-left w-full p-4 rounded-xl border transition-all ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border bg-card hover:border-primary/40 hover:bg-secondary/30"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <Icon size={28} className={`${color} shrink-0`} />
        <span
          className={`w-2 h-2 mt-1 rounded-full shrink-0 ${
            readiness === "ready"   ? "bg-success" :
            readiness === "blocked" ? "bg-warning"  : "bg-muted"
          }`}
          title={
            readiness === "ready"   ? "Ready" :
            readiness === "blocked" ? "Blocked \u2014 needs API connections" : "Unknown"
          }
        />
      </div>
      <div className="font-medium text-sm text-foreground leading-tight">{agent.name}</div>
      <div className={`text-[10px] mt-0.5 ${
        readiness === "ready"   ? "text-success" :
        readiness === "blocked" ? "text-warning"  : "text-muted-foreground"
      }`}>
        {readiness === "ready" ? "\u25cf Ready" :
         readiness === "blocked" ? "\u26a0 Blocked" : "\u25cb Unknown"}
      </div>
      {agent.description && (
        <p className="text-[10px] text-muted-foreground mt-2 line-clamp-2 leading-relaxed">
          {agent.description}
        </p>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// AgentSidePanel
// ---------------------------------------------------------------------------

function AgentSidePanel({
  agent,
  statuses,
  onClose,
  onRemove,
}: {
  agent: AgentEntry;
  statuses: IntegrationStatus[];
  onClose: () => void;
  onRemove: (name: string) => void;
}) {
  const Icon  = getAgentIcon(agent);
  const color = getAgentColor(agent);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving]     = useState(false);

  const missingDeps = (agent.integrations ?? []).filter((i) => {
    const s = statuses.find((x) => x.service === i);
    return s !== undefined && !s.configured;
  });

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(agent.name)}`, { method: "DELETE" });
      if (res.ok) { onRemove(agent.name); onClose(); }
      else {
        const d = await res.json().catch(() => ({}));
        alert(String(d?.detail ?? d?.error ?? "Failed to remove agent"));
      }
    } catch { alert("Network error while removing agent"); }
    finally { setRemoving(false); setConfirming(false); }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
        <div className="flex items-start gap-3">
          <Icon size={36} className={`${color} mt-0.5 shrink-0`} />
          <div>
            <div className="font-semibold text-foreground text-base">{agent.name}</div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {agent.agent_runtime === "github-copilot" ? (
                <>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/20 bg-accent/10 text-accent">MAF</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary/80">Copilot SDK</span>
                </>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/20 bg-accent/10 text-accent">MAF</span>
              )}
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                agent.status === "live" ? "bg-success/10 text-success" : "bg-secondary text-muted-foreground"
              }`}>{agent.status}</span>
              {agent.dynamic && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">custom</span>
              )}
            </div>
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {agent.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">{agent.description}</p>
        )}

        {(agent.tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.tags!.map((t) => (
              <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">{t}</span>
            ))}
          </div>
        )}

        {missingDeps.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
            <div className="text-xs text-warning">
              <span className="font-medium">Agent blocked</span> \u2014 needs{" "}
              <Link href="/integrations" className="underline hover:opacity-80">
                {missingDeps.map((i) => statuses.find((s) => s.service === i)?.label ?? i).join(", ")}
              </Link>
            </div>
          </div>
        )}

        {(agent.integrations?.length ?? 0) > 0 && (
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Required Integrations</div>
            <div className="flex flex-wrap gap-1.5">
              {agent.integrations!.map((i) => {
                const intg  = statuses.find((s) => s.service === i);
                const state = intg === undefined ? "unknown" : intg.configured ? "ok" : "missing";
                return (
                  <Link key={i} href="/integrations">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${
                      state === "ok"
                        ? "border-success/20 text-success bg-success/10 hover:bg-success/20"
                        : state === "missing"
                        ? "border-warning/20 text-warning bg-warning/5 hover:bg-warning/10"
                        : "border-border text-muted-foreground"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        state === "ok" ? "bg-success" : state === "missing" ? "bg-warning" : "bg-muted"
                      }`} />
                      {intg?.label ?? i}
                      {state === "missing" && <ExternalLink className="w-2.5 h-2.5" />}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {(agent.optional_integrations?.length ?? 0) > 0 && (
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Optional Integrations</div>
            <div className="flex flex-wrap gap-1.5">
              {agent.optional_integrations!.map((i) => {
                const intg = statuses.find((s) => s.service === i);
                const ok   = intg?.configured === true;
                return (
                  <Link key={i} href="/integrations">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs cursor-pointer transition-colors ${
                      ok ? "border-success/20 text-success hover:bg-success/10" : "border-border text-muted-foreground hover:bg-secondary"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-success" : "bg-muted"}`} />
                      {intg?.label ?? i}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {(agent.local_path ?? agent.repo_url ?? agent.repo_name) && (
          <div>
            <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Source</div>
            {agent.local_path ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono bg-secondary rounded-lg px-2.5 py-1.5">
                <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{agent.local_path}</span>
              </div>
            ) : (
              <a
                href={
                  agent.repo_url ??
                  (agent.repo_name?.includes("/")
                    ? `https://github.com/${agent.repo_name}`
                    : `https://github.com/FracktalWorks/${agent.repo_name}`)
                }
                target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <GithubIcon size={14} className="shrink-0" />
                <span className="truncate">{agent.repo_name ?? agent.repo_url}</span>
                <ExternalLink className="w-2.5 h-2.5 shrink-0 ml-auto" />
              </a>
            )}
          </div>
        )}

        {agent.agent_runtime === "github-copilot" && (
          <PendingCommits agentName={agent.name} />
        )}

        <div className="flex gap-2 pt-2">
          <Link
            href={`/chat?agent=${encodeURIComponent(agent.name)}`}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-primary hover:opacity-90 text-sm font-medium text-primary-foreground transition-colors"
          >
            <MessageCircle className="w-4 h-4" /> Chat
          </Link>
          {agent.dynamic && (
            confirming ? (
              <div className="flex items-center gap-1.5">
                <button disabled={removing} onClick={() => void handleRemove()}
                  className="px-3 py-2 rounded-lg bg-destructive text-destructive-foreground text-xs hover:opacity-90 disabled:opacity-50 transition-colors">
                  {removing ? "\u2026" : "Remove"}
                </button>
                <button onClick={() => setConfirming(false)}
                  className="px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors">
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)}
                className="p-2.5 rounded-lg border border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive transition-colors"
                title="Remove agent">
                <Trash2 className="w-4 h-4" />
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const [agents, setAgents]     = useState<AgentEntry[]>([]);
  const [intgs, setIntgs]       = useState<IntegrationStatus[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState<"all" | "builtin" | "custom">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [showAdd, setShowAdd]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [aRes, iRes] = await Promise.all([
        fetch("/api/agent/list"),
        fetch("/api/integrations/status"),
      ]);
      if (aRes.ok) setAgents(await aRes.json());
      if (iRes.ok) { const d = await iRes.json(); if (Array.isArray(d)) setIntgs(d); }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    // Only auto-select first agent on desktop (sm+). On mobile, keep the grid clean.
    const isDesktop = typeof window !== "undefined" && window.innerWidth >= 640;
    if (!loading && agents.length > 0 && !selected && isDesktop) setSelected(agents[0].name);
  }, [loading, agents, selected]);

  const handleRemove = (name: string) => {
    setAgents((p) => p.filter((a) => a.name !== name));
    if (selected === name) setSelected(null);
  };

  const handleAdded = (agent: AgentEntry) =>
    setAgents((p) => [...p, { ...agent, dynamic: true }]);

  const filtered = agents.filter((a) =>
    filter === "builtin" ? !a.dynamic : filter === "custom" ? !!a.dynamic : true
  );
  const selectedAgent = selected ? (agents.find((a) => a.name === selected) ?? null) : null;
  const readyCnt      = agents.filter((a) => agentReadiness(a, intgs) === "ready").length;
  const blockedCnt    = agents.filter((a) => agentReadiness(a, intgs) === "blocked").length;

  const FILTERS = [
    { id: "all"     as const, label: "All",      count: agents.length },
    { id: "builtin" as const, label: "Built-in", count: agents.filter((a) => !a.dynamic).length },
    { id: "custom"  as const, label: "Custom",   count: agents.filter((a) => !!a.dynamic).length },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-base sm:text-lg font-bold text-foreground">Agents</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {loading
              ? "Loading\u2026"
              : `${agents.length} agents \u00b7 ${readyCnt} ready${blockedCnt > 0 ? ` \u00b7 ${blockedCnt} blocked` : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} title="Refresh"
            className="p-2 rounded-lg border border-border text-muted-foreground hover:bg-secondary transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary hover:opacity-90 text-sm font-medium text-primary-foreground transition-colors">
            <Plus className="w-4 h-4" /><span className="hidden sm:inline">Add Agent</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 sm:px-4 py-2 border-b border-border shrink-0 overflow-x-auto scrollbar-hide">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`text-xs px-2.5 py-1 rounded-full whitespace-nowrap shrink-0 transition-colors ${
              filter === f.id
                ? "bg-primary text-primary-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}>
            {f.label} <span className="opacity-60">{f.count}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden relative">
        <div className={`flex-1 p-4 overflow-y-auto ${selectedAgent ? "sm:min-w-0" : ""}`}>
          {loading ? (
            <div className="flex items-center justify-center h-48 gap-3 text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading agents\u2026
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground text-sm">
              <p>No {filter !== "all" ? filter : ""} agents found.</p>
              <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 text-xs text-primary hover:opacity-80">
                <Plus className="w-3.5 h-3.5" /> Add agent
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {filtered.map((agent) => (
                <AgentTile
                  key={agent.name}
                  agent={agent}
                  selected={selected === agent.name}
                  statuses={intgs}
                  onClick={() => setSelected(agent.name)}
                />
              ))}
              <button
                onClick={() => setShowAdd(true)}
                className="p-4 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all flex flex-col items-center justify-center gap-2 min-h-[120px]"
              >
                <Plus className="w-5 h-5" /><span className="text-xs">Add Agent</span>
              </button>
            </div>
          )}
        </div>

        {selectedAgent && (
          <>
            {/* Mobile: compact slide-up panel (45% height) — grid stays visible below */}
            <div className="sm:hidden fixed inset-0 z-40 pointer-events-none">
              <div className="absolute inset-0 bg-black/50 pointer-events-auto" onClick={() => setSelected(null)} />
              <aside className="absolute inset-x-0 bottom-14 pointer-events-auto flex max-h-[45%] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl chat-fade-in">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {(() => {
                      const Icon = getAgentIcon(selectedAgent);
                      const color = getAgentColor(selectedAgent);
                      return <Icon size={20} className={color} />;
                    })()}
                    <span className="text-sm font-semibold truncate">{selectedAgent.name}</span>
                  </div>
                  <button onClick={() => setSelected(null)} className="p-1 rounded-md hover:bg-secondary text-muted-foreground shrink-0">
                    <X size={16} />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <AgentSidePanel
                    agent={selectedAgent}
                    statuses={intgs}
                    onClose={() => setSelected(null)}
                    onRemove={handleRemove}
                  />
                </div>
              </aside>
            </div>
            {/* Desktop: side panel */}
            <div className="hidden sm:flex w-[380px] border-l border-border bg-card shrink-0 flex-col overflow-hidden">
              <AgentSidePanel
                agent={selectedAgent}
                statuses={intgs}
                onClose={() => setSelected(null)}
                onRemove={handleRemove}
              />
            </div>
          </>
        )}
      </div>

      {showAdd && (
        <AddAgentModal
          onClose={() => setShowAdd(false)}
          onAdded={handleAdded}
        />
      )}
    </div>
  );
}
