"use client";

/**
 * The projects list — the densest management scan.
 *
 * Spec: `ProjectApp_Plan.md` §16 (SCREEN 3).
 *
 * ## It adds no endpoint
 *
 * `GET /projects/tasks` already does allowlisted server-side sorting, keyset
 * paging and ~15 filters. This slice added two SORTS to that endpoint
 * (`health`, `stage`) and nothing else — a second list route would have been a
 * parallel seam with its own filter semantics, and the two would disagree
 * about what "overdue" means within a release.
 *
 * **Nothing loads the portfolio into the browser** (plan §28): sort, filter and
 * page are all query parameters, and the table renders exactly one page.
 *
 * Client and Programme come from the tree rather than the row: `pm_tasks` knows
 * its `project_id`, and the typed ancestry (D-PM-2 · `kind`) lives in
 * `/projects/tree`. One extra fetch of ~23 nodes, resolved into a map, beats
 * widening the hot list query with two joins it does not otherwise need.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import Input, { Select } from "@/components/ui/Input";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { type AccentHue, accentForHue } from "@/lib/statusAccent";

import { HEALTH_LABELS } from "../home/lib/dashboard";
import { shortName } from "../home/lib/dashboard";
import { ancestry, type TreeNode } from "./lib/ancestry";

interface Row {
  id: string; title: string; project_id: string; status_id: string;
  stage_id?: string | null; health?: string | null; due_at?: string | null;
  next_action?: string | null; assignees?: string[]; updated_at?: string | null;
}

const PAGE_SIZE = 25;

/** Sort keys the SERVER allows (`core.TASK_SORTS`). Anything else is a 422. */
const COLUMNS: Array<{ key: string; label: string; sortable: boolean }> = [
  { key: "title", label: "Project", sortable: true },
  { key: "", label: "Client / Programme", sortable: false },
  { key: "", label: "Owner", sortable: false },
  { key: "status", label: "Status", sortable: true },
  { key: "stage", label: "Stage", sortable: true },
  { key: "health", label: "Health", sortable: true },
  { key: "due_at", label: "Due", sortable: true },
  { key: "", label: "Next action", sortable: false },
];

