"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Loader2, Plus, Trash2, Pencil, Play, Check, X, FlaskConical,
  History as HistoryIcon, Settings2, Sparkles, ChevronRight,
} from "lucide-react";
import {
  listRules, createRule, updateRule, deleteRule, testRules,
  getRulesHistory, runRules, getAssistantSettings, saveAssistantSettings,
} from "../../lib/api";
import {
  AutomationRule, RuleAction, RuleActionType, RuleTestResult, ExecutedRule,
  AssistantSettings,
} from "../../lib/types";

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
  "MOVE_FOLDER", "CALL_WEBHOOK",
];

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
    instructions:
      "Emails that need a reply or response from me — a person asking a " +
      "question, making a request, or awaiting my input. Not automated mail.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 0,
    actions: [{ type: "LABEL", label: "To Reply" }],
  },
  {
    name: "Newsletter",
    instructions:
      "Newsletters, digests, and content subscriptions I've signed up for.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 1,
    actions: [{ type: "LABEL", label: "Newsletter" }, { type: "ARCHIVE" }],
  },
  {
    name: "Marketing",
    instructions:
      "Marketing, promotional and sales emails — discounts, offers, product " +
      "announcements and campaigns.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 2,
    actions: [{ type: "LABEL", label: "Marketing" }, { type: "ARCHIVE" }],
  },
  {
    name: "Calendar",
    instructions: "Calendar invites, meeting requests and event notifications.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 3,
    actions: [{ type: "LABEL", label: "Calendar" }],
  },
  {
    name: "Receipt",
    instructions:
      "Receipts, invoices, order confirmations and payment notifications.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 4,
    actions: [{ type: "LABEL", label: "Receipt" }],
  },
  {
    name: "Notification",
    instructions:
      "Automated notifications, alerts and updates from apps and services.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 5,
    actions: [{ type: "LABEL", label: "Notification" }],
  },
  {
    name: "Cold Email",
    instructions:
      "Cold outreach — unsolicited sales, marketing or recruiting emails from " +
      "people or companies I have no prior relationship with.",
    enabled: true,
    run_on_threads: false,
    conditional_operator: "OR",
    sort_order: 6,
    actions: [{ type: "LABEL", label: "Cold Email" }, { type: "ARCHIVE" }],
  },
];

