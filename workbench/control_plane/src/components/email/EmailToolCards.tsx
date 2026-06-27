"use client";

/**
 * EmailToolCards — interactive AG-UI cards for the email-assistant agent's tools.
 *
 * Rendered by the shared <AgentChat> for any assistant message whose tool events
 * include email-assistant tools.  Because it's a no-op when no email tools are
 * present, it's safe to render for EVERY agent — so the rich email cards appear
 * in BOTH the main chat app and the email app.
 *
 * Card types:
 *   • DraftResultCard   — editable draft + Save-to-Drafts + Send (draft_reply)
 *   • RuleResultCard     — rule made/updated + Disable / Delete (create/update_rule)
 *   • SettingsUpdatedCard— what settings changed + Open settings (update_assistant_settings)
 *   • EmailListCard      — clickable results that open the email (search / find_*)
 *   • EmailPreviewCard   — opened email summary + Open (read_email)
 *   • ActionResultCard   — generic confirmation for every other mutating tool
 *
 * Cards self-source account / email / rule ids from the tool-call `args` (the
 * email-assistant tools take `account_id`, `email_id`, `rule_id`), falling back
 * to the optional `accountId` / `emailId` props the email app passes from its
 * current selection — so they work in the chat app too.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  PenLine, Sparkles, CheckCircle2, Loader2, Send, Reply, Mail, Tag, Archive,
  FolderInput, Trash2, X, RefreshCw, ExternalLink, Settings2, BookOpen,
  Clock, Wrench, Search,
} from "lucide-react";
import type { ToolEvent } from "@/components/MarkdownMessage";
import {
  saveDraftText, sendDraft, deleteRule, listRules, updateRule,
} from "@/app/email/lib/api";
import { useEmailStore } from "@/app/email/lib/emailStore";

// ── Tool → card routing ───────────────────────────────────────────────────────

const DRAFT_TOOLS = new Set(["draft_reply", "draft_email"]);
const RULE_TOOLS = new Set(["create_rule", "update_rule"]);
const LIST_TOOLS = new Set(["search_emails", "find_urgent", "find_needs_reply"]);
const READ_TOOL = "read_email";
const SETTINGS_TOOL = "update_assistant_settings";

/** Friendly label + icon for the generic confirmation card (mutating tools). */
const ACTION_META: Record<string, { icon: React.ElementType; label: string; danger?: boolean }> = {
  manage_inbox: { icon: Archive, label: "Inbox updated" },
  apply_labels: { icon: Tag, label: "Labels updated" },
  move_to_folder: { icon: FolderInput, label: "Moved to folder" },
  create_label: { icon: Tag, label: "Label ready" },
  send_email: { icon: Send, label: "Email sent" },
  send_reply: { icon: Reply, label: "Reply sent" },
  send_draft: { icon: Send, label: "Draft sent" },
  delete_rule: { icon: Trash2, label: "Rule deleted", danger: true },
  reset_rules: { icon: Sparkles, label: "Rules reset", danger: true },
  run_rules_now: { icon: Wrench, label: "Rules run" },
  update_rule_state: { icon: Sparkles, label: "Rule updated" },
  learn_rule_pattern: { icon: Sparkles, label: "Pattern learned" },
  install_default_rules: { icon: Sparkles, label: "Default rules installed" },
  process_past_emails: { icon: Clock, label: "Processing past mail" },
  approve_execution: { icon: CheckCircle2, label: "Approved" },
  reject_execution: { icon: X, label: "Rejected" },
  undo_execution: { icon: RefreshCw, label: "Undone" },
  add_knowledge: { icon: BookOpen, label: "Knowledge added" },
  update_knowledge: { icon: BookOpen, label: "Knowledge updated" },
  delete_knowledge: { icon: Trash2, label: "Knowledge deleted", danger: true },
  generate_writing_style: { icon: PenLine, label: "Writing style saved" },
  delete_learned_pattern: { icon: Trash2, label: "Pattern forgotten" },
  find_follow_ups: { icon: Clock, label: "Follow-ups scanned" },
  mark_thread_done: { icon: CheckCircle2, label: "Thread updated" },
  reclassify_reply_zero: { icon: RefreshCw, label: "Reply Zero reclassifying" },
  unsubscribe_sender: { icon: Archive, label: "Unsubscribed", danger: true },
  keep_newsletter: { icon: Mail, label: "Newsletter kept" },
  set_cold_sender: { icon: Archive, label: "Cold sender updated" },
  categorize_senders: { icon: Tag, label: "Categorizing senders" },
  send_digest: { icon: Send, label: "Digest sent" },
  sync_account: { icon: RefreshCw, label: "Syncing" },
  resync_account: { icon: RefreshCw, label: "Re-syncing" },
};

