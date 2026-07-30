"use client";

/**
 * /workflows/[id] — the visual workflow editor (RFC §5: three panes + run
 * console; spec F2–F6). React Flow canvas; palette + inspector are served
 * from the gateway catalog; Test ▸ runs the draft and streams per-node
 * status onto the canvas over SSE.
 */

import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  BadgeCheck,
  ChevronDown,
  Loader2,
  Play,
  Rocket,
  Save,
  ShieldCheck,
  Zap,
} from "lucide-react";
import NodeInspector from "../components/NodeInspector";
import NodePalette, { type PaletteDrop } from "../components/NodePalette";
import RunConsole from "../components/RunConsole";
import TriggerPanel from "../components/TriggerPanel";
import WorkflowNode, { type CCNodeData } from "../components/WorkflowNode";
import {
  ApiError,
  getCatalog,
  getWorkflow,
  publishWorkflow,
  runWorkflow,
  updateWorkflow,
  validateWorkflow,
} from "../lib/api";
import type {
  Catalog,
  GraphIssue,
  NodeType,
  RunEvent,
  TriggerSpec,
  WorkflowDetail,
  WorkflowGraph,
  WorkflowGraphNode,
} from "../lib/types";

const nodeTypes = { ccNode: WorkflowNode };

const TRIGGER_KIND_HINTS = [
  { kind: "manual" as const, hint: "Run button / POST /workflows/{id}/run" },
  { kind: "webhook" as const, hint: "per-workflow tokened URL (+ optional HMAC)" },
  { kind: "schedule" as const, hint: "cron expression, UTC" },
];

function summarize(type: NodeType, config: Record<string, unknown>, catalog: Catalog | null): string {
  if (type === "agent") return String(config.agent ?? "");
  if (type === "tool") return String(config.action ?? "");
  if (type === "module") {
    const mod = catalog?.modules.find((m) => m.id === config.module_id);
    return mod?.name ?? "";
  }
  if (type === "condition")
    return `${config.left ?? ""} ${config.op ?? ""} ${config.right ?? ""}`.trim();
  if (type === "set")
    return Object.keys((config.assignments as object) ?? {}).join(", ");
  if (type === "output") return String(config.value ?? "");
  return "";
}

