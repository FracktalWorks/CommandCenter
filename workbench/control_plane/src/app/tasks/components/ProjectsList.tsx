"use client";

import { useMemo, useState } from "react";
import {
  FolderKanban,
  AlertTriangle,
  ChevronRight,
  HardDrive,
  Cloud,
  Folder,
  Boxes,
  ListTree,
  Plus,
  Loader2,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { GtdItem, GtdProject } from "../lib/types";
import type { LocalFolder, LocalSpace } from "../lib/api";
import type { TaskAccount } from "../lib/api";

// The Projects view — a navigable hierarchy that mirrors the PM tool:
//   ClickUp <account>  →  Space → Folder → List(=Project) → Task → Subtask
//   Local              →  Space → Folder → Project        → Task → Subtask
// Two clearly-separated sections (ClickUp vs Local), each an expandable tree.
// Tasks + subtasks lazy-load from the store when a project node is expanded.

export function ProjectsList() {
  const accounts = useTaskStore((s) => s.accounts);
  const localHierarchy = useTaskStore((s) => s.localHierarchy);
  const projects = useTaskStore((s) => s.projects);
  const backend = useTaskStore((s) => s.backend);

  // Only ACTIVE (or unset-status) projects clutter-free.
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status === "ACTIVE"),
    [projects],
  );
  const syncedAccounts = accounts;
  const hasLocal =
    (localHierarchy?.spaces.length ?? 0) > 0 ||
    activeProjects.some((p) => p.source === "LOCAL");

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderKanban className="h-4 w-4 text-primary" />
          <h1 className="text-base font-bold text-foreground">Projects</h1>
          <span className="ml-auto text-xs text-muted-foreground">
            {activeProjects.length} active
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Spaces, folders, projects, tasks, and subtasks — local and your
          connected tools, side by side.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-4">
          {/* ── Connected tools (ClickUp) ── */}
          {syncedAccounts.map((acct) => (
            <AccountSection
              key={acct.id}
              account={acct}
              projects={activeProjects}
            />
          ))}

          {/* ── Local ── */}
          <LocalSection
            hierarchy={localHierarchy}
            projects={activeProjects}
            loading={backend === "live" && localHierarchy === null}
          />

          {!hasLocal && syncedAccounts.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <FolderKanban className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                No projects yet. Connect a workspace or create a local space.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Section shells ──────────────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  label,
  tone,
  count,
}: {
  icon: typeof HardDrive;
  label: string;
  tone: "local" | "synced";
  count?: number;
}) {
  return (
    <div className="mb-1 flex items-center gap-1.5 px-1">
      <Icon
        className={[
          "h-3.5 w-3.5",
          tone === "synced" ? "text-primary" : "text-muted-foreground",
        ].join(" ")}
      />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
        {label}
      </span>
      {count != null && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  );
}

/** A connected workspace (ClickUp): its spaces → folders → lists(projects). */
function AccountSection({
  account,
  projects,
}: {
  account: TaskAccount;
  projects: GtdProject[];
}) {
  // Mirrored list → the GtdProject that mirrors it (by providerRef).
  const byRef = useMemo(() => {
    const m = new Map<string, GtdProject>();
    for (const p of projects)
      if (p.source === "SYNCED" && p.providerRef)
        m.set(p.providerRef, p);
    return m;
  }, [projects]);

  const spaceCount = account.hierarchy.length;

  return (
    <section className="rounded-xl border border-primary/20 bg-primary/[0.02]">
      <div className="border-b border-border/60 px-3 py-2">
        <SectionHeader
          icon={Cloud}
          label={account.label || account.provider}
          tone="synced"
          count={spaceCount}
        />
      </div>
      <div className="p-1.5">
        {account.hierarchy.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground/70">
            No spaces synced — refresh the workspace schema.
          </p>
        ) : (
          account.hierarchy.map((space) => (
            <TreeNode
              key={space.id}
              label={space.name}
              icon={Boxes}
              depth={0}
              defaultOpen={account.hierarchy.length === 1}
            >
              {/* folderless lists directly on the space */}
              {space.lists.map((l) => (
                <ProjectNode
                  key={l.id}
                  project={byRef.get(l.id)}
                  fallbackName={l.name}
                  depth={1}
                />
              ))}
              {space.folders.map((folder) => (
                <TreeNode
                  key={folder.id}
                  label={folder.name}
                  icon={Folder}
                  depth={1}
                >
                  {folder.lists.map((l) => (
                    <ProjectNode
                      key={l.id}
                      project={byRef.get(l.id)}
                      fallbackName={l.name}
                      depth={2}
                    />
                  ))}
                  {folder.lists.length === 0 && (
                    <EmptyLeaf depth={2} text="No lists" />
                  )}
                </TreeNode>
              ))}
              {space.lists.length === 0 && space.folders.length === 0 && (
                <EmptyLeaf depth={1} text="Empty space" />
              )}
            </TreeNode>
          ))
        )}
      </div>
    </section>
  );
}

