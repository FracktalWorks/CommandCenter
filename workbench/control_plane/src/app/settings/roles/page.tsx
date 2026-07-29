"use client";

/**
 * Settings → Roles — the permission bundles members are assigned.
 *
 * Spec: ai-company-brain/specs/org_access_control.md §3.2.
 *
 * The five system roles are read-only: they are the floor the bootstrap path
 * depends on, and an org whose `admin` role has been edited into uselessness
 * has no way back. Custom roles are where local policy lives — but note the
 * copy nudging toward per-user overrides, because the failure mode of any
 * role system is one role per employee.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Lock, Plus, Trash2, X } from "lucide-react";
import { useAccess } from "@/components/AccessProvider";
import type { Feature, Role } from "../members/types";

export default function RolesPage() {
  const { access } = useAccess();
  const [roles, setRoles] = useState<Role[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      // Fetch first: no synchronous setState inside the mount effect.
      const [r, f] = await Promise.all([
        fetch("/api/admin/roles", { cache: "no-store" }),
        fetch("/api/admin/features", { cache: "no-store" }),
      ]);
      setError("");
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail ?? `Could not load roles (${r.status})`);
      }
      setRoles(await r.json());
      if (f.ok) {
        const payload = await f.json();
        setFeatures(payload.features ?? []);
        setCapabilities(payload.capabilities ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load roles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Wrapped rather than called directly: the effect must not reach a
    // setState synchronously (react-hooks/set-state-in-effect), and `load` is
    // also invoked from refresh buttons, so it stays a useCallback.
    const run = async () => {
      await load();
    };
    void run();
  }, [load]);

  const remove = async (slug: string) => {
    setError("");
    const res = await fetch(`/api/admin/roles/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.detail ?? "Could not delete this role.");
      return;
    }
    await load();
  };

  if (!access.is_admin && !loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">Roles is admin-only.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0 sm:px-6 sm:py-4">
        <div className="flex items-center gap-3">
          <Link
            href="/settings/members"
            className="rounded-lg border border-border p-2 text-muted-foreground tech-transition hover:bg-secondary"
            aria-label="Back to members"
          >
            <ArrowLeft size={15} />
          </Link>
          <div>
            <h1 className="text-base font-bold text-foreground sm:text-lg">Roles</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Permission bundles you assign to members
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground tech-transition hover:opacity-90 sm:px-4"
        >
          <Plus size={15} />
          New role
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-6">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <p className="mb-4 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
          Need one person to have a little more or less than their role gives
          them? Use per-user access on their member page instead of creating a
          role for them — that is what it is for.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading roles…
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {roles.map((r) => (
              <div key={r.slug} className="rounded-xl border border-border bg-card p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {r.display_name}
                      </span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {r.slug}
                      </code>
                      {r.is_system && (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Lock size={10} /> system
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-muted-foreground">
                      {r.member_count} member{r.member_count === 1 ? "" : "s"}
                    </span>
                    {!r.is_system && (
                      <button
                        onClick={() => void remove(r.slug)}
                        className="rounded-lg bg-destructive/10 p-2 text-destructive tech-transition hover:bg-destructive/20"
                        title="Delete role"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {r.permissions.map((p) => (
                    <code
                      key={p}
                      className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {p}
                    </code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateRoleDialog
          features={features}
          capabilities={capabilities}
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function CreateRoleDialog({
  features,
  capabilities,
  onClose,
  onDone,
}: {
  features: Feature[];
  capabilities: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (permission: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: name.trim().toLowerCase().replace(/\s+/g, "_"),
          display_name: name.trim(),
          description: description.trim(),
          permissions: [...selected],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Could not create the role.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the role.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">New role</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Custom roles always rank below the built-in ones.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Support Team"
            className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />

          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
            Description
          </label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this role is for"
            className="mb-4 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />

          <h3 className="mb-2 text-xs font-semibold text-foreground">Apps</h3>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {features.map((f) => (
              <PermissionChip
                key={f.permission}
                label={f.label}
                on={selected.has(f.permission)}
                onClick={() => toggle(f.permission)}
              />
            ))}
          </div>

          <h3 className="mb-2 text-xs font-semibold text-foreground">Capabilities</h3>
          <div className="flex flex-wrap gap-1.5">
            {capabilities.map((c) => (
              <PermissionChip
                key={c}
                label={c}
                mono
                on={selected.has(c)}
                onClick={() => toggle(c)}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-5">
          {error ? (
            <span className="text-xs text-destructive">{error}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {selected.size} permission{selected.size === 1 ? "" : "s"} selected
            </span>
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground tech-transition hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !name.trim() || selected.size === 0}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground tech-transition hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Create role
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionChip({
  label,
  on,
  mono = false,
  onClick,
}: {
  label: string;
  on: boolean;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-[11px] tech-transition ${
        mono ? "font-mono" : ""
      } ${
        on
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40"
      }`}
    >
      {label}
    </button>
  );
}