function EditorInner({ id }: { id: string }) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const { screenToFlowPosition } = useReactFlow();

  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [triggers, setTriggers] = useState<TriggerSpec[]>([]);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<GraphIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showTriggers, setShowTriggers] = useState(false);
  const [showTestPayload, setShowTestPayload] = useState(false);
  const [testPayload, setTestPayload] = useState('{\n  "body": "example"\n}');
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [consoleCollapsed, setConsoleCollapsed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef(1);
  const esRef = useRef<EventSource | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wf, cat] = await Promise.all([getWorkflow(id), getCatalog()]);
        if (cancelled) return;
        setDetail(wf);
        setCatalog(cat);
        setName(wf.name);
        setTriggers(wf.triggers);
        const g = wf.graph ?? { nodes: [], edges: [] };
        const graphNodes: WorkflowGraphNode[] = Array.isArray(g.nodes)
          ? g.nodes
          : [];
        if (graphNodes.length === 0) {
          // Every workflow starts from its trigger (RFC §5.2).
          setNodes([
            {
              id: "trigger",
              type: "ccNode",
              position: { x: 120, y: 60 },
              data: {
                label: "Trigger",
                nodeType: "trigger",
                config: { kind: "manual" },
              } satisfies CCNodeData & { config: Record<string, unknown> },
            },
          ]);
          setDirty(true);
        } else {
          setNodes(
            graphNodes.map((n) => ({
              id: n.id,
              type: "ccNode",
              position: n.position ?? { x: 0, y: 0 },
              data: {
                label: n.data?.label ?? n.id,
                nodeType: n.type,
                config: n.data?.config ?? {},
                summary: summarize(n.type, n.data?.config ?? {}, cat),
              },
            })),
          );
          setEdges(
            (Array.isArray(g.edges) ? g.edges : []).map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle ?? undefined,
              label: e.sourceHandle ?? undefined,
            })),
          );
        }
      } catch (e) {
        if (!cancelled)
          setLoadError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [id]);

  // ── Graph serialization ─────────────────────────────────────────────────
  const toGraph = useCallback((): WorkflowGraph => {
    return {
      nodes: nodes.map((n) => {
        const d = n.data as CCNodeData & { config: Record<string, unknown> };
        return {
          id: n.id,
          type: d.nodeType,
          position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
          data: { label: d.label, config: d.config ?? {} },
        };
      }),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: (e.sourceHandle as string) ?? null,
      })),
    };
  }, [nodes, edges]);

  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setNotice(null);
    try {
      const wf = await updateWorkflow(id, {
        name: name.trim() || "Untitled workflow",
        graph: toGraph(),
        triggers,
      });
      setDetail(wf);
      setDirty(false);
      return true;
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [id, name, toGraph, triggers]);

  // ── Canvas callbacks ────────────────────────────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type !== "select" && c.type !== "dimensions"))
      setDirty(true);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type !== "select")) setDirty(true);
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    setEdges((es) =>
      addEdge(
        {
          ...conn,
          id: `e_${conn.source}_${conn.sourceHandle ?? "out"}_${conn.target}`,
          label: conn.sourceHandle ?? undefined,
        },
        es,
      ),
    );
    setDirty(true);
  }, []);

  const addNode = useCallback(
    (drop: PaletteDrop, position?: { x: number; y: number }) => {
      const nid = `${drop.nodeType}_${counter.current++}${Date.now().toString(36).slice(-3)}`;
      setNodes((ns) => {
        const maxY = ns.reduce(
          (acc, n) => Math.max(acc, n.position.y),
          0,
        );
        return [
          ...ns,
          {
            id: nid,
            type: "ccNode",
            position: position ?? { x: 140, y: maxY + 120 },
            data: {
              label: drop.label,
              nodeType: drop.nodeType,
              config: drop.config,
              summary: summarize(drop.nodeType, drop.config, catalog),
            },
          },
        ];
      });
      setSelectedId(nid);
      setDirty(true);
    },
    [catalog],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/cc-workflow-node");
      if (!raw) return;
      try {
        const drop = JSON.parse(raw) as PaletteDrop;
        addNode(drop, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      } catch {
        /* malformed drag payload — ignore */
      }
    },
    [addNode, screenToFlowPosition],
  );

  const selected = useMemo(() => {
    const n = nodes.find((x) => x.id === selectedId);
    if (!n) return null;
    const d = n.data as CCNodeData & { config: Record<string, unknown> };
    return {
      id: n.id,
      type: d.nodeType,
      position: n.position,
      data: { label: d.label, config: d.config ?? {} },
    } as WorkflowGraphNode;
  }, [nodes, selectedId]);

  const upstreamIds = useMemo(() => {
    if (!selectedId) return [];
    const parents = new Map<string, string[]>();
    for (const e of edges) {
      parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
    }
    const seen = new Set<string>();
    const stack = [...(parents.get(selectedId) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(parents.get(cur) ?? []));
    }
    seen.delete("trigger");
    return [...seen];
  }, [edges, selectedId]);

  const patchSelected = useCallback(
    (patch: Record<string, unknown>) => {
      if (!selectedId) return;
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== selectedId) return n;
          const d = n.data as CCNodeData & { config: Record<string, unknown> };
          const config = { ...d.config, ...patch };
          return {
            ...n,
            data: {
              ...d,
              config,
              summary: summarize(d.nodeType, config, catalog),
            },
          };
        }),
      );
      setDirty(true);
    },
    [selectedId, catalog],
  );

  const relabelSelected = useCallback(
    (label: string) => {
      if (!selectedId) return;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedId ? { ...n, data: { ...n.data, label } } : n,
        ),
      );
      setDirty(true);
    },
    [selectedId],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) =>
      es.filter((e) => e.source !== selectedId && e.target !== selectedId),
    );
    setSelectedId(null);
    setDirty(true);
  }, [selectedId]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const applyIssues = useCallback((next: GraphIssue[]) => {
    setIssues(next);
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: {
          ...n.data,
          issueCount: next.filter((i) => i.node_id === n.id).length,
        },
      })),
    );
  }, []);

  const onValidate = useCallback(async () => {
    setBusy("validate");
    setNotice(null);
    try {
      if (!(await save())) return;
      const res = await validateWorkflow(id);
      applyIssues(res.issues);
      setNotice(res.ok ? "Graph is valid." : `${res.issues.length} issue(s) found.`);
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }, [id, save, applyIssues]);

  const setNodeRunStatus = useCallback(
    (nodeId: string, status: CCNodeData["runStatus"]) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, runStatus: status } } : n,
        ),
      );
    },
    [],
  );

  const onTest = useCallback(async () => {
    setBusy("test");
    setNotice(null);
    setRunEvents([]);
    setConsoleCollapsed(false);
    setNodes((ns) =>
      ns.map((n) => ({ ...n, data: { ...n.data, runStatus: undefined } })),
    );
    try {
      if (!(await save())) return;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(testPayload || "{}");
      } catch {
        setNotice("Test payload is not valid JSON");
        return;
      }
      const res = await runWorkflow(id, payload, true);
      setRunning(true);
      const es = new EventSource(`/api/workflows/runs/${res.run_id}/stream`);
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as RunEvent;
          setRunEvents((prev) => [...prev, event]);
          if (event.event === "node" && event.node_id) {
            setNodeRunStatus(
              event.node_id,
              event.status as CCNodeData["runStatus"],
            );
          }
          if (event.event === "run" && event.status !== "running") {
            setRunning(false);
            es.close();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      es.onerror = () => {
        setRunning(false);
        es.close();
      };
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err && err.issues().length) {
        applyIssues(err.issues());
        setNotice("Fix the validation issues, then test again.");
      } else {
        setNotice(String(e instanceof Error ? e.message : e));
      }
      setRunning(false);
    } finally {
      setBusy(null);
    }
  }, [id, save, testPayload, applyIssues, setNodeRunStatus]);

  const onPublish = useCallback(async () => {
    setBusy("publish");
    setNotice(null);
    try {
      if (!(await save())) return;
      const res = await publishWorkflow(id);
      applyIssues([]);
      setDetail((d) =>
        d ? { ...d, status: "published", latest_version: res.version } : d,
      );
      setNotice(`Published v${res.version} — triggers are live.`);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err && err.issues().length) {
        applyIssues(err.issues());
        setNotice("Publish blocked — fix the validation issues.");
      } else {
        setNotice(String(e instanceof Error ? e.message : e));
      }
    } finally {
      setBusy(null);
    }
  }, [id, save, applyIssues]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <button
          onClick={() => router.push("/workflows")}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Back to workflows
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const published = detail.status === "published";

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden relative">
      {/* Topbar */}
      <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-border shrink-0">
        <Link
          href="/workflows"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="bg-transparent text-sm font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-ring rounded-md px-1.5 py-0.5 min-w-0 w-48 sm:w-64"
        />
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${
            published
              ? "bg-success/10 text-success border-success/20"
              : "bg-warning/10 text-warning border-warning/20"
          }`}
        >
          {detail.status}
          {detail.latest_version ? ` · v${detail.latest_version}` : ""}
        </span>
        <button
          onClick={() => setShowTriggers((s) => !s)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition shrink-0"
        >
          <Zap className="w-3 h-3 text-amber-500" />
          {triggers.filter((t) => t.enabled).length + 1} trigger
          {triggers.filter((t) => t.enabled).length === 0 ? "" : "s"}
        </button>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {notice && (
            <span className="hidden md:inline text-[11px] text-muted-foreground max-w-64 truncate">
              {notice}
            </span>
          )}
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary tech-transition flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            {dirty ? "Save" : "Saved"}
          </button>
          <button
            onClick={onValidate}
            disabled={busy !== null}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary tech-transition flex items-center gap-1 disabled:opacity-50"
          >
            {busy === "validate" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="w-3.5 h-3.5" />
            )}
            Validate
          </button>
          <div className="flex items-center">
            <button
              onClick={onTest}
              disabled={busy !== null || running}
              className="rounded-l-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary tech-transition flex items-center gap-1 disabled:opacity-50"
            >
              {busy === "test" || running ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              Test
            </button>
            <button
              onClick={() => setShowTestPayload((s) => !s)}
              className="rounded-r-lg border border-l-0 border-border px-1 py-1.5 text-muted-foreground hover:bg-secondary tech-transition"
              title="Sample trigger payload"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={onPublish}
            disabled={busy !== null}
            className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition flex items-center gap-1 disabled:opacity-50"
          >
            {busy === "publish" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : published ? (
              <BadgeCheck className="w-3.5 h-3.5" />
            ) : (
              <Rocket className="w-3.5 h-3.5" />
            )}
            Publish
          </button>
        </div>
      </div>

      {showTriggers && (
        <TriggerPanel
          triggers={triggers}
          hookToken={detail.hook_token}
          published={published}
          onChange={(next) => {
            setTriggers(next);
            setDirty(true);
          }}
          onClose={() => setShowTriggers(false)}
        />
      )}

      {showTestPayload && (
        <div className="absolute right-3 top-12 z-20 w-80 rounded-xl border border-border bg-popover shadow-lg p-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Sample trigger payload (JSON) — {"{{trigger.*}}"}
          </div>
          <textarea
            value={testPayload}
            onChange={(e) => setTestPayload(e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      {/* Panes */}
      <div className="flex-1 min-h-0 flex">
        <NodePalette catalog={catalog} onAdd={(drop) => addNode(drop)} />
        <div
          className="flex-1 min-w-0 relative"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={({ nodes: sel }) =>
              setSelectedId(sel.length === 1 ? sel[0].id : null)
            }
            colorMode={resolvedTheme === "light" ? "light" : "dark"}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: "smoothstep" }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <NodeInspector
          node={selected}
          catalog={catalog}
          upstreamIds={upstreamIds}
          issues={issues}
          triggerKinds={TRIGGER_KIND_HINTS}
          onConfig={patchSelected}
          onLabel={relabelSelected}
          onDelete={deleteSelected}
        />
      </div>

      <RunConsole
        workflowId={id}
        events={runEvents}
        running={running}
        collapsed={consoleCollapsed}
        onToggle={() => setConsoleCollapsed((c) => !c)}
      />
    </div>
  );
}

export default function WorkflowEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <ReactFlowProvider>
        <EditorInner id={id} />
      </ReactFlowProvider>
    </Suspense>
  );
}
