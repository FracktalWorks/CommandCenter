"use client";

import { useEffect, useState } from "react";
import { PanelLeft, Plus, ArrowLeft, Sparkles } from "lucide-react";
import { useViewMode } from "@/components/ViewModeProvider";
import { useMobileDrawer } from "@/components/AppShell";
import { useTaskStore } from "./lib/taskStore";
import { ListsSidebar } from "./components/ListsSidebar";
import { CaptureBar } from "./components/CaptureBar";
import { ItemList } from "./components/ItemList";
import { ItemDetail } from "./components/ItemDetail";
import { AssistantRail } from "./components/AssistantRail";
import { InboxView } from "./components/InboxView";
import { QuickCapture } from "./components/QuickCapture";
import { WorkspacesModal } from "./components/WorkspacesModal";
import { TaskSettingsModal } from "./components/TaskSettingsModal";
import { TaskFocusModal } from "./components/TaskFocusModal";
import { ReclarifyModal } from "./components/ReclarifyModal";

// Task Manager (GTD) — 4-panel shell, mirroring the email app's layout
// philosophy: Lists/Contexts · Item list (+ capture) · Item detail · Assistant.
// UI-first: runs entirely on mock data (lib/mockData.ts); the gateway `/tasks`
// API is wired later. See ai-company-brain/specs/task_manager_app.md.
export default function TasksPage() {
  const { isMobile } = useViewMode();
  const { open: openDrawer, close: closeDrawer } = useMobileDrawer();
  const selectedView = useTaskStore((s) => s.selectedView);
  const selectedProjectId = useTaskStore((s) => s.selectedProjectId);
  const selectProject = useTaskStore((s) => s.selectProject);
  const selectView = useTaskStore((s) => s.selectView);
  const openQuickCapture = useTaskStore((s) => s.openQuickCapture);
  const quickCaptureOpen = useTaskStore((s) => s.quickCaptureOpen);
  const clarifyModalOpen = useTaskStore((s) => s.clarifyModalOpen);
  const hydrate = useTaskStore((s) => s.hydrate);
  const [leftOpen, setLeftOpen] = useState(true);
  // The AI assistant opens as a scene from the left sidebar (email-app pattern),
  // not an always-on right rail.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const isInbox = selectedView === "inbox";
  const isProjects = selectedView === "projects";

  // Load live data from the gateway once; stays on the bundled mock data when
  // the backend isn't reachable (UI-first demo mode).
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Tell the mobile bottom bar which GTD section is active (for its highlight).
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("cc-tasks-section", { detail: selectedView }),
    );
  }, [selectedView]);

  // Mobile bottom-nav tabs (from AppShell) → drive the tasks app.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "tasks-inbox") {
        selectView("inbox");
        closeDrawer();
      } else if (tab === "tasks-lists") {
        openDrawer(<ListsSidebar onNavigate={closeDrawer} />);
      } else if (tab === "tasks-capture") {
        openQuickCapture("single");
      } else if (tab === "tasks-assistant") {
        openDrawer(<AssistantRail />);
      }
    };
    window.addEventListener("cc-mobile-nav", handler);
    return () => window.removeEventListener("cc-mobile-nav", handler);
  }, [openDrawer, closeDrawer, openQuickCapture, selectView]);

  // Ubiquitous capture — a hotkey opens the capture palette from any Tasks view.
  // (App-wide capture from other Command Center apps needs a persisted store +
  // AppShell-level listener — see spec §2.1 C2 [plumbing].)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (quickCaptureOpen || clarifyModalOpen) return; // a modal owns the keyboard
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openQuickCapture("single");
        return;
      }
      if (
        !typing &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === "c" || e.key === "C")
      ) {
        e.preventDefault();
        openQuickCapture("single");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openQuickCapture, quickCaptureOpen, clarifyModalOpen]);

  if (isMobile) {
    // Single-pane mobile flow. Section switching + capture live in the AppShell
    // bottom bar; here we render just the current surface full-width. Tapping a
    // task opens it as a pop-up card (TaskFocusModal — full-screen on mobile),
    // the same detail surface as desktop.
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        {isInbox ? (
          <InboxView />
        ) : isProjects && selectedProjectId ? (
          // A selected project → full-screen roll-up with a Back affordance.
          <div className="flex h-full flex-col">
            <button
              type="button"
              onClick={() => selectProject(null)}
              className="tech-transition flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div className="min-h-0 flex-1">
              <ItemDetail />
            </div>
          </div>
        ) : (
          <ItemList />
        )}
        <QuickCapture />
        <WorkspacesModal />
        <TaskSettingsModal />
        <TaskFocusModal />
        <ReclarifyModal />
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
        <button
          type="button"
          onClick={() => openQuickCapture("single")}
          className="tech-transition ml-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Capture
          <kbd className="rounded border border-border px-1 text-[9px]">C</kbd>
        </button>
        <button
          type="button"
          onClick={() => setAssistantOpen((v) => !v)}
          aria-pressed={assistantOpen}
          title="Assistant"
          className={[
            "tech-transition ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
            assistantOpen
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
          ].join(" ")}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Assistant
        </button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {leftOpen && (
          <aside className="w-60 shrink-0 border-r border-border bg-card">
            <ListsSidebar
              onOpenAssistant={() => setAssistantOpen(true)}
              assistantActive={assistantOpen}
            />
          </aside>
        )}

        {assistantOpen ? (
          /* Assistant as a full scene (email-app pattern) — replaces the main
             panes, keeps the left sidebar. Close via its header × or the
             toolbar toggle. */
          <div className="min-w-0 flex-1 overflow-hidden">
            <AssistantRail onClose={() => setAssistantOpen(false)} />
          </div>
        ) : isInbox ? (
          /* Inbox: a single capture-first surface — no list/detail split */
          <div className="min-w-0 flex-1 overflow-hidden border-r border-border">
            <InboxView />
          </div>
        ) : isProjects ? (
          /* Projects keep the list + project-detail split (a project isn't a
             task card — its detail is a roll-up of its actions). */
          <>
            <div className="flex w-[260px] shrink-0 flex-col overflow-hidden border-r border-border lg:w-[300px] xl:w-[340px]">
              <CaptureBar />
              <div className="min-h-0 flex-1">
                <ItemList />
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-hidden border-r border-border">
              <ItemDetail />
            </div>
          </>
        ) : (
          /* Task views (Next/Waiting/Someday/Calendar): a full-width list/board.
             Clicking a task opens it as a pop-up card (TaskFocusModal,
             Jira/ClickUp-style) rather than a persistent detail sidebar. */
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-border">
            <CaptureBar />
            <div className="min-h-0 flex-1">
              <ItemList />
            </div>
          </div>
        )}
      </div>

      <QuickCapture />
      <WorkspacesModal />
      <TaskSettingsModal />
      <TaskFocusModal />
      <ReclarifyModal />
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
