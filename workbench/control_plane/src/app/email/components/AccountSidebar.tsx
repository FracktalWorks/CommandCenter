"use client";

import { useState } from "react";
import {
  Inbox, Send, FileText, Trash2, Star, Archive, Tag,
  Search, Plus, ChevronDown, ChevronRight, Settings2, Check,
  ShieldAlert, Folder,
} from "lucide-react";
import { EmailAccount, EmailFolder } from "../lib/types";

interface AccountSidebarProps {
  accounts: EmailAccount[];
  selectedAccountId: string;
  onAccountSelect: (id: string) => void;
  folders: EmailFolder[];
  selectedFolder: string;
  onFolderSelect: (folder: string) => void;
  onAddAccount?: () => void;
  onSearch?: (query: string) => void;
}

export function AccountSidebar({
  accounts,
  selectedAccountId,
  onAccountSelect,
  folders,
  selectedFolder,
  onFolderSelect,
  onAddAccount,
  onSearch,
}: AccountSidebarProps) {
  const [accountsExpanded, setAccountsExpanded] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? accounts[0];

  return (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-sidebar-border flex-shrink-0">
        <span className="text-xs tracking-widest uppercase text-muted-foreground font-semibold">
          Accounts
        </span>
        <button
          className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors"
          title="Add email account"
          onClick={onAddAccount}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-2 bg-secondary rounded-md px-3 py-1.5">
          <Search size={13} className="text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            placeholder="Search emails..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              onSearch?.(e.target.value);
            }}
            className="bg-transparent outline-none text-xs w-full text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Accounts list */}
      <div className="flex-shrink-0 px-2 pb-2">
        <button
          onClick={() => setAccountsExpanded((v) => !v)}
          className="flex items-center gap-1.5 w-full px-2 py-1 text-xs text-muted-foreground hover:text-sidebar-foreground transition-colors"
        >
          {accountsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>Email Accounts</span>
        </button>

        {accountsExpanded && (
          <div className="mt-1 space-y-0.5">
            {accounts.map((account) => (
              <button
                key={account.id}
                onClick={() => onAccountSelect(account.id)}
                className={`flex items-center gap-2.5 w-full px-2 py-2 rounded-md transition-colors text-left group ${
                  selectedAccountId === account.id
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "hover:bg-sidebar-accent/60 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                }`}
              >
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white flex-shrink-0"
                  style={{
                    backgroundColor: account.color,
                    fontSize: "10px",
                    fontWeight: 600,
                  }}
                >
                  {account.avatar}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{account.label}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {account.emailAddress}
                  </div>
                </div>
                {selectedAccountId === account.id && (
                  <Check size={11} className="text-primary flex-shrink-0" />
                )}
                {account.unreadCount > 0 && selectedAccountId !== account.id && (
                  <span className="bg-primary text-primary-foreground text-[9px] rounded-full px-1.5 py-0.5 flex-shrink-0">
                    {account.unreadCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-sidebar-border mx-3 mb-2 flex-shrink-0" />

      {/* Folders */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5 scrollbar-hide">
        {folders.map(({ label, key, count, type }) => {
          const IconComponent = getFolderIcon(key, type);
          return (
            <button
              key={key}
              onClick={() => onFolderSelect(key)}
              className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-md transition-colors text-left ${
                selectedFolder === key
                  ? "bg-primary/15 text-primary"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              }`}
            >
              <IconComponent size={14} className="flex-shrink-0" />
              <span className="flex-1 text-xs">{label}</span>
              {count > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    selectedFolder === key
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-sidebar-border px-3 py-3">
        <button className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
          <Settings2 size={13} />
          <span className="text-xs">Email Settings</span>
        </button>
      </div>
    </div>
  );
}

// Helper to map folder key to Lucide icon component.
function getFolderIcon(key: string, type?: "system" | "user"): React.ElementType {
  const map: Record<string, React.ElementType> = {
    inbox: Inbox,
    starred: Star,
    sent: Send,
    drafts: FileText,
    archive: Archive,
    junk: ShieldAlert,
    labels: Tag,
    trash: Trash2,
  };
  if (map[key]) return map[key];
  // User-created provider folders/labels get a generic folder icon.
  return type === "user" ? Folder : Inbox;
}
