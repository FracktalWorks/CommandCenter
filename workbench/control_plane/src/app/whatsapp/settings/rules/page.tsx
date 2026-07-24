"use client";

// WhatsApp Rules — a dry-run of the auto-reply engine over the current queue.
// The "honest stats" ethos: the founder sees exactly what automation WOULD do
// (no sends) before enabling any of it. Each row shows the decided action and
// why; the summary tallies actions by kind.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { fetchAccounts, fetchRulesPreview } from "../../lib/api";
import type { WaRulePreview, WaRulePreviewItem } from "../../lib/types";

const ACTION_LABEL: Record<string, string> = {
  answer_from_system: "Auto-answer",
  holding_reply: "Holding reply",
  draft: "Prepare draft",
  none: "Leave for you",
};

const ACTION_TONE: Record<string, string> = {
  answer_from_system: "text-emerald-500",
  holding_reply: "text-emerald-500",
  draft: "text-primary",
  none: "text-muted-foreground",
};

export default function RulesPreviewPage() {
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<WaRulePreview>({
    items: [],
    summary: {},
  });

  useEffect(() => {
    (async () => {
      const accs = await fetchAccounts();
      if (accs[0]?.id) setPreview(await fetchRulesPreview(accs[0].id));
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const order = ["answer_from_system", "holding_reply", "draft", "none"];
  const summaryEntries = order
    .filter((k) => preview.summary[k])
    .map((k) => [k, preview.summary[k]] as const);

  return (
    <div className="mx-auto max-w-3xl p-6 text-foreground">
      <div className="mb-5 flex items-center gap-3">
        <Link
          href="/whatsapp"
          className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Queue
        </Link>
        <h1 className="text-[15px] font-semibold">Rules preview</h1>
        <span className="text-[11px] text-muted-foreground">
          what automation would do — nothing is sent
        </span>
      </div>

      {/* summary tiles */}
      {summaryEntries.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {summaryEntries.map(([action, n]) => (
            <div
              key={action}
              className="rounded-lg border border-border px-3 py-2"
            >
              <span className={`text-[16px] font-bold ${ACTION_TONE[action]}`}>
                {n}
              </span>
              <span className="ml-1.5 text-[11px] text-muted-foreground">
                {ACTION_LABEL[action] ?? action}
              </span>
            </div>
          ))}
        </div>
      )}

      {preview.items.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-[13px] text-muted-foreground">
          Nothing in the needs-reply queue to preview right now.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                <th className="px-3 py-2 text-left font-bold">Chat</th>
                <th className="px-3 py-2 text-left font-bold">Intent</th>
                <th className="px-3 py-2 text-left font-bold">Would do</th>
                <th className="px-3 py-2 text-left font-bold">Why</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((it) => (
                <RuleRow key={it.chat_id} it={it} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-[11px] text-muted-foreground/70">
        Auto-answers run unattended; holding replies are canned and safe; drafts
        wait for your Send. VIP and Family are never auto-sent.
      </p>
    </div>
  );
}

function RuleRow({ it }: { it: WaRulePreviewItem }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2.5">
        <span className="font-semibold">{it.name}</span>
        {it.category && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            {it.category}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground">{it.intent ?? "—"}</td>
      <td className="px-3 py-2.5">
        <span className={`font-semibold ${ACTION_TONE[it.action] ?? ""}`}>
          {ACTION_LABEL[it.action] ?? it.action}
        </span>
        {it.via_template && (
          <span className="ml-1 text-[10px] text-amber-500">· template</span>
        )}
        {it.requires_approval && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            · approve
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
        {it.reason}
      </td>
    </tr>
  );
}