export default function ProjectsListPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("due_at");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [statuses, setStatuses] = useState<Record<string, { name: string; category: string; color: string | null }>>({});
  const [stages, setStages] = useState<Record<string, string>>({});
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      sort, direction: dir, page: String(page), page_size: String(PAGE_SIZE),
    });
    if (q.trim()) params.set("q", q.trim());
    if (category) params.set("status_category", category);
    const j = (p: string) =>
      fetch(`/api/projects${p}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    const [list, forest] = await Promise.all([j(`/tasks?${params}`), j("/tree")]);
    if (list) { setRows(list.rows ?? []); setTotal(list.total ?? 0); }
    if (forest?.rows) {
      setTree(forest.rows);
      const root = forest.rows[0];
      if (root) {
        const [s, g] = await Promise.all([
          j(`/nodes/${root.id}/statuses`), j(`/nodes/${root.id}/stages`),
        ]);
        type StatusRow = { id: string; name: string; category: string; color: string | null };
        if (s?.rows) setStatuses(Object.fromEntries((s.rows as StatusRow[]).map((x) => [x.id, x])));
        if (g?.rows) setStages(Object.fromEntries(g.rows.map((x: { id: string; name: string }) => [x.id, x.name])));
      }
    }
    setLoading(false);
  }, [sort, dir, page, q, category]);

  useEffect(() => {
    const run = async () => { await load(); };
    void run();
  }, [load]);

  const paths = useMemo(() => ancestry(tree), [tree]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** Clicking a sorted column flips direction; a new column starts ascending. */
  const clickSort = (key: string) => {
    if (!key) return;
    if (key === sort) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(key); setDir("asc"); }
    setPage(1);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <h1 className="shrink-0 text-xs font-medium text-muted-foreground">Projects list</h1>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Every project, sortable and filtered on the server
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" icon="LayoutDashboard"
            onClick={() => router.push("/projects/home")}>Control Center</Button>
          <Button variant="ghost" size="sm" icon="LayoutGrid"
            onClick={() => router.push("/projects")}>Board</Button>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-[220px] flex-1">
          <Input
            icon="Search" inputSize="sm" value={q} placeholder="Search titles and descriptions…"
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </div>
        <div className="w-40">
          <Select inputSize="sm" value={category}
            onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
            <option value="">Any status</option>
            {["todo", "in_progress", "blocked", "paused", "done"].map((c) => (
              <option key={c} value={c}>{c.replace("_", " ")}</option>
            ))}
          </Select>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {loading ? "—" : `${total} project${total === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4"><SkeletonRows rows={10} height="h-9" /></div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
            <Icon name="SearchX" size={22} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {q || category ? "Nothing matches those filters." : "No projects yet."}
            </p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                {COLUMNS.map((c) => (
                  <th key={c.label} className="px-3 py-2 font-medium">
                    {c.sortable ? (
                      <button type="button" onClick={() => clickSort(c.key)}
                        className="flex items-center gap-1 hover:text-foreground tech-transition">
                        {c.label}
                        {sort === c.key ? (
                          <Icon name={dir === "asc" ? "ChevronUp" : "ChevronDown"} size={11} />
                        ) : null}
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = statuses[r.status_id];
                const hue = (st?.color ?? "gray") as AccentHue;
                const a = accentForHue(hue);
                const path = paths[r.project_id];
                const overdue = r.due_at ? new Date(r.due_at) < new Date() : false;
                const health = r.health ? HEALTH_LABELS[r.health] : null;
                return (
                  <tr key={r.id} onClick={() => router.push(`/projects?task=${r.id}`)}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted tech-transition">
                    <td className="max-w-[240px] px-3 py-2 text-foreground"><span className="truncate">{r.title}</span></td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {path ? (
                        <>
                          <span className="text-foreground">{path.client ?? "—"}</span>
                          {path.program ? <span> / {path.program}</span> : null}
                        </>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {r.assignees?.length ? r.assignees.map(shortName).join(", ")
                        : <span className="text-warning">Unassigned</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {st ? (
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${a.soft} ${a.text}`}>{st.name}</span>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {r.stage_id ? stages[r.stage_id] ?? "—" : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {health ? (
                        <span className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${accentForHue(health.hue as AccentHue).dot}`} />
                          <span className="text-muted-foreground">{health.label}</span>
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {r.due_at ? (
                        <span className={overdue ? "text-destructive" : "text-muted-foreground"}>
                          {new Date(r.due_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="max-w-[220px] px-3 py-2">
                      {r.next_action ? <span className="truncate text-muted-foreground">{r.next_action}</span>
                        : <span className="text-warning">None set</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ⚠️ The pager sits on the LEFT, and that is not a style choice.
          `WorkTimerDock` is `fixed bottom-4 right-4 w-80` on every screen with
          a running session, so a bottom-RIGHT control is underneath it and
          swallows the click — measured: Playwright timed out for 30s on
          "Next", reporting the dock's card as intercepting pointer events. A
          user with a timer running simply could not page this list.

          Moving the controls is the fix rather than padding the footer by the
          dock's width, which would hard-code one component's geometry into
          another and silently break the day the dock is resized. Any future
          page with a bottom bar has the same constraint. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" icon="ChevronLeft" disabled={page <= 1}
            onClick={() => setPage((n) => Math.max(1, n - 1))}>Previous</Button>
          <span className="text-[11px] tabular-nums text-muted-foreground">{page} / {pages}</span>
          <Button variant="ghost" size="sm" icon="ChevronRight" disabled={page >= pages}
            onClick={() => setPage((n) => Math.min(pages, n + 1))}>Next</Button>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {total === 0 ? "—" :
            `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}
        </span>
        {/* Reserves the dock's corner so nothing is ever placed under it. */}
        <span aria-hidden="true" className="hidden sm:block sm:w-80" />
      </div>
    </div>
  );
}
