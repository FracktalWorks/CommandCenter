"use client";

import { useState } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { useViewMode } from "@/components/ViewModeProvider";
import { useTaskStore } from "./lib/taskStore";
import { ListsSidebar } from "./components/ListsSidebar";
import { CaptureBar } from "./components/CaptureBar";
import { ItemList } from "./components/ItemList";
import { ItemDetail } from "./components/ItemDetail";
import { AssistantRail } from "./components/AssistantRail";
import { InboxView } from "./components/InboxView";

// Task Manager (GTD) — 4-panel shell, mirroring the email app's layout
// philosophy: Lists/Contexts · Item list (+ capture) · Item detail · Assistant.
// UI-first: runs entirely on mock data (lib/mockData.ts); the gateway `/tasks`
// API is wired later. See ai-company-brain/specs/task_manager_app.md.
export default function TasksPage() {
  const { isMobile } = useViewMode();
  const selectedView = useTaskStore((s) => s.selectedView);
  const [leftOpen, setLeftOpen] = useState(true);
  const [railOpen, setRailOpen] = useState(true);
  const isInbox = selectedView === "inbox";

  if (isMobile) {
    // Simplified single-pane stack for narrow screens; full mobile flows land
    // in a later slice.
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        {isInbox ? (
          <div className="flex min-h-0 flex-1">
            <aside className="w-44 shrink-0 border-r border-border bg-card">
              <ListsSidebar />
            </aside>
            <div className="min-w-0 flex-1">
              <InboxView />
            </div>
          </div>
        ) : (
          <>
            <CaptureBar />
            <div className="flex min-h-0 flex-1">
              <aside className="w-44 shrink-0 border-r border-border bg-card">
                <ListsSidebar />
              </aside>
              <div className="min-w-0 flex-1">
                <ItemList />
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full select-none flex-col overflow-hidden bg-background">
      {/* Slim toolbar: panel toggles + title */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
        <PanelToggle
          active={leftOpen}
          onClick={() => setLeftOpen((v) => !v)}
          label="Toggle lists"
          icon={PanelLeft}
        />
        <span className="text-xs font-medium text-muted-foreground">
          Task Manager
        </span>
        <PanelToggle
          active={railOpen}
          onClick={() => setRailOpen((v) => !v)}
          label="Toggle assistant"
          icon={PanelRight}
          className="ml-auto"
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {leftOpen && (
          <aside className="w-60 shrink-0 border-r border-border bg-card">
            <ListsSidebar />
          </aside>
        )}

        {isInbox ? (
          /* Inbox: a single capture-first surface — no list/detail split */
          <div className="min-w-0 flex-1 overflow-hidden border-r border-border">
            <InboxView />
          </div>
        ) : (
          <>
            {/* Middle: capture bar + item list */}
            <div className="flex w-[380px] shrink-0 flex-col overflow-hidden border-r border-border">
              <CaptureBar />
              <div className="min-h-0 flex-1">
                <ItemList />
              </div>
            </div>

            {/* Detail */}
            <div className="min-w-0 flex-1 overflow-hidden border-r border-border">
              <ItemDetail />
            </div>
          </>
        )}

        {/* Assistant rail */}
        {railOpen && (
          <aside className="w-80 shrink-0">
            <AssistantRail />
          </aside>
        )}
      </div>
    </div>
  );
}

function PanelToggle({
  active,
  onClick,
  label,
  icon: Icon,
  className = "",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: typeof PanelLeft;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={[
        "tech-transition flex h-7 w-7 items-center justify-center rounded-md",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        className,
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
