"use client";

/**
 * /build/apps/[slug]/edit — the Workshop: sandboxed live preview on the left,
 * the app-builder chat pinned on the right (docs/app-workshop §4.2–4.3).
 *
 * The chat is a THIN wrapper around the shared <AgentChat> — the AssistantRail
 * pattern: one session per app (named `app:{slug}`), bound to the app's
 * workspace via PATCH /api/agent/workspace/{sessionId}, persona carrying the
 * workspace contract. Preview refreshes on artifact writes + a cheap poll.
 */

import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  Eye,
  FileCode,
  Loader2,
  Lock,
  RefreshCw,
  Rocket,
  Sparkles,
  X,
} from "lucide-react";
import AgentChat from "@/components/AgentChat";
import SandboxedHtml from "@/components/SandboxedHtml";
import Tabs from "@/components/Tabs";
import {
  createSession,
  getSessions,
  upsertSession,
  type ChatSession,
} from "@/lib/sessions";
import { buildAppSrcDoc, useCcBridge } from "../../lib/ccBridge";
import type { AppFile, AppMeta } from "../../lib/types";

const BUILDER_AGENT = "app-builder";
const SESSION_KEY_PREFIX = "cc-app-builder-session-";
const PREVIEW_POLL_MS = 10_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Find-or-create the ONE builder chat session for this app. */
function ensureBuilderSession(slug: string): ChatSession {
  const name = `app:${slug}`;
  const sessions = getSessions();
  // 1. Stable id remembered per app.
  const storedId =
    typeof window !== "undefined"
      ? localStorage.getItem(SESSION_KEY_PREFIX + slug)
      : null;
  if (storedId) {
    const existing = sessions.find((s) => s.id === storedId);
    if (existing) return existing;
  }
  // 2. A session already named for this app (e.g. from another device merge).
  const named = sessions.find(
    (s) => s.agentName === BUILDER_AGENT && s.name === name
  );
  if (named) {
    try {
      localStorage.setItem(SESSION_KEY_PREFIX + slug, named.id);
    } catch {}
    return named;
  }
  // 3. Fresh session, named for the app.
  const s = createSession(BUILDER_AGENT);
  s.name = name;
  s.title = name;
  upsertSession(s);
  try {
    localStorage.setItem(SESSION_KEY_PREFIX + slug, s.id);
  } catch {}
  return s;
}

// ─── Publish modal ────────────────────────────────────────────────────────