export function AssistantView({ accountId, selectedEmailId }: AssistantViewProps) {
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
        {tab === "test" && (
          <TestTab accountId={accountId} selectedEmailId={selectedEmailId} />
        )}
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
  run_on_threads: false,
  conditional_operator: "AND",
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
      const existing = new Set(rules.map((r) => r.name.toLowerCase()));
      for (const p of PRESET_RULES) {
        if (existing.has(p.name.toLowerCase())) continue;
        await createRule({ ...p, account_id: accountId });
      }
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
              No rules yet. Install the recommended set (To Reply, Newsletter,
              Marketing, Calendar, Receipt, Notification, Cold Email) or create
              your own.
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
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-start gap-3 bg-card border border-border rounded-xl px-4 py-3"
          >
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
              <div className="text-sm font-medium text-foreground">{rule.name}</div>
              {rule.instructions && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {rule.instructions}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1 mt-1.5">
                {rule.actions.map((a, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground"
                  >
                    {a.type}
                    {a.label ? `: ${a.label}` : ""}
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

  const setAction = (i: number, patch: Partial<RuleAction>) =>
    setDraft((d) => ({
      ...d,
      actions: d.actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
    }));

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

      <Field label="Instructions (plain English — matched by AI)">
        <textarea
          value={draft.instructions ?? ""}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder="e.g. Marketing or promotional emails, sales and discounts"
          rows={2}
          className={`${INPUT_CLS} resize-none`}
        />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="From contains">
          <input
            value={draft.from_pattern ?? ""}
            onChange={(e) => set({ from_pattern: e.target.value })}
            placeholder="newsletter@"
            className={INPUT_CLS}
          />
        </Field>
        <Field label="Subject contains">
          <input
            value={draft.subject_pattern ?? ""}
            onChange={(e) => set({ subject_pattern: e.target.value })}
            placeholder="invoice"
            className={INPUT_CLS}
          />
        </Field>
      </div>

      {/* Actions */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-foreground">Actions</span>
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
            <div key={i} className="flex items-center gap-2">
              <select
                value={a.type}
                onChange={(e) =>
                  setAction(i, { type: e.target.value as RuleActionType })
                }
                className={`${INPUT_CLS} flex-shrink-0 w-40`}
              >
                {ACTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {(a.type === "LABEL" || a.type === "MOVE_FOLDER") && (
                <input
                  value={a.label ?? ""}
                  onChange={(e) => setAction(i, { label: e.target.value })}
                  placeholder={a.type === "LABEL" ? "Label name" : "Folder key"}
                  className={`${INPUT_CLS} flex-1`}
                />
              )}
              {a.type === "CALL_WEBHOOK" && (
                <input
                  value={a.url ?? ""}
                  onChange={(e) => setAction(i, { url: e.target.value })}
                  placeholder="https://…"
                  className={`${INPUT_CLS} flex-1`}
                />
              )}
              <button
                onClick={() =>
                  set({ actions: draft.actions.filter((_, idx) => idx !== i) })
                }
                className="p-1.5 text-muted-foreground hover:text-destructive"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
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

// ── Test tab ────────────────────────────────────────────────────────────────

function TestTab({
  accountId,
  selectedEmailId,
}: {
  accountId: string | null;
  selectedEmailId: string | null;
}) {
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [useSelected, setUseSelected] = useState(!!selectedEmailId);
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await testRules({
        accountId,
        emailId: useSelected && selectedEmailId ? selectedEmailId : undefined,
        fromEmail: from,
        subject,
        body,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message || "Test failed");
    } finally {
      setLoading(false);
    }
  };

  if (!accountId) return <Empty>Select an account first.</Empty>;

  return (
    <div className="h-full overflow-y-auto px-5 py-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        Test which rule would match an email before turning it loose on your inbox.
      </p>

      {selectedEmailId && (
        <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={useSelected}
            onChange={(e) => setUseSelected(e.target.checked)}
            className="accent-primary"
          />
          Use the currently selected email
        </label>
      )}

      {!useSelected && (
        <div className="space-y-3">
          <Field label="From">
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="sender@example.com"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Subject">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject line"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Body">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Email body…"
              className={`${INPUT_CLS} resize-none`}
            />
          </Field>
        </div>
      )}

      <button
        onClick={run}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? <Loader2 className="animate-spin" size={13} /> : <FlaskConical size={13} />}
        Test rules
      </button>

      {error && <div className="text-xs text-destructive">{error}</div>}

      {result && (
        <div
          className={`rounded-xl border p-4 ${
            result.matched
              ? "border-primary/30 bg-primary/5"
              : "border-border bg-card"
          }`}
        >
          {result.matched ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Check size={14} className="text-primary" />
                Matched: {result.rule?.name}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{result.reason}</p>
              <div className="flex flex-wrap items-center gap-1 mt-2">
                {result.actions.map((a, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground"
                  >
                    {a.type}
                    {a.label ? `: ${a.label}` : ""}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <X size={14} /> No rule matched this email.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History tab ─────────────────────────────────────────────────────────────

function HistoryTab({ accountId }: { accountId: string | null }) {
  const [history, setHistory] = useState<ExecutedRule[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getRulesHistory(accountId ?? undefined, 200)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  if (loading) return <Spinner label="Loading history…" />;

  return (
    <div className="h-full overflow-y-auto px-5 py-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-muted-foreground">
          Every time a rule fired, with the actions taken.
        </p>
        <button
          onClick={load}
          className="text-xs text-primary hover:opacity-80"
        >
          Refresh
        </button>
      </div>
      {history.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-10">
          No rule executions yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {history.map((h) => (
            <div
              key={h.id}
              className="flex items-center gap-3 bg-card border border-border rounded-lg px-3 py-2"
            >
              <span
                className={`text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                  h.status === "APPLIED"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : h.status === "PENDING"
                      ? "bg-amber-500/15 text-amber-400"
                      : "bg-secondary text-muted-foreground"
                }`}
              >
                {h.status}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-foreground truncate">
                  {h.subject || "(no subject)"}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {h.from} · {h.rule_name}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {h.actions.map((a, i) => (
                  <span
                    key={i}
                    className="text-[9px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground"
                  >
                    {a}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Settings tab ────────────────────────────────────────────────────────────

function SettingsTab({ accountId }: { accountId: string | null }) {
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveAssistantSettings(settings);
      setSettings(res);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  if (!accountId) return <Empty>Select an account first.</Empty>;
  if (loading || !settings) return <Spinner label="Loading settings…" />;

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <Field label="About you (context the assistant uses when drafting replies)">
          <textarea
            value={settings.about}
            onChange={(e) => setSettings({ ...settings, about: e.target.value })}
            rows={3}
            placeholder="e.g. I'm the founder of Acme. Keep replies concise and friendly; I prefer to handle anything financial myself."
            className={`${INPUT_CLS} resize-none`}
          />
        </Field>
        <Field label="Signature">
          <textarea
            value={settings.signature}
            onChange={(e) =>
              setSettings({ ...settings, signature: e.target.value })
            }
            rows={2}
            placeholder={"Best,\nAlex"}
            className={`${INPUT_CLS} resize-none`}
          />
        </Field>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.auto_run}
            onChange={(e) =>
              setSettings({ ...settings, auto_run: e.target.checked })
            }
            className="accent-primary mt-0.5"
          />
          <span>
            <span className="text-xs text-foreground">
              Run rules automatically on new mail
            </span>
            <span className="block text-[11px] text-muted-foreground">
              Processes incoming inbox mail with your enabled rules as it arrives.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
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

      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-sm font-medium text-foreground mb-1">
          How the assistant works
        </h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Rules combine plain-English instructions (matched by the AI) with optional
          static conditions (sender / subject contains). When you run rules, each
          recent inbox message is matched to the best rule and its actions are applied.
          Use <span className="text-foreground">Dry run</span> to preview matches in
          the History tab without changing anything.
        </p>
      </div>

      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
        <ChevronRight size={11} /> Reply/forward/draft actions are coming soon.
      </p>
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
