"use client";

// The Assistant "Test" tab: run rules against real inbox emails in Test (preview)
// or Apply mode, one-at-a-time or "on all", with per-email result pills + Fix.
// The bulk-run sweep state lives in the email store so it survives unmount.
// Extracted from AssistantView.tsx.

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, Loader2, Play, RefreshCcw, Sparkles, Square } from "lucide-react";
import { listEmails } from "../../../lib/api";
import type { Email, RuleAction } from "../../../lib/types";
import { useEmailStore } from "../../../lib/emailStore";
import { EmailPreviewModal } from "../../EmailPreviewModal";
import { LabeledToggle } from "../ui";
import { Empty, INPUT_CLS, RuleResultPill, Spinner } from "./common";
import { FixButton } from "./fixDialog";

/** Inbox emails fetched per "Load more" in the Test tab. */
const TEST_PAGE_SIZE = 25;

export function TestTab({ accountId }: { accountId: string | null }) {
  const [applyMode, setApplyMode] = useState(false); // false = Test, true = Apply
  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Email | null>(null);

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
                <button
                  type="button"
                  onClick={() => setPreview(e)}
                  title="Preview email"
                  className="flex-1 min-w-0 text-left cursor-pointer hover:opacity-80 transition-opacity"
                >
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
                </button>
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
                        // Required, not optional. Without it the backend can't
                        // resolve the thread, so a correction to a conversation
                        // rule (Reply / Awaiting / FYI / Done) silently does
                        // nothing while the dialog still reports "Learned".
                        // Conversation state is set on the THREAD, so there is
                        // no pattern to fall back on.
                        messageId={e.id}
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
      {preview && (
        <EmailPreviewModal
          messageId={preview.id}
          seed={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
