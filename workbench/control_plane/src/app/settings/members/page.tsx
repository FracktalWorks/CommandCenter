"use client";

/**
 * Settings → Members — the organization roster, and the queue of people
 * trying to get into it.
 *
 * Spec: ai-company-brain/specs/org_access_control.md §6;
 *       ai-company-brain/specs/colleague_onboarding.md §6 (the Requests tab).
 *
 * Invite, suspend, change roles, and drill into one person's access. The
 * per-person editor is where the interesting work happens (./[email]); this
 * page is the list that gets you there.
 *
 * The **Requests** tab is the other direction. Until it existed this screen
 * only showed people an admin had already thought of; somebody arriving at the
 * front door produced a log line nobody read. The badge is the whole point —
 * the owner is supposed to learn that a colleague is locked out without being
 * told.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  DoorOpen,
  Loader2,
  Plus,
  RefreshCw,
  ShieldOff,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import FilterPills from "@/components/FilterPills";
import Tabs from "@/components/Tabs";
import { useAccess } from "@/components/AccessProvider";
import type { AccessRequest, Member, Role } from "./types";

const STATUS_STYLES: Record<Member["status"], string> = {
  active: "text-success",
  invited: "text-warning",
  suspended: "text-destructive",
  removed: "text-muted-foreground",
};

/**
 * What each status means to the person on the other end of it.
 *
 * `invited` is the one that matters: `is_active` is `status === "active"`
 * exactly, so an invited colleague sees the identical dead-end screen as a
 * total stranger while this list renders them as though they were live. That
 * ambiguity is the 2026-08-04 incident (colleague_onboarding.md §6) — the row
 * has to say so.
 */
const STATUS_LABELS: Record<Member["status"], string> = {
  active: "active",
  invited: "invited — never signed in",
  suspended: "suspended",
  removed: "removed",
};

