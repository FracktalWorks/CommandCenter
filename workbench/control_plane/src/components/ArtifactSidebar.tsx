"use client";

/**
 * ArtifactSidebar — collapsible right-side file tree for agent-generated artefacts.
 *
 * Props:
 *   sessionId        — active chat session (used to fetch /api/agent/workspace/{id})
 *   open             — controlled open/closed state
 *   onToggle         — called when the collapse chevron is clicked
 *   onFileOpen       — called when the user clicks a file (passes FileEntry)
 *   artifactUpdates  — new FileEntry objects pushed in from SSE (ST-AV-06); merged into tree
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronRight as FolderArrow,
  File,
  FileCode,
  FileText,
  FileImage,
  FileSpreadsheet,
  RefreshCw,
  Download,
  Trash2,
  PanelLeft,
  History,
  ArrowUpToLine,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Files in inputs/, outputs/, and agent-data/ are user/agent-generated
 *  and safe to delete from the Files Viewer.  Everything else (agent
 *  source, configs, skills) is hidden from the UI entirely. */
function isDeletable(entry: FileEntry): boolean {
  const p = entry.path;
  return (
    p.startsWith("inputs/") ||
    p.startsWith("outputs/") ||
    p.startsWith("agent-data/")
  );
}

export interface FileEntry {
  path: string;       // relative to workspace root, e.g. "reports/summary.md"
  name: string;
  size: number;       // bytes
  modified_at: string;
  mime_type: string;
  is_dir?: boolean;
}

/** One version row from the blob-store history endpoint. */
export interface FileHistoryRow {
  path: string;
  folder: string;
  sha256: string;
  size: number;
  action: string;     // create | modify | delete | promote
  actor: string;      // agent | user | system
  created_at: string;
}

interface TreeNode {
  name: string;
  path: string;       // full relative path (for files) or prefix (for dirs)
  isDir: boolean;
  entry?: FileEntry;
  children: Map<string, TreeNode>;
}

interface ArtifactSidebarProps {
  sessionId: string;
  open: boolean;
  onToggle: () => void;
  onFileOpen: (entry: FileEntry) => void;
  artifactUpdates?: FileEntry[];
  /** Render as a full-width drawer panel (mobile) rather than a collapsible rail. */
  fullWidth?: boolean;
  /** Right-click → "Open in side panel". When omitted, the context menu is off. */
  onOpenInSidePanel?: (entry: FileEntry) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        const isDir = i < parts.length - 1;
        node.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir,
          entry: isDir ? undefined : f,
          children: new Map(),
        });
      }
      node = node.children.get(part)!;
    }
    // attach entry to the leaf node
    if (node.entry === undefined) node.entry = f;
  }
  return root;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(entry: FileEntry) {
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = entry.mime_type;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext) || mime.startsWith("image/"))
    return <FileImage size={13} className="shrink-0 text-purple-400" />;
  if (["py", "ts", "tsx", "js", "jsx", "sh", "yaml", "yml", "toml", "json", "sql", "rs", "go", "java", "c", "cpp"].includes(ext))
    return <FileCode size={13} className="shrink-0 text-blue-400" />;
  if (["md", "txt", "log", "rst", "csv"].includes(ext) || mime.startsWith("text/"))
    return <FileText size={13} className="shrink-0 text-green-400" />;
  if (["pdf"].includes(ext) || mime === "application/pdf")
    return <FileText size={13} className="shrink-0 text-red-400" />;
  if (["xlsx", "xls", "csv"].includes(ext))
    return <FileSpreadsheet size={13} className="shrink-0 text-emerald-400" />;
  return <File size={13} className="shrink-0 text-muted-foreground" />;
}

// ─── TreeNodeRow ─────────────────────────────────────────────────────────────

