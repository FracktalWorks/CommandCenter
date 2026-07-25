"use client";

/**
 * /build/apps/[slug] — a published Custom App running full-page.
 *
 * Platform chrome (glyph · name · Live·vN · owner · viewer identity · info)
 * around the hardened SandboxedHtml frame; the cc bridge brokers the app's
 * user/storage/ai calls with the VIEWER's session (docs/app-workshop §4.4).
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { Hammer, Info, Loader2, Wrench } from "lucide-react";
import SandboxedHtml from "@/components/SandboxedHtml";
import { buildAppSrcDoc, useCcBridge } from "../lib/ccBridge";
import type { AppMeta, AppUsage, AppVersion } from "../lib/types";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
  } catch {
    return iso;
  }
}

export default function AppRunPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const { data: session } = useSession();
  const viewerEmail = session?.user?.email ?? "dev@fracktal.in";
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark";

  const [app, setApp] = useState<AppMeta | null>(null);
  const [bundle, setBundle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Info popover (versions + usage, fetched lazily on first open).
  const [showInfo, setShowInfo] = useState(false);
  const [versions, setVersions] = useState<AppVersion[] | null>(null);
  const [usage, setUsage] = useState<AppUsage | null>(null);
  const infoRef = useRef<HTMLDivElement | null>(null);

  // Broker the app frame's cc.* calls against /api/apps/{slug}/…
  useCcBridge(slug, { mode: "live" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(slug)}`);
        if (!res.ok) {
          if (!cancelled)
            setError(
              res.status === 404 ? "App not found." : `HTTP ${res.status}`
            );
          return;
        }
        const data = (await res.json()) as { app?: AppMeta };
        if (cancelled || !data.app) return;
        setApp(data.app);
        if (data.app.live_version) {
          // track=1: count this open in the app's usage stats.
          const bres = await fetch(
            `/api/apps/${encodeURIComponent(slug)}/bundle?version=live&track=1`
          );
          if (!cancelled && bres.ok) setBundle(await bres.text());
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const toggleInfo = useCallback(() => {
    setShowInfo((open) => {
      const next = !open;
      if (next) {
        if (versions === null) {
          fetch(`/api/apps/${encodeURIComponent(slug)}/versions`)
            .then((r) => (r.ok ? r.json() : { versions: [] }))
            .then((d: { versions?: AppVersion[] }) =>
              setVersions(Array.isArray(d.versions) ? d.versions : [])
            )
            .catch(() => setVersions([]));
        }
        if (usage === null) {
          fetch(`/api/apps/${encodeURIComponent(slug)}/usage`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: AppUsage | null) => setUsage(d))
            .catch(() => {});
        }
      }
      return next;
    });
  }, [slug, versions, usage]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!showInfo) return;
    const onDown = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setShowInfo(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showInfo]);

  const srcDoc = useMemo(
    () => (bundle ? buildAppSrcDoc(bundle, { slug, mode: "live" }) : null),
    [bundle, slug]
  );

  const canEdit = app?.role === "own" || app?.role === "edit";

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading app…</p>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-destructive">{error ?? "App not found."}</p>
        <button
          onClick={() => router.push("/build/apps")}
          className="rounded-lg border border-border px-3 sm:px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition"
        >
          Back to Custom Apps
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── App chrome header ───────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card shrink-0">
        <div className="w-8 h-8 rounded-lg border border-border bg-gradient-to-br from-primary/20 to-accent/15 flex items-center justify-center text-base shrink-0">
          {app.icon || "▦"}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground truncate">
              {app.name}
            </span>
            {app.live_version ? (
              <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full text-success bg-success/10 shrink-0">
                Live · v{app.live_version}
              </span>
            ) : (
              <span className="text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full text-warning bg-warning/10 shrink-0">
                Draft
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            by {app.owner_email}
          </div>
        </div>
        <div className="flex-1" />
        <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground border border-border rounded-full px-2.5 py-1 shrink-0">
          runs as {viewerEmail}
        </span>
        {canEdit && (
          <button
            onClick={() => router.push(`/build/apps/${slug}/edit`)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 tech-transition flex items-center gap-1.5 shrink-0"
          >
            <Wrench className="w-3.5 h-3.5" /> Open in Workshop
          </button>
        )}
        <div className="relative shrink-0" ref={infoRef}>
          <button
            onClick={toggleInfo}
            title="App info"
            className={`p-2 rounded-lg border border-border tech-transition ${
              showInfo
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:bg-secondary"
            }`}
          >
            <Info className="w-4 h-4" />
          </button>

          {/* Info popover */}
          {showInfo && (
            <div className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-border bg-card shadow-lg z-40 p-4 flex flex-col gap-3 text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Owner</span>
                <span className="text-foreground truncate">
                  {app.owner_email}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">AI usage</span>
                <span className="text-foreground">
                  {usage
                    ? `${formatTokens(usage.month_tokens)} tokens this month`
                    : "—"}
                </span>
              </div>
              <div className="border-t border-border pt-2.5 flex flex-col gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Versions
                </span>
                {versions === null ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                ) : versions.length === 0 ? (
                  <span className="text-muted-foreground">
                    No published versions.
                  </span>
                ) : (
                  versions.slice(0, 6).map((v) => (
                    <div
                      key={v.version}
                      className="flex items-center gap-2 text-muted-foreground"
                    >
                      <span className="font-mono text-foreground shrink-0">
                        v{v.version}
                      </span>
                      <span className="truncate flex-1">
                        {v.release_notes || "—"}
                      </span>
                      <span className="shrink-0">
                        {formatDate(v.published_at)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── The app, in the sandboxed frame ─────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col">
        {srcDoc ? (
          <SandboxedHtml chromeless html={srcDoc} theme={theme} />
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-6">
            <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
              <Hammer className="w-5 h-5 text-primary" />
            </div>
            <p className="text-sm font-medium text-foreground">
              Not published yet
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              This app has no live version. Build and publish it from the
              Workshop first.
            </p>
            {canEdit && (
              <button
                onClick={() => router.push(`/build/apps/${slug}/edit`)}
                className="rounded-lg bg-primary px-3 sm:px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 tech-transition"
              >
                Open Workshop
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Status strip ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-1 border-t border-border bg-card shrink-0 font-mono text-[10.5px] text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
        <span className="truncate">
          sandboxed frame · runs as {viewerEmail} · audit logged
        </span>
      </div>
    </div>
  );
}
