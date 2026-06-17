"use client";

import { useState } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRight,
  Columns2,
} from "lucide-react";
import { AccountSidebar } from "./components/AccountSidebar";
import { EmailList } from "./components/EmailList";
import { EmailDetail } from "./components/EmailDetail";
import { AIChatPanel } from "./components/AIChatPanel";
import { ComposePanel } from "./components/ComposePanel";
import { MOCK_ACCOUNTS, MOCK_FOLDERS, MOCK_EMAILS } from "./lib/mockData";
import { folderLabel } from "./lib/utils";

export default function EmailPage() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState("inbox");
  const [selectedAccountId, setSelectedAccountId] = useState("1");
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(
    MOCK_EMAILS[0].id
  );

  const visibleEmails = MOCK_EMAILS.filter(
    (e) =>
      e.folder === selectedFolder && e.accountId === selectedAccountId
  );
  const selectedEmail = MOCK_EMAILS.find((e) => e.id === selectedEmailId) ?? null;
  const unreadCount = visibleEmails.filter((e) => !e.isRead).length;

  return (
    <div className="flex h-full w-full bg-background overflow-hidden select-none">
      {/* ── Left sidebar — accounts + folders ── */}
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

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
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

        {/* Content: email list + detail */}
        <div className="flex-1 flex min-w-0 overflow-hidden">
          {/* Email list pane */}
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

          {/* Email detail pane */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <EmailDetail email={selectedEmail} />
          </div>
        </div>
      </div>

      {/* ── Right sidebar — AI chat ── */}
      <div
        className={`flex-shrink-0 border-l border-border transition-all duration-200 overflow-hidden ${
          rightOpen ? "w-72" : "w-0"
        }`}
      >
        {rightOpen && <AIChatPanel />}
      </div>

      {/* ── Compose modal ── */}
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
