"use client";

/**
 * /build/apps/[slug]/edit — the Workshop: sandboxed live preview on the left,
 * the app-builder chat pinned on the right (docs/app-workshop §4.2–4.3).
 *
 * The chat is a THIN wrapper around the shared <AgentChat> — the AssistantRail
 * pattern: one session per app (named `app:{slug}`), bound to the app's
 * workspace via PATCH /api/agent/workspace/{sessionId}, persona carrying the
 * workspace contract. Preview refreshes on artifact writes, on run-end
 * (onActivity → debounce → refetch + POST /sync), and a fallback poll.
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
import { useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  FileCode,
  History,
  Loader2,
  Lock,
  Plug,
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
import {
  buildAppSrcDoc,
  useCcBridge,
  type CcConsoleEvent,
  type CcToolConfirmDecision,
  type CcToolConfirmRequest,
} from "../../lib/ccBridge";
import type { AppFile, AppMeta, Checkpoint } from "../../lib/types";

/** A pending `cc.tools.call()` confirm, waiting on the builder's decision. */
type PendingToolConfirm = CcToolConfirmRequest & {
  resolve: (decision: CcToolConfirmDecision) => void;
};

const BUILDER_AGENT = "app-builder";
const SESSION_KEY_PREFIX = "cc-app-builder-session-";
/** Fallback poll — run-end sync (onActivity) is the primary refresh path. */
const PREVIEW_POLL_MS = 30_000;
/** Settle time after an assistant turn lands before refetch + sync. */
const RUN_SYNC_DEBOUNCE_MS = 1_500;
/** Bound on captured console events (newest-first, oldest dropped). */
const CONSOLE_EVENT_CAP = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** The `tool:`-prefixed manifest scopes — the ones gated by the Action Broker. */
function toolScopes(manifest: Record<string, unknown> | undefined): string[] {
  const raw = manifest?.scopes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is string => typeof s === "string" && s.startsWith("tool:")
  );
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
  // Org-wide publish with a write scope goes to the Approvals inbox instead
  // of going live (docs/app-workshop/README.md §5) — a distinct success
  // state so we don't navigate to a run page that would 404 or show the
  // stale live version.
  const [pendingReview, setPendingReview] = useState(false);

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
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: { error?: string; errors?: string[] } | string;
        review?: "pending" | "auto";
      };
      if (!res.ok) {
        // The platform-contract scan (RFC §4.0) rejects with a FastAPI-wrapped
        // detail listing each deviation — show them, they name the fix.
        const detail =
          typeof body.detail === "object" && body.detail ? body.detail : null;
        if (detail?.error === "conformance_failed" && detail.errors?.length) {
          setError(
            `This app deviates from the platform architecture:\n• ${detail.errors.join(
              "\n• "
            )}\nAsk the build chat to fix it — everything goes through window.cc.`
          );
          return;
        }
        setError(
          body.error ??
            (typeof body.detail === "string" ? body.detail : null) ??
            `Publish failed (HTTP ${res.status})`
        );
        return;
      }
      if (body.review === "pending") {
        // Not live yet — stay on this modal and show the review state
        // instead of navigating to a run page with nothing new to show.
        setPendingReview(true);
      } else {
        onPublished();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (pendingReview) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-lg p-5 flex flex-col items-center gap-3 text-center">
          <div className="w-11 h-11 rounded-xl bg-warning/10 flex items-center justify-center">
            <Clock className="w-5 h-5 text-warning" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">
              Sent for admin review
            </h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Teammates will see it once approved — you can keep building in
              the Workshop meanwhile.
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

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
          <div className="flex items-start gap-1.5 text-xs text-destructive whitespace-pre-line">
            <X className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{error}</span>
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
  const lastBundleRef = useRef<string | null>(null);

  // Console drawer (frame errors mirrored by the cc SDK, newest-first).
  const [consoleEvents, setConsoleEvents] = useState<CcConsoleEvent[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);

  // Checkpoints popover (topbar History icon).
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmSha, setConfirmSha] = useState<string | null>(null);
  const [restoringSha, setRestoringSha] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);

  // Code view.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  // New `tool:` scopes the builder has added to app.json since the Workshop
  // opened, surfaced as a dismissible "New capability requested" card above
  // the composer (no dedicated AG-UI event for this in Phase 2a — derived
  // purely from re-fetching app meta on the existing refresh paths).
  const seenToolScopesRef = useRef<Set<string> | null>(null);
  const [newCapabilities, setNewCapabilities] = useState<string[]>([]);
  const [dismissedCapabilities, setDismissedCapabilities] = useState<
    Set<string>
  >(new Set());
  const noteManifestScopes = useCallback(
    (manifest: Record<string, unknown> | undefined) => {
      const scopes = toolScopes(manifest);
      const prev = seenToolScopesRef.current;
      seenToolScopesRef.current = new Set(scopes);
      if (prev === null) return; // first observation is the baseline, not "new"
      const fresh = scopes.filter((s) => !prev.has(s));
      if (fresh.length === 0) return;
      setNewCapabilities((cur) => Array.from(new Set([...cur, ...fresh])));
    },
    []
  );
  const dismissCapability = useCallback((scope: string) => {
    setDismissedCapabilities((cur) => {
      const next = new Set(cur);
      next.add(scope);
      return next;
    });
  }, []);
  const visibleCapabilities = useMemo(
    () => newCapabilities.filter((s) => !dismissedCapabilities.has(s)),
    [newCapabilities, dismissedCapabilities]
  );

  // Tool-confirm toast (bottom-right) — mirrors the run page (RFC §4.4): a
  // cc.tools.call() in the DRAFT preview hit a destructive tool with no
  // remembered grant. Without this, testing a just-added scope inside the
  // Workshop would hard-fail instead of letting the builder try it.
  const [pendingConfirm, setPendingConfirm] = useState<PendingToolConfirm | null>(
    null
  );
  const [rememberTool, setRememberTool] = useState(false);
  const onToolConfirm = useCallback(
    (req: CcToolConfirmRequest) =>
      new Promise<CcToolConfirmDecision>((resolve) => {
        setRememberTool(false);
        setPendingConfirm({ ...req, resolve });
      }),
    []
  );

  // Broker the DRAFT frame's cc.* calls — same bridge as production so the
  // preview behaves identically to the published app (RFC §4.3). Console
  // notifications feed the drawer under the preview.
  const onConsoleEvent = useCallback((e: CcConsoleEvent) => {
    setConsoleEvents((prev) => [e, ...prev].slice(0, CONSOLE_EVENT_CAP));
  }, []);
  useCcBridge(slug, { mode: "draft", onConsoleEvent, onToolConfirm });

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
        if (!cancelled && data.app) {
          setApp(data.app);
          noteManifestScopes(data.app.manifest);
        }
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    fetchFiles();
    return () => {
      cancelled = true;
    };
  }, [slug, fetchFiles, noteManifestScopes]);

  /** Re-fetch app meta and check for newly-declared `tool:` scopes. */
  const refreshAppMeta = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { app?: AppMeta };
      if (!data.app) return;
      setApp(data.app);
      noteManifestScopes(data.app.manifest);
    } catch {
      // Best-effort — the next refresh (poll or activity) will catch it.
    }
  }, [slug, noteManifestScopes]);

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
        if (lastBundleRef.current !== text) {
          lastBundleRef.current = text;
          // New bundle reloads the frame — each rebuild starts with a clean
          // console (stale errors from the previous build would mislead).
          setConsoleEvents([]);
          setDraftBundle(text);
        }
      }
    } catch {
      // Preview refresh is best-effort.
    } finally {
      setPreviewBusy(false);
    }
  }, [slug]);

  useEffect(() => {
    refreshPreview();
    // Fallback poll so agent edits show up even if run-end sync misses; only
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
    refreshAppMeta();
  }, [refreshPreview, fetchFiles, refreshAppMeta]);

  // ── Checkpoints + run-end sync ──────────────────────────────────────
  const refreshCheckpoints = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/checkpoints`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { checkpoints?: Checkpoint[] };
      setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
    } catch {
      // Best-effort.
    }
  }, [slug]);

  /** Mirror the draft to Postgres + git checkpoint (best-effort). */
  const syncDraft = useCallback(async () => {
    try {
      await fetch(`/api/apps/${encodeURIComponent(slug)}/sync`, {
        method: "POST",
      });
    } catch {
      // Sync is best-effort — the 30 s poll still covers the preview.
    }
  }, [slug]);

  // When an assistant turn lands (messageCount grows), give the workspace a
  // moment to settle, then refetch the preview and mirror the draft. This is
  // the primary refresh path; the poll above is only the fallback.
  const lastMessageCountRef = useRef(0);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleActivity = useCallback(
    (info: { messageCount: number }) => {
      if (info.messageCount <= lastMessageCountRef.current) {
        lastMessageCountRef.current = info.messageCount;
        return;
      }
      lastMessageCountRef.current = info.messageCount;
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = null;
        refreshPreview();
        fetchFiles();
        syncDraft().then(refreshCheckpoints);
        // The builder mentions new tool: scopes in chat, not a dedicated
        // event (Phase 2a) — catch them by re-fetching app meta here too.
        refreshAppMeta();
      }, RUN_SYNC_DEBOUNCE_MS);
    },
    [refreshPreview, fetchFiles, syncDraft, refreshCheckpoints, refreshAppMeta]
  );
  useEffect(
    () => () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    },
    []
  );

  const toggleHistory = useCallback(() => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) {
      setConfirmSha(null);
      refreshCheckpoints();
    }
  }, [showHistory, refreshCheckpoints]);

  // Close the checkpoints popover on outside click.
  useEffect(() => {
    if (!showHistory) return;
    const onDown = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showHistory]);

  const restoreCheckpoint = useCallback(
    async (sha: string) => {
      setRestoringSha(sha);
      try {
        const res = await fetch(
          `/api/apps/${encodeURIComponent(slug)}/restore`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sha }),
          }
        );
        if (res.ok) {
          setConfirmSha(null);
          await Promise.all([
            refreshPreview(),
            fetchFiles(),
            refreshCheckpoints(),
          ]);
        }
      } catch {
        // Leave the popover open so the user can retry.
      } finally {
        setRestoringSha(null);
      }
    },
    [slug, refreshPreview, fetchFiles, refreshCheckpoints]
  );

  // "✦ Fix with AI" — seed the build chat composer with the newest errors.
  const fixWithAi = useCallback(() => {
    const recent = consoleEvents.slice(0, 3).reverse();
    if (recent.length === 0) return;
    const lines = recent.map((e) =>
      e.stack ? `${e.message}\n${e.stack}` : e.message
    );
    setPendingInput(`Preview errors:\n${lines.join("\n")}\nPlease fix them.`);
  }, [consoleEvents]);

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

        <div className="relative shrink-0" ref={historyRef}>
          <button
            onClick={toggleHistory}
            title="Checkpoints"
            className={`p-2 rounded-lg border border-border tech-transition ${
              showHistory
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:bg-secondary"
            }`}
          >
            <History className="w-4 h-4" />
          </button>

          {/* Checkpoints popover */}
          {showHistory && (
            <div className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-border bg-card shadow-lg z-40 p-3 flex flex-col gap-1 text-xs">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 py-1">
                Checkpoints
              </span>
              {checkpoints === null ? (
                <div className="px-2 py-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                </div>
              ) : checkpoints.length === 0 ? (
                <p className="px-2 py-1.5 text-muted-foreground">
                  No checkpoints yet — one is saved after each build turn.
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5">
                  {checkpoints.map((c, i) => (
                    <div
                      key={c.sha}
                      className="flex flex-col gap-1 rounded-lg px-2 py-1.5 hover:bg-secondary/50 tech-transition"
                    >
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-foreground truncate">
                            {c.message || c.sha.slice(0, 7)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatRelative(c.at)} · {c.files_changed}{" "}
                            {c.files_changed === 1 ? "file" : "files"} changed
                          </div>
                        </div>
                        {i === 0 ? (
                          <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full text-success bg-success/10 shrink-0">
                            Current
                          </span>
                        ) : confirmSha !== c.sha ? (
                          <button
                            onClick={() => setConfirmSha(c.sha)}
                            className="text-[10px] rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition shrink-0"
                          >
                            Restore
                          </button>
                        ) : null}
                      </div>
                      {confirmSha === c.sha && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground flex-1">
                            Restore this checkpoint?
                          </span>
                          <button
                            onClick={() => restoreCheckpoint(c.sha)}
                            disabled={restoringSha === c.sha}
                            className="text-[10px] rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground hover:opacity-90 tech-transition disabled:opacity-50 flex items-center gap-1"
                          >
                            {restoringSha === c.sha && (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            )}
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmSha(null)}
                            className="text-[10px] rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground tech-transition"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
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

              {/* Console drawer — frame errors mirrored by the cc SDK. */}
              <div className="border-t border-border bg-card shrink-0">
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <button
                    onClick={() => setConsoleOpen((o) => !o)}
                    className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground tech-transition"
                  >
                    {consoleOpen ? (
                      <ChevronDown className="w-3 h-3 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0" />
                    )}
                    {consoleEvents.length === 0 ? (
                      <span className="text-success">Console · clean</span>
                    ) : (
                      <span className="text-destructive">
                        Console · {consoleEvents.length}{" "}
                        {consoleEvents.length === 1 ? "error" : "errors"}
                      </span>
                    )}
                  </button>
                  <div className="flex-1" />
                  {consoleEvents.length > 0 && (
                    <button
                      onClick={fixWithAi}
                      className="font-mono text-[11px] text-primary hover:opacity-80 tech-transition shrink-0"
                    >
                      ✦ Fix with AI
                    </button>
                  )}
                </div>
                {consoleOpen && (
                  <div className="max-h-40 overflow-auto border-t border-border px-3 py-2 flex flex-col gap-2">
                    {consoleEvents.length === 0 ? (
                      <p className="font-mono text-[11px] text-muted-foreground">
                        No errors captured since the last rebuild.
                      </p>
                    ) : (
                      consoleEvents.map((e, i) => (
                        <div key={i} className="font-mono text-[11px]">
                          <div className="text-destructive break-words">
                            {e.message}
                          </div>
                          {e.stack && (
                            <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words mt-0.5">
                              {e.stack}
                            </pre>
                          )}
                        </div>
                      ))
                    )}
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

          {/* New capability requested — a tool: scope the builder just added
              to app.json, above the composer (not in the chat transcript). */}
          {visibleCapabilities.length > 0 && (
            <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-border shrink-0">
              {visibleCapabilities.map((scope) => (
                <div
                  key={scope}
                  className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary px-3 py-2.5"
                >
                  <Plug className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold text-foreground leading-snug">
                      New capability requested:{" "}
                      <span className="font-mono font-normal">
                        {scope.replace(/^tool:/, "")}
                      </span>
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                      Runs through the Action Broker with per-use approval
                      until an admin grants it at publish.
                    </p>
                  </div>
                  <button
                    onClick={() => dismissCapability(scope)}
                    aria-label="Dismiss"
                    className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground tech-transition"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

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
                onActivity={handleActivity}
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

      {/* ── Tool-confirm toast — a destructive cc.tools.call() in the DRAFT
          preview awaiting the builder's approve/deny (mirrors the run page,
          RFC §4.4). ─────────────────────────────────────────────────────── */}
      {pendingConfirm && (
        <div className="fixed bottom-5 right-5 z-40 w-[360px] rounded-2xl border border-border bg-popover shadow-lg p-3.5 flex flex-col gap-2.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold text-foreground leading-snug">
                Preview wants to use{" "}
                <span className="font-mono font-normal">
                  {pendingConfirm.tool}
                </span>
              </p>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Testing this scope as you — this runs through the Action
                Broker.
              </p>
            </div>
          </div>
          <pre className="rounded-lg border border-border bg-secondary px-2.5 py-2 font-mono text-[11px] text-muted-foreground overflow-auto max-h-40">
            {JSON.stringify(pendingConfirm.args, null, 2)}
          </pre>
          <div className="flex items-center gap-2">
            <label className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={rememberTool}
                onChange={(e) => setRememberTool(e.target.checked)}
                className="accent-current"
              />
              Always allow for this app
            </label>
            <button
              onClick={() => {
                pendingConfirm.resolve({
                  approved: false,
                  remember: rememberTool,
                });
                setPendingConfirm(null);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
            >
              Deny
            </button>
            <button
              onClick={() => {
                pendingConfirm.resolve({
                  approved: true,
                  remember: rememberTool,
                });
                setPendingConfirm(null);
              }}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition"
            >
              Approve
            </button>
          </div>
        </div>
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