/** The Local tree: our spaces → folders → projects, plus an ungrouped bucket. */
function LocalSection({
  hierarchy,
  projects,
  loading,
}: {
  hierarchy: ReturnType<typeof useTaskStore.getState>["localHierarchy"];
  projects: GtdProject[];
  loading: boolean;
}) {
  const createLocalSpace = useTaskStore((s) => s.createLocalSpace);
  const createLocalFolder = useTaskStore((s) => s.createLocalFolder);
  const createLocalProject = useTaskStore((s) => s.createLocalProject);

  const spaces: LocalSpace[] = hierarchy?.spaces ?? [];
  // Local projects that aren't in the hierarchy payload (older rows) still show
  // via the flat projects list under an "Ungrouped" bucket.
  const localProjects = projects.filter((p) => p.source === "LOCAL");
  const foldersBySpace = useMemo(() => {
    const m = new Map<string, LocalFolder[]>();
    for (const f of hierarchy?.folders ?? []) {
      const arr = m.get(f.spaceId) ?? [];
      arr.push(f);
      m.set(f.spaceId, arr);
    }
    return m;
  }, [hierarchy?.folders]);

  const projectsIn = (spaceId?: string, folderId?: string) =>
    localProjects.filter((p) =>
      folderId
        ? p.folderId === folderId
        : spaceId
          ? p.spaceId === spaceId && !p.folderId
          : !p.spaceId && !p.folderId,
    );

  const ungrouped = projectsIn(undefined, undefined);

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <SectionHeader
          icon={HardDrive}
          label="Local"
          tone="local"
          count={spaces.length}
        />
        <AddInline
          label="Space"
          onAdd={(name) => void createLocalSpace(name)}
        />
      </div>
      <div className="p-1.5">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : spaces.length === 0 && ungrouped.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground/70">
            No local spaces yet. Add one to organise your own projects.
          </p>
        ) : (
          <>
            {spaces.map((space) => {
              const spFolders = foldersBySpace.get(space.id) ?? [];
              return (
                <TreeNode
                  key={space.id}
                  label={space.name}
                  icon={Boxes}
                  depth={0}
                  trailing={
                    <AddInline
                      label="Folder"
                      onAdd={(name) => void createLocalFolder(space.id, name)}
                    />
                  }
                >
                  {projectsIn(space.id, undefined).map((p) => (
                    <ProjectNode key={p.id} project={p} depth={1} />
                  ))}
                  {spFolders.map((folder) => (
                    <TreeNode
                      key={folder.id}
                      label={folder.name}
                      icon={Folder}
                      depth={1}
                    >
                      {projectsIn(space.id, folder.id).map((p) => (
                        <ProjectNode key={p.id} project={p} depth={2} />
                      ))}
                      {projectsIn(space.id, folder.id).length === 0 && (
                        <EmptyLeaf depth={2} text="No projects" />
                      )}
                    </TreeNode>
                  ))}
                  <AddProjectRow
                    depth={1}
                    onAdd={(outcome) =>
                      void createLocalProject({ outcome, spaceId: space.id })
                    }
                  />
                </TreeNode>
              );
            })}

            {ungrouped.length > 0 && (
              <TreeNode label="Ungrouped" icon={Folder} depth={0} defaultOpen>
                {ungrouped.map((p) => (
                  <ProjectNode key={p.id} project={p} depth={1} />
                ))}
              </TreeNode>
            )}

            <AddProjectRow
              depth={0}
              onAdd={(outcome) => void createLocalProject({ outcome })}
              placeholder="New project (no space)…"
            />
          </>
        )}
      </div>
    </section>
  );
}

