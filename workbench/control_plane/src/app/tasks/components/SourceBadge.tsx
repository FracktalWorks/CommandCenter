"use client";

import { HardDrive, Cloud } from "lucide-react";
import { ProviderKind, Source } from "../lib/types";
import { sourceBadge } from "../lib/utils";

// A small badge showing whether an item is LOCAL (we own it) or SYNCED
// (mirrors a connected PM tool). Central to the dual-source model (§5.1).
export function SourceBadge({
  source,
  provider,
  size = "sm",
}: {
  source: Source;
  provider?: ProviderKind;
  size?: "sm" | "xs";
}) {
  const { label, tone } = sourceBadge(source, provider);
  const Icon = tone === "local" ? HardDrive : Cloud;
  const dim = size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3";
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
        size === "xs" ? "text-[9px]" : "text-[10px]",
        tone === "local"
          ? "bg-muted text-muted-foreground"
          : "bg-primary/10 text-primary",
      ].join(" ")}
      title={tone === "local" ? "Local — stored in CommandCenter" : `Synced — ${label}`}
    >
      <Icon className={dim} />
      {label}
    </span>
  );
}
