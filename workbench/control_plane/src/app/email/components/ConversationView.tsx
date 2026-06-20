"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Paperclip } from "lucide-react";
import { Email } from "../lib/types";
import { fullDateLabel, initials } from "../lib/utils";
import { getEmail } from "../lib/api";
import { MessageContent } from "./MessageContent";

/**
 * Gmail-style conversation view: the messages of a thread stacked oldest→newest.
 * Collapsed cards show sender + snippet; the opened message and the latest are
 * expanded by default. Bodies hydrate lazily when a card is expanded.
 */
export function ConversationView({
  messages,
  openedId,
}: {
  messages: Email[];
  openedId: string;
}) {
  const lastId = messages[messages.length - 1]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([openedId, lastId].filter(Boolean) as string[])
  );
  const [hydrated, setHydrated] = useState<Record<string, Email>>({});

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Hydrate full bodies for expanded messages that arrived body-less.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    messages.forEach((m) => {
      if (
        expanded.has(m.id) &&
        !hydrated[m.id] &&
        !m.bodyHtml &&
        !m.bodyText
      ) {
        getEmail(m.id)
          .then((full) => setHydrated((h) => ({ ...h, [m.id]: full })))
          .catch(() => {});
      }
    });
  }, [expanded, messages, hydrated]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex flex-col gap-2">
      {messages.map((m) => {
        const isOpen = expanded.has(m.id);
        const view = hydrated[m.id] ?? m;
        return (
          <div
            key={m.id}
            className={`border border-border rounded-lg overflow-hidden ${
              isOpen ? "" : "bg-secondary/20"
            }`}
          >
            <button
              onClick={() => toggle(m.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary/40 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                {initials(m.from.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate flex items-center gap-1">
                  {m.from.name}
                  {!m.isRead && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                  )}
                </div>
                {!isOpen && (
                  <div className="text-[11px] text-muted-foreground truncate">
                    {m.snippet}
                  </div>
                )}
              </div>
              {m.hasAttachments && (
                <Paperclip size={11} className="text-muted-foreground flex-shrink-0" />
              )}
              <span className="text-[10px] text-muted-foreground whitespace-nowrap flex-shrink-0">
                {fullDateLabel(m.receivedAt)}
              </span>
              <ChevronDown
                size={13}
                className={`text-muted-foreground flex-shrink-0 transition-transform ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {isOpen && (
              <div className="px-3 pb-3">
                <div className="text-[11px] text-muted-foreground mb-2">
                  To: {m.to.map((t) => t.name || t.email).join(", ")}
                </div>
                {view.bodyHtml || view.bodyText ? (
                  <MessageContent html={view.bodyHtml} text={view.bodyText} />
                ) : (
                  <div className="text-xs text-muted-foreground italic py-2">
                    No preview text.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