/** True when this completed tool event has a rich card to render. */
function hasEmailCard(e: ToolEvent): boolean {
  if (e.status !== "done") return false;
  return (
    DRAFT_TOOLS.has(e.name) ||
    RULE_TOOLS.has(e.name) ||
    LIST_TOOLS.has(e.name) ||
    e.name === READ_TOOL ||
    e.name === SETTINGS_TOOL ||
    e.name in ACTION_META
  );
}

/**
 * Render rich, interactive cards for the email-assistant tool calls in a message.
 * Returns null when there are none (inert for non-email agents).
 */
export default function EmailToolCards({
  toolEvents,
  accountId,
  emailId,
}: {
  toolEvents?: ToolEvent[];
  accountId?: string | null;
  emailId?: string | null;
}) {
  const cards = (toolEvents ?? []).filter(hasEmailCard);
  if (cards.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {cards.map((e) => {
        if (DRAFT_TOOLS.has(e.name)) {
          return <DraftResultCard key={e.id} event={e} accountId={accountId} emailId={emailId} />;
        }
        if (RULE_TOOLS.has(e.name)) {
          return <RuleResultCard key={e.id} event={e} accountId={accountId} />;
        }
        if (e.name === SETTINGS_TOOL) {
          return <SettingsUpdatedCard key={e.id} event={e} />;
        }
        if (LIST_TOOLS.has(e.name)) {
          return <EmailListCard key={e.id} event={e} />;
        }
        if (e.name === READ_TOOL) {
          return <EmailPreviewCard key={e.id} event={e} />;
        }
        return <ActionResultCard key={e.id} event={e} />;
      })}
    </div>
  );
}

// ── Navigation helper ─────────────────────────────────────────────────────────

/** Open an email in the email app (selects it in the store + routes to /email). */
function useOpenEmail() {
  const router = useRouter();
  return (id: string) => {
    try {
      useEmailStore.getState().selectEmail(id);
    } catch {
      /* store not ready — still navigate */
    }
    router.push("/email");
  };
}

// ── Draft card ────────────────────────────────────────────────────────────────

/** Editable draft — Save to Drafts or Send. */
function DraftResultCard({
  event: e,
  accountId,
  emailId,
}: {
  event: ToolEvent;
  accountId?: string | null;
  emailId?: string | null;
}) {
  const args = e.args as Record<string, unknown> | undefined;
  // draft_reply returns "Draft[ (saved…)]:\n\n<body>".
  const raw = e.result || "";
  const initial = raw.includes("\n\n")
    ? raw.slice(raw.indexOf("\n\n") + 2).trim()
    : raw.trim();
  const targetId = (args?.email_id as string) || emailId || "";
  const acctId = (args?.account_id as string) || accountId || "";
  const [body, setBody] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "sending" | "sent" | "error">("idle");

  const canAct = !!acctId && !!targetId && !!body.trim();

  const save = async () => {
    if (!canAct) return;
    setState("saving");
    try {
      await saveDraftText(acctId, targetId, body);
      setState("saved");
    } catch {
      setState("error");
    }
  };

  const send = async () => {
    if (!canAct || !confirm("Send this reply now?")) return;
    setState("sending");
    try {
      const res = await saveDraftText(acctId, targetId, body);
      if (res?.id) {
        await sendDraft(acctId, res.id);
        setState("sent");
      } else {
        // Couldn't resolve a draft id to send — left it in Drafts.
        setState("saved");
      }
    } catch {
      setState("error");
    }
  };

  const done = state === "saved" || state === "sent";

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <PenLine size={12} className="text-primary" />
        <span className="text-[11px] font-medium text-foreground">Draft reply</span>
      </div>
      <textarea
        value={body}
        onChange={(ev) => setBody(ev.target.value)}
        rows={5}
        disabled={done}
        className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none focus:border-primary resize-y leading-relaxed disabled:opacity-70"
      />
      <div className="flex items-center gap-2 mt-1.5">
        {state === "sent" ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-500">
            <Send size={11} /> Sent
          </span>
        ) : state === "saved" ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-500">
            <CheckCircle2 size={11} /> Saved to Drafts
          </span>
        ) : (
          <>
            <button
              onClick={save}
              disabled={!canAct || state === "saving" || state === "sending"}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border border-border text-foreground hover:bg-secondary disabled:opacity-50"
            >
              {state === "saving" ? <Loader2 size={11} className="animate-spin" /> : <PenLine size={11} />}
              Save to Drafts
            </button>
            <button
              onClick={send}
              disabled={!canAct || state === "saving" || state === "sending"}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {state === "sending" ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
              Send
            </button>
          </>
        )}
        {state === "error" && (
          <span className="text-[10px] text-destructive">Something went wrong.</span>
        )}
        {!targetId && (
          <span className="text-[10px] text-muted-foreground">Open the email to enable saving.</span>
        )}
      </div>
    </div>
  );
}

