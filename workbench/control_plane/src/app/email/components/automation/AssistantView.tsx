"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2, Plus, Trash2, Pencil, Play, Check, X, FlaskConical,
  History as HistoryIcon, Settings2, Settings, Sparkles, Wand2, BookOpen,
  ArrowUp, ArrowDown, Eye, MessageCircle, RefreshCcw, Square,
} from "lucide-react";
import {
  listRules, createRule, updateRule, deleteRule, runRuleOnMessage,
  getRulesHistory, runRules, getAssistantSettings, saveAssistantSettings,
  listColdSenders, upsertColdSender, generateWritingStyle, listEmails,
  listKnowledge, createKnowledge, updateKnowledge, deleteKnowledge,
  installPresetRules, reorderRules,
  listLearnedPatterns, deleteLearnedPattern,
} from "../../lib/api";
import {
  AutomationRule, RuleAction, RuleActionType, ExecutedRule, Email,
  AssistantSettings, EMAIL_CATEGORIES, ColdBlockerMode, RunMessageResult,
  ColdSender, LLMConfigResponse, KnowledgeEntry, LearnedPattern,
  RuleConditions, DraftConfidence, DRAFT_CONFIDENCE_OPTIONS, WEEKDAYS,
} from "../../lib/types";
import { useEmailStore } from "../../lib/emailStore";
import {
  Modal, Toggle, LabeledToggle, HoverPopover, SettingCard, SectionHeader,
} from "./ui";

interface AssistantViewProps {
  accountId: string | null;
  selectedEmailId: string | null;
}

type Tab = "rules" | "test" | "history" | "settings";

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "rules", label: "Rules", icon: Sparkles },
  { key: "test", label: "Test", icon: FlaskConical },
  { key: "history", label: "History", icon: HistoryIcon },
  { key: "settings", label: "Settings", icon: Settings2 },
];

const ACTION_TYPES: RuleActionType[] = [
  "ARCHIVE", "LABEL", "MARK_READ", "STAR", "MARK_SPAM", "TRASH",
  "MOVE_FOLDER", "REPLY", "FORWARD", "DRAFT_EMAIL", "CALL_WEBHOOK",
];

/**
 * Human-friendly name + one-line explanation for each rule action, so the UI
 * never shows raw enum values like DRAFT_EMAIL / CALL_WEBHOOK. The description
 * is surfaced as a tooltip and under the action editor.
 */
const ACTION_META: Record<RuleActionType, { label: string; description: string }> = {
  ARCHIVE: { label: "Archive", description: "Remove the email from the inbox." },
  LABEL: { label: "Apply label", description: "Add a label / category to the email." },
  MARK_READ: { label: "Mark as read", description: "Mark the email as read." },
  STAR: { label: "Star", description: "Star / flag the email." },
  MARK_SPAM: { label: "Mark as spam", description: "Move the email to the spam folder." },
  TRASH: { label: "Move to trash", description: "Send the email to trash." },
  MOVE_FOLDER: { label: "Move to folder", description: "Move the email to a specific folder." },
  REPLY: { label: "Reply", description: "Create a reply draft for your review — never auto-sent." },
  FORWARD: { label: "Forward", description: "Create a forward draft to someone — never auto-sent." },
  DRAFT_EMAIL: { label: "Draft a reply", description: "Let the AI write a reply draft for your review — never auto-sent." },
  CALL_WEBHOOK: { label: "Call webhook", description: "POST the email to a URL you specify." },
};

/** Action types that draft an email and expose to/subject/content fields. */
const DRAFT_ACTIONS = new Set<RuleActionType>(["REPLY", "FORWARD", "DRAFT_EMAIL"]);

const INPUT_CLS =
  "w-full bg-secondary border border-border rounded-lg px-2.5 py-2 text-xs " +
  "text-foreground outline-none focus:border-primary transition-colors";

/**
 * Default rule set, mirroring inbox-zero's presets. Installed on demand into the
 * selected account; each rule is then fully editable.
 */
type PresetRule = Omit<AutomationRule, "account_id">;

const PRESET_RULES: PresetRule[] = [
  {
    name: "To Reply",
    instructions: "Emails I need to respond to.",
    enabled: true,
    automated: true,
    run_on_threads: true,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 0,
    actions: [{ type: "LABEL", label: "To Reply" }, { type: "DRAFT_EMAIL" }],
  },
  {
    name: "FYI",
    instructions:
      "Important emails I should know about, but don't need to reply to.",
    enabled: true,
    automated: true,
    run_on_threads: true,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 1,
    actions: [{ type: "LABEL", label: "FYI" }],
  },
  {
    name: "Newsletter",
    instructions:
      "Newsletters: regular content from publications, blogs, or services " +
      "I've subscribed to.",
    enabled: true,
    automated: true,
    run_on_threads: false,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 2,
    actions: [{ type: "LABEL", label: "Newsletter" }],
  },
  {
    name: "Marketing",
    instructions:
      "Marketing: promotional emails about products, services, sales, or offers.",
    enabled: true,
    automated: true,
    run_on_threads: false,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 3,
    actions: [{ type: "LABEL", label: "Marketing" }, { type: "ARCHIVE" }],
  },
  {
    name: "Calendar",
    instructions:
      "Calendar: any email related to scheduling, meeting invites, or " +
      "calendar notifications.",
    enabled: true,
    automated: true,
    run_on_threads: false,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 4,
    actions: [{ type: "LABEL", label: "Calendar" }],
  },
  {
    name: "Receipt",
    instructions:
      "Receipts: purchase confirmations, payment receipts, transaction " +
      "records or invoices.",
    enabled: true,
    automated: true,
    run_on_threads: false,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 5,
    actions: [{ type: "LABEL", label: "Receipt" }],
  },
  {
    name: "Notification",
    instructions: "Notifications: alerts, status updates, or system messages.",
    enabled: true,
    automated: true,
    run_on_threads: false,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 6,
    actions: [{ type: "LABEL", label: "Notification" }],
  },
  {
    name: "Cold Email",
    instructions:
      "Cold emails: unsolicited sales pitches and outreach from people or " +
      "companies I have no prior relationship with.",
    enabled: true,
    automated: true,
    run_on_threads: false,
    conditional_operator: "AND",
    category_filters: [],
    sort_order: 7,
    actions: [{ type: "LABEL", label: "Cold Email" }, { type: "ARCHIVE" }],
  },
];

export function AssistantView({ accountId }: AssistantViewProps) {
  const [tab, setTab] = useState<Tab>("rules");

  return (
    <div className="h-full flex flex-col">
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-3 sm:px-5 py-2 border-b border-border flex-shrink-0 overflow-x-auto scrollbar-hide">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors flex-shrink-0 whitespace-nowrap ${
              tab === key
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "rules" && <RulesTab accountId={accountId} />}
        {tab === "test" && <TestTab accountId={accountId} />}
        {tab === "history" && <HistoryTab accountId={accountId} />}
        {tab === "settings" && <SettingsTab accountId={accountId} />}
      </div>
    </div>
  );
}

// ── Rules tab ───────────────────────────────────────────────────────────────

