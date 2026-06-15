"use client";

/**
 * Artifacts — global file browser for all agent-generated files.
 *
 * Shows every file in inputs/, outputs/, and agent-data/ across all
 * known agent workspaces.  Card-grid, list, and folder-tree views,
 * group-by-agent, category chip filters, search, and sort.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Download,
  Eye,
  FolderOpen,
  FolderClosed,
  File,
  FileCode,
  FileText,
  FileImage,
  FileSpreadsheet,
  X,
  LayoutGrid,
  List,
  ChevronDown,
  ChevronRight,
  Clock,
  Sparkles,
  RefreshCw,
  Bot,
  FolderTree,
} from "lucide-react";
import ArtifactViewerModal from "@/components/ArtifactViewerModal";
import type { FileEntry } from "@/components/ArtifactSidebar";

// ─── Types ────────────────────────────────────────────────────────────────

interface ArtifactEntry {
  agent_name: string;
  path: string;
  name: string;
  size: number;
  modified_at: string;
  mime_type: string;
  category: "inputs" | "outputs" | "agent-data";
  is_dir?: boolean;
}

interface AgentOption {
  name: string;
}

type ViewMode = "grid" | "list" | "tree";
type SortKey = "newest" | "oldest" | "name" | "largest" | "smallest";

// ─── Tree node ────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  entry?: ArtifactEntry;
  children: Map<string, TreeNode>;
}

function buildTree(artifacts: ArtifactEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: new Map() };
  for (const a of artifacts) {
    const parts = a.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        const isDir = i < parts.length - 1 || a.is_dir === true;
        node.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir,
          entry: isDir ? undefined : a,
          children: new Map(),
        });
      }
      node = node.children.get(part)!;
    }
    if (!node.isDir && node.entry === undefined) node.entry = a;
  }
  return root;
}

// ─── Agent color palette (deterministic from name) ────────────────────────

const AGENT_COLORS = [
  "border-l-blue-500",
  "border-l-emerald-500",
  "border-l-purple-500",
  "border-l-amber-500",
  "border-l-rose-500",
  "border-l-cyan-500",
  "border-l-orange-500",
  "border-l-violet-500",
  "border-l-teal-500",
  "border-l-pink-500",
];

function agentAccent(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

const CATEGORY_META: Record<string, { label: string; emoji: string; color: string }> = {
  inputs:     { label: "Inputs",     emoji: "📥", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" },
  outputs:    { label: "Outputs",    emoji: "📤", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
  "agent-data": { label: "Agent Data", emoji: "🧠", color: "text-purple-400 bg-purple-500/10 border-purple-500/30" },
};

function fileIconEl(entry: ArtifactEntry, size = 18) {
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = entry.mime_type;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext) || mime.startsWith("image/"))
    return <FileImage size={size} className="shrink-0 text-purple-400" />;
  if (["py", "ts", "tsx", "js", "jsx", "sh", "yaml", "yml", "toml", "json", "sql", "rs", "go", "java"].includes(ext))
    return <FileCode size={size} className="shrink-0 text-blue-400" />;
  if (["md", "txt", "log", "rst"].includes(ext) || mime.startsWith("text/"))
    return <FileText size={size} className="shrink-0 text-green-400" />;
  if (["pdf"].includes(ext) || mime === "application/pdf")
    return <FileText size={size} className="shrink-0 text-red-400" />;
  if (["xlsx", "xls", "csv"].includes(ext))
    return <FileSpreadsheet size={size} className="shrink-0 text-emerald-400" />;
  return <File size={size} className="shrink-0 text-muted-foreground" />;
}

function isImage(entry: ArtifactEntry): boolean {
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
    || entry.mime_type.startsWith("image/");
}

function toFileEntry(a: ArtifactEntry): FileEntry {
  return {
    path: a.path, name: a.name, size: a.size,
    modified_at: a.modified_at, mime_type: a.mime_type,
    is_dir: a.is_dir ?? false,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────

function FileCard({
  artifact,
  onView,
  onDownload,
  index,
}: {
  artifact: ArtifactEntry;
  onView: () => void;
  onDownload: () => void;
  index: number;
}) {
  const [imgError, setImgError] = useState(false);
  const accent = agentAccent(artifact.agent_name);
  const meta = CATEGORY_META[artifact.category];
  const showThumb = isImage(artifact) && !imgError;

  return (
    <div
      className="group relative rounded-xl border border-border bg-card hover:border-primary/20 hover:shadow-lg hover:shadow-primary/5 tech-transition overflow-hidden animate-fade-in cursor-pointer"
      style={{ animationDelay: `${Math.min(index * 40, 600)}ms` }}
      onClick={onView}
      title={`${artifact.name}\n${artifact.path}\nClick to view`}
    >
      {/* Category color accent — left edge */}
      <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${accent.replace("border-l-", "bg-")}`} />

      {/* Thumbnail area */}
      <div className="flex items-center justify-center h-28 bg-secondary/40 border-b border-border/50">
        {showThumb ? (
          <img
            src={`/api/agent/artifacts/file?agent=${encodeURIComponent(artifact.agent_name)}&path=${encodeURIComponent(artifact.path)}`}
            alt={artifact.name}
            className="max-w-full max-h-full object-contain p-2"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground/50">
            {fileIconEl(artifact, 32)}
            <span className="text-[10px] font-mono uppercase tracking-wider">
              {artifact.name.split(".").pop() ?? "file"}
            </span>
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="p-3">
        <p className="text-xs font-medium text-foreground truncate leading-tight mb-1" title={artifact.name}>
          {artifact.name}
        </p>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">{formatBytes(artifact.size)}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${meta.color}`}>
            {meta.emoji}
          </span>
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-muted-foreground/70 truncate max-w-[100px]" title={artifact.agent_name}>
            {artifact.agent_name}
          </span>
          <span className="text-[10px] text-muted-foreground/50">{formatRelative(artifact.modified_at)}</span>
        </div>
      </div>

      {/* Hover overlay actions */}
      <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 tech-transition flex items-center justify-center gap-3">
        <button
          onClick={(e) => { e.stopPropagation(); onView(); }}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition shadow-lg"
        >
          <Eye size={13} /> View
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          className="flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/80 tech-transition shadow-lg"
        >
          <Download size={13} /> Download
        </button>
      </div>
    </div>
  );
}