/** Absolute date + time; a knock at 16:21 yesterday is a fact, not "a while ago". */
function when(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MembersPage() {
  const { access, refresh: refreshAccess } = useAccess();
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("members");
  const [filter, setFilter] = useState("all");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      // The fetch goes first so no setState runs synchronously in the mount
      // effect — clearing the error afterwards is equivalent and avoids a
      // cascading render.
      const [m, r, q] = await Promise.all([
        fetch("/api/admin/members", { cache: "no-store" }),
        fetch("/api/admin/roles", { cache: "no-store" }),
        fetch("/api/admin/members/requests", { cache: "no-store" }),
      ]);
      setError("");
      if (!m.ok) {
        const body = await m.json().catch(() => ({}));
        throw new Error(body.detail ?? `Failed to load members (${m.status})`);
      }
      setMembers(await m.json());
      if (r.ok) setRoles(await r.json());
      // A deployment whose migration has not run yet still shows the roster;
      // the queue is additive and must never take the page down with it.
      setRequests(q.ok ? await q.json() : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load members.");
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

  const counts = useMemo(
    () => ({
      all: members.length,
      active: members.filter((m) => m.status === "active").length,
      invited: members.filter((m) => m.status === "invited").length,
      suspended: members.filter((m) => m.status === "suspended").length,
    }),
    [members]
  );

  const shown = useMemo(
    () => (filter === "all" ? members : members.filter((m) => m.status === filter)),
    [members, filter]
  );

  const setStatus = async (email: string, status: Member["status"]) => {
    setError("");
    const res = await fetch(`/api/admin/members/${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.detail ?? "Could not update this member.");
      return;
    }
    await load();
    // The admin may have just changed their own access.
    await refreshAccess();
  };

  /** Approve (provisions + activates in one action) or deny a knock. */
  const decide = async (
    email: string,
    decision: "approve" | "deny",
    roleSlug?: string
  ) => {
    setError("");
    const res = await fetch(
      `/api/admin/members/requests/${encodeURIComponent(email)}/${decision}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          decision === "approve"
            ? JSON.stringify({ roles: roleSlug ? [roleSlug] : [] })
            : undefined,
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.detail ?? `Could not ${decision} this request.`);
      return;
    }
    // Decided rows leave the tab; an approval also adds a member.
    await load();
  };

  if (!access.is_admin && !loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm rounded-xl border border-border bg-card p-8 text-center">
          <ShieldOff size={20} className="mx-auto mb-3 text-muted-foreground" />
          <h1 className="text-base font-semibold text-foreground">
            Members is admin-only
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            You need the <code className="font-mono">admin:members:read</code>{" "}
            permission to manage the organization roster.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0 sm:px-6 sm:py-4">
        <div>
          <h1 className="text-base font-bold text-foreground sm:text-lg">Members</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {access.organization?.display_name ?? "Organization"} ·{" "}
            {counts.active} active of {counts.all}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="rounded-lg border border-border p-2 text-muted-foreground tech-transition hover:bg-secondary"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <Link
            href="/settings/groups"
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground tech-transition hover:border-primary/30 hover:text-foreground"
          >
            Teams
          </Link>
          <Link
            href="/settings/roles"
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground tech-transition hover:border-primary/30 hover:text-foreground"
          >
            Roles
          </Link>
          <button
            onClick={() => setInviting(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground tech-transition hover:opacity-90 sm:px-4"
          >
            <Plus size={15} />
            Invite
          </button>
        </div>
      </div>

      <Tabs
        variant="underline"
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          { id: "members", label: "Members", icon: Users, count: counts.all },
          {
            id: "requests",
            label: "Requests",
            icon: DoorOpen,
            // Only badged when there is something to answer — a permanent "0"
            // is the kind of chrome people stop reading.
            count: requests.length || undefined,
            note: "People who signed in and found no account",
          },
        ]}
      />

      {tab === "members" && (
        <div className="border-b border-border px-4 py-2.5 sm:px-6">
          <FilterPills
            items={[
              { id: "all", label: "All", count: counts.all },
              { id: "active", label: "Active", count: counts.active },
              { id: "invited", label: "Invited", count: counts.invited },
              { id: "suspended", label: "Suspended", count: counts.suspended },
            ]}
            activeId={filter}
            onChange={setFilter}
          />
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-6">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading members…
          </div>
        ) : tab === "requests" ? (
          <RequestsTab
            requests={requests}
            roles={roles}
            onDecide={decide}
          />
        ) : shown.length === 0 ? (
          <p className="text-xs text-muted-foreground">No members here yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((m) => (
              <div
                key={m.email}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 sm:p-4"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/settings/members/${encodeURIComponent(m.email)}`}
                    className="truncate text-sm font-medium text-foreground hover:text-primary tech-transition"
                  >
                    {m.display_name || m.email}
                  </Link>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {m.email}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {m.roles.length === 0 ? (
                    <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      no role
                    </span>
                  ) : (
                    m.roles.map((r) => (
                      <span
                        key={r}
                        className="rounded-md bg-secondary px-2 py-0.5 text-[10px] text-foreground"
                      >
                        {roles.find((x) => x.slug === r)?.display_name ?? r}
                      </span>
                    ))
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      m.status === "active"
                        ? "bg-success"
                        : m.status === "invited"
                          ? "bg-warning"
                          : "bg-muted"
                    }`}
                  />
                  <span
                    className={`text-[11px] ${STATUS_STYLES[m.status]}`}
                    title={
                      m.status === "invited"
                        ? "Their row exists but is not active — they still see the same dead-end screen as a stranger. Activate them."
                        : undefined
                    }
                  >
                    {STATUS_LABELS[m.status]}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <Link
                    href={`/settings/members/${encodeURIComponent(m.email)}`}
                    className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground tech-transition hover:border-primary/30 hover:text-foreground"
                  >
                    Manage access
                  </Link>
                  {m.status === "suspended" || m.status === "invited" ? (
                    <button
                      onClick={() => void setStatus(m.email, "active")}
                      className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground tech-transition hover:border-primary/30 hover:text-foreground"
                    >
                      Activate
                    </button>
                  ) : (
                    <button
                      onClick={() => void setStatus(m.email, "suspended")}
                      className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive tech-transition hover:bg-destructive/20"
                    >
                      Suspend
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {inviting && (
        <InviteDialog
          roles={roles}
          onClose={() => setInviting(false)}
          onDone={async () => {
            setInviting(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The Requests tab — everyone who authenticated and found no account.
 *
 * Approve provisions them AND activates them in one action: an approval is the
 * decision to let somebody in, and they are already at the door. Leaving them
 * `invited` here would re-create the two-click trap this whole tab exists to
 * close (colleague_onboarding.md §6 done-when 7).
 */
function RequestsTab({
  requests,
  roles,
  onDecide,
}: {
  requests: AccessRequest[];
  roles: Role[];
  onDecide: (
    email: string,
    decision: "approve" | "deny",
    roleSlug?: string
  ) => Promise<void>;
}) {
  if (requests.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <DoorOpen size={18} className="mx-auto mb-2 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Nobody is waiting. Anyone who signs in without an account shows up
          here — you do not have to be told.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {requests.map((r) => (
        <RequestRow key={r.email} request={r} roles={roles} onDecide={onDecide} />
      ))}
    </div>
  );
}

function RequestRow({
  request,
  roles,
  onDecide,
}: {
  request: AccessRequest;
  roles: Role[];
  onDecide: (
    email: string,
    decision: "approve" | "deny",
    roleSlug?: string
  ) => Promise<void>;
}) {
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const assignable = roles.filter((r) => r.slug !== "agent_service");

  const act = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      await onDecide(request.email, decision, role);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 sm:p-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {request.display_name || request.email}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {request.email}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          First tried {when(request.first_seen_at)} · last{" "}
          {when(request.last_seen_at)}
        </div>
      </div>

      <span
        className={`rounded-md px-2 py-0.5 text-[10px] ${
          request.attempt_count > 5
            ? "bg-warning/10 text-warning"
            : "bg-secondary text-muted-foreground"
        }`}
        title="How many times they have tried to sign in"
      >
        {request.attempt_count}{" "}
        {request.attempt_count === 1 ? "attempt" : "attempts"}
      </span>

      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        aria-label={`Role for ${request.email}`}
        className="rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] text-foreground outline-none focus:border-primary/50"
      >
        {assignable.map((r) => (
          <option key={r.slug} value={r.slug}>
            {r.display_name}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-2">
        <button
          onClick={() => void act("approve")}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground tech-transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Check size={12} />
          )}
          Approve
        </button>
        <button
          onClick={() => void act("deny")}
          disabled={busy}
          className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive tech-transition hover:bg-destructive/20 disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function InviteDialog({
  roles,
  onClose,
  onDone,
}: {
  roles: Role[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const assignable = roles.filter((r) => r.slug !== "agent_service");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          display_name: displayName.trim(),
          roles: [role],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Invite failed.");
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <UserPlus size={15} /> Invite a member
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Sign-in is Microsoft SSO — this provisions their access, it does
              not send an email.
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

        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
          Work email
        </label>
        <input
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@fracktal.in"
          className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
        />

        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
          Display name (optional)
        </label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
        />

        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
          Role
        </label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
        >
          {assignable.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.display_name}
            </option>
          ))}
        </select>
        <p className="mb-4 text-[11px] text-muted-foreground">
          {assignable.find((r) => r.slug === role)?.description ?? ""}
        </p>

        {error && (
          <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground tech-transition hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !email.includes("@")}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground tech-transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Invite
          </button>
        </div>
      </div>
    </div>
  );
}
