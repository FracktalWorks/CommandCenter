"use client";

/**
 * People Center · the person page (§3.2) — four panels.
 *
 * Identity, skills, capacity, work. The panels are deliberately in that order:
 * who they are, what they can do, how loaded they are, what they are holding.
 */
import { useEffect, useState } from "react";

import Button from "@/components/ui/Button";

import { type PersonDetail, type WorkRow, peopleApi } from "../lib/api";
import { initials, loadBar, skillOrigin, statusTone } from "../lib/directory";

interface Props {
  personId: string;
  /** Bumped by the page after a save, so the panel re-reads what was written. */
  reloadKey?: number;
  onClose: () => void;
  /**
   * Opens the editor on this person. The panel raises it rather than rendering
   * the editor itself: the editor needs the directory (for the manager picker)
   * and the status vocabulary, and both belong to the page.
   */
  onEdit?: (person: PersonDetail) => void;
}

const TONE: Record<string, string> = {
  active: "bg-muted text-foreground",
  warn: "border border-border text-foreground",
  muted: "text-muted-foreground",
};

export function PersonPanel({ personId, reloadKey = 0, onClose, onEdit }: Props) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [work, setWork] = useState<{ rows: WorkRow[]; available: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [detail, tasks] = await Promise.all([
          peopleApi.person(personId),
          peopleApi.work(personId),
        ]);
        if (!live) return;
        setPerson(detail);
        setWork({ rows: tasks.rows, available: tasks.available });
        setError(null);
      } catch (err) {
        if (live) setError(String((err as Error).message));
      }
    })();
    return () => {
      live = false;
    };
  }, [personId, reloadKey]);

  if (error) {
    return (
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card p-3">
        <p className="text-sm text-foreground">{error}</p>
      </aside>
    );
  }
  if (!person) {
    return (
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card p-3">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </aside>
    );
  }

  const bar = loadBar(person);

  return (
    <aside className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card">
      <header className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
            {initials(person.name)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">{person.name}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {person.title || person.role || "—"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Absent without `admin:members:manage`, never disabled (§3.2). */}
          {person.can_manage && onEdit ? (
            <Button
              variant="secondary"
              size="sm"
              icon="Pencil"
              onClick={() => onEdit(person)}
            >
              Edit
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            icon="X"
            aria-label="Close person"
            onClick={onClose}
          />
        </div>
      </header>

      {/* 1 — Identity. The login badge is the visible half of the two-store
          split: it stops "why can't they see the board" being a mystery. */}
      <section className="space-y-1 border-b border-border p-3 text-xs">
        <Row label="Email">
          {person.email ? (
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-foreground">{person.email}</span>
              <span className={`rounded px-1 py-0.5 ${TONE[person.has_login ? "active" : "warn"]}`}>
                {person.has_login ? "has login" : "directory-only"}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </Row>
        {person.email_conflict ? (
          <p className="rounded-md border border-border p-2 text-xs text-foreground">
            Another record already claimed <strong>{person.email_conflict}</strong>. Somebody
            has to decide which row is the real person.
          </p>
        ) : null}
        <Row label="Department">{person.department || "—"}</Row>
        <Row label="Team">{person.team || "—"}</Row>
        <Row label="Manager">{person.manager || "—"}</Row>
        <Row label="Status">
          <span className={`rounded px-1 py-0.5 ${TONE[statusTone(person.status)]}`}>
            {person.status}
          </span>
        </Row>
      </section>

      {/* 2 — Skills, each carrying its provenance. */}
      <section className="border-b border-border p-3">
        <h3 className="mb-1 text-xs font-medium text-foreground">Skills</h3>
        {!person.hr_visible ? (
          <p className="text-xs text-muted-foreground">
            Restricted — skills, résumé and capacity need <code>admin:members:read</code>.
          </p>
        ) : (person.skills ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">Nobody has added any yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {(person.skills ?? []).map((skill) => {
              const origin = skillOrigin(skill, person.skills_source);
              return (
                <span
                  key={skill}
                  title={origin === "stated" ? "Stated by a person" : "Extracted from a résumé"}
                  className={`rounded-md px-2 py-1 text-xs ${
                    origin === "stated"
                      ? "bg-muted text-foreground"
                      : "border border-border text-muted-foreground"
                  }`}
                >
                  {skill}
                </span>
              );
            })}
          </div>
        )}
        {person.hr_visible && person.resume_summary ? (
          <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
            {person.resume_summary}
          </p>
        ) : null}
      </section>

      {/* 3 — Capacity, as ONE bar computed from open assigned tasks. */}
      <section className="border-b border-border p-3">
        <h3 className="mb-1 text-xs font-medium text-foreground">Capacity</h3>
        {!person.hr_visible ? (
          <p className="text-xs text-muted-foreground">Restricted.</p>
        ) : (
          <>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              {bar.unknown ? null : (
                <div
                  className="h-full bg-primary"
                  style={{ width: `${bar.percent}%` }}
                />
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{bar.label}</p>
          </>
        )}
      </section>

      {/* 4 — Work, scoped by the VIEWER's grants, not the subject's. */}
      <section className="p-3">
        <h3 className="mb-1 text-xs font-medium text-foreground">Open work</h3>
        {!work ? null : !work.available ? (
          <p className="text-xs text-muted-foreground">
            Needs the Projects app to show what they are working on.
          </p>
        ) : work.rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing open that you can see.
          </p>
        ) : (
          <ul className="space-y-1">
            {work.rows.map((task) => (
              <li key={task.id} className="text-xs">
                <a
                  href={`/projects?task=${task.id}`}
                  className="text-foreground hover:underline"
                >
                  {task.task_number ? `#${task.task_number} ` : ""}
                  {task.title}
                </a>
                <span className="text-muted-foreground">
                  {" — "}
                  {task.project_name ?? "a project"} · {task.status_name}
                  {task.due_at ? ` · due ${new Date(task.due_at).toLocaleDateString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </p>
  );
}