// ── Rule card ─────────────────────────────────────────────────────────────────

const RULE_ID_RE = /id=([0-9a-fA-F-]{8,})/;

/** Rule made/updated — disable or delete it. */
function RuleResultCard({
  event: e,
  accountId,
}: {
  event: ToolEvent;
  accountId?: string | null;
}) {
  const args = e.args as Record<string, unknown> | undefined;
  const acctId = (args?.account_id as string) || accountId || "";
  const ruleId = (args?.rule_id as string) || (e.result?.match(RULE_ID_RE)?.[1] ?? "");
  const name = (args?.name as string) || e.result?.match(/'([^']+)'/)?.[1] || "rule";
  const created = e.name === "create_rule";
  const [state, setState] = useState<"idle" | "busy" | "deleted" | "disabled">("idle");

  const del = async () => {
    if (!ruleId || !confirm(`Delete rule "${name}"?`)) return;
    setState("busy");
    try {
      await deleteRule(ruleId);
      setState("deleted");
    } catch {
      setState("idle");
    }
  };
  const disable = async () => {
    if (!ruleId || !acctId) return;
    setState("busy");
    try {
      const rules = await listRules(acctId);
      const r = rules.find((x) => x.id === ruleId);
      if (r) await updateRule(ruleId, { ...r, enabled: false });
      setState("disabled");
    } catch {
      setState("idle");
    }
  };

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-primary flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-foreground">
            {created ? "Created rule" : "Updated rule"}: {name}
          </div>
          {state === "deleted" && <div className="text-[10px] text-destructive">Deleted.</div>}
          {state === "disabled" && <div className="text-[10px] text-muted-foreground">Disabled.</div>}
        </div>
        {state === "idle" && ruleId && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {acctId && (
              <button
                onClick={disable}
                className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                Disable
              </button>
            )}
            <button
              onClick={del}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              Delete
            </button>
          </div>
        )}
        {state === "busy" && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}

// ── Settings card ─────────────────────────────────────────────────────────────

/** Map of setting key → friendly label for the "settings updated" summary. */
const SETTING_LABELS: Record<string, string> = {
  about: "About you",
  signature: "Signature",
  auto_run: "Auto-run rules",
  cold_email_blocker: "Cold-email blocker",
  personal_instructions: "Personal instructions",
  writing_style: "Writing style",
  draft_replies: "Auto-draft replies",
  draft_confidence: "Draft confidence",
  follow_up_awaiting_days: "Follow-up (awaiting)",
  follow_up_needs_reply_days: "Follow-up (needs reply)",
  follow_up_auto_draft: "Follow-up auto-draft",
  digest_frequency: "Digest frequency",
  digest_categories: "Digest categories",
  digest_day_of_week: "Digest day",
  digest_time_of_day: "Digest time",
  digest_send_to_email: "Email the digest",
  multi_rule_execution: "Multi-rule execution",
  sensitive_data_protection: "Sensitive-data protection",
  rule_model: "Rule model",
  draft_model: "Draft model",
  chat_model: "Chat model",
};

function fmtVal(v: unknown): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "all";
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

