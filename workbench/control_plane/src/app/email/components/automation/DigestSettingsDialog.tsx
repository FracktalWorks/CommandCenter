"use client";

/**
 * The ONE digest configuration dialog (2.7 dialog merge).
 *
 * Two drifted copies used to exist — DigestView's "Digest schedule" (no
 * category picker) and AI-Settings' "Digest settings" (with it) — so the same
 * schedule was edited from two dialogs that disagreed about what was
 * configurable. This is the superset, self-contained: it fetches the settings
 * and the rule names itself, saves itself, and reports the saved settings up
 * via `onSaved` so an embedding screen (AI-Settings) can sync its local copy.
 */

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  getAssistantSettings, listRules, saveAssistantSettings,
} from "../../lib/api";
import {
  AssistantSettings, DigestFrequency, WEEKDAYS,
} from "../../lib/types";
import { Modal, Toggle } from "./ui";

const INPUT_CLS =
  "w-full bg-background border border-border rounded-md px-2.5 py-2 text-xs " +
  "text-foreground outline-none focus:border-primary transition-colors";

export function DigestSettingsDialog({
  accountId,
  onClose,
  onSaved,
}: {
  accountId: string;
  onClose: () => void;
  onSaved?: (next: AssistantSettings) => void;
}) {
  const [s, setS] = useState<AssistantSettings | null>(null);
  const [ruleNames, setRuleNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAssistantSettings(accountId)
      .then((next) => !cancelled && setS(next))
      .catch(() => {});
    listRules(accountId)
      .then((rules) =>
        !cancelled && setRuleNames(rules.map((r) => r.name).filter(Boolean)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const set = (patch: Partial<AssistantSettings>) =>
    setS((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async () => {
    if (!s) return;
    setSaving(true);
    setErr(null);
    try {
      const next = await saveAssistantSettings(s);
      onSaved?.(next);
      onClose();
    } catch (e) {
      setErr((e as Error).message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  const options = [...ruleNames, "Cold Emails"];
  const allSelected = !s || s.digest_categories.length === 0; // empty = all
  const toggleCat = (name: string) => {
    if (!s) return;
    const has = s.digest_categories.includes(name);
    set({
      digest_categories: has
        ? s.digest_categories.filter((c) => c !== name)
        : [...s.digest_categories, name],
    });
  };

  return (
    <Modal
      title="Digest settings"
      description="Configure when your digest is sent and which rules it includes."
      onClose={onClose}
      maxWidth="max-w-md"
      footer={
        <button
          onClick={save}
          disabled={saving || !s}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
          Save
        </button>
      }
    >
      {!s ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
          <Loader2 className="animate-spin" size={14} /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <span className="text-xs text-muted-foreground mb-1.5 block">
              What to include in the digest{" "}
              {allSelected && (
                <span className="text-muted-foreground/70">(all rules)</span>
              )}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {options.map((name) => {
                const on = s.digest_categories.includes(name);
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
          <div>
            <label className="text-[11px] text-muted-foreground">Frequency</label>
            <select
              value={s.digest_frequency}
              onChange={(e) =>
                set({ digest_frequency: e.target.value as DigestFrequency })
              }
              className={INPUT_CLS}
            >
              <option value="OFF">Off</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>
          {s.digest_frequency === "WEEKLY" && (
            <div>
              <label className="text-[11px] text-muted-foreground">Day of week</label>
              <select
                value={s.digest_day_of_week}
                onChange={(e) =>
                  set({ digest_day_of_week: parseInt(e.target.value, 10) })
                }
                className={INPUT_CLS}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          {s.digest_frequency !== "OFF" && (
            <div>
              <label className="text-[11px] text-muted-foreground">Time of day (UTC)</label>
              <input
                type="time"
                value={s.digest_time_of_day}
                onChange={(e) => set({ digest_time_of_day: e.target.value })}
                className={INPUT_CLS}
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Email the digest to me</span>
            <Toggle
              enabled={s.digest_send_to_email}
              onChange={(v) => set({ digest_send_to_email: v })}
            />
          </div>
          {err && (
            <div className="text-[11px] text-destructive bg-destructive/10 rounded-md px-2 py-1.5">
              {err}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
