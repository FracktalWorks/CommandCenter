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
  X,
  Mail,
  ExternalLink,
  Settings,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { useViewMode } from "@/components/ViewModeProvider";
import { useMobileDrawer } from "@/components/AppShell";
import { AccountSidebar } from "./components/AccountSidebar";
import { EmailList } from "./components/EmailList";
import { EmailDetail } from "./components/EmailDetail";
import { AIChatPanel } from "./components/AIChatPanel";
import { ComposePanel } from "./components/ComposePanel";
import { useEmailStore } from "./lib/emailStore";
import { Email } from "./lib/types";
import { folderLabel } from "./lib/utils";

export default function EmailPage() {
  const { isMobile } = useViewMode();

  // Desktop UI state
  const [leftOpen, setLeftOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<{
    gmail: boolean; microsoft: boolean; checked: boolean;
  }>({ gmail: false, microsoft: false, checked: false });

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
    updateEmail,
    deleteEmail,
    triggerSync,
    sendEmail,
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

  // ── Onboarding detection ──
  // Check OAuth status and decide whether to show the setup guide
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/integrations/status");
        if (!res.ok) return;
        const data: Array<{ service: string; configured: boolean }> = await res.json();
        const gmailOk = data.find((i) => i.service === "gmail-oauth")?.configured ?? false;
        const msOk = data.find((i) => i.service === "microsoft-oauth")?.configured ?? false;
        setOauthStatus({ gmail: gmailOk, microsoft: msOk, checked: true });
      } catch {
        setOauthStatus((prev) => ({ ...prev, checked: true }));
      }
    };
    void check();
  }, []);

  // Show onboarding when accounts fetched and none exist
  useEffect(() => {
    if (!accountsLoading && accounts.length === 0 && oauthStatus.checked) {
      setShowOnboarding(true);
    }
  }, [accountsLoading, accounts.length, oauthStatus.checked]);

  const dismissOnboarding = () => setShowOnboarding(false);

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

  const handleConnect = useCallback((provider: "gmail" | "microsoft" | "imap") => {
    if (provider === "imap") {
      window.location.href = "/email?addAccount=imap";
    } else {
      const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8000";
      const redirectAfter = encodeURIComponent(window.location.href);
      window.location.href = `${gatewayUrl}/email/oauth/${provider}/authorize?redirect_after=${redirectAfter}`;
    }
  }, []);

  const handleAddAccount = useCallback(() => {
    setShowAddModal(true);
  }, []);

  accountsDrawerRef.current = (
    <AccountSidebar
      accounts={accounts}
      selectedAccountId={selectedAccountId ?? ""}
      onAccountSelect={handleAccountSelect}
      folders={folders}
      selectedFolder={selectedFolder}
      onFolderSelect={handleFolderSelect}
      onAddAccount={handleAddAccount}
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

  const handleToolbarAction = useCallback(
    (action: string, email: Email | null) => {
      if (!email) return;
      switch (action) {
        case "delete":
          deleteEmail(email.id);
          break;
        case "archive":
          updateEmail(email.id, { folder: "archive" });
          break;
        case "flag":
          updateEmail(email.id, { isFlagged: !email.isFlagged });
          break;
        case "mark-read":
          updateEmail(email.id, { isRead: true });
          break;
        case "reply":
          openCompose({
            to: email.from.email,
            subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
            replyToBody: `\n\nOn ${email.receivedAt}, ${email.from.name} wrote:\n> ${email.bodyText.replace(/\n/g, "\n> ")}`,
            replyToMessageId: email.providerMessageId,
          });
          break;
        case "reply-all":
          const allTo = [email.from.email, ...(email.to || []).filter(t => t.email !== email.from.email).map(t => t.email)].join(", ");
          openCompose({
            to: allTo,
            subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
            replyToBody: `\n\nOn ${email.receivedAt}, ${email.from.name} wrote:\n> ${email.bodyText.replace(/\n/g, "\n> ")}`,
            replyToMessageId: email.providerMessageId,
          });
          break;
        case "forward":
          openCompose({
            to: "",
            subject: email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`,
            replyToBody: `\n\n---------- Forwarded message ----------\nFrom: ${email.from.name} <${email.from.email}>\nDate: ${email.receivedAt}\nSubject: ${email.subject}\n\n${email.bodyText}`,
          });
          break;
        // move, label - will need folder/label picker (future)
      }
    },
    [deleteEmail, updateEmail, openCompose]
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

      {/* Onboarding modal — shown when no accounts exist */}
      {showOnboarding && !accountsLoading && accounts.length === 0 && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/85 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 chat-fade-in max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className="text-center mb-5">
              <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-3">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">Welcome to Email</h2>
              <p className="text-sm text-muted-foreground mt-1">
                A few setup steps to get your inbox connected.
              </p>
            </div>

            {/* Steps */}
            <div className="space-y-4 mb-5">
              {/* Step 1: OAuth */}
              <div className={`p-3 rounded-xl border ${oauthStatus.gmail && oauthStatus.microsoft ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold ${oauthStatus.gmail && oauthStatus.microsoft ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"}`}>
                    {oauthStatus.gmail && oauthStatus.microsoft ? <CheckCircle2 size={14} /> : "1"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      {oauthStatus.gmail && oauthStatus.microsoft
                        ? "OAuth configured"
                        : "Configure OAuth (one-time)"}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {oauthStatus.gmail && oauthStatus.microsoft
                        ? "Google + Microsoft OAuth are ready."
                        : "Register CommandCenter with Google and Microsoft so you can sign in with Gmail or Outlook."}
                    </p>
                    {(!oauthStatus.gmail || !oauthStatus.microsoft) && (
                      <a
                        href="/integrations?tab=apis&search=OAuth"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:opacity-80 mt-1.5 transition-opacity"
                      >
                        <Settings size={11} /> Open setup guides
                        <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {/* Step 2: Connect account */}
              <div className="p-3 rounded-xl border border-border bg-secondary/30">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold text-muted-foreground">
                    2
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      Connect your first account
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Choose a provider below. IMAP works immediately — no OAuth setup needed.
                    </p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button
                        onClick={() => handleConnect("gmail")}
                        disabled={!oauthStatus.gmail}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={!oauthStatus.gmail ? "Configure Gmail OAuth first (Step 1)" : "Connect Gmail account"}
                      >
                        <span className="w-4 h-4 rounded-full bg-red-500/15 text-red-400 flex items-center justify-center text-[9px] font-bold">G</span>
                        Gmail
                      </button>
                      <button
                        onClick={() => handleConnect("microsoft")}
                        disabled={!oauthStatus.microsoft}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={!oauthStatus.microsoft ? "Configure Microsoft OAuth first (Step 1)" : "Connect Outlook account"}
                      >
                        <span className="w-4 h-4 rounded-full bg-blue-500/15 text-blue-400 flex items-center justify-center text-[9px] font-bold">M</span>
                        Outlook
                      </button>
                      <button
                        onClick={() => handleConnect("imap")}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-secondary transition-colors"
                      >
                        <span className="w-4 h-4 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center text-[9px] font-bold">IM</span>
                        IMAP/SMTP
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-2">
              <button
                onClick={dismissOnboarding}
                className="flex-1 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors"
              >
                Maybe later
              </button>
              <a
                href="/integrations?tab=email"
                className="flex-1 py-2 rounded-lg bg-primary hover:opacity-90 text-xs font-medium text-primary-foreground text-center transition-colors flex items-center justify-center gap-1.5"
              >
                Manage in Integrations
                <ArrowRight size={12} />
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Error banner — only for non-onboarding errors */}
      {error && accounts.length > 0 && (
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
              onAddAccount={handleAddAccount}
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
                  onToolbarAction={handleToolbarAction}
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
                onToolbarAction={handleToolbarAction}
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
        accountId={selectedAccountId ?? ""}
        onSend={async (params) => {
          if (!selectedAccountId) return;
          await sendEmail({
            accountId: selectedAccountId,
            ...params,
          });
        }}
        defaultTo={composeDefaults?.to}
        defaultSubject={composeDefaults?.subject}
        replyToBody={composeDefaults?.replyToBody}
        replyToMessageId={composeDefaults?.replyToMessageId}
      />

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowAddModal(false)} />
          <div className="relative bg-card border border-border rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-foreground">Add Email Account</h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 rounded-md hover:bg-secondary text-muted-foreground transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => { setShowAddModal(false); handleConnect("gmail"); }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border hover:border-red-400/40 hover:bg-red-500/5 transition-colors text-left"
              >
                <span className="w-8 h-8 rounded-full bg-red-500/15 text-red-400 flex items-center justify-center text-xs font-bold">G</span>
                <div>
                  <div className="text-sm font-medium text-foreground">Google / Gmail</div>
                  <div className="text-[11px] text-muted-foreground">Sign in with Google OAuth</div>
                </div>
              </button>
              <button
                onClick={() => { setShowAddModal(false); handleConnect("microsoft"); }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border hover:border-blue-400/40 hover:bg-blue-500/5 transition-colors text-left"
              >
                <span className="w-8 h-8 rounded-full bg-blue-500/15 text-blue-400 flex items-center justify-center text-xs font-bold">M</span>
                <div>
                  <div className="text-sm font-medium text-foreground">Microsoft / Outlook</div>
                  <div className="text-[11px] text-muted-foreground">Sign in with Microsoft OAuth</div>
                </div>
              </button>
              <button
                onClick={() => { setShowAddModal(false); handleConnect("imap"); }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border hover:border-amber-400/40 hover:bg-amber-500/5 transition-colors text-left"
              >
                <span className="w-8 h-8 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center text-xs font-bold">IM</span>
                <div>
                  <div className="text-sm font-medium text-foreground">IMAP / SMTP</div>
                  <div className="text-[11px] text-muted-foreground">Manual server configuration</div>
                </div>
              </button>
            </div>
            <p className="mt-4 text-[10px] text-muted-foreground text-center">
              Credentials are encrypted at rest with AES-256-GCM
            </p>
          </div>
        </div>
      )}
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