function PublishModal({
  app,
  onClose,
  onPublished,
}: {
  app: AppMeta;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [visibility, setVisibility] = useState<"private" | "org">("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(app.slug)}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: notes || undefined, visibility }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `Publish failed (HTTP ${res.status})`);
        return;
      }
      onPublished();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-lg p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-bold text-foreground">
            Publish {app.name}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Snapshots the current draft as an immutable version and serves it
            from Custom Apps.
          </p>
        </div>

        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Release notes
          </label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What changed?"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 tech-transition"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Who can use it
          </label>
          <div className="flex flex-col gap-1.5">
            {(
              [
                ["private", "Only me", "Private — stays in your workshop"],
                [
                  "org",
                  "Everyone at Fracktal",
                  "Listed in Custom Apps for the whole team",
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer tech-transition ${
                  visibility === value
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:border-primary/30"
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === value}
                  onChange={() => setVisibility(value)}
                  className="accent-current"
                />
                <span className="text-sm text-foreground">{label}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {hint}
                </span>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <X className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 sm:px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
          >
            Cancel
          </button>
          <button
            onClick={publish}
            disabled={busy}
            className="rounded-lg bg-primary px-3 sm:px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Rocket className="w-4 h-4" />
            )}
            Publish
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Workshop ─────────────────────────────────────────────────────────────

function Workshop({ slug }: { slug: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark";

  const [app, setApp] = useState<AppMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [files, setFiles] = useState<AppFile[]>([]);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [showPublish, setShowPublish] = useState(false);

  // Builder chat session (one per app).
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);
  const [workspaceBound, setWorkspaceBound] = useState(false);
  const [pendingInput, setPendingInput] = useState<string | undefined>(() => {
    const seed = searchParams.get("seed");
    return seed ? seed : undefined;
  });

  // Draft preview.
  const [draftBundle, setDraftBundle] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // Code view.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  // Broker the DRAFT frame's cc.* calls — same bridge as production so the
  // preview behaves identically to the published app (RFC §4.3).
  useCcBridge(slug, { mode: "draft" });

  // ── App meta + files ────────────────────────────────────────────────
  // Fetch-on-mount wiring: same pattern (and lint carve-out) as
  // tasks/components/AssistantRail.tsx.
  /* eslint-disable react-hooks/set-state-in-effect */
  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/files`);
      if (!res.ok) return;
      const data = (await res.json()) as { files?: AppFile[] };
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch {}
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
        if (!res.ok) {
          if (!cancelled)
            setLoadError(
              res.status === 404 ? "App not found." : `HTTP ${res.status}`
            );
          return;
        }
        const data = (await res.json()) as { app?: AppMeta };
        if (!cancelled && data.app) setApp(data.app);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    fetchFiles();
    return () => {
      cancelled = true;
    };
  }, [slug, fetchFiles]);

  // ── Builder session wiring (critical) ───────────────────────────────
  // Only editors receive workspace_path from the API; without it the chat is
  // replaced by a read-only notice.
  useEffect(() => {
    if (!app) return;
    if (!app.workspace_path) return;
    const s = ensureBuilderSession(slug);
    setChatSession(s);
    // Bind the builder's working directory to the app workspace (idempotent).
    fetch(`/api/agent/workspace/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_path: app.workspace_path }),
    })
      .then((res) => setWorkspaceBound(res.ok))
      .catch(() => setWorkspaceBound(false));
  }, [app, slug]);

  // ── Draft preview fetch + poll ──────────────────────────────────────
  const refreshPreview = useCallback(async () => {
    setPreviewBusy(true);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/bundle?version=draft`
      );
      if (res.ok) {
        const text = await res.text();
        setDraftBundle((prev) => (prev === text ? prev : text));
      }
    } catch {
      // Preview refresh is best-effort.
    } finally {
      setPreviewBusy(false);
    }
  }, [slug]);

  useEffect(() => {
    refreshPreview();
    // Cheap poll so agent edits show up even without an artifact event; only
    // while the tab is visible.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refreshPreview();
    }, PREVIEW_POLL_MS);
    return () => clearInterval(t);
  }, [refreshPreview]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const onArtifact = useCallback(() => {
    refreshPreview();
    fetchFiles();
  }, [refreshPreview, fetchFiles]);

  // ── Code view file content ──────────────────────────────────────────
  const selectFile = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      setFileContent(null);
      try {
        const res = await fetch(
          `/api/apps/${encodeURIComponent(slug)}/files/content?path=${encodeURIComponent(path)}`
        );
        setFileContent(res.ok ? await res.text() : `(failed to load ${path})`);
      } catch (e) {
        setFileContent(String(e));
      }
    },
    [slug]
  );

  // ── Persona: workspace contract for the builder ─────────────────────
  const persona = useMemo(() => {
    if (!app) return undefined;
    const fileList =
      files.length > 0
        ? files.map((f) => f.path).join(", ")
        : "(empty workspace)";
    return [
      `You are the app-builder for the CommandCenter custom app "${app.name}" (slug: ${app.slug}).`,
      `You are building the app in this workspace. Entry file: index.html.`,
      `Workspace files: ${fileList}.`,
    ].join("\n");
  }, [app, files]);

  const srcDoc = useMemo(
    () =>
      draftBundle ? buildAppSrcDoc(draftBundle, { slug, mode: "draft" }) : null,
    [draftBundle, slug]
  );

  // ── Render ──────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <button
          onClick={() => router.push("/build/apps")}
          className="rounded-lg border border-border px-3 sm:px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
        >
          Back to Custom Apps
        </button>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Opening Workshop…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Topbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 sm:px-4 py-2 border-b border-border bg-card shrink-0">
        <button
          onClick={() => router.push("/build/apps")}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
        >
          <ArrowLeft className="w-4 h-4" /> Apps
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg border border-border bg-gradient-to-br from-primary/20 to-accent/15 flex items-center justify-center text-sm shrink-0">
            {app.icon || "▦"}
          </div>
          <span className="text-sm font-bold text-foreground truncate">
            {app.name}
          </span>
          <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full text-warning bg-warning/10 shrink-0">
            Draft
          </span>
        </div>

        <div className="flex-1 flex justify-center">
          <Tabs
            tabs={[
              { id: "preview", label: "Preview" },
              { id: "code", label: "Code" },
            ]}
            activeTab={view}
            onTabChange={(id) => setView(id as "preview" | "code")}
            variant="segmented"
            className="border-b-0! px-0! sm:px-0! pt-0! pb-0!"
          />
        </div>

        <button
          onClick={() => setShowPublish(true)}
          className="rounded-lg bg-primary px-3 sm:px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition flex items-center gap-1.5 shrink-0"
        >
          <Rocket className="w-4 h-4" /> Publish
        </button>
      </div>

      {/* ── Split main ──────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* Left: preview / code */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {view === "preview" ? (
            <>
              {/* Preview toolbar */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
                <button
                  onClick={refreshPreview}
                  title="Reload preview"
                  className="p-1.5 rounded-lg border border-border text-muted-foreground hover:bg-secondary tech-transition"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${previewBusy ? "animate-spin" : ""}`}
                  />
                </button>
                <span className="font-mono text-[10.5px] px-2 py-0.5 rounded-full border border-border text-warning">
                  draft
                </span>
                {app.live_version ? (
                  <span className="font-mono text-[10.5px] px-2 py-0.5 rounded-full border border-border text-success">
                    v{app.live_version} live
                  </span>
                ) : null}
                <div className="flex-1" />
                <span className="font-mono text-[10px] text-muted-foreground hidden sm:block">
                  sandboxed · opaque origin
                </span>
              </div>
              <div className="flex-1 min-h-0 flex flex-col">
                {srcDoc ? (
                  <SandboxedHtml chromeless html={srcDoc} theme={theme} />
                ) : (
                  <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-6">
                    <Sparkles className="w-6 h-6 text-muted-foreground/50" />
                    <p className="text-sm font-medium text-foreground">
                      No preview yet
                    </p>
                    <p className="text-xs text-muted-foreground max-w-xs">
                      Ask the builder to scaffold the app — the preview appears
                      as soon as it writes the first draft.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-0 flex">
              {/* File list */}
              <div className="w-52 shrink-0 border-r border-border overflow-y-auto p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 py-1.5">
                  {app.slug}
                </div>
                {files.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground px-2 py-1">
                    No files yet.
                  </p>
                ) : (
                  files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => selectFile(f.path)}
                      title={`${f.path} · ${formatBytes(f.size)}`}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left font-mono text-[11.5px] tech-transition ${
                        selectedPath === f.path
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-secondary"
                      }`}
                    >
                      <FileCode className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{f.path}</span>
                    </button>
                  ))
                )}
              </div>
              {/* Read-only source */}
              <div className="flex-1 min-w-0 flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-auto">
                  {selectedPath === null ? (
                    <p className="text-xs text-muted-foreground p-4">
                      Select a file to read its source.
                    </p>
                  ) : fileContent === null ? (
                    <div className="p-4">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <pre className="font-mono text-xs text-foreground p-4 whitespace-pre-wrap break-words">
                      {fileContent}
                    </pre>
                  )}
                </div>
                <div className="flex items-center gap-2 px-4 py-2 border-t border-border text-[11px] text-muted-foreground shrink-0">
                  <Eye className="w-3.5 h-3.5" />
                  Code is agent-authored — edit through chat.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: build chat */}
        <div className="w-[400px] shrink-0 border-l border-border flex flex-col min-h-0 bg-card">
          <div className="flex items-center gap-2 px-4 h-10 border-b border-border shrink-0">
            <Sparkles className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground">
                Build chat
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                app-builder · app:{app.slug}
              </div>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {!app.workspace_path ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
                <Lock className="w-5 h-5 text-muted-foreground/60" />
                <p className="text-sm font-medium text-foreground">Read-only</p>
                <p className="text-xs text-muted-foreground max-w-[16rem]">
                  You can browse this app&apos;s preview and code, but only its
                  editors can talk to the builder.
                </p>
              </div>
            ) : chatSession ? (
              <AgentChat
                key={chatSession.id}
                agentName={BUILDER_AGENT}
                sessionId={chatSession.id}
                compact
                persona={persona}
                pendingInput={pendingInput}
                onPendingInputConsumed={() => setPendingInput(undefined)}
                onArtifact={onArtifact}
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          {app.workspace_path && chatSession && !workspaceBound && (
            <div className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground shrink-0">
              Binding workspace…
            </div>
          )}
        </div>
      </div>

      {/* ── Publish modal ───────────────────────────────────────────── */}
      {showPublish && (
        <PublishModal
          app={app}
          onClose={() => setShowPublish(false)}
          onPublished={() => router.push(`/build/apps/${slug}`)}
        />
      )}
    </div>
  );
}

// ─── Page (Suspense boundary for useSearchParams — Next 16) ──────────────

export default function WorkshopPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <Workshop slug={slug} />
    </Suspense>
  );
}
