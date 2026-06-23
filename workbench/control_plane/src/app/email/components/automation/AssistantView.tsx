"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2, Plus, Trash2, Pencil, Play, Check, X, FlaskConical,
  History as HistoryIcon, Settings2, Settings, Sparkles, Wand2, BookOpen,
  ArrowUp, ArrowDown, Eye, MessageCircle, RefreshCcw, Square,
  MoreVertical, MoreHorizontal, Copy, Paperclip, Upload, FolderOpen,
  Inbox, Zap, ChevronRight, ChevronDown, Tag, FolderPlus,
} from "lucide-react";
import {
  listRules, createRule, updateRule, deleteRule,
  getRulesHistory, getAssistantSettings, saveAssistantSettings,
  listColdSenders, upsertColdSender, generateWritingStyle, listEmails,
  listKnowledge, createKnowledge, updateKnowledge, deleteKnowledge,
  installPresetRules, reorderRules, processPastEmails,
  listLearnedPatterns, deleteLearnedPattern,
  submitRuleFeedback, listRulePatterns, deleteRulePattern,
  generateRules, uploadEmailArtifacts, listEmailArtifacts,
  createEmailFolder,
} from "../../lib/api";
import type { EmailArtifact } from "../../lib/api";
import {
  AutomationRule, RuleAction, RuleActionType, RuleActionAttachment, ExecutedRule, Email,
  AssistantSettings, ColdBlockerMode,
  ColdSender, LLMConfigResponse, KnowledgeEntry, LearnedPattern,
  LearnedRulePattern,
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
  LABEL: { label: "Categorize", description: "Apply a label / category to the email." },
  MARK_READ: { label: "Mark as read", description: "Mark the email as read." },
  STAR: { label: "Star", description: "Star / flag the email." },
  MARK_SPAM: { label: "Mark as spam", description: "Move the email to the spam folder." },
  TRASH: { label: "Move to trash", description: "Send the email to trash." },
  MOVE_FOLDER: { label: "Move to folder", description: "Move the email to a specific folder." },
  REPLY: { label: "Reply", description: "Create a reply draft for your review — never auto-sent." },
  FORWARD: { label: "Forward", description: "Create a forward draft to someone — never auto-sent." },
  DRAFT_EMAIL: { label: "Draft reply", description: "Let the AI write a reply draft for your review — never auto-sent." },
  CALL_WEBHOOK: { label: "Call webhook", description: "POST the email to a URL you specify." },
};

/**
 * Per-action badge colors (bg / text / border) so actions read at a glance in
 * the Rules list, History popovers and Test results — mirrors inbox-zero's
 * colored action chips. Uses Tailwind palette tints that work on light & dark.
 */
const ACTION_COLOR: Record<RuleActionType, string> = {
  ARCHIVE: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20",
  LABEL: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  MARK_READ: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20",
  STAR: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  MARK_SPAM: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
  TRASH: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  MOVE_FOLDER: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20",
  REPLY: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  FORWARD: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
  DRAFT_EMAIL: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
  CALL_WEBHOOK: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
};

function actionColor(type: string): string {
  return (
    ACTION_COLOR[type as RuleActionType] ??
    "bg-secondary text-muted-foreground border-border"
  );
}

// Base field styling WITHOUT a width — compose with `w-full` (INPUT_CLS) or a
// fixed width (the action/condition type selects). Keeping `w-full` out of the
// base avoids the Tailwind `w-full`+`w-40` conflict that made the selects span
// the whole row and shove the config card into horizontal overflow.
const INPUT_BASE =
  "bg-secondary border border-border rounded-lg px-2.5 py-2 text-xs " +
  "text-foreground outline-none focus:border-primary transition-colors";
const INPUT_CLS = `w-full ${INPUT_BASE}`;

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
    sort_order: 0,
    actions: [{ type: "LABEL", label: "To Reply" }, { type: "DRAFT_EMAIL" }],
  },
  {
    name: "Awaiting Reply",
    instructions:
      "Threads where I've already replied and am now waiting to hear back " +
      "from the other person.",
    enabled: true,
    automated: true,
    run_on_threads: true,
    conditional_operator: "AND",
    sort_order: 1,
    actions: [{ type: "LABEL", label: "Awaiting Reply" }],
  },
  {
    name: "Actioned",
    instructions:
      "Emails I've already handled or replied to that need no further action " +
      "from me.",
    enabled: true,
    automated: true,
    run_on_threads: true,
    conditional_operator: "AND",
    sort_order: 2,
    actions: [{ type: "LABEL", label: "Actioned" }],
  },
  {
    name: "FYI",
    instructions:
      "Important emails I should know about, but don't need to reply to.",
    enabled: true,
    automated: true,
    run_on_threads: true,
    conditional_operator: "AND",
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
    sort_order: 7,
    actions: [{ type: "LABEL", label: "Cold Email" }, { type: "ARCHIVE" }],
  },
];