/** Shows which settings the assistant changed, with a shortcut to the settings UI. */
function SettingsUpdatedCard({ event: e }: { event: ToolEvent }) {
  const router = useRouter();
  const args = e.args as Record<string, unknown> | undefined;
  const changed = Object.entries(args ?? {}).filter(
    ([k, v]) => k !== "account_id" && v !== null && v !== undefined && k in SETTING_LABELS,
  );

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Settings2 size={13} className="text-primary flex-shrink-0" />
        <span className="text-[11px] font-medium text-foreground flex-1">Settings updated</span>
        <button
          onClick={() => router.push("/email")}
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
        >
          <ExternalLink size={10} /> Open
        </button>
      </div>
      {changed.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {changed.map(([k, v]) => (
            <span
              key={k}
              className="text-[10px] px-1.5 py-0.5 rounded bg-secondary/70 text-muted-foreground"
              title={`${SETTING_LABELS[k]}: ${fmtVal(v)}`}
            >
              {SETTING_LABELS[k]}: <span className="text-foreground">{fmtVal(v)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Email list card ───────────────────────────────────────────────────────────

interface ParsedRow { id: string; sender: string; subject: string }

/** Parse the "• id=<id> | <sender>: <subject> — <snippet>" rows the read tools emit. */
function parseEmailRows(result: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const line of result.split("\n")) {
    const m = line.match(/id=([^\s|]+)\s*\|\s*([^:]+):\s*(.*)$/);
    if (m) {
      const subject = m[3].split(" — ")[0].trim();
      rows.push({ id: m[1].trim(), sender: m[2].trim(), subject: subject || "(no subject)" });
    }
  }
  return rows;
}

const LIST_META: Record<string, { icon: React.ElementType; label: string }> = {
  search_emails: { icon: Search, label: "Search results" },
  find_urgent: { icon: Clock, label: "Urgent / needs attention" },
  find_needs_reply: { icon: Reply, label: "Needs a reply" },
};

/** Clickable email results — each row opens the message in the email app. */
function EmailListCard({ event: e }: { event: ToolEvent }) {
  const openEmail = useOpenEmail();
  const [expanded, setExpanded] = useState(false);
  const rows = parseEmailRows(e.result || "");
  // No parseable rows (e.g. "Nothing needs a reply") → generic summary card.
  if (rows.length === 0) return <ActionResultCard event={e} />;
  const meta = LIST_META[e.name] ?? { icon: Mail, label: "Emails" };
  const Icon = meta.icon;
  const shown = expanded ? rows : rows.slice(0, 5);

  return (
    <div className="rounded-lg border border-sidebar-border bg-secondary/40 px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-primary" />
        <span className="text-[11px] font-medium text-foreground">{meta.label}</span>
        <span className="text-[10px] text-muted-foreground">({rows.length})</span>
      </div>
      <div className="space-y-1">
        {shown.map((r) => (
          <button
            key={r.id}
            onClick={() => openEmail(r.id)}
            className="w-full text-left rounded-md px-2 py-1 hover:bg-secondary border border-transparent hover:border-border transition-colors group"
          >
            <div className="flex items-center gap-1.5">
              <Mail size={11} className="text-muted-foreground flex-shrink-0" />
              <span className="text-[11px] text-foreground truncate flex-1">{r.subject}</span>
              <ExternalLink size={10} className="text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0" />
            </div>
            <div className="text-[10px] text-muted-foreground truncate pl-[18px]">{r.sender}</div>
          </button>
        ))}
      </div>
      {rows.length > 5 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[10px] text-primary hover:opacity-80"
        >
          {expanded ? "Show less" : `Show ${rows.length - 5} more`}
        </button>
      )}
    </div>
  );
}

// ── Email preview card ────────────────────────────────────────────────────────

/** Opened email — show From / Subject + a button to open it in the app. */
function EmailPreviewCard({ event: e }: { event: ToolEvent }) {
  const openEmail = useOpenEmail();
  const args = e.args as Record<string, unknown> | undefined;
  const id = (args?.email_id as string) || "";
  const result = e.result || "";
  const from = result.match(/^From:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const subject = result.match(/^Subject:\s*(.+)$/m)?.[1]?.trim() ?? "(no subject)";

  return (
    <div className="rounded-lg border border-sidebar-border bg-secondary/40 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Mail size={13} className="text-primary flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-foreground truncate">{subject}</div>
          {from && <div className="text-[10px] text-muted-foreground truncate">{from}</div>}
        </div>
        {id && (
          <button
            onClick={() => openEmail(id)}
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary flex-shrink-0"
          >
            <ExternalLink size={10} /> Open
          </button>
        )}
      </div>
    </div>
  );
}

// ── Generic action card ───────────────────────────────────────────────────────

/** Confirmation card for any mutating tool — icon + label + result summary. */
function ActionResultCard({ event: e }: { event: ToolEvent }) {
  const meta = ACTION_META[e.name] ?? { icon: Wrench, label: e.name.replace(/_/g, " ") };
  const failed = e.status === "error";
  const Icon = failed ? X : meta.icon;
  const result = (e.result || "").trim();
  const detail = result.length > 160 ? result.slice(0, 160) + "…" : result;

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        failed
          ? "border-destructive/40 bg-destructive/5"
          : meta.danger
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-sidebar-border bg-secondary/40"
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 flex-shrink-0 ${
            failed ? "text-destructive" : meta.danger ? "text-amber-500" : "text-emerald-500"
          }`}
        >
          <Icon size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-foreground">{meta.label}</div>
          {detail && (
            <div className="mt-0.5 text-[10px] text-muted-foreground whitespace-pre-wrap line-clamp-3">
              {detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