function TreeNodeRow({
  node,
  depth,
  onFileOpen,
  sessionId,
  onDeleteFile,
  onOpenInSidePanel,
}: {
  node: TreeNode;
  depth: number;
  onFileOpen: (entry: FileEntry) => void;
  sessionId: string;
  onDeleteFile: (entry: FileEntry) => void;
  onOpenInSidePanel?: (entry: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Declared before the dir early-return so the hook order is stable across
  // renders (rules-of-hooks): context-menu anchor + per-file history/promote state.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [history, setHistory] = useState<FileHistoryRow[] | null>(null);
  const [promoting, setPromoting] = useState(false);
  const paddingLeft = 8 + depth * 12;

  if (node.isDir) {
    const children = Array.from(node.children.values()).sort((a, b) => {
      // dirs first, then files
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    return (
      <div>
        <button
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-secondary transition-colors"
          style={{ paddingLeft }}
          onClick={() => setExpanded((e) => !e)}
        >

          {expanded ? <ChevronDown size={11} className="shrink-0" /> : <FolderArrow size={11} className="shrink-0" />}
          <span className="truncate font-medium text-foreground">{node.name || "/"}</span>
        </button>
        {expanded && children.map((child) => (
          <TreeNodeRow key={child.path} node={child} depth={depth + 1} onFileOpen={onFileOpen} sessionId={sessionId} onDeleteFile={onDeleteFile} onOpenInSidePanel={onOpenInSidePanel} />
        ))}
      </div>
    );
  }

  const entry = node.entry!;
  const downloadUrl = `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(entry.path)}`;
  const deletable = isDeletable(entry);
  const isInput = entry.path.startsWith("inputs/");

  const loadHistory = async () => {
    try {
      const res = await fetch(
        `/api/agent/workspace/${sessionId}/history?path=${encodeURIComponent(entry.path)}`,
      );
      const data = await res.json();
      setHistory(Array.isArray(data.history) ? data.history : []);
    } catch {
      setHistory([]);
    }
  };

  const promote = async () => {
    setPromoting(true);
    try {
      const res = await fetch(`/api/agent/workspace/${sessionId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.path }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.detail ?? `HTTP ${res.status}`);
      }
      onDeleteFile(entry); // it moved out of inputs/ — drop the old row
    } catch (err) {
      alert(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPromoting(false);
    }
  };

  const openContext = (e: React.MouseEvent) => {
    e.preventDefault();
    // Clamp so the small menu stays on-screen near the cursor.
    const x = Math.min(e.clientX, window.innerWidth - 190);
    const y = Math.min(e.clientY, window.innerHeight - 90);
    setMenu({ x, y });
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete "${entry.name}"?\n\nThis cannot be undone.`)) return;
    try {
      const res = await fetch(
        `/api/agent/workspace/${sessionId}/file?path=${encodeURIComponent(entry.path)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleteFile(entry);
    } catch (err) {
      alert(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <div
        className="group flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-secondary cursor-pointer transition-colors"
        style={{ paddingLeft: paddingLeft + 14 }}
        onClick={() => onFileOpen(entry)}
        onContextMenu={openContext}
        title={`${entry.path} · ${formatBytes(entry.size)}${deletable ? "\nClick 🗑 to delete" : "\nProtected file"}\nClick to open${onOpenInSidePanel ? " · Right-click for more" : ""}`}
      >
        {fileIcon(entry)}
        <span className="flex-1 truncate">{entry.name}</span>
        <span className="shrink-0 text-muted-foreground text-[10px]">{formatBytes(entry.size)}</span>
        <a
          href={downloadUrl}
          download={entry.name}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-muted-foreground hover:text-blue-400 transition-all p-0.5"
          title={`Download ${entry.name}`}
        >
          <Download size={12} />
        </a>
        {deletable && (
          <button
            onClick={handleDelete}
            className="shrink-0 text-muted-foreground hover:text-red-400 transition-all p-0.5"
            title={`Delete ${entry.name}`}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {menu && (
        <>
          {/* Full-screen catcher: any click / right-click closes the menu. */}
          <div
            className="fixed inset-0 z-[80]"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-[81] min-w-[190px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {onOpenInSidePanel && (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-popover-foreground hover:bg-secondary transition-colors"
                onClick={() => {
                  onOpenInSidePanel(entry);
                  setMenu(null);
                }}
              >
                <PanelLeft size={13} className="shrink-0 text-muted-foreground" />
                Open in side panel
              </button>
            )}
            {isInput && (
              <button
                disabled={promoting}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-popover-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                onClick={() => {
                  promote();
                  setMenu(null);
                }}
                title="Move to Agent Data — permanent, prompt-shaping storage"
              >
                <ArrowUpToLine size={13} className="shrink-0 text-muted-foreground" />
                {promoting ? "Promoting…" : "Promote to Agent Data"}
              </button>
            )}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-popover-foreground hover:bg-secondary transition-colors"
              onClick={() => {
                loadHistory();
                setMenu(null);
              }}
            >
              <History size={13} className="shrink-0 text-muted-foreground" />
              Version history
            </button>
            <a
              href={downloadUrl}
              download={entry.name}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-popover-foreground hover:bg-secondary transition-colors"
              onClick={() => setMenu(null)}
            >
              <Download size={13} className="shrink-0 text-muted-foreground" />
              Download
            </a>
          </div>
        </>
      )}

      {history !== null && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setHistory(null)}
        >
          <div
            className="max-h-[70vh] w-full max-w-md overflow-hidden rounded-xl border border-border bg-popover shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <History size={14} className="text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground truncate">
                {entry.name}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {history.length} version{history.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {history.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No history recorded yet.
                </p>
              ) : (
                history.map((h, i) => (
                  <div
                    key={`${h.sha256}-${i}`}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-secondary"
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        h.action === "delete"
                          ? "bg-red-900/30 text-red-300"
                          : h.action === "promote"
                          ? "bg-primary/15 text-primary"
                          : h.action === "create"
                          ? "bg-emerald-900/30 text-emerald-300"
                          : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {h.action}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {h.sha256.slice(0, 8)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{formatBytes(h.size)}</span>
                    <span className="text-[10px] text-muted-foreground/70">· {h.actor}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/70">
                      {new Date(h.created_at).toLocaleString("en-IN")}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ArtifactSidebar({
  sessionId,
  open,
  onToggle,
  onFileOpen,
  artifactUpdates = [],
  fullWidth = false,
  onOpenInSidePanel,
}: ArtifactSidebarProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const prevSessionRef = useRef<string>("");

  const fetchTree = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setOffline(false);
    try {
      const res = await fetch(`/api/agent/workspace/${sessionId}`);
      // 503 = gateway offline; treat as empty workspace, not a hard error
      if (res.status === 503 || res.status === 502) {
        setOffline(true);
        setFiles([]);
        return;
      }
      if (!res.ok) {
        setFiles([]);
        return;
      }
      const data = await res.json();
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch {
      // Network error (gateway unreachable)
      setOffline(true);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Reload when session changes
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      prevSessionRef.current = sessionId;
      setFiles([]);
      fetchTree();
    }
  }, [sessionId, fetchTree]);

  // Merge SSE artifact updates into the local file list.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (artifactUpdates.length === 0) return;
    setFiles((prev) => {
      const map = new Map(prev.map((f) => [f.path, f]));
      for (const u of artifactUpdates) {
        const old = map.get(u.path);
        // Merge rather than replace: an SSE update that omits size/mime must not
        // wipe values a /workspace fetch already filled in.
        map.set(u.path, old
          ? { ...old, ...u, size: u.size || old.size, mime_type: u.mime_type || old.mime_type }
          : u);
      }
      return Array.from(map.values());
    });
  }, [artifactUpdates]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleDeleteFile = useCallback((entry: FileEntry) => {
    setFiles((prev) => prev.filter((f) => f.path !== entry.path));
  }, []);

  const tree = buildTree(files);
  const rootChildren = Array.from(tree.children.values()).sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <aside
      className={
        fullWidth
          ? "h-full w-full border-l border-border bg-card flex flex-col"
          : `shrink-0 border-l border-border bg-card/40 flex flex-col transition-all duration-200 ${
              open ? "w-64" : "w-10"
            }`
      }
    >
      {/* Header */}
      <div
        className={`flex items-center border-b border-border ${
          open ? "justify-between px-3 py-2.5" : "justify-center py-2.5"
        }`}
      >
        {open && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">Files</span>
            {files.length > 0 && (
              <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {files.length}
              </span>
            )}
          </div>
        )}
        <div className={`flex items-center gap-1 ${open ? "" : "flex-col"}`}>
          {open && (
            <button
              onClick={fetchTree}
              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              title="Refresh file tree"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
          )}
          <button
            onClick={onToggle}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            title={open ? "Collapse file browser" : "Expand file browser"}
          >
            {open ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
      </div>

      {/* Content */}
      {open && (
        <div className="flex flex-col flex-1 overflow-y-auto p-1.5 min-h-0">
          {loading && (
            <div className="flex items-center gap-1.5 px-2 py-3 text-xs text-muted-foreground">
              <RefreshCw size={11} className="animate-spin" />
              Loading…
            </div>
          )}

          {!loading && offline && (
            <div className="px-2 py-4 text-center">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Gateway offline.
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                Start the backend to browse agent files.
              </p>
            </div>
          )}

          {!loading && !offline && files.length === 0 && (
            <div className="px-2 py-4 text-center">
              <p className="text-xs text-muted-foreground leading-relaxed">
                No files yet.
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                Artifacts appear here as the agent creates them.
              </p>
            </div>
          )}

          {!loading && rootChildren.map((node) => (
            <TreeNodeRow key={node.path} node={node} depth={0} onFileOpen={onFileOpen} sessionId={sessionId} onDeleteFile={handleDeleteFile} onOpenInSidePanel={onOpenInSidePanel} />
          ))}
        </div>
      )}

      {/* Collapsed: just show a rotated label */}
      {!open && (
        <div className="flex flex-1 items-center justify-center">
          <span
            className="text-[10px] text-muted-foreground font-semibold tracking-widest"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            FILES
          </span>
        </div>
      )}
    </aside>
  );
}
