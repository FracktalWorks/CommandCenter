"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Loader2, Users, Link2 } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { OrgPerson } from "../lib/types";
import { PersonEditor } from "./PersonEditor";

/**
 * PeopleView — the HR roster behind the Task Manager's "People" nav entry.
 * Shows everyone's role/title, department, manager, skills, capacity and their
 * ClickUp link, and is the entry point to add/edit a person + ingest résumés.
 * The app is the source of truth for this data (edits persist to gtd_people).
 */
export function PeopleView() {
  const orgPeople = useTaskStore((s) => s.orgPeople);
  const loadPeople = useTaskStore((s) => s.loadPeople);
  const backend = useTaskStore((s) => s.backend);

  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<OrgPerson | "new" | null>(null);

  useEffect(() => {
    // `loading` starts true (initial state), so no synchronous setState here —
    // we only clear it once the fetch settles. loadPeople never rejects (the
    // store swallows errors), so .finally is enough.
    let active = true;
    loadPeople({ includeInactive }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [loadPeople, includeInactive]);

  const departments = useMemo(
    () =>
      Array.from(
        new Set(orgPeople.map((p) => p.department).filter(Boolean) as string[])
      ).sort(),
    [orgPeople]
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return orgPeople.filter((p) => {
      if (dept && p.department !== dept) return false;
      if (!needle) return true;
      return (
        p.name.toLowerCase().includes(needle) ||
        (p.role || "").toLowerCase().includes(needle) ||
        (p.title || "").toLowerCase().includes(needle) ||
        (p.department || "").toLowerCase().includes(needle) ||
        p.skills.some((s) => s.toLowerCase().includes(needle))
      );
    });
  }, [orgPeople, q, dept]);

  if (backend !== "live") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <Users size={22} className="opacity-40" />
        Connect a live workspace to manage your team.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Users size={15} />
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-foreground">
              People
            </h1>
            <p className="text-[11px] leading-tight text-muted-foreground">
              Roles, skills & capacity — the org for capability-aware delegation
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md bg-secondary px-2.5 py-1.5">
            <Search size={13} className="text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, role, skill…"
              className="w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={() => setEditing("new")}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus size={14} /> Add person
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <select
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-foreground"
        >
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="accent-primary"
          />
          Show inactive
        </label>
        <span className="ml-auto text-muted-foreground">
          {visible.length} {visible.length === 1 ? "person" : "people"}
        </span>
      </div>

      {/* Roster */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading people…
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Users size={22} className="opacity-40" />
            {orgPeople.length === 0
              ? "No people yet — add your team or seed from the HR import."
              : "No one matches those filters."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visible.map((p) => (
              <PersonRow key={p.id} p={p} onOpen={() => setEditing(p)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <PersonEditor
          person={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function PersonRow({ p, onOpen }: { p: OrgPerson; onOpen: () => void }) {
  const cap = p.capacityHoursPerWeek ?? 0;
  const load = p.currentLoadHoursPerWeek ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((load / cap) * 100)) : 0;
  const over = cap > 0 && load > cap;
  const initial = (p.name || "?").trim().charAt(0).toUpperCase();

  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50"
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {p.name}
          </span>
          {p.status !== "active" && (
            <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
              {p.status}
            </span>
          )}
          {p.providerUserId && (
            <Link2
              size={11}
              className="text-emerald-500"
              aria-label="Linked to ClickUp"
            />
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {[p.title || p.role, p.department, p.team].filter(Boolean).join(" · ") ||
            "—"}
        </div>
        {p.skills.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {p.skills.slice(0, 6).map((s) => (
              <span
                key={s}
                className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-foreground/70"
              >
                {s}
              </span>
            ))}
            {p.skills.length > 6 && (
              <span className="text-[10px] text-muted-foreground">
                +{p.skills.length - 6}
              </span>
            )}
          </div>
        )}
      </div>
      {/* Capacity */}
      <div className="hidden w-28 flex-shrink-0 sm:block">
        {cap > 0 ? (
          <>
            <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{load}h</span>
              <span>{cap}h</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className={`h-full ${over ? "bg-red-500" : "bg-primary"}`}
                style={{ width: `${Math.max(pct, over ? 100 : pct)}%` }}
              />
            </div>
          </>
        ) : (
          <span className="text-[10px] text-muted-foreground">No capacity set</span>
        )}
      </div>
    </button>
  );
}
