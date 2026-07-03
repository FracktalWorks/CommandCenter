"use client";

import { useState } from "react";
import {
  X,
  Cloud,
  Plus,
  RefreshCw,
  Trash2,
  KeyRound,
  Building2,
  Check,
  Loader2,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { apiConnectWorkspace, apiListWorkspaces } from "../lib/api";

// Connect / manage PM-tool workspaces (task_accounts). ClickUp needs more than
// a bare token — the flow is: paste token → we verify it and list the
// workspaces it reaches → pick one → connect. Repeat for several workspaces/
// companies: each becomes its own account row with its own credentials (§5.1).
export function WorkspacesModal() {
  const open = useTaskStore((s) => s.workspacesModalOpen);
  if (!open) return null;
  return <WorkspacesPanel />;
}

type Workspace = { id: string; name: string; memberCount: number };

function WorkspacesPanel() {
  const close = useTaskStore((s) => s.closeWorkspaces);
  const backend = useTaskStore((s) => s.backend);
  const accounts = useTaskStore((s) => s.accounts);
  const refreshAccounts = useTaskStore((s) => s.refreshAccounts);
  const disconnectAccount = useTaskStore((s) => s.disconnectAccount);
  const refreshAccountSchema = useTaskStore((s) => s.refreshAccountSchema);
  const syncNow = useTaskStore((s) => s.syncNow);
  const syncing = useTaskStore((s) => s.syncing);

  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const findWorkspaces = async () => {
    setBusy("find");
    setError(null);
    try {
      setWorkspaces(await apiListWorkspaces("clickup", token.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach ClickUp");
      setWorkspaces(null);
    } finally {
      setBusy(null);
    }
  };

  const connect = async (w: Workspace) => {
    setBusy(w.id);
    setError(null);
    try {
      await apiConnectWorkspace({
        provider: "clickup",
        apiToken: token.trim(),
        workspaceId: w.id,
        label: w.name,
      });
      await refreshAccounts();
      setWorkspaces((ws) => ws?.filter((x) => x.id !== w.id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setBusy(null);
    }
  };

  const connectedIds = new Set(
    accounts.filter((a) => a.provider === "clickup").map((a) => a.workspaceId),
  );

  return (
    <div
      className="chat-fade-in fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 sm:items-start sm:p-4 sm:pt-[10vh]"
      onClick={close}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl border-t border-border bg-card shadow-2xl pb-safe sm:max-h-[85vh] sm:rounded-2xl sm:border sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Cloud className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">
            PM-tool workspaces
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="tech-transition ml-auto rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {backend !== "live" && (
            <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              The tasks backend isn&apos;t reachable — running on demo data.
              Connecting workspaces needs the gateway.
            </p>
          )}

          {/* Connected accounts */}
          <div>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Connected
            </h3>
            {accounts.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No workspaces connected yet. Personal tasks stay Local; connect
                your team&apos;s ClickUp to delegate and sync collaborative work.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {accounts.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
                  >
                    <Building2 className="h-4 w-4 shrink-0 text-primary/80" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {a.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {a.provider} · {a.projectCount} projects ·{" "}
                        {a.members.length} members ·{" "}
                        {a.statuses.length
                          ? a.statuses.join(" / ")
                          : "no stages cached"}
                      </p>
                      {a.syncError && (
                        <p className="truncate text-[11px] text-destructive">
                          {a.syncError}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      title="Pull this workspace's tasks into the GTD views"
                      disabled={syncing}
                      onClick={() => void syncNow(a.id)}
                      className="tech-transition rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                    >
                      {syncing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Cloud className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      title="Re-fetch projects/members/stages"
                      onClick={() => void refreshAccountSchema(a.id)}
                      className="tech-transition rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Disconnect workspace"
                      onClick={() => void disconnectAccount(a.id)}
                      className="tech-transition rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Connect flow */}
          <div>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Connect a ClickUp workspace
            </h3>
            <div className="flex items-center gap-2">
              <div className="tech-transition flex flex-1 items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 focus-within:border-primary/50">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Personal API token (pk_…)"
                  type="password"
                  className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none sm:text-sm"
                />
              </div>
              <button
                type="button"
                disabled={!token.trim() || busy === "find" || backend !== "live"}
                onClick={() => void findWorkspaces()}
                className="tech-transition inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                {busy === "find" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Find workspaces
              </button>
            </div>
            <p className="mt-1 px-1 text-[10px] text-muted-foreground">
              ClickUp → Settings → Apps → API Token. The token is encrypted at
              rest; one account per workspace, so several companies can coexist.
            </p>

            {error && (
              <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {error}
              </p>
            )}

            {workspaces && (
              <div className="mt-2 flex flex-col gap-1.5">
                {workspaces.length === 0 && (
                  <p className="text-[12px] text-muted-foreground">
                    This token reaches no workspaces.
                  </p>
                )}
                {workspaces.map((w) => {
                  const already = connectedIds.has(w.id);
                  return (
                    <div
                      key={w.id}
                      className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
                    >
                      <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] text-foreground">{w.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {w.memberCount} members · id {w.id}
                        </p>
                      </div>
                      {already ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-success">
                          <Check className="h-3.5 w-3.5" /> connected
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy === w.id}
                          onClick={() => void connect(w)}
                          className="tech-transition inline-flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                        >
                          {busy === w.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Plus className="h-3.5 w-3.5" />
                          )}
                          Connect
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