// ── Tree primitives ─────────────────────────────────────────────────────────

const INDENT = 14;

function TreeNode({
  label,
  icon: Icon,
  depth,
  children,
  defaultOpen = false,
  trailing,
}: {
  label: string;
  icon: typeof Folder;
  depth: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  trailing?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded-md py-1 pr-1.5 hover:bg-secondary/50"
        style={{ paddingLeft: depth * INDENT + 4 }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={[
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open ? "rotate-90" : "",
            ].join(" ")}
          />
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[13px] font-medium text-foreground">
            {label}
          </span>
        </button>
        {trailing && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            {trailing}
          </span>
        )}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

/** A project (ClickUp list or local project). Expands to its tasks. */
function ProjectNode({
  project,
  fallbackName,
  depth,
}: {
  project?: GtdProject;
  fallbackName?: string;
  depth: number;
}) {
  const items = useTaskStore((s) => s.items);
  const selectProject = useTaskStore((s) => s.selectProject);
  const [open, setOpen] = useState(false);

  const name = project?.outcome ?? fallbackName ?? "Untitled";
  // Not-yet-mirrored ClickUp lists have no local project row — show them muted.
  const notMirrored = !project;

  const tasks = useMemo(
    () =>
      project
        ? items.filter(
            (i) => i.projectId === project.id && !i.parentItemId,
          )
        : [],
    [items, project],
  );
  const openTasks = tasks.filter((t) => t.disposition === "NEXT").length;

  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded-md py-1 pr-1.5 hover:bg-secondary/50"
        style={{ paddingLeft: depth * INDENT + 4 }}
      >
        <button
          type="button"
          onClick={() => !notMirrored && setOpen((o) => !o)}
          disabled={notMirrored}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
          title={notMirrored ? "Not mirrored yet — sync the workspace" : undefined}
        >
          <ChevronRight
            className={[
              "h-3.5 w-3.5 shrink-0 transition-transform",
              notMirrored ? "opacity-20" : "text-muted-foreground",
              open ? "rotate-90" : "",
            ].join(" ")}
          />
          <FolderKanban
            className={[
              "h-3.5 w-3.5 shrink-0",
              notMirrored ? "text-muted-foreground/40" : "text-primary/70",
            ].join(" ")}
          />
          <span
            className={[
              "truncate text-[13px]",
              notMirrored ? "text-muted-foreground/60" : "text-foreground",
            ].join(" ")}
          >
            {name}
          </span>
          {project && !project.hasNextAction && tasks.length === 0 && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-warning">
              <AlertTriangle className="h-3 w-3" />
            </span>
          )}
          {openTasks > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {openTasks}
            </span>
          )}
        </button>
        {project && (
          <button
            type="button"
            onClick={() => selectProject(project.id)}
            className="shrink-0 rounded px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
            title="Open project"
          >
            Open
          </button>
        )}
      </div>
      {open && project && (
        <div>
          {tasks.map((t) => (
            <TaskNode key={t.id} task={t} depth={depth + 1} />
          ))}
          {tasks.length === 0 && (
            <EmptyLeaf depth={depth + 1} text="No tasks yet" />
          )}
        </div>
      )}
    </div>
  );
}

