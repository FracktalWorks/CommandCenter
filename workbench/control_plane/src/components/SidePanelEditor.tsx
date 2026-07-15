"use client";

/**
 * SidePanelEditor — VS Code-style collapsible editor panel that sits between the
 * file manager and the chat. Shows the agent's live documents as tabs, each with
 * a rendered ↔ edit toggle and live Markdown/HTML preview (DocumentPane).
 *
 * State lives in sidePanelStore (module-level) so the file tree, inline chat
 * cards, and the agent-context fold all stay in sync with what's open here.
 * Reads the store via useSyncExternalStore with a STABLE snapshot (getState
 * returns the same reference until a real change) to avoid React #185.
 */

import { useSyncExternalStore } from "react";
import { X, PanelLeftClose, Loader2, FileText } from "lucide-react";
import {
  subscribe,
  getState,
  closeDoc,
  focusDoc,
  togglePanel,
} from "@/lib/sidePanelStore";
import DocumentPane from "@/components/DocumentPane";

export default function SidePanelEditor() {
  const state = useSyncExternalStore(subscribe, getState, getState);
  const { open, docs, activePath } = state;

  // Collapsed rail — a thin strip that reopens the panel and shows a doc count.
  if (!open) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-border bg-card/40 py-2.5">
        <button
          onClick={togglePanel}
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title="Open document panel"
        >
          <FileText size={15} />
        </button>
        {docs.length > 0 && (
          <span className="mt-1 rounded-full bg-secondary px-1 text-[10px] text-muted-foreground">
            {docs.length}
          </span>
        )}
        <div className="mt-3 flex flex-1 items-center justify-center">
          <span
            className="text-[10px] font-semibold tracking-widest text-muted-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            DOCUMENTS
          </span>
        </div>
      </aside>
    );
  }

  const active = docs.find((d) => d.path === activePath) ?? null;

  return (
    <aside className="flex w-[30rem] max-w-[45vw] min-w-[20rem] shrink-0 flex-col border-r border-border bg-card/20">
      {/* Tab bar */}
      <div className="flex items-stretch border-b border-border bg-card/50">
        <div className="flex flex-1 items-stretch overflow-x-auto">
          {docs.length === 0 ? (
            <div className="flex items-center px-3 py-2 text-xs text-muted-foreground">
              Documents
            </div>
          ) : (
            docs.map((d) => {
              const isActive = d.path === activePath;
              return (
                <div
                  key={d.path}
                  onClick={() => focusDoc(d.path)}
                  className={`group flex max-w-[14rem] cursor-pointer items-center gap-1.5 border-r border-border px-3 py-2 text-xs transition-colors ${
                    isActive
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                  }`}
                  title={d.path}
                >
                  {d.live && <Loader2 size={10} className="shrink-0 animate-spin text-primary" />}
                  <span className="truncate">{d.name}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDoc(d.path);
                    }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 hover:bg-secondary hover:text-foreground group-hover:opacity-100 transition"
                    title={`Close ${d.name}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <button
          onClick={togglePanel}
          className="flex shrink-0 items-center border-l border-border px-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          title="Collapse document panel"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      {/* Active document */}
      <div className="flex flex-1 min-h-0 flex-col">
        {active ? (
          <DocumentPane
            key={`${active.sessionId}:${active.path}`}
            sessionId={active.sessionId}
            path={active.path}
            name={active.name}
            live={active.live}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <FileText size={22} className="text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">No document open.</p>
            <p className="max-w-[16rem] text-[11px] text-muted-foreground/70">
              Open a file from the Files panel (or right-click → “Open in side panel”).
              Documents the agent writes appear here automatically.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
