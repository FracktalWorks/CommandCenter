"use client";

import { useState, useEffect, useRef } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRight,
  Columns2,
  ArrowLeft,
  Pencil,
} from "lucide-react";
import { useViewMode } from "@/components/ViewModeProvider";
import { useMobileDrawer } from "@/components/AppShell";
import { AccountSidebar } from "./components/AccountSidebar";
import { EmailList } from "./components/EmailList";
import { EmailDetail } from "./components/EmailDetail";
import { AIChatPanel } from "./components/AIChatPanel";
import { ComposePanel } from "./components/ComposePanel";
import { MOCK_ACCOUNTS, MOCK_FOLDERS, MOCK_EMAILS } from "./lib/mockData";
import { folderLabel } from "./lib/utils";

export default function EmailPage() {
  const { isMobile } = useViewMode();

  // Desktop state
  const [leftOpen, setLeftOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // Shared state
  const [composeOpen, setComposeOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState("inbox");
  const [selectedAccountId, setSelectedAccountId] = useState("1");
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(
    MOCK_EMAILS[0].id
  );

  // Mobile-specific state
  const [mobileView, setMobileView] = useState<"inbox" | "detail">("inbox");

  const { open: openDrawer, close: closeDrawer } = useMobileDrawer();

  const visibleEmails = MOCK_EMAILS.filter(
    (e) => e.folder === selectedFolder && e.accountId === selectedAccountId
  );
  const selectedEmail = MOCK_EMAILS.find((e) => e.id === selectedEmailId) ?? null;
  const unreadCount = visibleEmails.filter((e) => !e.isRead).length;
  const selectedAccount = MOCK_ACCOUNTS.find((a) => a.id === selectedAccountId);

  // Reset mobile view when folder/account changes
  useEffect(() => {
    setMobileView("inbox");
  }, [selectedFolder, selectedAccountId]);

  // ── Mobile drawer content builders ──

  // Refs to hold drawer content so the event listener can open them.
  const accountsDrawerRef = useRef<React.ReactNode>(null);
  const aiDrawerRef = useRef<React.ReactNode>(null);

  // Build the drawer content (kept in refs so the event listener can access them).
  accountsDrawerRef.current = (
    <AccountSidebar
      accounts={MOCK_ACCOUNTS}
      selectedAccountId={selectedAccountId}
      onAccountSelect={(id) => {
        setSelectedAccountId(id);
        const firstForAccount = MOCK_EMAILS.find(
          (e) => e.folder === selectedFolder && e.accountId === id
        );
        setSelectedEmailId(firstForAccount?.id ?? null);
        setMobileView("inbox");
        closeDrawer();
      }}
      folders={MOCK_FOLDERS}
      selectedFolder={selectedFolder}
      onFolderSelect={(f) => {
        setSelectedFolder(f);
        setMobileView("inbox");
        closeDrawer();
      }}
    />
  );

  aiDrawerRef.current = <AIChatPanel />;

  // Listen for bottom-nav tab events from AppShell MobileBottomNav.
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === "email-accounts" && accountsDrawerRef.current) {
        openDrawer(accountsDrawerRef.current);
      } else if (tab === "email-ai" && aiDrawerRef.current) {
        openDrawer(aiDrawerRef.current);
      }
    };
    window.addEventListener("cc-mobile-nav", handler);
    return () => window.removeEventListener("cc-mobile-nav", handler);
  }, [openDrawer]);

  const handleEmailSelect = (id: string) => {
    setSelectedEmailId(id);
    if (isMobile) setMobileView("detail");
  };

  const handleBack = () => setMobileView("inbox");

  // ── Render ──

  return (
    <div className="flex h-full w-full bg-background overflow-hidden select-none">
      {/* ═══ DESKTOP: Left sidebar — accounts + folders ═══ */}
      {!isMobile && (
        <div
          className={`flex-shrink-0 border-r border-border transition-all duration-200 overflow-hidden ${
            leftOpen ? "w-56" : "w-0"
          }`}
        >
          {leftOpen && (
            <AccountSidebar
              accounts={MOCK_ACCOUNTS}
              selectedAccountId={selectedAccountId}
              onAccountSelect={(id) => {
                setSelectedAccountId(id);
                const firstForAccount = MOCK_EMAILS.find(
                  (e) => e.folder === selectedFolder && e.accountId === id
                );
                setSelectedEmailId(firstForAccount?.id ?? null);
              }}
              folders={MOCK_FOLDERS}
              selectedFolder={selectedFolder}
              onFolderSelect={setSelectedFolder}
            />
          )}
        </div>
      )}

      {/* ═══ Main area ═══ */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* ── DESKTOP top bar ── */}
        {!isMobile && (
          <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0 bg-card">
            <div className="flex items-center gap-1.5">
              <IconBtn
                icon={leftOpen ? PanelLeftClose : PanelLeftOpen}
                label={leftOpen ? "Hide accounts" : "Show accounts"}
                onClick={() => setLeftOpen((v) => !v)}
              />
              <div className="w-px h-4 bg-border" />
              <IconBtn
                icon={Columns2}
                label={listOpen ? "Hide email list" : "Show email list"}
                onClick={() => setListOpen((v) => !v)}
                active={listOpen}
              />
              <div className="w-px h-4 bg-border" />
              <div className="flex items-center gap-1.5 ml-1">
                <h1 className="text-sm font-medium text-foreground">
                  {folderLabel(selectedFolder)}
                </h1>
                {unreadCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-full">
                    {unreadCount} unread
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <IconBtn
                icon={rightOpen ? PanelRightClose : PanelRight}
                label={rightOpen ? "Hide AI assistant" : "Show AI assistant"}
                onClick={() => setRightOpen((v) => !v)}
              />
            </div>
          </div>
        )}

        {/* ── MOBILE: detail top bar (back button) ── */}
        {isMobile && mobileView === "detail" && selectedEmail && (
          <div className="flex items-center gap-2 px-2 py-2 border-b border-border flex-shrink-0 bg-card">
            <button
              onClick={handleBack}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              aria-label="Back to inbox"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground truncate">
                {selectedEmail.subject}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                {selectedEmail.from.name}
              </div>
            </div>
          </div>
        )}

        {/* ── MOBILE: inbox top bar ── */}
        {isMobile && mobileView === "inbox" && (
          <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0 bg-card">
            <button
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("cc-mobile-nav", { detail: "email-accounts" })
                );
              }}
              className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
            >
              {selectedAccount && (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white flex-shrink-0 text-[10px] font-semibold"
                  style={{ backgroundColor: selectedAccount.color }}
                >
                  {selectedAccount.avatar}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  {folderLabel(selectedFolder)}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {selectedAccount?.emailAddress ?? ""}
                </div>
              </div>
            </button>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-full">
                  {unreadCount}
                </span>
              )}
              <button
                onClick={() => setComposeOpen(true)}
                className="p-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                aria-label="Compose"
              >
                <Pencil size={14} />
              </button>
            </div>
          </div>
        )}

        {/* ── Content: email list + detail ── */}
        <div className="flex-1 flex min-w-0 overflow-hidden">
          {/* DESKTOP: email list pane */}
          {!isMobile && (
            <div
              className={`flex-shrink-0 border-r border-border transition-all duration-200 overflow-hidden ${
                listOpen ? "w-72" : "w-0"
              }`}
            >
              {listOpen && (
                <EmailList
                  emails={visibleEmails}
                  selectedId={selectedEmailId}
                  onSelect={setSelectedEmailId}
                  onCompose={() => setComposeOpen(true)}
                />
              )}
            </div>
          )}

          {/* MOBILE: email list (full width) */}
          {isMobile && mobileView === "inbox" && (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <EmailList
                emails={visibleEmails}
                selectedId={selectedEmailId}
                onSelect={handleEmailSelect}
                onCompose={() => setComposeOpen(true)}
              />
            </div>
          )}

          {/* MOBILE: email detail (full width) */}
          {isMobile && mobileView === "detail" && (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <EmailDetail email={selectedEmail} />
            </div>
          )}

          {/* DESKTOP: email detail pane */}
          {!isMobile && (
            <div className="flex-1 min-w-0 overflow-hidden">
              <EmailDetail email={selectedEmail} />
            </div>
          )}
        </div>
      </div>

      {/* ═══ DESKTOP: Right sidebar — AI chat ═══ */}
      {!isMobile && (
        <div
          className={`flex-shrink-0 border-l border-border transition-all duration-200 overflow-hidden ${
            rightOpen ? "w-72" : "w-0"
          }`}
        >
          {rightOpen && <AIChatPanel />}
        </div>
      )}

      <ComposePanel open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}

function IconBtn({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`p-1.5 rounded transition-colors ${
        active === false
          ? "text-muted-foreground hover:text-foreground hover:bg-secondary"
          : active
            ? "text-primary bg-primary/10 hover:bg-primary/15"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      <Icon size={15} />
    </button>
  );
}
