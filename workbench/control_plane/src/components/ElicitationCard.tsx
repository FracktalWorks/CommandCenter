"use client";

/**
 * ElicitationCard — VS Code-style HITL question card.
 *
 * When the agent calls ask_questions(), it emits an "elicitation_requested"
 * custom event.  This card renders inline in the chat thread with
 * interactive options (single/multi-select) + optional freeform input.
 *
 * Mirrors VS Code's vscode_askQuestions tool UX:
 *   • Header + question text per item
 *   • Option buttons with recommended star indicator
 *   • Multi-select checkboxes when multiSelect=true
 *   • Freeform text input when allowFreeformInput=true
 *   • Submit button collects all answers and sends them as next message
 *
 * Usage:
 *   <ElicitationCard
 *     questions={[...]}
 *     onSubmit={(answers) => sendMessage(JSON.stringify(answers))}
 *   />
 */

import { useState, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────

export interface ElicitationOption {
  label: string;
  description?: string | null;
  recommended?: boolean;
}

export interface ElicitationQuestion {
  header: string;
  question: string;
  multiSelect?: boolean;
  allowFreeformInput?: boolean;
  options?: ElicitationOption[] | null;
}

export interface ElicitationAnswers {
  [header: string]: {
    selected?: string[];
    freeform?: string;
  };
}

interface ElicitationCardProps {
  questions: ElicitationQuestion[];
  onSubmit: (answers: ElicitationAnswers) => void;
  disabled?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────

export default function ElicitationCard({
  questions,
  onSubmit,
  disabled = false,
}: ElicitationCardProps) {
  const [answers, setAnswers] = useState<ElicitationAnswers>({});
  const [freeformTexts, setFreeformTexts] = useState<Record<string, string>>({});

  const toggleOption = useCallback(
    (header: string, label: string, multi: boolean) => {
      if (disabled) return;
      setAnswers((prev) => {
        const cur = prev[header]?.selected ?? [];
        let next: string[];
        if (multi) {
          next = cur.includes(label)
            ? cur.filter((l) => l !== label)
            : [...cur, label];
        } else {
          next = cur.includes(label) ? [] : [label];
        }
        return { ...prev, [header]: { ...prev[header], selected: next } };
      });
    },
    [disabled],
  );

  const handleSubmit = () => {
    if (disabled) return;
    // Merge freeform text into answers.
    const final: ElicitationAnswers = {};
    for (const q of questions) {
      final[q.header] = {
        selected: answers[q.header]?.selected ?? [],
        freeform: freeformTexts[q.header] || undefined,
      };
    }
    onSubmit(final);
  };

  const canSubmit = questions.every((q) => {
    const hasOptions = q.options && q.options.length > 0;
    const hasFreeform = q.allowFreeformInput !== false;
    const selected = answers[q.header]?.selected?.length ?? 0;
    const freeformFilled = (freeformTexts[q.header] ?? "").trim().length > 0;
    // When BOTH a freeform box and options are offered, typing a custom answer
    // is a valid response on its own — don't force the user to also pick an
    // option (previously the Submit button stayed disabled/hidden until an
    // option was selected, even after typing a custom answer).
    if (hasOptions && hasFreeform) return selected > 0 || freeformFilled;
    if (hasOptions) return selected > 0;
    if (hasFreeform) return freeformFilled;
    return false;
  });

  if (questions.length === 0) return null;

  return (
    <div className="my-3 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-primary/20 bg-primary/10">
        <span className="text-base">💬</span>
        <span className="text-[12px] sm:text-[13px] font-medium text-foreground">
          {questions.length === 1
            ? questions[0].header
            : `${questions.length} questions`}
        </span>
      </div>

      {/* Questions */}
      <div className="px-4 py-3 space-y-4">
        {questions.map((q, qi) => {
          const hasOptions = q.options && q.options.length > 0;
          const selected = answers[q.header]?.selected ?? [];
          const ft = freeformTexts[q.header] ?? "";

          return (
            <div key={qi}>
              {/* Question header */}
              {questions.length > 1 && (
                <div className="text-[11px] font-semibold text-primary/80 uppercase tracking-wide mb-1">
                  {q.header}
                </div>
              )}
              <p className="text-[12px] sm:text-[13px] text-foreground leading-relaxed mb-2">
                {q.question}
              </p>

              {/* Options */}
              {hasOptions && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {q.options!.map((opt, oi) => {
                    const isSelected = selected.includes(opt.label);
                    return (
                      <button
                        key={oi}
                        type="button"
                        onClick={() =>
                          toggleOption(q.header, opt.label, !!q.multiSelect)
                        }
                        disabled={disabled}
                        className={
                          "text-[11px] sm:text-[12px] px-3 py-1.5 rounded-lg font-medium transition-colors border " +
                          (isSelected
                            ? "bg-primary/20 border-primary text-primary-foreground"
                            : "bg-card border-border text-muted-foreground hover:border-primary/40 hover:text-foreground")
                        }
                        title={opt.description ?? undefined}
                      >
                        {opt.recommended && (
                          <span className="mr-1" title="Recommended">
                            ⭐
                          </span>
                        )}
                        {opt.label}
                        {q.multiSelect && isSelected && (
                          <span className="ml-1 text-[10px]">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Freeform input */}
              {q.allowFreeformInput !== false && (
                <textarea
                  value={ft}
                  onChange={(e) =>
                    setFreeformTexts((prev) => ({
                      ...prev,
                      [q.header]: e.target.value,
                    }))
                  }
                  disabled={disabled}
                  placeholder={
                    hasOptions
                      ? "Or type a custom answer…"
                      : "Type your answer…"
                  }
                  rows={2}
                  className="w-full text-[12px] bg-card border border-border rounded-lg px-3 py-1.5 resize-none focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/50 disabled:opacity-40"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Submit */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-primary/20 bg-primary/5">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !canSubmit}
          className="text-[12px] px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/80 disabled:opacity-40 transition-colors"
        >
          Submit
        </button>
        <span className="text-[10px] text-muted-foreground">
          Your answers will be sent to the agent
        </span>
      </div>
    </div>
  );
}
