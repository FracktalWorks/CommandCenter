"use client";

/**
 * Trigger bindings panel (RFC §7) — manual is always available; webhook
 * exposes the per-workflow hook URL (+ optional HMAC secret); schedule takes
 * a cron expression. All kinds converge on the same run entrypoint.
 */

import { useMemo, useState } from "react";
import { Copy, X, Zap } from "lucide-react";
import type { TriggerSpec } from "../lib/types";

const inputCls =
  "w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

export default function TriggerPanel({
  triggers,
  hookToken,
  published,
  onChange,
  onClose,
}: {
  triggers: TriggerSpec[];
  hookToken?: string;
  published: boolean;
  onChange: (next: TriggerSpec[]) => void;
  onClose: () => void;
}) {
  const webhook = useMemo(
    () => triggers.find((t) => t.kind === "webhook"),
    [triggers],
  );
  const schedule = useMemo(
    () => triggers.find((t) => t.kind === "schedule"),
    [triggers],
  );
  const [copied, setCopied] = useState(false);

  const hookUrl =
    typeof window !== "undefined" && hookToken
      ? `${window.location.origin}/api/workflows/hooks/${hookToken}`
      : "";

  const upsert = (kind: "webhook" | "schedule", patch: Partial<TriggerSpec>) => {
    const rest = triggers.filter((t) => t.kind !== kind);
    const current = triggers.find((t) => t.kind === kind) ?? {
      kind,
      config: {},
      enabled: false,
    };
    onChange([...rest, { ...current, ...patch } as TriggerSpec]);
  };

  const remove = (kind: string) =>
    onChange(triggers.filter((t) => t.kind !== kind));

  return (
    <div className="absolute right-3 top-12 z-20 w-80 rounded-xl border border-border bg-popover shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-amber-500" />
          Triggers
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary tech-transition"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-4 text-xs">
        <div>
          <div className="font-medium text-foreground">Manual / API</div>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Always available — the Run button here, or{" "}
            <code className="bg-secondary px-1 rounded">
              POST /workflows/&#123;id&#125;/run
            </code>
            .
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">Webhook</span>
            <input
              type="checkbox"
              checked={Boolean(webhook?.enabled)}
              onChange={(e) =>
                e.target.checked
                  ? upsert("webhook", { enabled: true })
                  : remove("webhook")
              }
            />
          </div>
          {webhook?.enabled && (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex items-center gap-1">
                <input
                  readOnly
                  value={hookUrl}
                  className={`${inputCls} font-mono text-[10px]`}
                />
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(hookUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground tech-transition shrink-0"
                  title="Copy URL"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              {copied && (
                <p className="text-[10px] text-success">Copied.</p>
              )}
              <input
                placeholder="Optional HMAC secret (X-CC-Signature)"
                value={String(webhook.config.secret ?? "")}
                onChange={(e) =>
                  upsert("webhook", {
                    config: { ...webhook.config, secret: e.target.value },
                  })
                }
                className={inputCls}
              />
              {!published && (
                <p className="text-[10px] text-warning">
                  Fires only once the workflow is published.
                </p>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">Schedule (cron)</span>
            <input
              type="checkbox"
              checked={Boolean(schedule?.enabled)}
              onChange={(e) =>
                e.target.checked
                  ? upsert("schedule", {
                      enabled: true,
                      config: { cron: String(schedule?.config.cron ?? "0 9 * * *") },
                    })
                  : remove("schedule")
              }
            />
          </div>
          {schedule?.enabled && (
            <div className="mt-1.5 space-y-1">
              <input
                placeholder="0 9 * * 1-5"
                value={String(schedule.config.cron ?? "")}
                onChange={(e) =>
                  upsert("schedule", {
                    config: { ...schedule.config, cron: e.target.value },
                  })
                }
                className={`${inputCls} font-mono`}
              />
              <p className="text-[10px] text-muted-foreground">
                Five-field cron, UTC. e.g.{" "}
                <code className="bg-secondary px-1 rounded">0 9 * * 1-5</code> =
                weekdays 09:00.
              </p>
              {!published && (
                <p className="text-[10px] text-warning">
                  Fires only once the workflow is published.
                </p>
              )}
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground border-t border-border pt-2">
          Trigger changes save with the workflow. Event triggers (CRM/task/email
          events) arrive in a later slice.
        </p>
      </div>
    </div>
  );
}