const emptyRule = (accountId: string): AutomationRule => ({
  account_id: accountId,
  name: "",
  instructions: "",
  enabled: true,
  automated: true,
  run_on_threads: false,
  conditional_operator: "AND",
  category_filters: [],
  from_pattern: "",
  subject_pattern: "",
  sort_order: 0,
  actions: [{ type: "ARCHIVE" }],
});

function RulesTab({ accountId }: { accountId: string | null }) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listRules(accountId)
      .then(setRules)
      .catch((e) => setError(e.message || "Failed to load rules"))
      .finally(() => setLoading(false));
  }, [accountId]);

  const missingDefaults = PRESET_RULES.some(
    (p) => !rules.some((r) => r.name.toLowerCase() === p.name.toLowerCase())
  );

  const installDefaults = async () => {
    if (!accountId) return;
    setInstalling(true);
    setError(null);
    try {
      // Backend owns the canonical preset set (also used by the AI assistant).
      await installPresetRules(accountId);
      load();
    } catch (e) {
      setError((e as Error).message || "Failed to install default rules");
    } finally {
      setInstalling(false);
    }
  };

  useEffect(load, [load]);

  const save = async (rule: AutomationRule) => {
    try {
      if (rule.id) await updateRule(rule.id, rule);
      else await createRule(rule);
      setEditing(null);
      load();
    } catch (e) {
      setError((e as Error).message || "Failed to save rule");
    }
  };

  const toggle = async (rule: AutomationRule) => {
    if (!rule.id) return;
    const next = { ...rule, enabled: !rule.enabled };
    setRules((prev) => prev.map((r) => (r.id === rule.id ? next : r)));
    try {
      await updateRule(rule.id, next);
    } catch {
      load();
    }
  };

  const remove = async (rule: AutomationRule) => {
    if (!rule.id || !confirm(`Delete rule "${rule.name}"?`)) return;
    setRules((prev) => prev.filter((r) => r.id !== rule.id));
    try {
      await deleteRule(rule.id);
    } catch {
      load();
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    if (!accountId) return;
    const j = index + dir;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[index], next[j]] = [next[j], next[index]];
    setRules(next);
    try {
      await reorderRules(
        accountId,
        next.map((r) => r.id).filter((id): id is string => !!id)
      );
    } catch {
      load();
    }
  };

  const doRun = async () => {
    if (!accountId) return;
    setRunning(true);
    try {
      await runRules({ accountId, dryRun: true, limit: 25 });
      setToast("Dry run scheduled — check the History tab in a moment.");
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setError((e as Error).message || "Run failed");
    } finally {
      setRunning(false);
    }
  };

  if (!accountId) return <Empty>Select an account first.</Empty>;
  if (loading) return <Spinner label="Loading rules…" />;

  if (editing) {
    return (
      <RuleEditor
        rule={editing}
        onSave={save}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
        <p className="text-xs text-muted-foreground">
          Rules run on inbox mail; the AI matches your plain-English conditions.
        </p>
        <div className="flex items-center gap-2">
          {missingDefaults && rules.length > 0 && (
            <button
              onClick={installDefaults}
              disabled={installing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              {installing ? <Loader2 className="animate-spin" size={13} /> : <Sparkles size={13} />}
              Add defaults
            </button>
          )}
          <button
            onClick={doRun}
            disabled={running || rules.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="animate-spin" size={13} /> : <Play size={13} />}
            Dry run
          </button>
          <button
            onClick={() => setEditing(emptyRule(accountId))}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus size={13} /> New rule
          </button>
        </div>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs text-destructive bg-destructive/10">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
        {rules.length === 0 && (
          <div className="flex flex-col items-center text-center py-10 gap-3">
            <Sparkles size={22} className="text-primary/60" />
            <div className="text-sm text-muted-foreground max-w-xs">
              No rules yet. Install the recommended set (To Reply, FYI,
              Newsletter, Marketing, Calendar, Receipt, Notification, Cold Email)
              or create your own.
            </div>
            <button
              onClick={installDefaults}
              disabled={installing}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {installing ? (
                <Loader2 className="animate-spin" size={13} />
              ) : (
                <Sparkles size={13} />
              )}
              Install default rules
            </button>
          </div>
        )}
        {rules.map((rule, idx) => (
          <div
            key={rule.id}
            className="flex items-start gap-3 bg-card border border-border rounded-xl px-4 py-3"
          >
            <div className="flex flex-col -my-0.5">
              <button
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                title="Move up (higher priority)"
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ArrowUp size={12} />
              </button>
              <button
                onClick={() => move(idx, 1)}
                disabled={idx === rules.length - 1}
                title="Move down (lower priority)"
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ArrowDown size={12} />
              </button>
            </div>
            <button
              onClick={() => toggle(rule)}
              title={rule.enabled ? "Disable" : "Enable"}
              className={`mt-0.5 w-8 h-4.5 rounded-full transition-colors flex-shrink-0 relative ${
                rule.enabled ? "bg-primary" : "bg-secondary"
              }`}
              style={{ height: 18, width: 32 }}
            >
              <span
                className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${
                  rule.enabled ? "left-[15px]" : "left-0.5"
                }`}
              />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {rule.name}
                </span>
              </div>
              {rule.instructions && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {rule.instructions}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1 mt-1.5">
                {rule.actions.map((a, i) => (
                  <span
                    key={i}
                    title={actionDescription(a.type)}
                    className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground"
                  >
                    {actionText(a)}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <IconAction title="Edit" onClick={() => setEditing(rule)}>
                <Pencil size={13} />
              </IconAction>
              <IconAction
                title="Delete"
                onClick={() => remove(rule)}
                className="hover:text-destructive"
              >
                <Trash2 size={13} />
              </IconAction>
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-card border border-border shadow-xl rounded-lg px-4 py-2 text-xs text-foreground">
          {toast}
        </div>
      )}
    </div>
  );
}

/** Condition types exposed in the rule editor, mapped to the flat rule fields. */
type CondType = "prompt" | "from" | "to" | "subject" | "body";

const COND_META: Record<
  CondType,
  {
    label: string;
    field: "instructions" | "from_pattern" | "to_pattern" | "subject_pattern" | "body_pattern";
    placeholder: string;
    textarea?: boolean;
  }
> = {
  prompt: {
    label: "AI Prompt",
    field: "instructions",
    placeholder: "Describe the emails this matches, in plain English…",
    textarea: true,
  },
  from: { label: "From", field: "from_pattern", placeholder: "newsletter@ or @vendor.com" },
  to: { label: "To", field: "to_pattern", placeholder: "me@company.com" },
  subject: { label: "Subject", field: "subject_pattern", placeholder: "invoice" },
  body: { label: "Body", field: "body_pattern", placeholder: "unsubscribe" },
};

const COND_ORDER: CondType[] = ["prompt", "from", "to", "subject", "body"];

function RuleEditor({
  rule,
  onSave,
  onCancel,
}: {
  rule: AutomationRule;
  onSave: (r: AutomationRule) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AutomationRule>(rule);
  const set = (patch: Partial<AutomationRule>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const setField = (field: CondType, value: string) =>
    setDraft((d) => ({ ...d, [COND_META[field].field]: value }));

  const setAction = (i: number, patch: Partial<RuleAction>) =>
    setDraft((d) => ({
      ...d,
      actions: d.actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    }));

  // Conditions visible in the builder: any pre-filled field, plus ones the user
  // explicitly adds. A new rule starts with the AI Prompt row.
  const prefilled = COND_ORDER.filter(
    (t) => ((draft[COND_META[t].field] ?? "") as string).trim() !== ""
  );
  const [shown, setShown] = useState<CondType[]>(
    prefilled.length ? prefilled : ["prompt"]
  );
  const addable = COND_ORDER.filter((t) => !shown.includes(t));
  const removeCondition = (t: CondType) => {
    setShown((s) => s.filter((x) => x !== t));
    setField(t, "");
  };

  const valid = draft.name.trim().length > 0 && draft.actions.length > 0;

  return (
    <div className="h-full overflow-y-auto px-5 py-4 space-y-4">
      <h3 className="text-sm font-semibold text-foreground">
        {rule.id ? "Edit rule" : "New rule"}
      </h3>

      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Archive promotions"
          className={INPUT_CLS}
        />
      </Field>

      {/* When — conditions */}
      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">
            When I get an email…
          </span>
          {shown.length > 1 && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>match</span>
              <select
                value={draft.conditional_operator}
                onChange={(e) =>
                  set({ conditional_operator: e.target.value as "AND" | "OR" })
                }
                className="bg-secondary border border-border rounded px-1.5 py-0.5 text-foreground outline-none"
              >
                <option value="AND">ALL</option>
                <option value="OR">ANY</option>
              </select>
              <span>of these</span>
            </div>
          )}
        </div>

        {shown.map((t) => {
          const meta = COND_META[t];
          const value = (draft[meta.field] ?? "") as string;
          return (
            <div key={t} className="flex items-start gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground w-12 pt-2 flex-shrink-0">
                {meta.label}
              </span>
              {meta.textarea ? (
                <textarea
                  value={value}
                  onChange={(e) => setField(t, e.target.value)}
                  rows={2}
                  placeholder={meta.placeholder}
                  className={`${INPUT_CLS} resize-none flex-1`}
                />
              ) : (
                <input
                  value={value}
                  onChange={(e) => setField(t, e.target.value)}
                  placeholder={meta.placeholder}
                  className={`${INPUT_CLS} flex-1`}
                />
              )}
              {shown.length > 1 && (
                <button
                  onClick={() => removeCondition(t)}
                  title="Remove condition"
                  className="p-1.5 text-muted-foreground hover:text-destructive flex-shrink-0 mt-0.5"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}

        {addable.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Add:</span>
            {addable.map((t) => (
              <button
                key={t}
                onClick={() => setShown((s) => [...s, t])}
                className="text-[11px] px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <Plus size={10} className="inline -mt-0.5" /> {COND_META[t].label}
              </button>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          AI Prompt is matched by the assistant; From/To/Subject/Body are literal
          text matches.
        </p>

        {/* Category condition */}
        <div className="pt-2 border-t border-border/60">
          <span className="text-xs font-medium text-foreground">
            Sender category (optional)
          </span>
          <select
            value={draft.category_filter_type ?? ""}
            onChange={(e) =>
              set({
                category_filter_type:
                  (e.target.value || null) as "INCLUDE" | "EXCLUDE" | null,
              })
            }
            className={`${INPUT_CLS} mt-1.5`}
          >
            <option value="">No category filter</option>
            <option value="INCLUDE">Only these categories</option>
            <option value="EXCLUDE">Except these categories</option>
          </select>
          {draft.category_filter_type && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {EMAIL_CATEGORIES.map((c) => {
                const on = draft.category_filters.includes(c);
                return (
                  <button
                    key={c}
                    onClick={() =>
                      set({
                        category_filters: on
                          ? draft.category_filters.filter((x) => x !== c)
                          : [...draft.category_filters, c],
                      })
                    }
                    className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                      on
                        ? "bg-primary/15 text-primary border-primary/40"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Then — actions */}
      <div className="bg-card border border-border rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-foreground">Then…</span>
          <button
            onClick={() =>
              set({ actions: [...draft.actions, { type: "ARCHIVE" }] })
            }
            className="flex items-center gap-1 text-xs text-primary hover:opacity-80"
          >
            <Plus size={12} /> Add action
          </button>
        </div>
        <div className="space-y-2">
          {draft.actions.map((a, i) => (
            <div
              key={i}
              className="border border-border rounded-lg p-2 space-y-2 bg-secondary/30"
            >
              <div className="flex items-center gap-2">
                <select
                  value={a.type}
                  onChange={(e) =>
                    setAction(i, { type: e.target.value as RuleActionType })
                  }
                  title={ACTION_META[a.type].description}
                  className={`${INPUT_CLS} flex-1`}
                >
                  {ACTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ACTION_META[t].label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    set({ actions: draft.actions.filter((_, idx) => idx !== i) })
                  }
                  className="p-1.5 text-muted-foreground hover:text-destructive flex-shrink-0"
                >
                  <X size={13} />
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground -mt-0.5">
                {ACTION_META[a.type].description}
              </p>

              {(a.type === "LABEL" || a.type === "MOVE_FOLDER") && (
                <input
                  value={a.label ?? ""}
                  onChange={(e) => setAction(i, { label: e.target.value })}
                  placeholder={a.type === "LABEL" ? "Label name" : "Folder key"}
                  className={INPUT_CLS}
                />
              )}
              {a.type === "CALL_WEBHOOK" && (
                <input
                  value={a.url ?? ""}
                  onChange={(e) => setAction(i, { url: e.target.value })}
                  placeholder="https://…"
                  className={INPUT_CLS}
                />
              )}
              {DRAFT_ACTIONS.has(a.type) && (
                <div className="space-y-2">
                  <input
                    value={a.to_address ?? ""}
                    onChange={(e) => setAction(i, { to_address: e.target.value })}
                    placeholder={
                      a.type === "FORWARD"
                        ? "Forward to (email)"
                        : "To (defaults to the sender)"
                    }
                    className={INPUT_CLS}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={a.cc_address ?? ""}
                      onChange={(e) => setAction(i, { cc_address: e.target.value })}
                      placeholder="Cc (optional)"
                      className={INPUT_CLS}
                    />
                    <input
                      value={a.bcc_address ?? ""}
                      onChange={(e) =>
                        setAction(i, { bcc_address: e.target.value })
                      }
                      placeholder="Bcc (optional)"
                      className={INPUT_CLS}
                    />
                  </div>
                  <input
                    value={a.subject ?? ""}
                    onChange={(e) => setAction(i, { subject: e.target.value })}
                    placeholder="Subject (optional)"
                    className={INPUT_CLS}
                  />
                  <textarea
                    value={a.content ?? ""}
                    onChange={(e) => setAction(i, { content: e.target.value })}
                    rows={2}
                    placeholder={
                      a.type === "FORWARD"
                        ? "Note to add above the forwarded message (optional)"
                        : "Draft text — leave blank to let the AI write the reply"
                    }
                    className={`${INPUT_CLS} resize-none`}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Creates a draft for review — never auto-sends.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Options */}
      <div className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.run_on_threads}
            onChange={(e) => set({ run_on_threads: e.target.checked })}
            className="accent-primary mt-0.5"
          />
          <span>
            <span className="text-xs text-foreground">Apply to replies in a thread</span>
            <span className="block text-[11px] text-muted-foreground">
              Re-evaluate this rule on every new message in an ongoing
              conversation (recommended for “To Reply” / “FYI”).
            </span>
          </span>
        </label>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={() => onSave(draft)}
          disabled={!valid}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Check size={13} /> Save rule
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Shared result pills + Fix flow (used by Test & History) ──────────────────

/** Friendly name for an action type string (handles unknowns gracefully). */
function actionLabel(type: string): string {
  return ACTION_META[type as RuleActionType]?.label ?? type;
}

/** Friendly description for an action type string. */
function actionDescription(type: string): string {
  return ACTION_META[type as RuleActionType]?.description ?? "";
}

/** Human label for an action spec (e.g. `Label as "Receipt"`). */
function actionText(a: RuleAction): string {
  if (a.type === "LABEL" && a.label) return `Label as "${a.label}"`;
  if (a.type === "MOVE_FOLDER" && a.label) return `Move to "${a.label}"`;
  if (a.type === "FORWARD" && a.to_address) return `Forward to ${a.to_address}`;
  return actionLabel(a.type);
}

/** Render a rule's conditions the way inbox-zero's popover does. */
function PrettyConditions({ c }: { c: RuleConditions }) {
  const parts: { k: string; v: string }[] = [];
  if (c.instructions) parts.push({ k: "AI", v: c.instructions });
  if (c.from_pattern) parts.push({ k: "From", v: c.from_pattern });
  if (c.to_pattern) parts.push({ k: "To", v: c.to_pattern });
  if (c.subject_pattern) parts.push({ k: "Subject", v: c.subject_pattern });
  if (c.body_pattern) parts.push({ k: "Body", v: c.body_pattern });
  if (c.category_filter_type && c.category_filters.length)
    parts.push({
      k: c.category_filter_type === "INCLUDE" ? "Category in" : "Category not in",
      v: c.category_filters.join(", "),
    });
  if (parts.length === 0) return null;
  const op = c.conditional_operator === "OR" ? "ANY" : "ALL";
  return (
    <div className="text-[11px] text-muted-foreground space-y-0.5">
      {parts.length > 1 && (
        <div className="text-[9px] uppercase tracking-wide text-muted-foreground/70">
          Match {op}:
        </div>
      )}
      {parts.map((p, i) => (
        <div key={i}>
          <span className="text-foreground/80">{p.k}:</span> {p.v}
        </div>
      ))}
    </div>
  );
}

/**
 * A green (matched) / red (no match) rule pill that reveals the rule's
 * conditions, the actions taken, and the AI's reasoning on hover/tap.
 */
function RuleResultPill({
  matched,
  ruleName,
  reason,
  conditions,
  actionSpecs,
  takenTypes,
}: {
  matched: boolean;
  ruleName: string | null;
  reason?: string | null;
  conditions?: RuleConditions | null;
  actionSpecs?: RuleAction[];
  takenTypes?: string[];
}) {
  const pill = (
    <span
      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap ${
        matched
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-red-500/15 text-red-400"
      }`}
    >
      {matched ? ruleName || "Matched" : "No match found"}
      <Eye size={11} className="opacity-70" />
    </span>
  );
  const specs = actionSpecs ?? [];
  const types = takenTypes ?? [];
  return (
    <HoverPopover trigger={pill}>
      <div className="space-y-2">
        <div className="text-xs font-medium text-foreground">
          {matched ? ruleName || "Matched rule" : "No rule matched"}
        </div>
        {conditions && <PrettyConditions c={conditions} />}
        {(specs.length > 0 || types.length > 0) && (
          <div>
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Actions
            </div>
            <div className="flex flex-wrap gap-1">
              {specs.length > 0
                ? specs.map((a, i) => (
                    <span
                      key={i}
                      title={actionDescription(a.type)}
                      className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground"
                    >
                      {actionText(a)}
                    </span>
                  ))
                : types.map((t, i) => (
                    <span
                      key={i}
                      title={actionDescription(t)}
                      className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground"
                    >
                      {actionLabel(t)}
                    </span>
                  ))}
            </div>
          </div>
        )}
        {reason && (
          <div className="text-[10px] text-muted-foreground/80 bg-secondary/40 rounded-md px-2 py-1.5 italic">
            <span className="not-italic text-muted-foreground/60">
              Reason for choosing this rule:{" "}
            </span>
            {reason}
          </div>
        )}
      </div>
    </HoverPopover>
  );
}

type Expected = "none" | "new" | { id: string; name: string };

function buildFixPrompt(
  expected: Expected,
  explanation: string,
  email: { subject: string; from: string },
): string {
  const ctx = `For the email "${email.subject || "(no subject)"}" from ${
    email.from || "unknown sender"
  }, `;
  const why = explanation.trim() ? ` because ${explanation.trim()}` : ".";
  if (expected === "new")
    return `${ctx}create a new rule for emails like this${why}`;
  if (expected === "none")
    return `${ctx}this email shouldn't have matched any rule${why}`;
  return `${ctx}this email should have matched the "${expected.name}" rule${why}`;
}

/** The inbox-zero "Improve Rules" dialog — hands a correction to the AI chat. */
function FixDialog({
  accountId,
  email,
  current,
  onClose,
}: {
  accountId: string;
  email: { subject: string; from: string };
  current: { matched: boolean; ruleName: string | null };
  onClose: () => void;
}) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [expected, setExpected] = useState<Expected | null>(null);
  const [explanation, setExplanation] = useState("");
  const setPendingChatPrompt = useEmailStore((s) => s.setPendingChatPrompt);

  useEffect(() => {
    listRules(accountId).then(setRules).catch(() => {});
  }, [accountId]);

  const submit = () => {
    if (!expected) return;
    setPendingChatPrompt(buildFixPrompt(expected, explanation, email));
    onClose();
  };

  const expectedLabel =
    expected === "new"
      ? "✨ New rule"
      : expected === "none"
        ? "❌ None"
        : expected
          ? expected.name
          : "";

  return (
    <Modal
      title="Improve Rules"
      onClose={onClose}
      footer={
        expected ? (
          <>
            <button
              onClick={() => setExpected(null)}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors"
            >
              Back
            </button>
            <button
              onClick={submit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              <MessageCircle size={13} /> Send to assistant
            </button>
          </>
        ) : undefined
      }
    >
      <div>
        <div className="text-[11px] text-muted-foreground mb-1">Matched:</div>
        <span
          className={`inline-block text-[10px] px-1.5 py-0.5 rounded-md ${
            current.matched
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-red-500/15 text-red-400"
          }`}
        >
          {current.matched ? current.ruleName || "Matched" : "No match found"}
        </span>
      </div>

      {!expected ? (
        <div>
          <div className="text-xs font-medium text-foreground mb-2">
            Which rule did you expect it to match?
          </div>
          <div className="space-y-1.5">
            <FixOption onClick={() => setExpected("none")}>❌ None</FixOption>
            <FixOption onClick={() => setExpected("new")}>✨ New rule</FixOption>
            {rules.map((r) => (
              <FixOption
                key={r.id}
                onClick={() => setExpected({ id: r.id!, name: r.name })}
              >
                {r.name}
              </FixOption>
            ))}
            {rules.length === 0 && (
              <div className="text-[11px] text-muted-foreground">
                You haven&apos;t created any rules yet.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-foreground">
            Selected rule:{" "}
            <span className="text-primary">{expectedLabel}</span>
          </div>
          <textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            rows={3}
            placeholder="Why should this rule have been applied? (optional)"
            className={`${INPUT_CLS} resize-none`}
          />
          <p className="text-[10px] text-muted-foreground">
            Providing an explanation helps the AI understand your intent better.
          </p>
        </div>
      )}
    </Modal>
  );
}

function FixOption({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left text-xs px-3 py-2 rounded-lg border border-border text-foreground hover:bg-secondary transition-colors"
    >
      {children}
    </button>
  );
}

/** The "Fix" button that opens the Improve Rules dialog for one email. */
function FixButton({
  accountId,
  email,
  current,
}: {
  accountId: string;
  email: { subject: string; from: string };
  current: { matched: boolean; ruleName: string | null };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Tell the assistant this was wrong"
        className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] text-muted-foreground border border-border hover:text-foreground hover:bg-secondary transition-colors"
      >
        <MessageCircle size={12} /> Fix
      </button>
      {open && (
        <FixDialog
          accountId={accountId}
          email={email}
          current={current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ── Test tab ────────────────────────────────────────────────────────────────

/** Inbox emails fetched per "Load more" in the Test tab. */
const TEST_PAGE_SIZE = 25;

function TestTab({ accountId }: { accountId: string | null }) {
  const [applyMode, setApplyMode] = useState(false); // false = Test, true = Apply
  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunMessageResult>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [search, setSearch] = useState("");
  const stopRef = useRef(false);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listEmails({ accountId, folder: "inbox", page: 1, pageSize: TEST_PAGE_SIZE })
      .then((r) => {
        setEmails(r.emails);
        setTotal(r.total);
        setPage(1);
      })
      .catch((e) => setError((e as Error).message || "Failed to load emails"))
      .finally(() => setLoading(false));
  }, [accountId]);
  useEffect(load, [load]);

  // Switching Test↔Apply invalidates prior previews (the action changes).
  useEffect(() => setResults({}), [applyMode]);

  // Load the next page of older inbox mail and append it — running Test/Apply
  // "on all" then covers everything loaded, so loading further back lets the
  // rules reach deeper into inbox history (inbox-zero parity).
  const loadMore = useCallback(async () => {
    if (!accountId) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const r = await listEmails({
        accountId, folder: "inbox", page: next, pageSize: TEST_PAGE_SIZE,
      });
      setEmails((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...r.emails.filter((e) => !seen.has(e.id))];
      });
      setTotal(r.total);
      setPage(next);
    } catch (e) {
      setError((e as Error).message || "Failed to load more emails");
    } finally {
      setLoadingMore(false);
    }
  }, [accountId, page]);

  const runOne = useCallback(
    async (id: string) => {
      if (!accountId) return;
      setRunning((s) => new Set(s).add(id));
      try {
        const res = await runRuleOnMessage({
          accountId,
          messageId: id,
          isTest: !applyMode,
        });
        setResults((r) => ({ ...r, [id]: res }));
      } catch (e) {
        setError((e as Error).message || "Run failed");
      } finally {
        setRunning((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    },
    [accountId, applyMode],
  );

  if (!accountId) return <Empty>Select an account first.</Empty>;

  const visible = emails.filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      e.subject.toLowerCase().includes(q) ||
      (e.from.name || e.from.email).toLowerCase().includes(q)
    );
  });

  const runAll = async () => {
    setBulk(true);
    stopRef.current = false;
    for (const e of visible) {
      if (stopRef.current) break;
      await runOne(e.id);
    }
    setBulk(false);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header: mode-aware description + Test/Apply toggle */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-border flex-shrink-0">
        <p className="text-xs text-muted-foreground">
          {applyMode
            ? "Run your rules on previous emails."
            : "Check how your rules perform against previous emails."}
        </p>
        <LabeledToggle
          label="Test"
          labelRight="Apply"
          enabled={applyMode}
          onChange={setApplyMode}
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-2 border-b border-border flex-shrink-0">
        {bulk ? (
          <button
            onClick={() => {
              stopRef.current = true;
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <Square size={12} /> Stop
          </button>
        ) : (
          <button
            onClick={runAll}
            disabled={visible.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            <Play size={12} /> {applyMode ? "Run on all" : "Test all"}
          </button>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className={`${INPUT_CLS} w-40 py-1`}
        />
      </div>

      {error && (
        <div className="px-5 py-2 text-xs text-destructive bg-destructive/10">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3 space-y-1.5">
        {loading ? (
          <Spinner label="Loading inbox…" />
        ) : visible.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-10">
            No emails found.
          </div>
        ) : (
          visible.map((e) => {
            const res = results[e.id];
            const isRunning = running.has(e.id);
            return (
              <div
                key={e.id}
                className={`flex items-start gap-3 bg-card border border-border rounded-lg px-3 py-2 ${
                  isRunning ? "animate-pulse" : ""
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-foreground truncate">
                    {e.subject || "(no subject)"}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {e.from.name || e.from.email}
                  </div>
                  {e.snippet && (
                    <div className="text-[10px] text-muted-foreground/70 line-clamp-1 mt-0.5">
                      {e.snippet}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {res ? (
                    <>
                      <RuleResultPill
                        matched={res.matched}
                        ruleName={res.rule?.name ?? null}
                        reason={res.reason}
                        actionSpecs={res.actions.filter(
                          (a): a is RuleAction => typeof a !== "string",
                        )}
                        takenTypes={res.actions.filter(
                          (a): a is string => typeof a === "string",
                        )}
                      />
                      <FixButton
                        accountId={accountId}
                        email={{ subject: e.subject, from: e.from.email }}
                        current={{
                          matched: res.matched,
                          ruleName: res.rule?.name ?? null,
                        }}
                      />
                      <button
                        onClick={() => runOne(e.id)}
                        disabled={isRunning}
                        title={applyMode ? "Rerun" : "Retest"}
                        className="p-1.5 rounded-md text-muted-foreground border border-border hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                      >
                        <RefreshCcw size={12} />
                      </button>
                    </>
                  ) : isRunning ? (
                    <Loader2 className="animate-spin text-muted-foreground" size={14} />
                  ) : (
                    <button
                      onClick={() => runOne(e.id)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors"
                    >
                      <Sparkles size={12} /> {applyMode ? "Run" : "Test"}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}

        {!loading && emails.length < total && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            {loadingMore ? (
              <Loader2 className="animate-spin" size={13} />
            ) : (
              <ArrowDown size={13} />
            )}
            Load more ({emails.length} of {total})
          </button>
        )}
      </div>
    </div>
  );
}

// ── History tab ─────────────────────────────────────────────────────────────

function HistoryTab({ accountId }: { accountId: string | null }) {
  const [history, setHistory] = useState<ExecutedRule[]>([]);
  const [loading, setLoading] = useState(true);
  // "all" | "skipped" (No match) | a rule name.
  const [ruleFilter, setRuleFilter] = useState("all");

  const load = useCallback(() => {
    setLoading(true);
    getRulesHistory(accountId ?? undefined, 200)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  if (loading) return <Spinner label="Loading history…" />;

  // History is a LOG of what the assistant did — actions it applied and the
  // emails where nothing matched (inbox-zero has no approval queue).
  const log = history.filter(
    (h) => h.status === "APPLIED" || h.status === "SKIPPED"
  );
  const ruleNames = Array.from(
    new Set(log.map((h) => h.rule_name).filter((n): n is string => !!n))
  ).sort();
  const filtered = log.filter((h) =>
    ruleFilter === "all"
      ? true
      : ruleFilter === "skipped"
        ? h.status === "SKIPPED"
        : h.rule_name === ruleFilter
  );
  const groups = groupHistoryByDate(filtered);

  return (
    <div className="h-full overflow-y-auto px-3 sm:px-5 py-3">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <select
          value={ruleFilter}
          onChange={(e) => setRuleFilter(e.target.value)}
          className={`${INPUT_CLS} w-auto py-1`}
        >
          <option value="all">All rules</option>
          <option value="skipped">No match</option>
          {ruleNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          onClick={load}
          className="ml-auto text-xs text-primary hover:opacity-80"
        >
          Refresh
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-10">
          {log.length === 0
            ? "No emails have been processed yet."
            : "No entries match this filter."}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 px-0.5">
                {g.label}
              </div>
              <div className="space-y-1.5">
                {g.items.map((h) => (
                  <HistoryRow key={h.id} h={h} accountId={accountId} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupHistoryByDate(items: ExecutedRule[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  const groups: { key: string; label: string; items: ExecutedRule[] }[] = [];
  const byKey: Record<string, (typeof groups)[number]> = {};
  for (const h of items) {
    const d = h.created_at ? new Date(h.created_at) : null;
    let key = "unknown";
    let label = "Earlier";
    if (d && !isNaN(d.getTime())) {
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      key = day.toISOString().slice(0, 10);
      if (day.getTime() === today.getTime()) label = "Today";
      else if (day.getTime() === yest.getTime()) label = "Yesterday";
      else
        label = day.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
    }
    if (!byKey[key]) {
      byKey[key] = { key, label, items: [] };
      groups.push(byKey[key]);
    }
    byKey[key].items.push(h);
  }
  return groups;
}

function HistoryRow({
  h,
  accountId,
}: {
  h: ExecutedRule;
  accountId: string | null;
}) {
  const matched = h.status !== "SKIPPED";
  return (
    <div className="flex items-start gap-3 bg-card border border-border rounded-lg px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground truncate">
          {h.subject || "(no subject)"}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">{h.from}</div>
        {h.snippet && (
          <div className="text-[10px] text-muted-foreground/70 line-clamp-1 mt-0.5">
            {h.snippet}
          </div>
        )}
        {!h.automated && (
          <span className="inline-block mt-1 text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
            Applied manually
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <RuleResultPill
          matched={matched}
          ruleName={h.rule_name}
          reason={h.reason}
          conditions={h.conditions ?? undefined}
          actionSpecs={h.rule_actions}
          takenTypes={h.actions}
        />
        {accountId && (
          <FixButton
            accountId={accountId}
            email={{ subject: h.subject || "", from: h.from || "" }}
            current={{ matched, ruleName: h.rule_name }}
          />
        )}
      </div>
    </div>
  );
}

// ── Settings tab ────────────────────────────────────────────────────────────

const CONFIGURE_BTN =
  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border " +
  "text-xs text-muted-foreground hover:text-foreground hover:bg-secondary " +
  "transition-colors";

function SettingsTab({ accountId }: { accountId: string | null }) {
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llm, setLlm] = useState<LLMConfigResponse | null>(null);
  const [ruleNames, setRuleNames] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"followup" | "digest" | null>(null);

  useEffect(() => {
    fetch("/api/settings/llm")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setLlm(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getAssistantSettings(accountId)
      .then((s) => !cancelled && setSettings(s))
      .catch((e) => !cancelled && setError(e.message || "Failed to load settings"))
      .finally(() => !cancelled && setLoading(false));
    listRules(accountId)
      .then((rs) => !cancelled && setRuleNames(rs.map((r) => r.name)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Persist the whole settings object. Toggles/selects persist immediately;
  // the free-text cards rely on the bottom "Save settings" button.
  const persist = async (next: AssistantSettings) => {
    setSettings(next);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveAssistantSettings(next);
      setSettings(res);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  if (!accountId) return <Empty>Select an account first.</Empty>;
  if (loading || !settings) return <Spinner label="Loading settings…" />;

  const s = settings; // narrowed
  const patch = (p: Partial<AssistantSettings>) => setSettings({ ...s, ...p });
  const persistPatch = (p: Partial<AssistantSettings>) => persist({ ...s, ...p });
  const followUpOn = s.follow_up_awaiting_days > 0 || s.follow_up_needs_reply_days > 0;
  const digestOn = s.digest_frequency !== "OFF";

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-5 py-4">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* ── Drafting ── */}
        <div className="space-y-2">
          <SettingCard
            title="Auto draft replies"
            description="Automatically draft replies written in your tone to emails needing a reply."
            right={
              <Toggle
                enabled={s.draft_replies}
                onChange={(v) => persistPatch({ draft_replies: v })}
              />
            }
          />
          <SettingCard
            title="Draft confidence"
            description="How sure should the AI be before drafting a reply?"
            right={
              <select
                value={s.draft_confidence}
                onChange={(e) =>
                  persistPatch({
                    draft_confidence: e.target.value as DraftConfidence,
                  })
                }
                className={`${INPUT_CLS} w-44 py-1`}
              >
                {DRAFT_CONFIDENCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            }
          />
        </div>

        {/* ── Updates ── */}
        <div className="space-y-2">
          <SectionHeader>Updates</SectionHeader>
          <SettingCard
            title="Follow-up reminders"
            description="Label emails where you haven't heard back or haven't replied."
            right={
              <div className="flex items-center gap-2">
                {followUpOn && (
                  <button onClick={() => setDialog("followup")} className={CONFIGURE_BTN}>
                    <Settings size={12} /> Configure
                  </button>
                )}
                <Toggle
                  enabled={followUpOn}
                  onChange={(v) =>
                    persistPatch(
                      v
                        ? { follow_up_awaiting_days: 3, follow_up_needs_reply_days: 3 }
                        : { follow_up_awaiting_days: 0, follow_up_needs_reply_days: 0 }
                    )
                  }
                />
              </div>
            }
          />
          <SettingCard
            title="Digest"
            description="Get a daily summary of your emails."
            right={
              <div className="flex items-center gap-2">
                {digestOn && (
                  <button onClick={() => setDialog("digest")} className={CONFIGURE_BTN}>
                    <Settings size={12} /> Configure
                  </button>
                )}
                <Toggle
                  enabled={digestOn}
                  onChange={(v) =>
                    persistPatch({ digest_frequency: v ? "DAILY" : "OFF" })
                  }
                />
              </div>
            }
          />
        </div>

        {/* ── Your voice ── */}
        <div className="space-y-2">
          <SectionHeader>Your voice</SectionHeader>
          <SettingCard
            title="Writing style"
            description="Define your tone and style — used to draft replies in your voice."
          >
            <textarea
              value={s.writing_style}
              onChange={(e) => patch({ writing_style: e.target.value })}
              rows={3}
              placeholder="e.g. Concise and friendly. 2–3 short sentences. No corporate jargon. Sign off with just my first name."
              className={`${INPUT_CLS} resize-none`}
            />
            <div className="mt-2">
              <WritingStyleGenerator
                accountId={accountId}
                onGenerated={(ws) => patch({ writing_style: ws })}
              />
            </div>
          </SettingCard>
          <SettingCard
            title="Personal instructions"
            description="Tell the AI about yourself and how you'd like it to handle your emails."
          >
            <textarea
              value={s.about}
              onChange={(e) => patch({ about: e.target.value })}
              rows={3}
              placeholder="e.g. I'm the founder of Acme. If I'm CC'd, it's not To Reply. Emails from jane@accounting.com aren't Notifications."
              className={`${INPUT_CLS} resize-none`}
            />
            <textarea
              value={s.personal_instructions}
              onChange={(e) => patch({ personal_instructions: e.target.value })}
              rows={3}
              placeholder="Global rules the assistant always follows — e.g. Never commit to dates without checking with me. Don't discuss pricing over email."
              className={`${INPUT_CLS} resize-none mt-2`}
            />
          </SettingCard>
          <SettingCard
            title="Email signature"
            description="Set your email signature to include in drafted messages."
          >
            <textarea
              value={s.signature}
              onChange={(e) => patch({ signature: e.target.value })}
              rows={2}
              placeholder={"Best,\nAlex"}
              className={`${INPUT_CLS} resize-none`}
            />
          </SettingCard>
        </div>

        {/* ── Knowledge ── */}
        <div className="space-y-2">
          <SectionHeader>Knowledge</SectionHeader>
          <KnowledgeBase accountId={accountId} />
          <LearnedPreferences accountId={accountId} />
        </div>

        {/* ── Advanced ── */}
        <div className="space-y-2">
          <SectionHeader>Advanced</SectionHeader>
          <SettingCard
            title="Run rules automatically on new mail"
            description="Processes incoming inbox mail with your enabled rules as it arrives."
            right={
              <Toggle
                enabled={s.auto_run}
                onChange={(v) => persistPatch({ auto_run: v })}
              />
            }
          />
          <SettingCard
            title="Cold-email blocker"
            description="Handle first-time, unsolicited senders."
            right={
              <select
                value={s.cold_email_blocker}
                onChange={(e) =>
                  persistPatch({
                    cold_email_blocker: e.target.value as ColdBlockerMode,
                  })
                }
                className={`${INPUT_CLS} w-44 py-1`}
              >
                <option value="OFF">Off</option>
                <option value="LABEL">Label as “Cold Email”</option>
                <option value="ARCHIVE">Label and archive</option>
              </select>
            }
          />
          <ColdSendersList accountId={accountId} />
          <SettingCard
            title="Assistant model"
            description="The model tier the assistant agent and chat use."
            right={
              <select
                value={s.agent_model}
                onChange={(e) => persistPatch({ agent_model: e.target.value })}
                className={`${INPUT_CLS} w-56 py-1`}
              >
                {llm ? (
                  <>
                    <optgroup label="LiteLLM tiers">
                      {llm.tiers.map((t) => (
                        <option key={t.tier_name} value={t.tier_name}>
                          {t.tier_name}
                          {t.tier_name === "tier-balanced" ? " (default)" : ""}
                        </option>
                      ))}
                    </optgroup>
                    {llm.providers
                      .filter((p) => p.configured && p.models.length > 0)
                      .map((p) => (
                        <optgroup key={p.id} label={p.label || p.id}>
                          {p.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    {!llm.tiers.some((t) => t.tier_name === s.agent_model) &&
                      !llm.providers.some((p) =>
                        p.models.includes(s.agent_model)
                      ) && (
                        <option value={s.agent_model}>{s.agent_model}</option>
                      )}
                  </>
                ) : (
                  <option value={s.agent_model || "tier-balanced"}>
                    {s.agent_model || "tier-balanced"} (default)
                  </option>
                )}
              </select>
            }
          />
        </div>

        {/* Save bar for the free-text cards */}
        <div className="flex items-center gap-2 pb-2">
          <button
            onClick={() => persist(s)}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
            Save settings
          </button>
          {saved && <span className="text-[11px] text-emerald-400">Saved ✓</span>}
          {error && <span className="text-[11px] text-destructive">{error}</span>}
        </div>
      </div>

      {dialog === "followup" && (
        <FollowUpDialog
          settings={s}
          onSave={(next) => {
            persist(next);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "digest" && (
        <DigestDialog
          settings={s}
          ruleNames={ruleNames}
          onSave={(next) => {
            persist(next);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// ── Settings: Configure dialogs ──────────────────────────────────────────────

function FollowUpDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: AssistantSettings;
  onSave: (next: AssistantSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const num = (v: string) => Math.max(0, parseInt(v || "0", 10) || 0);
  return (
    <Modal
      title="Follow-up reminders"
      description="Get reminded about conversations that need attention. Saturdays and Sundays don't count."
      onClose={onClose}
      footer={
        <button
          onClick={() => onSave(draft)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Check size={13} /> Save
        </button>
      }
    >
      <Field label="Remind me when they haven't replied after (days)">
        <input
          type="number"
          min={0}
          max={90}
          value={draft.follow_up_awaiting_days}
          onChange={(e) =>
            setDraft({ ...draft, follow_up_awaiting_days: num(e.target.value) })
          }
          className={INPUT_CLS}
        />
      </Field>
      <Field label="Remind me when I haven't replied after (days)">
        <input
          type="number"
          min={0}
          max={90}
          value={draft.follow_up_needs_reply_days}
          onChange={(e) =>
            setDraft({ ...draft, follow_up_needs_reply_days: num(e.target.value) })
          }
          className={INPUT_CLS}
        />
      </Field>
      <label className="flex items-start gap-2 cursor-pointer pt-1">
        <input
          type="checkbox"
          checked={draft.follow_up_auto_draft}
          onChange={(e) =>
            setDraft({ ...draft, follow_up_auto_draft: e.target.checked })
          }
          className="accent-primary mt-0.5"
        />
        <span>
          <span className="text-xs text-foreground">Auto-generate drafts</span>
          <span className="block text-[11px] text-muted-foreground">
            Draft a nudge when you haven&apos;t heard back.
          </span>
        </span>
      </label>
    </Modal>
  );
}

function DigestDialog({
  settings,
  ruleNames,
  onSave,
  onClose,
}: {
  settings: AssistantSettings;
  ruleNames: string[];
  onSave: (next: AssistantSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const options = [...ruleNames, "Cold Emails"];
  const allSelected = draft.digest_categories.length === 0; // empty = everything
  const toggleCat = (name: string) => {
    const has = draft.digest_categories.includes(name);
    setDraft({
      ...draft,
      digest_categories: has
        ? draft.digest_categories.filter((c) => c !== name)
        : [...draft.digest_categories, name],
    });
  };
  const weekly = draft.digest_frequency === "WEEKLY";
  return (
    <Modal
      title="Digest settings"
      description="Configure when your digest is sent and which rules it includes."
      onClose={onClose}
      footer={
        <button
          onClick={() => onSave(draft)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Check size={13} /> Save
        </button>
      }
    >
      <div>
        <span className="text-xs text-muted-foreground mb-1.5 block">
          What to include in the digest{" "}
          {allSelected && <span className="text-muted-foreground/70">(all rules)</span>}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {options.map((name) => {
            const on = draft.digest_categories.includes(name);
            return (
              <button
                key={name}
                onClick={() => toggleCat(name)}
                className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                  on
                    ? "bg-primary/15 text-primary border-primary/40"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Send the digest">
        <select
          value={draft.digest_frequency}
          onChange={(e) =>
            setDraft({
              ...draft,
              digest_frequency: e.target.value as AssistantSettings["digest_frequency"],
            })
          }
          className={INPUT_CLS}
        >
          <option value="DAILY">Every day</option>
          <option value="WEEKLY">Every week</option>
        </select>
      </Field>
      {weekly && (
        <Field label="On">
          <select
            value={draft.digest_day_of_week}
            onChange={(e) =>
              setDraft({ ...draft, digest_day_of_week: parseInt(e.target.value, 10) })
            }
            className={INPUT_CLS}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="At">
        <input
          type="time"
          value={draft.digest_time_of_day}
          onChange={(e) =>
            setDraft({ ...draft, digest_time_of_day: e.target.value || "09:00" })
          }
          className={INPUT_CLS}
        />
      </Field>
      <label className="flex items-start gap-2 cursor-pointer pt-1">
        <input
          type="checkbox"
          checked={draft.digest_send_to_email}
          onChange={(e) =>
            setDraft({ ...draft, digest_send_to_email: e.target.checked })
          }
          className="accent-primary mt-0.5"
        />
        <span className="text-xs text-foreground">Send digest to my email</span>
      </label>
    </Modal>
  );
}

function WritingStyleGenerator({
  accountId,
  onGenerated,
}: {
  accountId: string;
  onGenerated: (style: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await generateWritingStyle(accountId);
      onGenerated(res.writing_style);
    } catch (e) {
      setErr((e as Error).message || "Could not analyze your sent mail.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 -mt-2">
      <button
        onClick={generate}
        disabled={busy}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="animate-spin" size={12} />
        ) : (
          <Wand2 size={12} />
        )}
        Generate from my sent mail
      </button>
      <span className="text-[10px] text-muted-foreground">
        Analyzes recent sent emails — review before saving.
      </span>
      {err && <span className="text-[10px] text-destructive">{err}</span>}
    </div>
  );
}

function KnowledgeBase({ accountId }: { accountId: string | null }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listKnowledge(accountId)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  const save = async () => {
    if (!editing || !accountId || !editing.title.trim()) return;
    setBusy(true);
    try {
      if (editing.id) await updateKnowledge(editing.id, editing);
      else await createKnowledge({ ...editing, account_id: accountId });
      setEditing(null);
      load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: KnowledgeEntry) => {
    if (!entry.id || !confirm(`Delete “${entry.title}”?`)) return;
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    try {
      await deleteKnowledge(entry.id);
    } catch {
      load();
    }
  };

  if (!accountId) return null;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <BookOpen size={14} className="text-primary" /> Knowledge base
        </h3>
        {!editing && (
          <button
            onClick={() => setEditing({ account_id: accountId, title: "", content: "" })}
            className="flex items-center gap-1 text-xs text-primary hover:opacity-80"
          >
            <Plus size={12} /> Add entry
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        Reference snippets (pricing, FAQs, policies, boilerplate) the assistant
        draws on when drafting replies.
      </p>

      {editing ? (
        <div className="space-y-2 border border-border rounded-lg p-2.5 bg-secondary/30">
          <input
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            placeholder="Title — e.g. Pricing & plans"
            className={INPUT_CLS}
          />
          <textarea
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            rows={4}
            placeholder="The facts the assistant should use when this topic comes up…"
            className={`${INPUT_CLS} resize-none`}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={busy || !editing.title.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
              Save
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">No entries yet.</div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-2 border border-border rounded-lg px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">
                  {entry.title}
                </div>
                <div className="text-[11px] text-muted-foreground line-clamp-2">
                  {entry.content}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <IconAction title="Edit" onClick={() => setEditing(entry)}>
                  <Pencil size={12} />
                </IconAction>
                <IconAction
                  title="Delete"
                  onClick={() => remove(entry)}
                  className="hover:text-destructive"
                >
                  <Trash2 size={12} />
                </IconAction>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LearnedPreferences({ accountId }: { accountId: string | null }) {
  const [patterns, setPatterns] = useState<LearnedPattern[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listLearnedPatterns(accountId)
      .then(setPatterns)
      .catch(() => setPatterns([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  const forget = async (id: string) => {
    setPatterns((prev) => prev.filter((p) => p.id !== id));
    try {
      await deleteLearnedPattern(id);
    } catch {
      load();
    }
  };

  if (!accountId || loading || patterns.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-1">
        <Sparkles size={14} className="text-primary" />
        <h3 className="text-sm font-medium text-foreground">Learned preferences</h3>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        Picked up from how you edit the assistant's drafts before sending. These
        nudge future drafts — remove any you don't want.
      </p>
      <div className="space-y-1.5">
        {patterns.map((p) => (
          <div key={p.id} className="flex items-start gap-2">
            <div className="flex-1 min-w-0 text-xs text-foreground/80">
              {p.pattern}
              {p.weight > 1 && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ×{p.weight}
                </span>
              )}
            </div>
            <button
              onClick={() => forget(p.id)}
              title="Forget this"
              className="text-muted-foreground hover:text-destructive flex-shrink-0"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ColdSendersList({ accountId }: { accountId: string | null }) {
  const [cold, setCold] = useState<ColdSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listColdSenders(accountId)
      .then(setCold)
      .catch(() => setCold([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  const whitelist = async (email: string) => {
    if (!accountId) return;
    setBusy(email);
    try {
      await upsertColdSender({
        accountId,
        fromEmail: email,
        status: "USER_REJECTED_COLD",
      });
      setCold((prev) =>
        prev.map((c) =>
          c.from_email === email ? { ...c, status: "USER_REJECTED_COLD" } : c
        )
      );
    } catch {
      load();
    } finally {
      setBusy(null);
    }
  };

  if (loading || cold.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">Cold senders</h3>
      <div className="space-y-1.5">
        {cold.map((c) => (
          <div key={c.from_email} className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-foreground truncate">{c.from_email}</div>
              {c.reason && (
                <div className="text-[10px] text-muted-foreground truncate">
                  {c.reason}
                </div>
              )}
            </div>
            {c.status === "USER_REJECTED_COLD" ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 flex-shrink-0">
                Not cold
              </span>
            ) : busy === c.from_email ? (
              <Loader2 className="animate-spin text-muted-foreground" size={13} />
            ) : (
              <button
                onClick={() => whitelist(c.from_email)}
                className="text-[10px] px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors flex-shrink-0"
              >
                Not cold
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function IconAction({
  children,
  onClick,
  title,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-md text-muted-foreground hover:bg-secondary transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground gap-2 text-sm">
      <Loader2 className="animate-spin" size={16} /> {label}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      {children}
    </div>
  );
}
