"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface ComposePanelProps {
  open: boolean;
  onClose: () => void;
  defaultTo?: string;
  defaultSubject?: string;
  replyToBody?: string;
}

export function ComposePanel({
  open,
  onClose,
  defaultTo = "",
  defaultSubject = "",
  replyToBody,
}: ComposePanelProps) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(replyToBody || "");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 sm:pt-20 px-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Compose window */}
      <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/50">
          <span className="text-sm font-medium text-foreground">New Message</span>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Fields */}
        <div className="px-4 py-3 space-y-3">
          {/* To */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">To:</span>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Email address..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Cc */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">Cc:</span>
            <input
              type="text"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="Cc..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Subject */}
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground w-8 flex-shrink-0">Subj:</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>

          {/* Body */}
          <div className="border-t border-border pt-3">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              rows={12}
              autoFocus
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none resize-none leading-relaxed"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            Sent from your connected email account
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              Discard
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
