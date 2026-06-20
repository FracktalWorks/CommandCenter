"use client";

import { ArrowLeft, Sparkles, MailMinus, Archive, BarChart3 } from "lucide-react";
import { AutomationFeature } from "../../lib/types";
import { AssistantView } from "./AssistantView";
import { BulkUnsubscribeView } from "./BulkUnsubscribeView";
import { BulkArchiveView } from "./BulkArchiveView";
import { AnalyticsView } from "./AnalyticsView";

interface AutomationViewProps {
  feature: AutomationFeature;
  accountId: string | null;
  selectedEmailId: string | null;
  onClose: () => void;
  onArchived?: () => void;
}

const META: Record<
  AutomationFeature,
  { title: string; subtitle: string; icon: React.ElementType }
> = {
  assistant: {
    title: "Assistant",
    subtitle: "Rules, testing & history",
    icon: Sparkles,
  },
  unsubscribe: {
    title: "Bulk Unsubscribe",
    subtitle: "Clean up newsletters & subscriptions",
    icon: MailMinus,
  },
  archive: {
    title: "Bulk Archive",
    subtitle: "Archive old mail in bulk",
    icon: Archive,
  },
  analytics: {
    title: "Analytics",
    subtitle: "Inbox trends & activity",
    icon: BarChart3,
  },
};

export function AutomationView({
  feature,
  accountId,
  selectedEmailId,
  onClose,
  onArchived,
}: AutomationViewProps) {
  const meta = META[feature];
  const Icon = meta.icon;

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border flex-shrink-0 bg-card">
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label="Back to inbox"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="w-7 h-7 rounded-lg bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
          <Icon size={15} />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-foreground leading-tight">
            {meta.title}
          </h1>
          <p className="text-[11px] text-muted-foreground leading-tight">
            {meta.subtitle}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {feature === "assistant" && (
          <AssistantView accountId={accountId} selectedEmailId={selectedEmailId} />
        )}
        {feature === "unsubscribe" && (
          <BulkUnsubscribeView accountId={accountId} />
        )}
        {feature === "archive" && (
          <BulkArchiveView accountId={accountId} onArchived={onArchived} />
        )}
        {feature === "analytics" && <AnalyticsView accountId={accountId} />}
      </div>
    </div>
  );
}