export function AssistantView({ accountId }: AssistantViewProps) {
  const [tab, setTab] = useState<Tab>("rules");
  // When the user picks "See history" from a rule's ⋯ menu, jump to the History
  // tab pre-filtered to that rule.
  const [historyRuleFilter, setHistoryRuleFilter] = useState("all");
  const seeHistory = (ruleName: string) => {
    setHistoryRuleFilter(ruleName);
    setTab("history");
  };

  return (
    <div className="h-full flex flex-col">
      {/* Sub-tabs — centered to match the content column on wide screens. */}
      <div className="border-b border-border flex-shrink-0">
        <div className="max-w-3xl mx-auto w-full flex items-center gap-1 px-3 sm:px-5 py-2 overflow-x-auto scrollbar-hide">
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
      </div>

      {/* Content is centered in a readable column (inbox-zero parity) so the
          tabs don't stretch edge-to-edge on widescreen monitors. */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full max-w-3xl mx-auto w-full">
          {tab === "rules" && <RulesTab accountId={accountId} onSeeHistory={seeHistory} />}
          {tab === "test" && <TestTab accountId={accountId} />}
          {tab === "history" && (
            <HistoryTab accountId={accountId} initialRuleFilter={historyRuleFilter} />
          )}
          {tab === "settings" && <SettingsTab accountId={accountId} />}
        </div>
      </div>
    </div>
  );
}

// ── Rules tab ───────────────────────────────────────────────────────────────

function RuleMenuItem({
  icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-secondary transition-colors ${
        destructive ? "text-destructive" : "text-foreground"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  );
}

const emptyRule = (accountId: string): AutomationRule => ({
  account_id: accountId,
  name: "",
  instructions: "",
  enabled: true,
  automated: true,
  run_on_threads: false,
  conditional_operator: "AND",
  from_pattern: "",
  subject_pattern: "",
  sort_order: 0,
  actions: [{ type: "ARCHIVE" }],
});

function RulesTab({
  accountId,
  onSeeHistory,
}: {
  accountId: string | null;
  onSeeHistory?: (ruleName: string) => void;
}) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const setPendingChatPrompt = useEmailStore((s) => s.setPendingChatPrompt);

  const duplicate = async (rule: AutomationRule) => {
    if (!accountId) return;
    setMenuFor(null);
    const { id: _id, ...rest } = rule;
    void _id;
    try {
      await createRule({
        ...rest,
        account_id: accountId,
        name: `${rule.name} (copy)`,
      });
      load();
    } catch (e) {
      setError((e as Error).message || "Failed to duplicate rule");
    }
  };

  const editWithAI = (rule: AutomationRule) => {
    setMenuFor(null);
    setPendingChatPrompt(
      `Help me improve my "${rule.name}" email rule. ` +
        `Its current instructions are: "${rule.instructions || "(none)"}". ` +
        `I want to `,
    );
  };

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

  if (!accountId) return <Empty>Select an account first.</Empty>;
  if (loading) return <Spinner label="Loading rules…" />;

  return (
    <div className="h-full flex flex-col relative">
      {editing && (
        <RuleEditor
          rule={editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
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
          {rules.length > 0 && (
            <button
              onClick={() => setShowPast(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <HistoryIcon size={13} /> Past emails
            </button>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus size={13} /> Add rule
          </button>
        </div>
      </div>
      {showAdd && accountId && (
        <AddRuleDialog
          accountId={accountId}
          onManual={() => {
            setShowAdd(false);
            setEditing(emptyRule(accountId));
          }}
          onCreated={() => {
            setShowAdd(false);
            load();
          }}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showPast && accountId && (
        <ProcessPastEmailsDialog
          accountId={accountId}
          onClose={() => setShowPast(false)}
        />
      )}

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
                    className={`text-[10px] px-1.5 py-0.5 rounded-md border ${actionColor(a.type)}`}
                  >
                    {actionText(a)}
                  </span>
                ))}
              </div>
            </div>
            <div className="relative flex items-center gap-1 flex-shrink-0">
              <IconAction
                title="More"
                onClick={() => setMenuFor(menuFor === rule.id ? null : rule.id ?? null)}
              >
                <MoreVertical size={14} />
              </IconAction>
              {menuFor === rule.id && (
                <>
                  {/* Click-away backdrop */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuFor(null)}
                  />
                  <div className="absolute right-0 top-7 z-50 w-44 rounded-lg border border-border bg-card shadow-lg py-1 text-xs">
                    <RuleMenuItem
                      icon={<Pencil size={13} />}
                      label="Edit"
                      onClick={() => {
                        setMenuFor(null);
                        setEditing(rule);
                      }}
                    />
                    <RuleMenuItem
                      icon={<Wand2 size={13} />}
                      label="Edit with AI"
                      onClick={() => editWithAI(rule)}
                    />
                    <RuleMenuItem
                      icon={<Copy size={13} />}
                      label="Duplicate"
                      onClick={() => duplicate(rule)}
                    />
                    <RuleMenuItem
                      icon={<HistoryIcon size={13} />}
                      label="See history"
                      onClick={() => {
                        setMenuFor(null);
                        onSeeHistory?.(rule.name);
                      }}
                    />
                    <div className="my-1 h-px bg-border" />
                    <RuleMenuItem
                      icon={<Trash2 size={13} />}
                      label="Delete"
                      destructive
                      onClick={() => {
                        setMenuFor(null);
                        remove(rule);
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
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

  // Real provider labels so the "Categorize" action offers a pick-list (with
  // free-type for new labels), mirroring inbox-zero's LabelCombobox.
  const availableLabels = useEmailStore((s) => s.availableLabels);

  // Conditions visible in the builder: any pre-filled field, plus ones the user
  // explicitly adds. A new rule starts with the AI Prompt row.
  const prefilled = COND_ORDER.filter(
    (t) => ((draft[COND_META[t].field] ?? "") as string).trim() !== ""
  );
  const [shown, setShown] = useState<CondType[]>(
    prefilled.length ? prefilled : ["prompt"]
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const removeCondition = (index: number) => {
    const t = shown[index];
    setShown((s) => s.filter((_, i) => i !== index));
    setField(t, "");
  };
  // Re-type a condition row: carry its value over to the new field type so the
  // user doesn't lose what they typed when switching From → Subject etc.
  const changeCondType = (index: number, next: CondType) => {
    const old = shown[index];
    if (old === next) return;
    const val = (draft[COND_META[old].field] ?? "") as string;
    setField(old, "");
    setField(next, val);
    setShown((s) => s.map((x, i) => (i === index ? next : x)));
  };
  const addCondition = () => {
    const next = COND_ORDER.find((t) => !shown.includes(t));
    if (next) setShown((s) => [...s, next]);
  };

  const valid = draft.name.trim().length > 0 && draft.actions.length > 0;

  return (
    <Modal
      title={rule.id ? "Edit Rule" : "Create Rule"}
      onClose={onCancel}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={!valid}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Check size={13} /> {rule.id ? "Save" : "Create"}
          </button>
        </>
      }
    >
      {/* Rule name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Rule name</label>
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Label receipts"
          className={INPUT_CLS}
        />
      </div>

      {/* When — conditions */}
      <div className="bg-card border border-border rounded-xl p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Inbox size={16} className="text-blue-500" />
            When I get an email
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

        <p className="text-xs text-muted-foreground">That matches:</p>

        {shown.map((t, i) => {
          const meta = COND_META[t];
          const value = (draft[meta.field] ?? "") as string;
          const opts = COND_ORDER.filter((o) => o === t || !shown.includes(o));
          return (
            <div key={t} className="flex items-start gap-2">
              <select
                value={t}
                onChange={(e) => changeCondType(i, e.target.value as CondType)}
                className={`${INPUT_BASE} w-28 flex-shrink-0`}
              >
                {opts.map((o) => (
                  <option key={o} value={o}>
                    {COND_META[o].label}
                  </option>
                ))}
              </select>
              {meta.textarea ? (
                <textarea
                  value={value}
                  onChange={(e) => setField(t, e.target.value)}
                  rows={2}
                  placeholder={meta.placeholder}
                  className={`${INPUT_CLS} resize-none flex-1 min-w-0`}
                />
              ) : (
                <input
                  value={value}
                  onChange={(e) => setField(t, e.target.value)}
                  placeholder={meta.placeholder}
                  className={`${INPUT_CLS} flex-1 min-w-0`}
                />
              )}
              {shown.length > 1 && (
                <button
                  onClick={() => removeCondition(i)}
                  title="Remove condition"
                  className="p-1.5 text-muted-foreground hover:text-destructive flex-shrink-0 mt-0.5"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}

        {shown.length < COND_ORDER.length && (
          <button
            onClick={addCondition}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            <Plus size={13} /> Add Condition
          </button>
        )}
      </div>

      {/* Then — actions */}
      <div className="bg-card border border-border rounded-xl p-3.5 space-y-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Zap size={16} className="text-emerald-500" />
          Then
        </span>
        <div className="space-y-2.5">
          {draft.actions.map((a, i) => (
            <div key={i} className="flex items-start gap-2">
              <select
                value={a.type}
                onChange={(e) =>
                  setAction(i, { type: e.target.value as RuleActionType })
                }
                title={ACTION_META[a.type].description}
                className={`${INPUT_BASE} w-40 flex-shrink-0`}
              >
                {ACTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACTION_META[t].label}
                  </option>
                ))}
              </select>
              <div className="flex-1 min-w-0">
                <ActionConfig
                  action={a}
                  idx={i}
                  set={(patch) => setAction(i, patch)}
                  onRemove={() =>
                    set({
                      actions: draft.actions.filter((_, idx) => idx !== i),
                    })
                  }
                  availableLabels={availableLabels}
                />
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={() => set({ actions: [...draft.actions, { type: "LABEL" }] })}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <Plus size={13} /> Add Action
        </button>
      </div>

      {/* Advanced options */}
      <div className="border border-border rounded-xl bg-card overflow-hidden">
        <button
          onClick={() => setAdvancedOpen((o) => !o)}
          className="w-full flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-foreground hover:bg-secondary/40 transition-colors"
        >
          <ChevronRight
            size={14}
            className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          />
          Advanced options
        </button>
        {advancedOpen && (
          <div className="px-3.5 pb-3.5 pt-1 space-y-3 border-t border-border/60">
            {/* Apply to threads */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.run_on_threads}
                onChange={(e) => set({ run_on_threads: e.target.checked })}
                className="accent-primary mt-0.5"
              />
              <span>
                <span className="text-xs text-foreground">Apply to threads</span>
                <span className="block text-[11px] text-muted-foreground">
                  Run on every reply in a conversation, not just the first
                  message (recommended for “To Reply” / “FYI”).
                </span>
              </span>
            </label>

          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * MOVE_FOLDER destination picker: a combobox of the account's real folders
 * (user folders + Archive/Junk) with an inline "Create folder" affordance when
 * the typed name doesn't exist yet. The stored value is the folder's display
 * name, which the backend resolves (system folders by key, user folders via
 * get-or-create) — inbox-zero parity for filing mail into folders.
 */
function MoveFolderField({
  value,
  onChange,
  idx,
}: {
  value: string;
  onChange: (v: string) => void;
  idx: number;
}) {
  const folders = useEmailStore((s) => s.folders);
  const accountId = useEmailStore((s) => s.selectedAccountId);
  const fetchFolders = useEmailStore((s) => s.fetchFolders);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Folders a message can be moved into: user folders + the Archive/Junk system
  // targets (inbox/sent/drafts/trash aren't sensible rule destinations).
  const targets = folders.filter(
    (f) => f.type === "user" || f.key === "archive" || f.key === "junk",
  );
  const typed = value.trim();
  const exists = targets.some(
    (t) => t.label.toLowerCase() === typed.toLowerCase(),
  );
  const dlId = `folder-options-${idx}`;

  const handleCreate = async () => {
    if (!accountId || !typed || creating) return;
    setCreating(true);
    setErr(null);
    try {
      const folder = await createEmailFolder(accountId, typed);
      await fetchFolders(accountId);
      onChange(folder.name);
    } catch {
      setErr("Couldn't create that folder. Try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <input
        list={dlId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Choose or type a folder name"
        className={INPUT_CLS}
      />
      <datalist id={dlId}>
        {targets.map((f) => (
          <option key={f.key} value={f.label} />
        ))}
      </datalist>
      {typed && !exists && (
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !accountId}
          className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : <FolderPlus size={12} />}
          Create folder “{typed}”
        </button>
      )}
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </div>
  );
}

/**
 * The right-hand configuration card for a single rule action — mirrors
 * inbox-zero's per-action card with a "…" overflow menu and the per-field
 * AI-vs-manual model (label combobox ↔ AI prompt; AI draft ↔ manual content
 * with {{variables}}). Attachments + delay live behind the overflow menu.
 */
function ActionConfig({
  action,
  idx,
  set,
  onRemove,
  availableLabels,
}: {
  action: RuleAction;
  idx: number;
  set: (patch: Partial<RuleAction>) => void;
  onRemove: () => void;
  availableLabels: string[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAttach, setShowAttach] = useState(
    (action.attachments?.length ?? 0) > 0,
  );

  const isDraftReply = action.type === "DRAFT_EMAIL" || action.type === "REPLY";
  const isForward = action.type === "FORWARD";
  const draftLike = isDraftReply || isForward;
  const delayable = action.type !== "CALL_WEBHOOK";
  // Forward is inherently manual (a note above the forwarded body); reply/draft
  // follow the explicit content_manual toggle (default = AI writes it).
  const manual = isForward ? true : !!action.content_manual;

  type MenuItem = { icon: React.ReactNode; label: string; onClick: () => void };
  const menuItems: MenuItem[] = [];
  if (action.type === "LABEL") {
    menuItems.push(
      action.label_ai
        ? { icon: <Tag size={13} />, label: "Use a fixed label", onClick: () => set({ label_ai: false }) }
        : { icon: <Sparkles size={13} />, label: "Use an AI prompt", onClick: () => set({ label_ai: true }) },
    );
  }
  if (isDraftReply) {
    menuItems.push(
      manual
        ? { icon: <Sparkles size={13} />, label: "Use AI draft", onClick: () => set({ content_manual: false }) }
        : { icon: <Pencil size={13} />, label: "Set content manually", onClick: () => set({ content_manual: true }) },
    );
  }
  if (draftLike) {
    menuItems.push({
      icon: <Paperclip size={13} />,
      label: showAttach ? "Hide attachments" : "Configure attachments",
      onClick: () => setShowAttach((v) => !v),
    });
  }
  if (delayable) {
    menuItems.push(
      action.delay_minutes != null
        ? { icon: <X size={13} />, label: "Remove delay", onClick: () => set({ delay_minutes: null }) }
        : { icon: <ChevronDown size={13} />, label: "Add delay", onClick: () => set({ delay_minutes: 60 }) },
    );
  }

  const dlId = `label-options-${idx}`;

  return (
    <div className="border border-border rounded-lg p-3 bg-secondary/30 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {ACTION_META[action.type].description}
        </p>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {menuItems.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                title="More options"
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-7 z-20 w-52 rounded-lg border border-border bg-popover shadow-lg p-1">
                    {menuItems.map((m, j) => (
                      <button
                        key={j}
                        onClick={() => {
                          m.onClick();
                          setMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-foreground hover:bg-secondary text-left"
                      >
                        {m.icon}
                        {m.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <button
            onClick={onRemove}
            title="Delete action"
            className="p-1 rounded text-muted-foreground hover:text-destructive"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Categorize (LABEL): label combobox or AI prompt */}
      {action.type === "LABEL" && (
        action.label_ai ? (
          <>
            <input
              value={action.label ?? ""}
              onChange={(e) => set({ label: e.target.value })}
              placeholder={'e.g. {{choose "urgent", "normal", or "low"}}'}
              className={INPUT_CLS}
            />
            <VariablesHint />
          </>
        ) : (
          <>
            <input
              list={dlId}
              value={action.label ?? ""}
              onChange={(e) => set({ label: e.target.value })}
              placeholder="Select a label"
              className={INPUT_CLS}
            />
            <datalist id={dlId}>
              {availableLabels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </>
        )
      )}

      {action.type === "MOVE_FOLDER" && (
        <MoveFolderField
          value={action.label ?? ""}
          onChange={(v) => set({ label: v })}
          idx={idx}
        />
      )}

      {action.type === "CALL_WEBHOOK" && (
        <input
          value={action.url ?? ""}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://…"
          className={INPUT_CLS}
        />
      )}

      {/* Draft reply — AI mode (default) */}
      {draftLike && !manual && (
        <>
          <p className="text-xs text-muted-foreground">
            Our AI generates a draft reply from your email history and knowledge
            base.
          </p>
          <DraftToSection />
        </>
      )}

      {/* Draft reply / forward — manual content */}
      {draftLike && manual && (
        <div className="space-y-2">
          <FieldLabel>Content</FieldLabel>
          <textarea
            value={action.content ?? ""}
            onChange={(e) => set({ content: e.target.value })}
            rows={3}
            placeholder={
              isForward
                ? "Note to add above the forwarded message (optional)"
                : "Reply text — supports {{variables}}"
            }
            className={`${INPUT_CLS} resize-none`}
          />
          <FieldLabel>Subject</FieldLabel>
          <input
            value={action.subject ?? ""}
            onChange={(e) => set({ subject: e.target.value })}
            placeholder="Subject (optional)"
            className={INPUT_CLS}
          />
          <FieldLabel>To</FieldLabel>
          <input
            value={action.to_address ?? ""}
            onChange={(e) => set({ to_address: e.target.value })}
            placeholder={
              isForward ? "Forward to (email)" : "To (defaults to the sender)"
            }
            className={INPUT_CLS}
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>CC</FieldLabel>
              <input
                value={action.cc_address ?? ""}
                onChange={(e) => set({ cc_address: e.target.value })}
                placeholder="Cc (optional)"
                className={`${INPUT_CLS} mt-1`}
              />
            </div>
            <div>
              <FieldLabel>BCC</FieldLabel>
              <input
                value={action.bcc_address ?? ""}
                onChange={(e) => set({ bcc_address: e.target.value })}
                placeholder="Bcc (optional)"
                className={`${INPUT_CLS} mt-1`}
              />
            </div>
          </div>
          <VariablesHint />
          <p className="text-[10px] text-muted-foreground">
            Creates a draft for review — never auto-sends.
          </p>
          <DraftToSection />
        </div>
      )}

      {/* Attachments (draft/reply/forward) — behind "Configure attachments" */}
      {draftLike && showAttach && (
        <div className="pt-2 border-t border-border/60 space-y-1.5">
          <FieldLabel>Attachments</FieldLabel>
          <ActionAttachments
            attachments={action.attachments ?? []}
            onChange={(att) => set({ attachments: att })}
          />
        </div>
      )}

      {/* Delay — behind "Add delay" */}
      {delayable && action.delay_minutes != null && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[10px] text-muted-foreground">Run after</span>
          <input
            type="number"
            min={0}
            value={action.delay_minutes ?? ""}
            onChange={(e) =>
              set({
                delay_minutes: e.target.value
                  ? Math.max(0, parseInt(e.target.value, 10) || 0)
                  : 0,
              })
            }
            placeholder="0"
            className={`${INPUT_BASE} w-20`}
          />
          <span className="text-[10px] text-muted-foreground">
            minutes (0 = immediately)
          </span>
        </div>
      )}
    </div>
  );
}

/** Small field label used inside the action config card. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium text-foreground">{children}</span>
  );
}

/**
 * "Draft to" delivery row — Email is always on (drafts land in the inbox).
 * Messaging-channel delivery (Slack/Telegram) is shown for parity but not yet
 * wired, so the connect button is disabled.
 */
function DraftToSection() {
  return (
    <div className="pt-2 border-t border-border/60">
      <span className="text-xs font-medium text-foreground">Draft to</span>
      <label className="flex items-center gap-2 mt-1.5">
        <input
          type="checkbox"
          checked
          disabled
          readOnly
          className="accent-primary"
          title="Drafts always appear in your inbox"
        />
        <span className="text-xs text-foreground">
          Email{" "}
          <span className="text-muted-foreground">
            — Draft appears in your inbox
          </span>
        </span>
      </label>
      <button
        type="button"
        disabled
        title="Coming soon"
        className="mt-2 text-[11px] px-2.5 py-1.5 rounded-md border border-border text-muted-foreground opacity-60 cursor-not-allowed"
      >
        Connect Slack or Telegram
      </button>
    </div>
  );
}

/** Blue {{variables}} hint banner with an inline examples disclosure. */
function VariablesHint() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 px-2.5 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-blue-600 dark:text-blue-400">
          ✨ Use {"{{variables}}"} for personalized content
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="px-1.5 py-0.5 rounded border border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"
        >
          See examples
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1 text-muted-foreground">
          <li>
            <code className="text-foreground">{"{{name}}"}</code> — the sender’s
            name
          </li>
          <li>
            <code className="text-foreground">{"{{summarize the email}}"}</code>{" "}
            — a short summary of their message
          </li>
          <li>
            <code className="text-foreground">{'{{choose "urgent", "normal"}}'}</code>{" "}
            — let the AI pick a value
          </li>
        </ul>
      )}
    </div>
  );
}

// ── Process past emails (inbox-zero parity) ─────────────────────────────────

const PAST_PRESETS: { label: string; days: number }[] = [
  { label: "Last 24 hours", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

/** ISO YYYY-MM-DD for `daysAgo` days before today (0 = today). */
function isoDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function ProcessPastEmailsDialog({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [start, setStart] = useState(isoDaysAgo(7));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [includeRead, setIncludeRead] = useState(true); // true = all mail, false = unread only
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Processing past emails always APPLIES the matched rules (there's nothing
      // to "test" against history) — results land in the History tab.
      const r = await processPastEmails({
        accountId,
        startDate: start || undefined,
        endDate: end || undefined,
        isTest: false,
        includeRead,
      });
      setResult(
        r.count === 0
          ? "No emails found in that range."
          : `Applying your rules to ${r.count} email${r.count === 1 ? "" : "s"} ` +
              "— results appear in the History tab.",
      );
    } catch (e) {
      setError((e as Error).message || "Failed to start processing");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Process past emails"
      description="Apply your rules to older inbox mail in a date range."
      onClose={onClose}
      footer={
        <button
          onClick={run}
          disabled={busy}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 className="animate-spin" size={13} /> : <Play size={13} />}
          Process emails
        </button>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {PAST_PRESETS.map((p) => (
          <button
            key={p.days}
            onClick={() => {
              setStart(isoDaysAgo(p.days));
              setEnd(isoDaysAgo(0));
            }}
            className="text-[11px] px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <input
            type="date"
            value={start}
            max={end || undefined}
            onChange={(e) => setStart(e.target.value)}
            className={INPUT_CLS}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={end}
            min={start || undefined}
            onChange={(e) => setEnd(e.target.value)}
            className={INPUT_CLS}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between">
        <LabeledToggle
          label="Unread only"
          labelRight="All mail"
          enabled={includeRead}
          onChange={setIncludeRead}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Runs the matched actions (labels, drafts, archive…) on{" "}
        {includeRead ? "every email" : "unread mail"} in the range. Applied
        actions show up in the History tab.
      </p>
      {result && (
        <div className="text-xs text-emerald-400 bg-emerald-500/10 rounded-md px-2.5 py-2">
          {result}
        </div>
      )}
      {error && (
        <div className="text-xs text-destructive bg-destructive/10 rounded-md px-2.5 py-2">
          {error}
        </div>
      )}
    </Modal>
  );
}

/**
 * Attachments for a draft/reply/forward action (inbox-zero parity). Files are
 * stored in the email-assistant workspace: drag-and-drop or click to upload from
 * your device, or pick an existing artifact. The agent attaches them when it
 * drafts. "AI-selected" lets the assistant choose which to attach at draft time.
 */
function ActionAttachments({
  attachments,
  onChange,
}: {
  attachments: RuleActionAttachment[];
  onChange: (next: RuleActionAttachment[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    setErr(null);
    try {
      const up = await uploadEmailArtifacts(files);
      onChange([
        ...attachments,
        ...up.map((u) => ({ path: u.path, name: u.name, ai_selected: false })),
      ]);
    } catch (e) {
      setErr((e as Error).message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const pick = (a: EmailArtifact) => {
    if (attachments.some((x) => x.path === a.path)) return;
    onChange([...attachments, { path: a.path, name: a.name, ai_selected: false }]);
  };

  return (
    <div className="space-y-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((att, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border border-border bg-secondary/40 text-foreground"
            >
              <Paperclip size={9} className="text-muted-foreground" />
              {att.name || att.path || "attachment"}
              {att.ai_selected && (
                <span className="text-primary" title="AI-selected source">✨</span>
              )}
              <button
                onClick={() => onChange(attachments.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Drag-and-drop / click-to-upload zone */}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[11px] cursor-pointer transition-colors ${
          dragOver
            ? "border-primary bg-primary/5 text-primary"
            : "border-border text-muted-foreground hover:border-primary/40 hover:bg-secondary/40"
        }`}
      >
        {uploading ? (
          <>
            <Loader2 size={13} className="animate-spin" /> Uploading…
          </>
        ) : (
          <>
            <Upload size={13} /> Drag &amp; drop files, or click to upload
          </>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />

      <div className="flex items-center gap-3">
        <button
          onClick={() => setShowPicker(true)}
          className="flex items-center gap-1 text-[11px] text-primary hover:opacity-80"
        >
          <FolderOpen size={12} /> Choose from artifacts
        </button>
        {attachments.some((a) => !a.ai_selected) && (
          <button
            onClick={() =>
              onChange(
                attachments.map((a) => ({ ...a, ai_selected: !a.ai_selected })),
              )
            }
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {attachments.every((a) => a.ai_selected)
              ? "Always attach these"
              : "Let the assistant choose which to attach"}
          </button>
        )}
      </div>
      {err && (
        <div className="text-[10px] text-destructive bg-destructive/10 rounded px-2 py-1">
          {err}
        </div>
      )}

      {showPicker && (
        <ArtifactPickerDialog
          selectedPaths={attachments.map((a) => a.path || "")}
          onPick={pick}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

/** Popup to browse + pick a file from the email-assistant workspace. */
function ArtifactPickerDialog({
  selectedPaths,
  onPick,
  onClose,
}: {
  selectedPaths: string[];
  onPick: (a: EmailArtifact) => void;
  onClose: () => void;
}) {
  const [artifacts, setArtifacts] = useState<EmailArtifact[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    listEmailArtifacts()
      .then(setArtifacts)
      .catch(() => setArtifacts([]));
  }, []);

  const visible = (artifacts ?? []).filter(
    (a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Modal
      title="Choose an attachment"
      description="Pick a file from the email assistant's workspace."
      onClose={onClose}
      maxWidth="max-w-md"
    >
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search files…"
        className={INPUT_CLS}
      />
      <div className="max-h-72 overflow-y-auto space-y-1">
        {artifacts === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="text-xs text-muted-foreground py-3">
            No files yet. Upload one by dragging it onto the action.
          </div>
        ) : (
          visible.map((a) => {
            const picked = selectedPaths.includes(a.path);
            return (
              <button
                key={a.path}
                onClick={() => onPick(a)}
                disabled={picked}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border text-left hover:border-primary/40 hover:bg-secondary/40 transition-colors disabled:opacity-50"
              >
                <Paperclip size={12} className="text-muted-foreground flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-xs text-foreground truncate">
                    {a.name}
                  </span>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {a.category} · {(a.size / 1024).toFixed(0)} KB
                  </span>
                </span>
                {picked && <Check size={12} className="text-emerald-500" />}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}

// Example rule prompts, lifted from inbox-zero (examples.ts), as full
// natural-language sentences. Clicking one appends it to the Add-rules prompt;
// the AI turns the text into structured rules. `@[Label]` mentions are written
// out plainly here. Emails/links are illustrative placeholders.
const EXAMPLE_PERSONA_KEYS = [
  "General", "Founder", "Sales", "Recruiter", "Developer", "Support", "Investor",
];

const EXAMPLE_PROMPTS: Record<string, string[]> = {
  General: [
    "Label urgent emails as Urgent",
    "Label emails from @mycompany.com addresses as Team",
    "Forward receipts to jane@accounting.com and label them Receipt",
    "Label newsletters as Newsletter and archive them",
    "Label marketing and promotional emails as Marketing and archive them",
    "Reply to cold emails telling them I'm not interested, then mark them as spam",
    "Label high priority emails as High Priority",
    "If someone asks to set up a call, draft a reply with my calendar link: https://cal.com/example",
    "If a founder sends me an investor update, label it Investor Update and archive it",
    "If someone asks for a discount, reply with the discount code INBOX20",
    "If people ask me to speak at an event, label the email Speaker Opportunity and archive it",
    "Label emails from customers as Customer",
    "Label legal documents as Legal",
    "Label Stripe emails as Stripe and archive them",
  ],
  Founder: [
    "If someone asks to set up a call, draft a reply with my calendar link: https://cal.com/example",
    "Label feedback from customers about our product as Customer Feedback",
    "Label emails from customers who need help and support as Customer Support",
    "Label emails from investors as Investor",
    "Label legal documents as Legal",
    "Label emails about travel as Travel",
    "Label recruitment related emails as Hiring",
  ],
  Sales: [
    "Label emails from prospects as Prospect",
    "Label emails from customers as Customer",
    "Label emails about deal negotiations as Deal Discussion",
    "If someone asks for pricing, draft a reply with our pricing page link: https://company.com/pricing",
    "If someone requests a demo, draft a reply with my calendar link: https://cal.com/example",
    "Label emails containing signed contracts as Signed Contract and forward to legal@company.com",
    "If a customer mentions churn risk, label as Churn Risk and draft an urgent note to customer success",
    "If someone asks about enterprise pricing, draft a reply asking about their company size and requirements",
  ],
  Recruiter: [
    "Label emails from candidates as Candidate",
    "Label emails from hiring managers as Hiring Manager",
    "If someone applies for a job, label as New Application and draft a reply acknowledging their application",
    "Label emails containing resumes or CVs as Resume",
    "Label emails about interview scheduling as Interview Scheduling",
    "Label emails from job boards as Job Board and archive them",
    "Label emails about salary negotiations as Compensation",
    "If an internal employee refers someone, label as Employee Referral",
  ],
  Developer: [
    "Label server errors, deployment failures, and other alerts as Alert and forward to oncall@company.com",
    "Label emails from GitHub as GitHub and archive them",
    "Label emails from Stripe as Stripe and archive them",
    "Label emails about bug reports as Bug",
    "If someone reports a security vulnerability, label as Security and forward to security@company.com",
    "Label emails from recruiters as Recruiter and archive them",
  ],
  Support: [
    "Label customer requests for help as Support Ticket",
    "If someone reports a critical issue, label as Urgent Support and forward to urgent@company.com",
    "Label bug reports as Bug and forward to engineering@company.com",
    "Label feature requests as Feature Request and forward to product@company.com",
    "If someone asks for a refund, draft a reply with our refund policy link: https://company.com/refund-policy",
    "Label positive feedback as Testimonial and forward to marketing@company.com",
  ],
  Investor: [
    "If a founder asks to set up a call, draft a reply with my calendar link: https://cal.com/example",
    "If a founder sends me an investor update, label it Investor Update and archive it",
    "Forward pitch decks to analyst@vc.com and label them Pitch Deck",
    "Label emails from LPs as LP",
    "Label emails containing term sheets as Term Sheet",
    "Label due diligence related emails as Due Diligence",
    "Label emails about portfolio company exits as Exit Opportunity",
  ],
};

/**
 * The primary "Add rule" experience, matching inbox-zero: describe your rules in
 * plain English (one per line). "Choose from examples" reveals a list of real
 * example rules (lifted from inbox-zero) you click to APPEND to the box. "Create
 * rules" turns the text into structured rules via the AI; "Add rule manually"
 * opens the structured editor instead.
 */
function AddRuleDialog({
  accountId,
  onManual,
  onCreated,
  onClose,
}: {
  accountId: string;
  onManual: () => void;
  onCreated: (created: AutomationRule[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [persona, setPersona] = useState("General");
  const [showExamples, setShowExamples] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const examples = EXAMPLE_PROMPTS[persona] ?? EXAMPLE_PROMPTS.General;

  const append = (line: string) =>
    setText((t) => {
      const base = t.replace(/\n+$/, "");
      return (base ? base + "\n" : "") + "* " + line;
    });

  const create = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await generateRules(accountId, text);
      if (!res.created || res.created.length === 0) {
        setError(res.error || "Couldn't create any rules — try rephrasing.");
        return;
      }
      onCreated(res.created);
    } catch (e) {
      setError((e as Error).message || "Failed to create rules.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add rules"
      description="Describe what you want, one rule per line — the assistant turns it into rules."
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <>
          <button
            onClick={onManual}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            Add rule manually
          </button>
          <button
            onClick={create}
            disabled={busy || !text.trim()}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 className="animate-spin" size={13} /> : <Wand2 size={13} />}
            Create rules
          </button>
        </>
      }
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        autoFocus
        placeholder={
          "* Label urgent emails as Urgent\n" +
          "* Forward receipts to jane@accounting.com and label them Receipt\n" +
          "* Archive newsletters and marketing"
        }
        className={`${INPUT_CLS} resize-y leading-relaxed`}
      />
      {error && (
        <div className="text-[11px] text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <button
          onClick={() => setShowExamples((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-primary hover:opacity-80"
        >
          <Sparkles size={12} />
          {showExamples ? "Hide examples" : "Choose from examples"}
        </button>
        {showExamples && (
          <>
            {/* Persona tabs */}
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PERSONA_KEYS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPersona(p)}
                  className={`text-[11px] px-2.5 py-1 rounded-full transition-colors ${
                    persona === p
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            {/* Full-sentence examples — click to append to the prompt. */}
            <div className="grid grid-cols-1 gap-1.5 max-h-64 overflow-y-auto pr-1">
              {examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => append(ex)}
                  className="flex items-start gap-2 text-left text-[11px] px-2.5 py-2 rounded-lg border border-border text-foreground hover:border-primary/40 hover:bg-secondary/40 transition-colors"
                >
                  <Plus size={11} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                  <span>{ex}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
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
                      className={`text-[10px] px-1.5 py-0.5 rounded-md border ${actionColor(a.type)}`}
                    >
                      {actionText(a)}
                    </span>
                  ))
                : types.map((t, i) => (
                    <span
                      key={i}
                      title={actionDescription(t)}
                      className={`text-[10px] px-1.5 py-0.5 rounded-md border ${actionColor(t)}`}
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

/**
 * The "Improve Rules" dialog. For an existing rule / "None" it PERSISTS a
 * learned classification pattern (so the same sender matches/skips that rule
 * next time — inbox-zero parity). For "New rule" it hands off to the AI chat.
 */
function FixDialog({
  accountId,
  email,
  current,
  onClose,
}: {
  accountId: string;
  email: { subject: string; from: string };
  current: { matched: boolean; ruleName: string | null; ruleId?: string | null };
  onClose: () => void;
}) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [expected, setExpected] = useState<Expected | null>(null);
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What signal(s) to learn the correction on (inbox-zero teaches by sender
  // and/or subject keyword). Sender is on by default.
  const [useSender, setUseSender] = useState(true);
  const [useSubject, setUseSubject] = useState(false);
  const [subjectKw, setSubjectKw] = useState("");
  const setPendingChatPrompt = useEmailStore((s) => s.setPendingChatPrompt);

  useEffect(() => {
    listRules(accountId).then(setRules).catch(() => {});
  }, [accountId]);

  // Seed the subject-keyword box with the email subject the first time the
  // user opts into subject matching, so they can trim it down to a keyword.
  const enableSubject = () => {
    setUseSubject((on) => {
      if (!on && !subjectKw) setSubjectKw(email.subject || "");
      return !on;
    });
  };

  const submit = async () => {
    if (!expected) return;
    // "New rule" still routes through the assistant chat (it has to be created).
    if (expected === "new") {
      setPendingChatPrompt(buildFixPrompt(expected, explanation, email));
      onClose();
      return;
    }
    const senderVal = useSender ? email.from : "";
    const subjectVal = useSubject ? subjectKw.trim() : "";
    if (!senderVal && !subjectVal) {
      setError("Pick the sender and/or a subject keyword to learn from.");
      return;
    }
    // Existing rule / None → persist a learned pattern so it sticks.
    setBusy(true);
    setError(null);
    try {
      const matchedIds = current.ruleId ? [current.ruleId] : [];
      await submitRuleFeedback({
        accountId,
        sender: senderVal,
        expected: expected === "none" ? "none" : expected.id,
        matchedRuleIds: matchedIds,
        explanation,
        subjectKeyword: subjectVal || undefined,
      });
      const target = [
        senderVal && `from ${senderVal}`,
        subjectVal && `about "${subjectVal}"`,
      ]
        .filter(Boolean)
        .join(" / ");
      setDone(
        expected === "none"
          ? `Got it — emails ${target} won't match ${
              current.ruleName || "that rule"
            } anymore.`
          : `Learned — emails ${target} will now match "${expected.name}".`,
      );
    } catch (e) {
      setError((e as Error).message || "Couldn't save the correction.");
    } finally {
      setBusy(false);
    }
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
        done ? (
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
          >
            Done
          </button>
        ) : expected ? (
          <>
            <button
              onClick={() => setExpected(null)}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              Back
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="animate-spin" size={13} />
              ) : expected === "new" ? (
                <MessageCircle size={13} />
              ) : (
                <Check size={13} />
              )}
              {expected === "new" ? "Send to assistant" : "Apply correction"}
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

      {done ? (
        <div className="text-xs text-emerald-400 bg-emerald-500/10 rounded-md px-2.5 py-2">
          {done}
        </div>
      ) : !expected ? (
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
          {expected !== "new" && (
            <div className="rounded-lg border border-border p-2.5 space-y-2">
              <div className="text-[11px] font-medium text-foreground">
                Apply this to emails…
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={useSender}
                  onChange={() => setUseSender((v) => !v)}
                  className="accent-primary"
                />
                from{" "}
                <span className="text-muted-foreground truncate">
                  {email.from || "this sender"}
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={useSubject}
                  onChange={enableSubject}
                  className="accent-primary"
                />
                with subject containing…
              </label>
              {useSubject && (
                <input
                  value={subjectKw}
                  onChange={(e) => setSubjectKw(e.target.value)}
                  placeholder="keyword in the subject (e.g. invoice)"
                  className={`${INPUT_CLS} ml-6 w-[calc(100%-1.5rem)]`}
                />
              )}
            </div>
          )}
          <textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            rows={3}
            placeholder="Why should this rule have been applied? (optional)"
            className={`${INPUT_CLS} resize-none`}
          />
          <p className="text-[10px] text-muted-foreground">
            {expected === "new"
              ? "The assistant will create a rule for emails like this."
              : "We'll remember this for matching emails. An explanation is optional."}
          </p>
          {error && (
            <div className="text-[11px] text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
              {error}
            </div>
          )}
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
  current: { matched: boolean; ruleName: string | null; ruleId?: string | null };
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
  const [search, setSearch] = useState("");

  // Bulk Test/Run sweep state lives in the email store so it keeps running even
  // if the user navigates away from the Assistant (TestTab unmounts).
  const results = useEmailStore((s) => s.testResults);
  const runningIds = useEmailStore((s) => s.testRunningIds);
  const bulk = useEmailStore((s) => s.testBulkRunning);
  const runTestOnMessage = useEmailStore((s) => s.runTestOnMessage);
  const runTestOnAll = useEmailStore((s) => s.runTestOnAll);
  const stopTestRun = useEmailStore((s) => s.stopTestRun);
  const clearTestResults = useEmailStore((s) => s.clearTestResults);

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
  useEffect(() => clearTestResults(), [applyMode, clearTestResults]);

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
    (id: string) => {
      if (!accountId) return;
      runTestOnMessage(accountId, id, !applyMode);
    },
    [accountId, applyMode, runTestOnMessage],
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

  const runAll = () => {
    if (!accountId) return;
    runTestOnAll(accountId, visible.map((e) => e.id), !applyMode);
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
            onClick={stopTestRun}
            className="flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-700 transition-colors"
          >
            <Square size={12} /> {applyMode ? "Stop run" : "Stop test"}
          </button>
        ) : (
          <button
            onClick={runAll}
            disabled={visible.length === 0}
            className="flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            const isRunning = runningIds.includes(e.id);
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
                          ruleId: res.rule?.id ?? null,
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

function HistoryTab({
  accountId,
  initialRuleFilter = "all",
}: {
  accountId: string | null;
  initialRuleFilter?: string;
}) {
  const [history, setHistory] = useState<ExecutedRule[]>([]);
  const [loading, setLoading] = useState(true);
  // "all" | "skipped" (No match) | a rule name.
  const [ruleFilter, setRuleFilter] = useState(initialRuleFilter);

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
            current={{ matched, ruleName: h.rule_name, ruleId: h.rule_id ?? null }}
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
  // Only the models the user enabled on the Models page (eye toggle).
  const [enabledModels, setEnabledModels] = useState<
    { id: string; label?: string; provider?: string }[]
  >([]);
  const [ruleNames, setRuleNames] = useState<string[]>([]);
  const [dialog, setDialog] = useState<
    | "followup"
    | "digest"
    | "writingstyle"
    | "personal"
    | "signature"
    | "knowledge"
    | "learned"
    | "patterns"
    | null
  >(null);

  useEffect(() => {
    fetch("/api/settings/llm")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setLlm(d))
      .catch(() => {});
    // The model dropdown should offer the LiteLLM tiers + only the models the
    // user made visible on the Models page (not the full static catalogue).
    fetch("/api/settings/llm/enabled-models")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setEnabledModels(d.enabled ?? d.custom ?? []))
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

        {/* ── Your voice ── (editors live in popups to keep the tab uncluttered) */}
        <div className="space-y-2">
          <SectionHeader>Your voice</SectionHeader>
          <SettingCard
            title="Writing style"
            description={summary(s.writing_style, "Define your tone and style — used to draft replies in your voice.")}
            right={<EditBtn onClick={() => setDialog("writingstyle")} set={!!s.writing_style} />}
          />
          <SettingCard
            title="Personal instructions"
            description={summary(
              [s.about, s.personal_instructions].filter(Boolean).join(" • "),
              "Tell the AI about yourself and how you'd like it to handle your emails.",
            )}
            right={<EditBtn onClick={() => setDialog("personal")} set={!!(s.about || s.personal_instructions)} />}
          />
          <SettingCard
            title="Email signature"
            description={summary(s.signature, "Set your email signature to include in drafted messages.")}
            right={<EditBtn onClick={() => setDialog("signature")} set={!!s.signature} />}
          />
        </div>

        {/* ── Knowledge ── (managed in popups) */}
        <div className="space-y-2">
          <SectionHeader>Knowledge</SectionHeader>
          <SettingCard
            title="Draft knowledge base"
            description="Facts, snippets and boilerplate the assistant can pull into drafts."
            right={<EditBtn onClick={() => setDialog("knowledge")} label="Manage" />}
          />
          <SettingCard
            title="Learned patterns"
            description="Senders the assistant learned to match (or skip) for a rule, from your Fix corrections."
            right={<EditBtn onClick={() => setDialog("patterns")} label="Manage" />}
          />
          <SettingCard
            title="Writing preferences"
            description="How the assistant adapts its drafting from the edits you make before sending."
            right={<EditBtn onClick={() => setDialog("learned")} label="Manage" />}
          />
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
            title="Multi-rule execution"
            description="When on, the AI applies every rule that matches an email (inbox-zero multi-rule). Off = only the single best-matching rule runs."
            right={
              <Toggle
                enabled={s.multi_rule_execution}
                onChange={(v) => persistPatch({ multi_rule_execution: v })}
              />
            }
          />
          <SettingCard
            title="Sensitive data protection"
            description="Skip auto-drafting replies on emails that look like they contain passwords, OTPs, or card/account numbers."
            right={
              <Toggle
                enabled={s.sensitive_data_protection}
                onChange={(v) => persistPatch({ sensitive_data_protection: v })}
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
                {llm || enabledModels.length > 0 ? (
                  <>
                    {llm && (
                      <optgroup label="Tiers (auto-routing)">
                        {llm.tiers.map((t) => (
                          <option key={t.tier_name} value={t.tier_name}>
                            {t.tier_name}
                            {t.tier_name === "tier-balanced" ? " (default)" : ""}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {enabledModels.length > 0 && (
                      <optgroup label="Your enabled models">
                        {enabledModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label || m.id}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {/* Keep a previously-saved value selectable even if it's no
                        longer a tier or an enabled model. */}
                    {!llm?.tiers.some((t) => t.tier_name === s.agent_model) &&
                      !enabledModels.some((m) => m.id === s.agent_model) && (
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

        {/* Each setting saves on its own (toggle / dialog) — show live status. */}
        <div className="flex items-center gap-2 pb-2 h-5">
          {saving && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="animate-spin" size={12} /> Saving…
            </span>
          )}
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
      {dialog === "writingstyle" && (
        <WritingStyleDialog
          settings={s}
          accountId={accountId}
          onSave={(next) => {
            persist(next);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "personal" && (
        <PersonalInstructionsDialog
          settings={s}
          onSave={(next) => {
            persist(next);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "signature" && (
        <SignatureDialog
          settings={s}
          onSave={(next) => {
            persist(next);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "knowledge" && (
        <Modal
          title="Draft knowledge base"
          description="Facts and snippets the assistant can pull into drafts."
          onClose={() => setDialog(null)}
        >
          <KnowledgeBase accountId={accountId} />
        </Modal>
      )}
      {dialog === "learned" && (
        <Modal
          title="Writing preferences"
          description="Preferences picked up from how you edit drafts before sending."
          onClose={() => setDialog(null)}
        >
          <LearnedPreferences accountId={accountId} />
        </Modal>
      )}
      {dialog === "patterns" && (
        <Modal
          title="Learned patterns"
          description="Senders the assistant learned to match (or skip) for a rule, from your Fix corrections."
          onClose={() => setDialog(null)}
        >
          <LearnedPatternsList accountId={accountId} />
        </Modal>
      )}
    </div>
  );
}

/** Small "Edit"/"Manage" button used by the Settings rows to open an editor popup. */
function EditBtn({
  onClick,
  label,
  set,
}: {
  onClick: () => void;
  label?: string;
  set?: boolean;
}) {
  return (
    <button onClick={onClick} className={CONFIGURE_BTN}>
      <Settings size={12} /> {label ?? (set ? "Edit" : "Set up")}
    </button>
  );
}

/** Trim a settings value into a one-line preview; fall back to the help text. */
function summary(value: string | undefined | null, fallback: string): string {
  const v = (value || "").trim().replace(/\s+/g, " ");
  if (!v) return fallback;
  return v.length > 90 ? v.slice(0, 90) + "…" : v;
}

function WritingStyleDialog({
  settings,
  accountId,
  onSave,
  onClose,
}: {
  settings: AssistantSettings;
  accountId: string;
  onSave: (next: AssistantSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  return (
    <Modal
      title="Writing style"
      description="Define your tone and style — used to draft replies in your voice."
      onClose={onClose}
      footer={
        <button
          onClick={() => onSave(draft)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Check size={13} /> Save
        </button>
      }
    >
      <textarea
        value={draft.writing_style}
        onChange={(e) => setDraft({ ...draft, writing_style: e.target.value })}
        rows={6}
        placeholder="e.g. Concise and friendly. 2–3 short sentences. No corporate jargon. Sign off with just my first name."
        className={`${INPUT_CLS} resize-none`}
      />
      <WritingStyleGenerator
        accountId={accountId}
        onGenerated={(ws) => setDraft({ ...draft, writing_style: ws })}
      />
    </Modal>
  );
}

function PersonalInstructionsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: AssistantSettings;
  onSave: (next: AssistantSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  return (
    <Modal
      title="Personal instructions"
      description="Tell the AI about yourself and how you'd like it to handle your emails."
      onClose={onClose}
      footer={
        <button
          onClick={() => onSave(draft)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Check size={13} /> Save
        </button>
      }
    >
      <Field label="About you">
        <textarea
          value={draft.about}
          onChange={(e) => setDraft({ ...draft, about: e.target.value })}
          rows={4}
          placeholder="e.g. I'm the founder of Acme. If I'm CC'd, it's not To Reply. Emails from jane@accounting.com aren't Notifications."
          className={`${INPUT_CLS} resize-none`}
        />
      </Field>
      <Field label="Global instructions">
        <textarea
          value={draft.personal_instructions}
          onChange={(e) => setDraft({ ...draft, personal_instructions: e.target.value })}
          rows={4}
          placeholder="Rules the assistant always follows — e.g. Never commit to dates without checking with me. Don't discuss pricing over email."
          className={`${INPUT_CLS} resize-none`}
        />
      </Field>
    </Modal>
  );
}

function SignatureDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: AssistantSettings;
  onSave: (next: AssistantSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  return (
    <Modal
      title="Email signature"
      description="Included at the bottom of drafted messages."
      onClose={onClose}
      footer={
        <button
          onClick={() => onSave(draft)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          <Check size={13} /> Save
        </button>
      }
    >
      <textarea
        value={draft.signature}
        onChange={(e) => setDraft({ ...draft, signature: e.target.value })}
        rows={4}
        placeholder={"Best,\nAlex"}
        className={`${INPUT_CLS} resize-none`}
      />
    </Modal>
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
        Picked up from how you edit the assistant&apos;s drafts before sending. These
        nudge future drafts — remove any you don&apos;t want.
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

/** Classification patterns learned from Fix corrections (sender → rule
 *  include/exclude). The real "Learned Patterns", inbox-zero style. */
function LearnedPatternsList({ accountId }: { accountId: string | null }) {
  const [patterns, setPatterns] = useState<LearnedRulePattern[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listRulePatterns(accountId)
      .then(setPatterns)
      .catch(() => setPatterns([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  const forget = async (id: string) => {
    setPatterns((prev) => prev.filter((p) => p.id !== id));
    try {
      await deleteRulePattern(id);
    } catch {
      load();
    }
  };

  if (loading) return <Spinner label="Loading learned patterns…" />;
  if (patterns.length === 0) {
    return (
      <div className="text-center text-xs text-muted-foreground py-6 space-y-1">
        <p>No learned patterns yet.</p>
        <p className="text-[11px]">
          Use the <b>Fix</b> button on a History or Test result to teach the
          assistant which rule a sender should (or shouldn&apos;t) match — it
          shows up here and is applied automatically next time.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {patterns.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2"
        >
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap ${
              p.exclude
                ? "bg-red-500/15 text-red-400"
                : "bg-emerald-500/15 text-emerald-400"
            }`}
          >
            {p.exclude ? "Never match" : "Always match"}
          </span>
          <div className="flex-1 min-w-0 text-xs text-foreground/80 truncate">
            <span className="text-muted-foreground">From</span> {p.value}{" "}
            <span className="text-muted-foreground">→</span>{" "}
            <span className="text-foreground">{p.rule_name || "(deleted rule)"}</span>
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