function FileListRow({
  artifact,
  onView,
  onDownload,
  index,
}: {
  artifact: ArtifactEntry;
  onView: () => void;
  onDownload: () => void;
  index: number;
}) {
  const accent = agentAccent(artifact.agent_name);
  const meta = CATEGORY_META[artifact.category];

  return (
    <div
      className={`grid grid-cols-[1fr_90px_70px_70px_80px] sm:grid-cols-[1fr_120px_90px_90px_100px] gap-x-3 gap-y-1 px-4 py-2.5 border-b border-border/40 last:border-b-0 hover:bg-secondary/20 tech-transition cursor-pointer border-l-2 ${accent} animate-fade-in`}
      style={{ animationDelay: `${Math.min(index * 25, 500)}ms` }}
      onClick={onView}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {fileIconEl(artifact, 16)}
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">{artifact.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">{artifact.path}</div>
        </div>
      </div>
      <div className="flex items-center text-[11px] text-muted-foreground truncate" title={artifact.agent_name}>
        {artifact.agent_name}
      </div>
      <div className="flex items-center">
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${meta.color}`}>{meta.emoji}</span>
      </div>
      <div className="flex items-center text-[11px] text-muted-foreground tabular-nums">{formatBytes(artifact.size)}</div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] text-muted-foreground/60">{formatRelative(artifact.modified_at)}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 tech-transition">
          <button onClick={(e) => { e.stopPropagation(); onView(); }} className="p-1 rounded hover:bg-secondary" title="View">
            <Eye size={12} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDownload(); }} className="p-1 rounded hover:bg-secondary" title="Download">
            <Download size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tree view components ─────────────────────────────────────────────────

/** Sort tree children: dirs first, then alphabetically */
function treeSort(a: TreeNode, b: TreeNode): number {
  if (a.isDir && !b.isDir) return -1;
  if (!a.isDir && b.isDir) return 1;
  return a.name.localeCompare(b.name);
}

function treeFileIcon(entry: ArtifactEntry) {
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = entry.mime_type;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext) || mime.startsWith("image/"))
    return <FileImage size={13} className="shrink-0 text-purple-400" />;
  if (["py", "ts", "tsx", "js", "jsx", "sh", "yaml", "yml", "toml", "json", "sql", "rs", "go", "java"].includes(ext))
    return <FileCode size={13} className="shrink-0 text-blue-400" />;
  if (["md", "txt", "log", "rst"].includes(ext) || mime.startsWith("text/"))
    return <FileText size={13} className="shrink-0 text-green-400" />;
  if (["pdf"].includes(ext) || mime === "application/pdf")
    return <FileText size={13} className="shrink-0 text-red-400" />;
  if (["docx", "doc"].includes(ext))
    return <FileText size={13} className="shrink-0 text-cyan-400" />;
  if (["xlsx", "xls", "csv"].includes(ext))
    return <FileSpreadsheet size={13} className="shrink-0 text-emerald-400" />;
  return <File size={13} className="shrink-0 text-muted-foreground" />;
}

function ArtifactTreeNode({
  node,
  depth,
  onView,
  onDownload,
}: {
  node: TreeNode;
  depth: number;
  onView: (a: ArtifactEntry) => void;
  onDownload: (a: ArtifactEntry) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const paddingLeft = 8 + depth * 14;

  if (node.isDir) {
    const children = Array.from(node.children.values()).sort(treeSort);
    const isCategory = depth === 0;
    const meta = CATEGORY_META[node.name];
    return (
      <div>
        <button
          className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-secondary transition-colors ${isCategory ? "text-foreground font-semibold" : "text-muted-foreground"}`}
          style={{ paddingLeft }}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded
            ? <ChevronDown size={11} className="shrink-0" />
            : <ChevronRight size={11} className="shrink-0" />}
          {expanded
            ? <FolderOpen size={isCategory ? 14 : 13} className={`shrink-0 ${isCategory ? "text-amber-400" : "text-muted-foreground"}`} />
            : <FolderClosed size={isCategory ? 14 : 13} className={`shrink-0 ${isCategory ? "text-amber-400" : "text-muted-foreground"}`} />}
          <span className="truncate">
            {isCategory && meta ? <>{meta.emoji} {meta.label}</> : node.name}
          </span>
          {!isCategory && (
            <span className="text-[10px] text-muted-foreground/60 ml-1">
              {children.filter((c) => !c.isDir).length} files
            </span>
          )}
        </button>
        {expanded && children.map((child) => (
          <ArtifactTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onView={onView}
            onDownload={onDownload}
          />
        ))}
      </div>
    );
  }

  // File node
  const entry = node.entry!;
  const isDocx = entry.name.toLowerCase().endsWith(".docx");

  return (
    <div
      className="group flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-secondary cursor-pointer transition-colors"
      style={{ paddingLeft: paddingLeft + 14 }}
      onClick={() => onView(entry)}
      title={`${entry.path}\nAgent: ${entry.agent_name}\n${formatBytes(entry.size)}\nClick to view`}
    >
      {treeFileIcon(entry)}
      <span className="flex-1 truncate">{entry.name}</span>
      {/* Agent badge */}
      <span
        className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-secondary/60 text-muted-foreground truncate max-w-[80px]"
        title={entry.agent_name}
      >
        {entry.agent_name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
        {isDocx ? "DOCX" : formatBytes(entry.size)}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onDownload(entry); }}
        className="shrink-0 p-0.5 text-muted-foreground hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all"
        title="Download"
      >
        <Download size={11} />
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [groupByAgent, setGroupByAgent] = useState(false);

  // Filters
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");

  // Viewer
  const [viewerEntry, setViewerEntry] = useState<FileEntry | null>(null);
  const [viewerUrl, setViewerUrl] = useState("");

  // ── Fetch agent list ──────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/agent/list")
      .then((r) => r.json())
      .then((data: AgentOption[]) => { if (Array.isArray(data)) setAgents(data); })
      .catch(() => {});
  }, []);

  // ── Fetch artifacts ───────────────────────────────────────────────────
  const fetchArtifacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (agentFilter) params.set("agent", agentFilter);
      if (categoryFilter) params.set("category", categoryFilter);
      const res = await fetch(`/api/agent/artifacts?${params.toString()}`);
      if (res.status === 503 || res.status === 502) {
        setError("Gateway offline. Start the backend to browse artifacts.");
        setArtifacts([]); return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(err.error ?? `HTTP ${res.status}`);
        setArtifacts([]); return;
      }
      const data = await res.json();
      setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
    } catch (e) {
      setError(String(e)); setArtifacts([]);
    } finally { setLoading(false); }
  }, [agentFilter, categoryFilter]);

  useEffect(() => { fetchArtifacts(); }, [fetchArtifacts]);

  // ── Sort & filter ─────────────────────────────────────────────────────
  const processed = useMemo(() => {
    let list = [...artifacts];

    // Exclude directories from grid/list views
    list = list.filter((a) => !a.is_dir);

    // Client-side search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        a.path.toLowerCase().includes(q) ||
        a.agent_name.toLowerCase().includes(q)
      );
    }

    // Sort
    list.sort((a, b) => {
      switch (sortKey) {
        case "newest": return new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime();
        case "oldest": return new Date(a.modified_at).getTime() - new Date(b.modified_at).getTime();
        case "name":   return a.name.localeCompare(b.name);
        case "largest":  return b.size - a.size;
        case "smallest": return a.size - b.size;
        default: return 0;
      }
    });

    return list;
  }, [artifacts, searchQuery, sortKey]);

  // ── Tree data (includes directories) ─────────────────────────────────
  const { treeData, treeFiltered } = useMemo(() => {
    // For tree view, apply search filter across all entries (incl. dirs)
    let filtered = artifacts;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      // Keep entries that match, plus their parent directories
      const matchingPaths = new Set<string>();
      for (const a of artifacts) {
        if (a.name.toLowerCase().includes(q) ||
            a.path.toLowerCase().includes(q) ||
            a.agent_name.toLowerCase().includes(q)) {
          matchingPaths.add(a.path);
          // Add all ancestor paths
          const parts = a.path.split("/");
          for (let i = 1; i < parts.length; i++) {
            matchingPaths.add(parts.slice(0, i).join("/"));
          }
        }
      }
      filtered = artifacts.filter((a) => matchingPaths.has(a.path));
    }
    return { treeData: buildTree(filtered), treeFiltered: filtered };
  }, [artifacts, searchQuery]);

  // ── Group by agent ────────────────────────────────────────────────────
  const grouped = useMemo(() => {
    if (!groupByAgent) return null;
    const map = new Map<string, ArtifactEntry[]>();
    for (const a of processed) {
      const list = map.get(a.agent_name) ?? [];
      list.push(a);
      map.set(a.agent_name, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [processed, groupByAgent]);

  // ── Stats ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total: artifacts.filter((a) => !a.is_dir).length,
    dirs: artifacts.filter((a) => a.is_dir).length,
    inputs: artifacts.filter((a) => a.category === "inputs" && !a.is_dir).length,
    outputs: artifacts.filter((a) => a.category === "outputs" && !a.is_dir).length,
    data: artifacts.filter((a) => a.category === "agent-data" && !a.is_dir).length,
    totalSize: artifacts.reduce((s, a) => s + (a.is_dir ? 0 : a.size), 0),
  }), [artifacts]);

  const clearFilters = () => { setAgentFilter(""); setCategoryFilter(""); setSearchQuery(""); };
  const hasFilters = !!(agentFilter || categoryFilter || searchQuery);
  const isFiltered = searchQuery
    ? treeFiltered.filter((a) => !a.is_dir).length !== artifacts.filter((a) => !a.is_dir).length
    : processed.length !== artifacts.filter((a) => !a.is_dir).length;

  const makeFileUrl = (a: ArtifactEntry) =>
    `/api/agent/artifacts/file?agent=${encodeURIComponent(a.agent_name)}&path=${encodeURIComponent(a.path)}`;

  const openViewer = (a: ArtifactEntry) => {
    setViewerUrl(makeFileUrl(a));
    setViewerEntry(toFileEntry(a));
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* ═══ Header ══════════════════════════════════════════════════════ */}
      <div className="shrink-0 border-b border-border px-4 sm:px-6 py-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15">
              <FolderOpen size={20} className="text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-foreground">Artifacts</h1>
              <p className="text-[11px] text-muted-foreground">All files from all agents</p>
            </div>
          </div>
          <button
            onClick={fetchArtifacts}
            className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
            title="Refresh"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Stats pills */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className="text-[11px] text-muted-foreground mr-1">
            <span className="font-semibold text-foreground">{stats.total}</span> files
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            📥 {stats.inputs}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            📤 {stats.outputs}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
            🧠 {stats.data}
          </span>
          <span className="text-[11px] text-muted-foreground">· {formatBytes(stats.totalSize)}</span>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Category chip toggle */}
          <div className="flex items-center gap-1 bg-secondary/60 rounded-lg p-0.5">
            {(["", "inputs", "outputs", "agent-data"] as const).map((cat) => {
              const active = categoryFilter === cat || (!cat && !categoryFilter);
              const meta = cat ? CATEGORY_META[cat] : null;
              return (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium tech-transition ${
                    active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {cat ? `${meta!.emoji} ${meta!.label}` : "All"}
                </button>
              );
            })}
          </div>

          {/* Agent filter */}
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">All agents</option>
            {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>

          {/* Sort */}
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
            <option value="largest">Largest first</option>
            <option value="smallest">Smallest first</option>
          </select>

          {/* Group by agent — only in grid/list */}
          {viewMode !== "tree" && (
            <button
              onClick={() => setGroupByAgent((g) => !g)}
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] tech-transition flex items-center gap-1.5 ${
                groupByAgent
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              <Bot size={13} /> Group
            </button>
          )}

          <div className="flex-1" />

          {/* Search */}
          <div className="relative w-full sm:w-56">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text" value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files…"
              className="w-full rounded-lg border border-border bg-secondary pl-8 pr-8 py-1.5 text-[11px] text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X size={12} />
              </button>
            )}
          </div>

          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-border bg-secondary p-0.5">
            <button
              onClick={() => setViewMode("tree")}
              className={`rounded-md p-1.5 tech-transition ${viewMode === "tree" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              title="Folder tree view"
            ><FolderTree size={14} /></button>
            <button
              onClick={() => setViewMode("grid")}
              className={`rounded-md p-1.5 tech-transition ${viewMode === "grid" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              title="Grid view"
            ><LayoutGrid size={14} /></button>
            <button
              onClick={() => setViewMode("list")}
              className={`rounded-md p-1.5 tech-transition ${viewMode === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              title="List view"
            ><List size={14} /></button>
          </div>

          {hasFilters && (
            <button onClick={clearFilters} className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition flex items-center gap-1">
              <X size={11} /> Clear
            </button>
          )}
        </div>

        {isFiltered && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            Showing {viewMode === "tree" ? treeFiltered.filter((a) => !a.is_dir).length : processed.length} of {stats.total} files
          </p>
        )}
      </div>

      {/* ═══ Content ══════════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-auto">
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
              <RefreshCw size={18} className="animate-spin text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground animate-pulse">Loading artifacts…</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10">
              <X size={18} className="text-red-400" />
            </div>
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={fetchArtifacts} className="text-xs text-muted-foreground hover:text-foreground underline">Retry</button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && (
          viewMode === "tree"
            ? treeFiltered.filter((a) => !a.is_dir).length === 0
            : processed.length === 0
        ) && (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary/50">
              {artifacts.filter((a) => !a.is_dir).length === 0 ? (
                <Sparkles size={28} className="text-muted-foreground/40" />
              ) : (
                <Search size={28} className="text-muted-foreground/40" />
              )}
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">
                {artifacts.filter((a) => !a.is_dir).length === 0 ? "No artifacts yet" : "No matching files"}
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                {artifacts.filter((a) => !a.is_dir).length === 0
                  ? "Files will appear here automatically as agents create reports, exports, and data files."
                  : "Try adjusting your filters or search query."}
              </p>
            </div>
            {artifacts.filter((a) => !a.is_dir).length === 0 && (
              <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground/60">
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-400" /> inputs/</span>
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> outputs/</span>
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-purple-400" /> agent-data/</span>
              </div>
            )}
          </div>
        )}

        {/* Content — Tree view */}
        {!loading && viewMode === "tree" && treeFiltered.filter((a) => !a.is_dir).length > 0 && (
          <div className="flex-1 overflow-auto p-2">
            {Array.from(treeData.children.values()).sort(treeSort).map((node) => (
              <ArtifactTreeNode
                key={node.path}
                node={node}
                depth={0}
                onView={openViewer}
                onDownload={(a) => window.open(makeFileUrl(a), "_blank")}
              />
            ))}
          </div>
        )}

        {/* Content — Grid / List */}
        {!loading && viewMode !== "tree" && processed.length > 0 && (
          <div className="p-4 sm:p-6">
            {grouped ? (
              /* ── Grouped by agent ──────────────────────────────────── */
              <div className="flex flex-col gap-6">
                {grouped.map(([agentName, files]) => (
                  <AgentGroup
                    key={agentName}
                    agentName={agentName}
                    files={files}
                    viewMode={viewMode}
                    onView={openViewer}
                    makeFileUrl={makeFileUrl}
                  />
                ))}
              </div>
            ) : viewMode === "grid" ? (
              /* ── Grid ──────────────────────────────────────────────── */
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {processed.map((a, i) => (
                  <FileCard
                    key={`${a.agent_name}:${a.path}`}
                    artifact={a}
                    index={i}
                    onView={() => openViewer(a)}
                    onDownload={() => window.open(makeFileUrl(a), "_blank")}
                  />
                ))}
              </div>
            ) : (
              /* ── List / Table ──────────────────────────────────────── */
              <div className="rounded-xl border border-border overflow-hidden bg-card">
                <div className="hidden sm:grid grid-cols-[1fr_120px_90px_90px_100px] gap-x-3 px-4 py-2.5 bg-secondary/40 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <span>File</span><span>Agent</span><span>Type</span><span>Size</span><span>Modified</span>
                </div>
                {processed.map((a, i) => (
                  <FileListRow
                    key={`${a.agent_name}:${a.path}`}
                    artifact={a}
                    index={i}
                    onView={() => openViewer(a)}
                    onDownload={() => window.open(makeFileUrl(a), "_blank")}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ Viewer modal ════════════════════════════════════════════════ */}
      {viewerEntry && (
        <ArtifactViewerModal
          sessionId="artifacts"
          entry={viewerEntry}
          downloadUrl={viewerUrl}
          saveUrl={viewerUrl}
          onClose={() => setViewerEntry(null)}
        />
      )}
    </div>
  );
}

// ─── Agent group (collapsible) ─────────────────────────────────────────────

function AgentGroup({
  agentName,
  files,
  viewMode,
  onView,
  makeFileUrl,
}: {
  agentName: string;
  files: ArtifactEntry[];
  viewMode: ViewMode;
  onView: (a: ArtifactEntry) => void;
  makeFileUrl: (a: ArtifactEntry) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const accent = agentAccent(agentName);
  const accentBg = accent.replace("border-l-", "bg-");

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className={`w-full flex items-center gap-3 px-4 py-3 bg-secondary/30 hover:bg-secondary/50 tech-transition border-l-2 ${accent}`}
      >
        {expanded ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
        <div className={`w-2 h-2 rounded-full ${accentBg}`} />
        <span className="text-sm font-medium text-foreground">{agentName}</span>
        <span className="text-[11px] text-muted-foreground">{files.length} file{files.length !== 1 ? "s" : ""}</span>
      </button>
      {expanded && (
        <div className="p-3">
          {viewMode === "grid" ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {files.map((a, i) => (
                <FileCard
                  key={`${a.agent_name}:${a.path}`}
                  artifact={a} index={i}
                  onView={() => onView(a)}
                  onDownload={() => window.open(makeFileUrl(a), "_blank")}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="hidden sm:grid grid-cols-[1fr_120px_90px_90px_100px] gap-x-3 px-4 py-2 bg-secondary/30 border-b border-border text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <span>File</span><span>Agent</span><span>Type</span><span>Size</span><span>Modified</span>
              </div>
              {files.map((a, i) => (
                <FileListRow
                  key={`${a.agent_name}:${a.path}`}
                  artifact={a} index={i}
                  onView={() => onView(a)}
                  onDownload={() => window.open(makeFileUrl(a), "_blank")}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