/** A task under a project. Expands to its subtasks if it has any. */
function TaskNode({ task, depth }: { task: GtdItem; depth: number }) {
  const loadSubtasks = useTaskStore((s) => s.loadSubtasks);
  const openFocus = useTaskStore((s) => s.openFocus);
  const [open, setOpen] = useState(false);
  const [subs, setSubs] = useState<GtdItem[] | null>(null);
  const hasSubs = (task.subtaskCount ?? 0) > 0;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && subs === null && hasSubs) {
      void loadSubtasks(task.id).then(setSubs);
    }
  };
  const done = task.disposition === "DONE";

  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded-md py-1 pr-1.5 hover:bg-secondary/50"
        style={{ paddingLeft: depth * INDENT + 4 }}
      >
        {hasSubs ? (
          <button type="button" onClick={toggle} className="shrink-0">
            <ChevronRight
              className={[
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                open ? "rotate-90" : "",
              ].join(" ")}
            />
          </button>
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => openFocus(task.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span
            className={[
              "h-1.5 w-1.5 shrink-0 rounded-full",
              done ? "bg-success" : "bg-muted-foreground/40",
            ].join(" ")}
          />
          <span
            className={[
              "truncate text-[12px]",
              done ? "text-muted-foreground line-through" : "text-foreground",
            ].join(" ")}
          >
            {task.title}
          </span>
          {hasSubs && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <ListTree className="h-3 w-3" />
              {task.subtaskCount}
            </span>
          )}
        </button>
      </div>
      {open && subs && (
        <div>
          {subs.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 rounded-md py-0.5 pr-1.5 hover:bg-secondary/40"
              style={{ paddingLeft: (depth + 1) * INDENT + 4 }}
            >
              <span className="h-3.5 w-3.5 shrink-0" />
              <span
                className={[
                  "h-1 w-1 shrink-0 rounded-full",
                  s.disposition === "DONE"
                    ? "bg-success"
                    : "bg-muted-foreground/40",
                ].join(" ")}
              />
              <button
                type="button"
                onClick={() => openFocus(s.id)}
                className={[
                  "min-w-0 flex-1 truncate text-left text-[11px]",
                  s.disposition === "DONE"
                    ? "text-muted-foreground line-through"
                    : "text-muted-foreground",
                ].join(" ")}
              >
                {s.title}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyLeaf({ depth, text }: { depth: number; text: string }) {
  return (
    <p
      className="py-1 text-[11px] italic text-muted-foreground/40"
      style={{ paddingLeft: depth * INDENT + 22 }}
    >
      {text}
    </p>
  );
}

// ── Inline creators ─────────────────────────────────────────────────────────

function AddInline({
  label,
  onAdd,
}: {
  label: string;
  onAdd: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const commit = () => {
    const t = name.trim();
    if (t) onAdd(t);
    setName("");
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="tech-transition inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> {label}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { setName(""); setEditing(false); }
      }}
      placeholder={`New ${label.toLowerCase()}…`}
      className="w-32 rounded border border-primary/40 bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none"
    />
  );
}

function AddProjectRow({
  depth,
  onAdd,
  placeholder = "New project…",
}: {
  depth: number;
  onAdd: (outcome: string) => void;
  placeholder?: string;
}) {
  const [name, setName] = useState("");
  const commit = () => {
    const t = name.trim();
    if (!t) return;
    onAdd(t);
    setName("");
  };
  return (
    <div
      className="flex items-center gap-1.5 py-1 pr-1.5"
      style={{ paddingLeft: depth * INDENT + 22 }}
    >
      <Plus className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
      />
      {name.trim() && (
        <button
          type="button"
          onClick={commit}
          className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground hover:opacity-90"
        >
          Add
        </button>
      )}
    </div>
  );
}
