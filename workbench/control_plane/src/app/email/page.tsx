"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
import { useEmailStore } from "./lib/emailStore";
import { folderLabel } from "./lib/utils";

export default function EmailPage() {
  const { isMobile } = useViewMode();

  // Desktop UI state
  const [leftOpen, setLeftOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // Mobile-specific state
  const [mobileView, setMobileView] = useState<"inbox" | "detail">("inbox");

  const { open: openDrawer, close: closeDrawer } = useMobileDrawer();

  // ── Zustand store ──
  const {
    accounts,
    emails,
    folders,
    accountsLoading,
    emailsLoading,
    selectedAccountId,
    selectedFolder,
    selectedEmailId,
    composeOpen,
    composeDefaults,
    error,
    fetchAccounts,
    fetchEmails,
    selectAccount,
    selectFolder,
    selectEmail,
    setSearchQuery,
    openCompose,
    closeCompose,
    deleteEmail,
    triggerSync,
  } = useEmailStore();

  // Fetch on mount
  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Fetch emails when account or folder changes
  useEffect(() => {
    if (selectedAccountId) {
      fetchEmails();
    }
  }, [selectedAccountId, selectedFolder, fetchEmails]);

  // Derived data
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const selectedEmail = emails.find((e) => e.id === selectedEmailId) ?? null;
  const unreadCount = emails.filter(
    (e) => e.folder === selectedFolder && !e.isRead
  ).length;

  // Reset mobile view when folder/account changes
  useEffect(() => {
    setMobileView("inbox");
  }, [selectedFolder, selectedAccountId]);

  // ── Mobile drawer content builders ──

  const accountsDrawerRef = useRef<React.ReactNode>(null);
  const aiDrawerRef = useRef<React.ReactNode>(null);

  const handleAccountSelect = useCallback(
    (id: string) => {
      selectAccount(id);
      setMobileView("inbox");
      closeDrawer();
    },
    [selectAccount, closeDrawer]
  );

  const handleFolderSelect = useCallback(
    (f: string) => {
      selectFolder(f);
      if (isMobile) {
        setMobileView("inbox");
        closeDrawer();
      }
    },
    [selectFolder, isMobile, closeDrawer]
  );

  accountsDrawerRef.current = (
    <AccountSidebar
      accounts={accounts}
      selectedAccountId={selectedAccountId ?? ""}
      onAccountSelect={handleAccountSelect}
      folders={folders}
      selectedFolder={selectedFolder}
      onFolderSelect={handleFolderSelect}
    />
  );

  aiDrawerRef.current = <AIChatPanel selectedAccountId={selectedAccountId} selectedEmailId={selectedEmailId} />;

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
  }, [openDrawer, closeDrawer]);

  const handleEmailSelect = useCallback(
    (id: string) => {
      selectEmail(id);
      if (isMobile) setMobileView("detail");
    },
    [selectEmail, isMobile]
  );

  const handleBack = () => setMobileView("inbox");

  // ── Render ──

  return (
    <div className="flex h-full w-full bg-background overflow-hidden select-none">
      {/* Loading overlay */}
      {accountsLoading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="flex gap-2 items-center text-sm text-muted-foreground">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            Loading accounts…
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground text-xs px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <span>{error}</span>
          <button
            onClick={() => useEmailStore.getState().clearError()}
            className="underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ═══ DESKTOP: Left sidebar — accounts + folders ═══ */}
      {!isMobile && (
        <div
          className={`flex-shrink-0 border-r border-border transition-all duration-200 overflow-hidden ${
            leftOpen ? "w-56" : "w-0"
          }`}
        >
          {leftOpen && (
            <AccountSidebar
              accounts={accounts}
              selectedAccountId={selectedAccountId ?? ""}
              onAccountSelect={selectAccount}
              folders={folders.length > 0 ? folders : []}
              selectedFolder={selectedFolder}
              onFolderSelect={selectFolder}
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
                onClick={() => openCompose()}
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
                  emails={emails}
                  selectedId={selectedEmailId}
                  onSelect={handleEmailSelect}
                  onCompose={() => openCompose()}
                  loading={emailsLoading}
                />
              )}
            </div>
          )}

          {/* MOBILE: email list (full width) */}
          {isMobile && mobileView === "inbox" && (
            <div className="flex-1 min-w-0 overflow-y-auto">
              <EmailList
                emails={emails}
                selectedId={selectedEmailId}
                onSelect={handleEmailSelect}
                onCompose={() => openCompose()}
                loading={emailsLoading}
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
          {rightOpen && <AIChatPanel selectedAccountId={selectedAccountId} selectedEmailId={selectedEmailId} />}
        </div>
      )}

      <ComposePanel
        open={composeOpen}
        onClose={closeCompose}
        defaultTo={composeDefaults?.to}
        defaultSubject={composeDefaults?.subject}
        replyToBody={composeDefaults?.replyToBody}
      />
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
